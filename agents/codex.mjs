import {spawn} from 'node:child_process';
import {readdirSync,readFileSync,realpathSync,statSync} from 'node:fs';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {AgentRun,filesNote} from './run.mjs';
const defaultBin='/usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex';
const permissionModes={
 'read-only':{label:'Только чтение',description:'Просмотр файлов без изменений. Действия вне ограничений требуют подтверждения.',sandbox:'read-only',approvalPolicy:'untrusted'},
 'workspace':{label:'Работа в проекте',description:'Изменения в проекте. Нетипичные команды и выход за ограничения требуют подтверждения.',sandbox:'workspace-write',approvalPolicy:'untrusted'},
 'full-access':{label:'Полный доступ',description:'Доступ ко всему VPS и сети без запросов подтверждения.',sandbox:'danger-full-access',approvalPolicy:'never'}
};
function cleanEnv(){const env={...process.env};for(const k of ['OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN'])delete env[k];return env;}
// Real process start time: /proc/<pid>/stat field 22 (clock ticks since boot) plus boot time. The /proc directory times are not start times.
let bootMs=null;
function processStart(pid){
 try{if(bootMs===null)bootMs=Number(readFileSync('/proc/stat','utf8').match(/^btime (\d+)/m)[1])*1000;
  const stat=readFileSync('/proc/'+pid+'/stat','utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');return bootMs+Number(fields[19])*10;}catch{return Date.now();}
}
export function codexAgent(ctx){
 const bin=()=>process.env.CODEX_BIN||ctx.config.paths.codex||defaultBin;
 class CodexRun extends AgentRun{
  constructor(task,cwd){super(ctx,task,cwd);this.pending=new Map();this.seq=0;
   this.spawn(bin(),['app-server','--listen','stdio://'],{cwd,env:cleanEnv()});
   this.proc.on('error',()=>this.finish('failed'));this.proc.on('exit',()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Codex завершился'));}this.pending.clear();this.finish('failed');});
  }
  send(x){if(this.closed)throw Error('Codex завершился');this.proc.stdin.write(JSON.stringify(x)+'\n');}
  call(method,params){return new Promise((resolve,reject)=>{const id=++this.seq;const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Тайм-аут Codex'));},60000);this.pending.set(id,{resolve,reject,timer});this.send({id,method,params});});}
  receive(m){if(m.id!==undefined&&!m.method){const p=this.pending.get(m.id);if(p){clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}return;}
   if(m.id!==undefined){if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(m.method)){const key=ctx.token();this.approvals.set(key,m);this.event({type:'approval',key,method:m.method,params:m.params});}else{this.send({id:m.id,error:{code:-32601,message:'Unsupported request; denied by panel'}});this.event({type:'notice',message:'Неподдерживаемый запрос отклонён: '+m.method});}return;}
   this.event({type:'event',method:m.method,params:m.params});
   if(m.method==='turn/started')this.turn=m.params.turn.id;
   if(m.method==='turn/completed')this.finish(m.params.turn.status);
  }
  decide(key,decision){const m=this.approvals.get(key);this.send({id:m.id,result:{decision}});}
  interrupt(){if(this.turn)this.call('turn/interrupt',{threadId:this.thread,turnId:this.turn}).catch(()=>{});}
  async start(cwd,prompt,thread,settings,files=[]){{const context=await ctx.mailContext(this.task);if(context)prompt+='\n\n'+context;}await this.call('initialize',{clientInfo:{name:'agent_panel',title:'Панель агентов',version:'1.0.0'},capabilities:{experimentalApi:true}});this.send({method:'initialized',params:{}});
   const account=await this.call('account/read',{refreshToken:false});if(account.account?.type!=='chatgpt')throw Error('Требуется локальный вход Codex через ChatGPT');
   const mode=permissionModes[settings.permissions];
   const params={cwd,model:settings.model,approvalPolicy:mode.approvalPolicy,approvalsReviewer:'user',sandbox:mode.sandbox,modelProvider:'openai',config:{'sandbox_workspace_write.network_access':false,...(process.env.PANEL_TEST==='1'?{}:{'mcp_servers.panel_bridge':ctx.bridgeConfig(this.task)})}};
   const result=await this.call(thread?(settings.fork?'thread/fork':'thread/resume'):'thread/start',thread?{...params,threadId:thread}:params);this.setThread(result.thread.id);
   const r=await this.call('turn/start',{threadId:this.thread,model:settings.model,effort:settings.reasoning,input:[{type:'text',text:prompt+filesNote(files),text_elements:[]},...files.filter(f=>f.image).map(f=>({type:'localImage',path:f.path}))]});this.turn=r.turn.id;
  }
 }
 // Short-lived app-server for catalog and session queries; the caller closes it.
 async function appServer(){
  const proc=spawn(bin(),['app-server','--listen','stdio://'],{env:cleanEnv(),stdio:['pipe','pipe','ignore']});
  const pending=new Map();let seq=0;
  const fail=e=>{for(const p of pending.values())p.reject(e);pending.clear();};
  proc.on('error',fail);proc.on('exit',()=>fail(Error('Codex app-server завершился')));proc.stdin.on('error',fail);
  const lines=createInterface({input:proc.stdout});lines.on('line',line=>{try{const m=JSON.parse(line),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}}catch{}});
  const call=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});proc.stdin.write(JSON.stringify({id,method,params})+'\n');});
  const timer=setTimeout(()=>{fail(Error('Тайм-аут Codex app-server'));proc.kill();},20000);
  await call('initialize',{clientInfo:{name:'agent_panel_sessions',version:'1.0.0'}});proc.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
  return {call,close(){clearTimeout(timer);lines.close();proc.kill();}};
 }
 // Codex sessions started outside the panel (TUI, exec, IDE), read through the app-server protocol.
 const ownOriginators=new Set(['agent_panel','bro_codex_panel','agent_panel_sessions','bro_panel_models','agent_panel_models']);
 const real=p=>{try{return realpathSync(p);}catch{return null;}};
 const inside=(dir,root)=>dir===root||dir.startsWith(root.endsWith('/')?root:root+'/');
 let threadCache=null;
 async function threads(fresh=false){
  if(!fresh&&threadCache&&Date.now()-threadCache.time<30000)return threadCache.value;
  const server=await appServer();const out=[];
  try{let cursor;do{const page=await server.call('thread/list',{limit:100,sortKey:'updated_at',sortDirection:'desc',sourceKinds:['cli','vscode','exec','appServer'],...(cursor?{cursor}:{})});out.push(...page.data);cursor=page.nextCursor;}while(cursor&&out.length<500);}
  finally{server.close();}
  const value=out.filter(t=>!ownOriginators.has(t.originator)&&!t.ephemeral&&!t.parentThreadId).map(t=>({id:t.id,cwd:t.cwd,runCwd:t.cwd,title:String(t.name||'').slice(0,150),lastPrompt:String(t.preview||'').slice(0,300),size:t.path?(()=>{try{return statSync(t.path).size;}catch{return 0;}})():0,updated:new Date((t.updatedAt||t.createdAt)*1000).toISOString(),originator:t.originator||'',service:t.source==='exec'||t.originator==='codex_exec'||!t.preview}));
  threadCache={time:Date.now(),value};return value;
 }
 // Live: a process started with the thread id, or an interactive codex (not app-server) in its folder since before the last write.
 let liveCache=null;
 // Lists share one /proc scan for 3 s; safety checks before a turn or a move always scan anew.
 function liveInfo(fresh=false){
  if(!fresh&&liveCache&&Date.now()-liveCache.time<3000)return liveCache.value;
  const ids=new Set(),tuis=[];
  for(const pid of readdirSync('/proc')){if(!/^\d+$/.test(pid)||Number(pid)===process.pid)continue;
   let args;try{args=readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0');}catch{continue;}
   if(!args.slice(0,2).some(a=>path.basename(a)==='codex'))continue;
   let found=false;for(const a of args){const m=a.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);if(m){ids.add(m[0]);found=true;}}
   if(!found&&!args.includes('app-server')){try{tuis.push({cwd:realpathSync('/proc/'+pid+'/cwd'),start:processStart(pid)});}catch{}}}
  liveCache={time:Date.now(),value:{ids,tuis}};return liveCache.value;
 }
 function isLive(t,info=liveInfo()){if(info.ids.has(t.id))return true;const cwd=real(t.cwd);return info.tuis.some(x=>x.cwd===cwd&&Date.parse(t.updated)>=x.start-60000);}
 const sessions={
  async list(projectCwd,others=[],{fresh=false}={}){
   const info=liveInfo(fresh);
   return (await threads(fresh)).filter(t=>{const dir=t.cwd&&real(t.cwd);if(!dir)return false;if(projectCwd===null)return !others.some(o=>inside(dir,o));return inside(dir,projectCwd)&&!others.some(o=>o!==projectCwd&&inside(o,projectCwd)&&inside(dir,o));})
    .map(t=>({...t,folder:projectCwd===null?real(t.cwd):real(t.cwd)===projectCwd?'':path.relative(projectCwd,real(t.cwd)),live:isLive(t,info)}));
  },
  async find(id){return (await threads(true)).find(t=>t.id===id)||null;},
  async history(id,limit=40){
   const server=await appServer();let thread;
   try{thread=(await server.call('thread/read',{threadId:id,includeTurns:true})).thread;}finally{server.close();}
   const items=[];
   for(const turn of thread.turns||[])for(const i of turn.items||[]){
    if(i.type==='userMessage'){const text=(i.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n').trim();if(text)items.push({role:'user',text:text.slice(0,4000)});}
    else if(i.type==='agentMessage'&&i.text?.trim())items.push({role:'assistant',text:i.text.trim().slice(0,6000)});
   }
   return {session:{id:thread.id,title:thread.name||'',cwd:thread.cwd},messages:items.slice(-limit),truncated:items.length>limit};
  },
  live:id=>liveInfo(true).ids.has(id),
  isLive:t=>isLive(t,liveInfo(true))
 };
 let catalogPromise,catalogTime=0;
 function catalog(){
  if(catalogPromise&&Date.now()-catalogTime<60000)return catalogPromise;
  catalogTime=Date.now();catalogPromise=(async()=>{
   const proc=spawn(bin(),['app-server','--listen','stdio://'],{env:cleanEnv(),stdio:['pipe','pipe','ignore']});
   const pending=new Map();let seq=0;
   const fail=e=>{for(const p of pending.values())p.reject(e);pending.clear();};
   proc.on('error',fail);proc.on('exit',()=>fail(Error('Не удалось загрузить модели Codex')));proc.stdin.on('error',fail);
   const lines=createInterface({input:proc.stdout});lines.on('line',line=>{try{const m=JSON.parse(line),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}}catch{}});
   const call=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});proc.stdin.write(JSON.stringify({id,method,params})+'\n');});
   const timer=setTimeout(()=>{fail(Error('Тайм-аут загрузки моделей'));proc.kill();},20000);
   try{await call('initialize',{clientInfo:{name:'agent_panel_models',version:'1.0.0'}});proc.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
    const models=[];let cursor;do{const page=await call('model/list',{limit:100,includeHidden:false,...(cursor?{cursor}:{})});models.push(...page.data);cursor=page.nextCursor;}while(cursor);
    return {models,permissions:Object.entries(permissionModes).map(([id,m])=>({id,label:m.label,description:m.description}))};
   }finally{clearTimeout(timer);lines.close();proc.kill();}
  })();catalogPromise.catch(()=>{catalogPromise=null;});return catalogPromise;
 }
 return {id:'codex',name:'Codex',vendor:'OpenAI',connection:'Локальный Codex app-server через stdio',icon:'code',path:bin,catalog,sessions,createRun:(task,cwd)=>new CodexRun(task,cwd)};
}
