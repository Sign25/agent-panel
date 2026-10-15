import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {AgentRun} from './run.mjs';
import {claudeSessions} from '../claude-sessions.mjs';
const runFile=promisify(execFile);
const permissions=[{id:'read-only',label:'Только чтение',description:'Только Read, Glob и Grep. Без команд, изменений, hooks и MCP.'},{id:'workspace',label:'С подтверждениями',description:'Команды и изменения требуют разрешения в панели. Это разрешения Claude, без изоляции файловой системы Codex.'},{id:'auto',label:'Авто',description:'Классификатор Claude сам разрешает безопасные действия и отклоняет опасные; спорные приходят на подтверждение в панель.'},{id:'bypass',label:'Без подтверждений',description:'Bypass permissions: все команды и изменения выполняются без запросов, включая доступ ко всему VPS. Используйте только в доверенных проектах.'}];
export function claudeAgent(ctx){
 const bin=()=>process.env.CLAUDE_BIN||ctx.config.paths.claude||'/usr/bin/claude';
 const worker=()=>process.env.CLAUDE_WORKER||path.join(ctx.root,'claude-worker.mjs');
 class ClaudeRun extends AgentRun{
  constructor(task,cwd){super(ctx,task,cwd);
   this.spawn(process.execPath,[worker()],{cwd,env:process.env});
   this.proc.on('error',()=>{this.event({type:'error',message:'Не удалось запустить Claude Code'});this.finish('failed');});
   this.proc.on('exit',()=>{if(!this.closed){this.event({type:'error',message:'Claude Code завершился без результата'});this.finish('failed');}});
  }
  send(x){if(this.closed)throw Error('Claude завершился');this.proc.stdin.write(JSON.stringify(x)+'\n');}
  async start(cwd,prompt,thread,settings,files){const context=await ctx.mailContext(this.task);this.send({type:'start',cwd,prompt,thread,settings,files,mailContext:context,...(process.env.PANEL_TEST==='1'?{}:{bridge:ctx.bridgeConfig(this.task)})});}
  receive(m){if(this.closed)return;
   if(m.type==='session'){this.setThread(m.id);return;}
   if(m.type==='approval'){this.approvals.set(m.key,m);this.event(m);return;}
   if(m.type==='approval-cancelled'){this.approvals.delete(m.key);return;}
   if(m.type==='injected'){const r=this.injects?.get(m.id);if(r){this.injects.delete(m.id);r(m.ok);}return;}
   if(m.type==='done'){this.finish(m.status);return;}
   if(['error','event','notice'].includes(m.type))this.event(m);
  }
  decide(key,decision){this.send({type:'approval',key,decision});}
  // A message for the running turn: the worker answers whether the turn could still take it.
  inject(text){this.injects??=new Map();const id=Math.random().toString(36).slice(2);
   return new Promise(resolve=>{this.injects.set(id,resolve);try{this.send({type:'inject',id,text});}catch{this.injects.delete(id);return resolve(false);}setTimeout(()=>{if(this.injects.delete(id))resolve(false);},5000);});}
 }
 let catalogPromise,catalogTime=0;
 function catalog(){
  if(!catalogPromise||Date.now()-catalogTime>60000){catalogTime=Date.now();catalogPromise=(async()=>{
   const env={...process.env};if(process.env.PANEL_CLAUDE_AUTH==='api'){if(!env.ANTHROPIC_API_KEY)throw Error('API-ключ Claude не настроен на сервере');delete env.CLAUDE_CODE_OAUTH_TOKEN;}else delete env.ANTHROPIC_API_KEY;
   const {stdout}=await runFile(bin(),['auth','status'],{env,timeout:10000,maxBuffer:65536});
   const auth=JSON.parse(stdout);if(!auth.loggedIn)throw Error('Выполните claude auth login на сервере');
   if(process.env.PANEL_CLAUDE_AUTH!=='api'&&!['claude.ai','oauth_token'].includes(auth.authMethod))throw Error('Для Claude требуется вход через подписку либо явная настройка API-ключа для панели');
   const output=await runFile(process.execPath,[worker(),'--catalog'],{timeout:30000,maxBuffer:1024*1024});
   const result=JSON.parse(output.stdout.trim());if(!result.models?.length)throw Error('Список моделей Claude недоступен');
   return {models:result.models.map((m,i)=>{const levels=m.supportedEffortLevels?.length?m.supportedEffortLevels:['default'];return {model:m.value,displayName:m.displayName,isDefault:i===0,defaultReasoningEffort:levels.includes('medium')?'medium':levels[0],supportedReasoningEfforts:levels.map(reasoningEffort=>({reasoningEffort}))};}),permissions};
  })();catalogPromise.catch(()=>{catalogPromise=null;});}
  return catalogPromise;
 }
 const sessions=claudeSessions();
 // Plan limits change slowly: one worker call per 5 minutes at most.
 let usagePromise,usageTime=0;
 function usage(){
  if(!usagePromise||Date.now()-usageTime>300000){usageTime=Date.now();usagePromise=runFile(process.execPath,[worker(),'--usage'],{timeout:30000,maxBuffer:65536}).then(o=>{const r=JSON.parse(o.stdout.trim().split('\n').at(-1));if(r.error)throw Error(r.error);return {...r,checked:new Date().toISOString()};});usagePromise.catch(()=>{usagePromise=null;});}
  return usagePromise;
 }
 return {id:'claude',name:'Claude Code',usage,vendor:'Anthropic',connection:'Локальный Claude Code через SDK',icon:'claude',path:bin,catalog,sessions,createRun:(task,cwd)=>new ClaudeRun(task,cwd)};
}
