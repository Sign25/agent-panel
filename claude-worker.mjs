import {claudeEvents} from './claude-events.mjs';
import {query} from '@anthropic-ai/claude-agent-sdk';
import {createInterface} from 'node:readline';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const emit=x=>process.stdout.write(JSON.stringify(x)+'\n');
const env={...process.env,PANEL_MANAGED_SESSION:'1'};delete env.CLAUDECODE;if(process.env.PANEL_CLAUDE_AUTH==='api')delete env.CLAUDE_CODE_OAUTH_TOKEN;else delete env.ANTHROPIC_API_KEY;
const common={pathToClaudeCodeExecutable:process.env.CLAUDE_BIN||'/usr/bin/claude',env,systemPrompt:{type:'preset',preset:'claude_code'},settingSources:['user','project','local']};
let session,stopInput,pending=new Map(),inject=null;
let inputDone=new Promise(resolve=>stopInput=resolve);
function permission(tool,input,options){
 if(tool==='AskUserQuestion')return Promise.resolve({behavior:'deny',message:'Задай вопрос обычным сообщением и дождись следующего сообщения пользователя.'});
 const key=randomUUID();return new Promise(resolve=>{
  const settle=decision=>{pending.delete(key);options.signal.removeEventListener('abort',abort);emit({type:'approval-cancelled',key});resolve(decision==='accept'?{behavior:'allow',updatedInput:input}:{behavior:'deny',message:'Действие отклонено пользователем.'});};
  const abort=()=>settle('decline');pending.set(key,settle);options.signal.addEventListener('abort',abort,{once:true});
  emit({type:'approval',key,method:'claude/tool/requestApproval',params:{tool,input,reason:'Claude запрашивает разрешение на действие'}});
  if(options.signal.aborted)abort();
 });
}
// Panel modes: read-only and workspace ask through the panel; auto lets Claude's classifier decide (panel asks only when it cannot);
// bypass runs without any prompts.
const sdkModes={auto:'auto',bypass:'bypassPermissions'};
function baseOptions(mode){return {...common,permissionMode:sdkModes[mode]||'default',// Claude refuses bypass as root unless IS_SANDBOX=1, as in the server's Remote Control sessions; set only for bypass tasks.
...(mode==='bypass'?{allowDangerouslySkipPermissions:true,env:{...env,IS_SANDBOX:'1'}}:{}),canUseTool:(tool,input,options)=>mode==='read-only'&&!['Read','Glob','Grep'].includes(tool)?Promise.resolve({behavior:'deny',message:'В этом чате разрешено только чтение файлов.'}):permission(tool,input,options),includePartialMessages:true,// Project hooks would run commands without panel approval: off in the modes that promise approvals.
settings:{disableAllHooks:mode==='read-only'||mode==='workspace',...(sdkModes[mode]?{}:{permissions:{ask:['Bash','Edit','Write','NotebookEdit']}})},...(mode==='read-only'?{tools:['Read','Glob','Grep'],strictMcpConfig:true,mcpServers:{}}:{}),disallowedTools:['AskUserQuestion']};}
async function catalog(){
 async function* empty(){await inputDone;}
 session=query({prompt:empty(),options:{...common,cwd:'/tmp',persistSession:false,tools:[],strictMcpConfig:true,mcpServers:{},settingSources:[],settings:{disableAllHooks:true}}});
 try{const models=await session.supportedModels();emit({models});}finally{stopInput();session.close();}
}
async function run(b){
 // Mail context goes to the system prompt only, not into every user message.
 const text=b.prompt+(b.files?.length?'\n\nПриложенные пользователем файлы (имя и локальный путь, JSON):\n'+JSON.stringify(b.files.map(f=>({name:f.name,path:f.path})))+'\nИспользуй эти файлы как материалы к запросу.':'');
 const content=[{type:'text',text}];
 for(const f of b.files||[])if(f.image){const bytes=readFileSync(f.path);const mime=bytes[0]===137?'image/png':bytes[0]===255?'image/jpeg':bytes.subarray(0,3).toString()==='GIF'?'image/gif':'image/webp';content.push({type:'image',source:{type:'base64',media_type:mime,data:bytes.toString('base64')}});}
 // Messages the owner sends while the turn runs go into the same input stream; Claude picks them up mid-turn,
 // as a message typed into a working terminal session. The turn ends only after the last of them got an answer.
 const queue=[];let wake=null,lastInject=0,lastWork=0,open=true;
 inject=x=>{if(!open)return false;queue.push({type:'user',message:{role:'user',content:[{type:'text',text:x.text}]},parent_tool_use_id:null,session_id:''});lastInject=Date.now();wake?.();return true;};
 async function* input(){yield {type:'user',message:{role:'user',content},parent_tool_use_id:null,session_id:b.thread||''};
  while(true){while(queue.length)yield queue.shift();const done=await Promise.race([inputDone.then(()=>true),new Promise(r=>wake=r).then(()=>false)]);wake=null;if(done&&!queue.length)return;}}
 const options={...baseOptions(b.settings.permissions),cwd:b.cwd,model:b.settings.model,...(b.settings.reasoning!=='default'?{effort:b.settings.reasoning}:{}),...(b.thread?{resume:b.thread}:{}),...(b.thread&&b.settings.fork?{forkSession:true}:{})};
 // The owner reads this chat in the web panel (usually on a tablet): it renders markdown and pictures from this server.
 const panelNote='Ты отвечаешь в чате веб-панели. Чтобы показать владельцу картинку (варианты дизайна, скриншоты, схемы), сохрани её файлом PNG, JPEG, WebP или GIF и вставь в ответ отдельной строкой: ![подпись](/абсолютный/путь/файл.png). Панель покажет её прямо в чате; несколько таких строк подряд встанут рядом для сравнения. SVG и ссылки на сайты панель как картинки не показывает.';
 options.systemPrompt={type:'preset',preset:'claude_code',append:panelNote+(b.mailContext?'\n\n'+b.mailContext:'')};
 if(b.bridge){options.mcpServers={...(options.mcpServers||{}),panel_bridge:b.bridge};options.allowedTools=['mcp__panel_bridge__projects_list','mcp__panel_bridge__sessions_list','mcp__panel_bridge__inbox_read','mcp__panel_bridge__message_ack',...(b.settings.permissions==='read-only'?[]:['mcp__panel_bridge__message_send'])];}
 session=query({prompt:input(),options});let resultSeen=false;
 const event=(method,params)=>emit({type:'event',method,params});
 const forward=claudeEvents(event);
// How full the chat's context window is, as Claude Code's /context counts it (summary: no extra API calls).
const contextUsage=()=>process.env.PANEL_TEST==='1'||!session?.getContextUsage?Promise.resolve():session.getContextUsage({detail:'summary'}).then(r=>event('context/usage',{total:r.totalTokens,max:r.rawMaxTokens||r.maxTokens,percent:r.percentage,model:r.model,parts:(r.categories||[]).filter(c=>(c.kind==='used'||c.kind==='buffer')&&c.tokens>0).map(c=>({name:c.name,kind:c.kind,tokens:c.tokens}))})).catch(()=>{});
let contextAt=0;
 let worked=false,staleTimer=null,missing=false;
 // Background work (shell commands, subagents, monitors) lives in this Claude process: the turn's result does not end the run
 // while some of it is still going. Claude continues by itself when a task reports back; then the run ends as usual.
 let background=new Map(),waiting=false,graceTimer=null,capTimer=null;
 const end=status=>{clearTimeout(staleTimer);clearTimeout(graceTimer);clearTimeout(capTimer);resultSeen=true;emit({type:'done',status});stopInput();session.close();};
 try{for await(const m of session){
  if(m.session_id)emit({type:'session',id:m.session_id});
  if(m.type==='system'&&m.subtype==='init')event('turn/started',{turn:{id:m.session_id}});
  forward(m);
  if(m.type==='assistant'&&Date.now()-contextAt>15000){contextAt=Date.now();contextUsage();}
  if(m.type==='system'&&m.subtype==='background_tasks_changed'){
   const next=new Map();for(const t of m.tasks||[]){if(t.ambient)continue;const type=String(t.task_type||'');next.set(t.task_id,background.get(t.task_id)||{id:t.task_id,kind:/agent/.test(type)?'agent':/monitor/.test(type)?'monitor':'command',title:String(t.description||type).split('\n')[0].slice(0,140),started:new Date().toISOString()});}
   background=next;event('background/changed',{tasks:[...background.values()]});
   // Everything reported back: Claude normally starts the follow-up turn at once; if it does not, end the run.
   if(waiting&&!background.size){clearTimeout(graceTimer);graceTimer=setTimeout(()=>end('completed'),90000);}
   continue;
  }
  if(m.type==='assistant'){worked=true;lastWork=Date.now();clearTimeout(graceTimer);}
  // A resumed or copied session may first close a turn left hanging in the terminal (an unfinished background command).
  // That result comes before any work on our prompt: keep waiting for our own turn, but not forever.
  if(m.type==='result'&&!worked&&!m.is_error&&!staleTimer){staleTimer=setTimeout(()=>{resultSeen=true;emit({type:'done',status:'completed'});stopInput();session.close();},120000);continue;}
  // A message sent after the model's last step has not been answered yet: it starts another turn in this run.
  if(m.type==='result'&&!m.is_error&&lastInject>lastWork){clearTimeout(staleTimer);continue;}
  if(m.type==='result'&&!m.is_error&&background.size){clearTimeout(staleTimer);if(!waiting){waiting=true;capTimer=setTimeout(()=>end('completed'),6*3600000);}event('turn/waiting-background',{tasks:[...background.values()]});continue;}
  // The chat's previous Claude session is gone (its file was deleted or lives on another machine): start a new one.
  if(m.type==='result'&&m.is_error&&b.thread&&!worked&&/No conversation found/i.test((m.errors||[]).join('\n')+(m.result||''))){missing=true;resultSeen=true;break;}
  if(m.type==='result'&&!m.is_error)await Promise.race([contextUsage(),new Promise(r=>setTimeout(r,4000))]);
  if(m.type==='result'){open=false;clearTimeout(staleTimer);clearTimeout(graceTimer);clearTimeout(capTimer);resultSeen=true;if(m.is_error)emit({type:'error',message:m.errors?.join('\n')||m.result||'Claude завершил задачу с ошибкой'});emit({type:'done',status:m.is_error?'failed':'completed'});break;}
 }
 if(!resultSeen)throw Error('Claude завершился без результата');
 }catch(e){if(!(b.thread&&!worked&&/No conversation found/i.test(e.message)))throw e;missing=true;}
 finally{stopInput();session.close();}
 if(missing){emit({type:'notice',message:'Прежняя сессия этого чата не найдена на сервере: начата новая, без её истории.'});inputDone=new Promise(resolve=>stopInput=resolve);return run({...b,thread:null,settings:{...b.settings,fork:false}});}
}
// Plan limits of the logged-in account (the data behind /usage). The SDK marks this call experimental.
async function usage(){
 async function* empty(){await inputDone;}
 session=query({prompt:empty(),options:{...common,cwd:'/tmp',persistSession:false,tools:[],strictMcpConfig:true,mcpServers:{},settingSources:[],settings:{disableAllHooks:true}}});
 try{const u=await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors:true});const r=u.rate_limits||{};
  const pick=w=>w&&typeof w.utilization==='number'?{percent:w.utilization,resetsAt:w.resets_at||null}:null;
  emit({available:Boolean(u.rate_limits_available&&u.rate_limits),five_hour:pick(r.five_hour),seven_day:pick(r.seven_day),seven_day_opus:pick(r.seven_day_opus),seven_day_sonnet:pick(r.seven_day_sonnet)});}
 finally{stopInput();session.close();}
}
if(process.argv.includes('--usage'))usage().catch(e=>{emit({error:e.message});process.exitCode=1;});
else if(process.argv.includes('--catalog'))catalog().catch(e=>{emit({error:e.message});process.exitCode=1;});
else{
 let started=false;createInterface({input:process.stdin}).on('line',line=>{try{const b=JSON.parse(line);if(b.type==='approval')pending.get(b.key)?.(b.decision);else if(b.type==='inject')emit({type:'injected',id:b.id,ok:Boolean(inject?.(b))});else if(b.type==='start'&&!started){started=true;run(b).catch(e=>{emit({type:'error',message:e.message});emit({type:'done',status:'failed'});}).finally(()=>process.stdout.write('',()=>process.exit()));}}catch{}});
}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{for(const settle of pending.values())settle('decline');stopInput();session?.close();process.exit();});
