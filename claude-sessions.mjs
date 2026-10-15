import {readdirSync,statSync,openSync,readSync,closeSync,realpathSync,readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
// Claude Code sessions started outside the panel: ~/.claude/projects/<folder>/<uuid>.jsonl.
// Files are only read here; continuing a session is done by the Claude worker with resume.
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Real process start time: /proc/<pid>/stat field 22 (clock ticks since boot) plus boot time. The /proc directory times are not start times.
let bootMs=null;
function processStart(pid){
 try{if(bootMs===null)bootMs=Number(readFileSync('/proc/stat','utf8').match(/^btime (\d+)/m)[1])*1000;
  const stat=readFileSync('/proc/'+pid+'/stat','utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');return bootMs+Number(fields[19])*10;}catch{return Date.now();}
}
export function claudeSessions(){
 const home=()=>process.env.CLAUDE_CONFIG_DIR||path.join(homedir(),'.claude');
 const cache=new Map();
 function chunk(file,start,length){
  const fd=openSync(file,'r');try{const buf=Buffer.alloc(length);const n=readSync(fd,buf,0,length,start);return buf.subarray(0,n).toString('utf8');}finally{closeSync(fd);}
 }
 function entries(text,partialStart){
  const lines=text.split('\n');if(partialStart)lines.shift();
  const out=[];for(const line of lines){if(!line.trim())continue;try{out.push(JSON.parse(line));}catch{}}return out;
 }
 // The line the panel types into a session when mail arrives is not what the session works on: never its name or topic.
 const panelLine=p=>/^Межпроектная связь панели:/.test(p);
 function promptText(d){
  // A message typed while the model works is stored as a queued command attachment, not as a user entry.
  const queued=d.type==='attachment'&&d.attachment?.type==='queued_command';
  if(!queued&&(d.type!=='user'||d.isMeta)||d.isSidechain)return '';
  const c=queued?d.attachment.prompt:d.message?.content;
  const text=typeof c==='string'?c:Array.isArray(c)?c.filter(x=>x.type==='text').map(x=>x.text).join('\n'):'';
  // Text injected by Claude Code or other sessions (tags, notifications, continuations) is not a user prompt.
  // Long text sent into a terminal session arrives as a paste: Claude Code wraps it in <pasted_content id=…>. It is the
  // owner's own message, so it is shown without the wrapper.
  const t=text.replace(/<pasted_content\b[^>]*>\n?([\s\S]*?)\n?<\/pasted_content\b[^>]*>/g,'$1').trim();return /^<[a-z][\w-]*[\s>/]/i.test(t)||/^(Another Claude session sent a message|This session is being continued from a previous conversation|\[Request interrupted)/.test(t)?'':t;
 }
 function meta(file){
  const st=statSync(file),key=file+':'+st.size+':'+st.mtimeMs;const hit=cache.get(file);if(hit?.key===key)return settle(hit);
  const head=entries(chunk(file,0,Math.min(st.size,65536)),false);
  const tailStart=Math.max(0,st.size-524288),tail=tailStart?entries(chunk(file,tailStart,st.size-tailStart),true):head;
  let cwd=null,sidechain=false,title='',lastPrompt='',updated=null;const cwds=new Set();
  let entrypoint='';
  // Remote Control writes bridge-session records: the session was a working one reachable from outside.
  const rc=[...head,...tail].some(d=>d.type==='bridge-session');
  for(const d of head){if(!cwd&&typeof d.cwd==='string')cwd=d.cwd;if(typeof d.cwd==='string')cwds.add(d.cwd);if(d.isSidechain)sidechain=true;if(!entrypoint&&d.type==='user'&&typeof d.entrypoint==='string')entrypoint=d.entrypoint;}
  for(const d of tail){if(typeof d.cwd==='string'){cwd=d.cwd;cwds.add(d.cwd);}if(!entrypoint&&d.type==='user'&&typeof d.entrypoint==='string')entrypoint=d.entrypoint;if(typeof d.customTitle==='string')title=d.customTitle;else if(!title&&typeof d.agentName==='string')title=d.agentName;const p=promptText(d);if(p&&!panelLine(p))lastPrompt=p;if(typeof d.timestamp==='string')updated=d.timestamp;}
  let firstPrompt='';for(const d of head){const p=promptText(d);if(p&&!panelLine(p)){firstPrompt=p;break;}}
  if(!lastPrompt)lastPrompt=firstPrompt;
  if(!title)title=(firstPrompt||lastPrompt).split('\n')[0];
  // Claude finds a session by the folder it was written under; a symlinked path keeps its own folder name.
  // The session may have moved into a subfolder later (cd): walk up its folders until one matches the file's folder name.
  const folder=path.basename(path.dirname(file)),enc=c=>c.replace(/[^a-zA-Z0-9]/g,'-');
  let runCwd=[...cwds].find(c=>enc(c)===folder);
  for(const c of cwds){if(runCwd)break;for(let d=c;d&&d!=='/';d=path.dirname(d))if(enc(d)===folder){runCwd=d;break;}}
  runCwd=runCwd||cwd;
  // A turn is open while the last prompt or model step comes after the last end-of-turn marker. A compaction is not a
  // step: Claude compacts idle sessions and writes the summary as a user entry.
  let lastStep=-1,lastEnd=-1;tail.forEach((d,i)=>{if(d.type==='system'&&['turn_duration','stop_hook_summary','compact_boundary'].includes(d.subtype)||d.type==='result')lastEnd=i;else if((d.type==='assistant'||d.type==='user')&&!d.isMeta&&!d.isSidechain&&!d.isCompactSummary&&!d.isVisibleInTranscriptOnly)lastStep=i;});
  // Some turns end without a marker: a final text-only answer counts as closed once the file has been quiet for 5 minutes.
  const tailStep=tail[lastStep],parts=Array.isArray(tailStep?.message?.content)?tailStep.message.content:[];
  // Also an input the model never picked up (a notification injected when the daemon restarts a session): no reply in 5 minutes.
  const quiet=tailStep?.type==='assistant'?!parts.some(x=>x.type==='tool_use'):tailStep?.type==='user'&&!parts.some(x=>x.type==='tool_result');
  const turnOpenRaw=lastStep>lastEnd;
  // Service sessions: started by programs (Agent SDK, claude -p) or small files without any prompt.
  const service=/^sdk-/.test(entrypoint)||(!lastPrompt&&st.size<65536);
  const value={id:path.basename(file,'.jsonl'),file,cwd,runCwd,sidechain,service,turnOpen:turnOpenRaw,rc,title:title.slice(0,150),lastPrompt:lastPrompt.slice(0,300),size:st.size,updated:updated||st.mtime.toISOString()};
  cache.set(file,{key,value,quiet,mtime:st.mtimeMs});return settle(cache.get(file));
 }
 const settle=hit=>hit.value.turnOpen&&hit.quiet&&Date.now()-hit.mtime>300000?{...hit.value,turnOpen:false}:hit.value;
 function files(){
  const out=[];let dirs=[];try{dirs=readdirSync(path.join(home(),'projects'));}catch{return out;}
  for(const dir of dirs){let names=[];try{names=readdirSync(path.join(home(),'projects',dir));}catch{continue;}
   for(const name of names)if(name.endsWith('.jsonl')&&uuid.test(name.slice(0,-6)))out.push(path.join(home(),'projects',dir,name));}
  return out;
 }
 // A session is live while some process (terminal, Remote Control) was started with its id.
 // A Remote Control server (claude remote-control without an id) hosts several sessions in one
 // process: sessions of its folder written after it started may be open there.
 let liveCache=null;
 // Lists share one /proc scan for 3 s; safety checks before a turn or a move always scan anew.
 function liveInfo(fresh=false){
  if(!fresh&&liveCache&&Date.now()-liveCache.time<3000)return liveCache.value;
  const ids=new Set(),servers=[],names=new Map();
  for(const pid of readdirSync('/proc')){if(!/^\d+$/.test(pid)||Number(pid)===process.pid)continue;
   let args;try{args=readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0');}catch{continue;}
   // Remote Control name: claude --remote-control NAME or remote-control --name NAME.
   const at=args.findIndex(a=>a==='--remote-control'||a==='--name'),name=at>=0&&args[at+1]&&!args[at+1].startsWith('-')?args[at+1]:'';
   // Only Claude processes hold a session. Other programs may carry the id in their command line or environment
   // (a dev server started from a session's shell): they must not keep a closed session "open".
   const claude=args.slice(0,3).some(a=>a&&!/\s/.test(a)&&path.basename(a).includes('claude'));
   let found=false;if(claude)for(const a of args){const m=a.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);if(m){ids.add(m[0]);if(name)names.set(m[0],name);found=true;}}
   // Remote Control hosts without a session id: the RC server, and the background workers it starts in a session folder (bg-spare).
   // Some workers rewrite argv into one string ("claude bg-spare"), so match the joined command line.
   const line=args.join(' ');
   if(!found&&/(^|\s)(--)?(remote-control|bg-spare)(\s|$)/.test(line)&&/^(\S*\/)?claude(\s|$)|\/claude\/versions\//.test(line)){try{servers.push({cwd:realpathSync('/proc/'+pid+'/cwd'),start:processStart(pid),spare:/(^|\s)bg-spare(\s|$)/.test(line)});}catch{}}}
  liveCache={time:Date.now(),value:{ids,servers,names}};return liveCache.value;
 }
 const liveIds=()=>liveInfo(true).ids;
 function isLive(m,info=liveInfo()){if(info.ids.has(m.id))return true;const cwd=real(m.cwd);return info.servers.some(s=>!s.spare&&s.cwd===cwd&&Date.parse(m.updated)>=s.start-60000);}
 // Safety checks (move, every turn of a moved session) are stricter: any background worker in the session folder counts.
 function guardLive(m,info){return isLive(m,info)||info.servers.some(s=>s.spare&&s.cwd===real(m.cwd));}
 // A background worker (bg-spare) holds the session of its folder even when it is idle: the newest working session there.
 function markSpares(items,info){for(const s of info.servers.filter(s=>s.spare)){const host=items.filter(x=>!x.service&&real(x.cwd)===s.cwd).sort((a,b)=>b.updated.localeCompare(a.updated))[0];if(host)host.live=true;}return items;}
 const real=p=>{try{return realpathSync(p);}catch{return null;}};
 // The same rule as markSpares for one session: a background worker holds only the newest working session of its folder.
 function spareHost(m,info){const cwd=real(m.cwd);if(m.service||!info.servers.some(s=>s.spare&&s.cwd===cwd))return false;
  for(const file of files()){let o;try{o=meta(file);}catch{continue;}if(o.id!==m.id&&!o.service&&!o.sidechain&&o.updated>m.updated&&real(o.cwd)===cwd)return false;}return true;}
 function list(projectCwd,others=[],{fresh=false}={}){
  const info=liveInfo(fresh),out=[];
  // Sessions in subfolders (git worktrees) belong to the closest registered project.
  const inside=(dir,root)=>dir===root||dir.startsWith(root.endsWith('/')?root:root+'/');
  for(const file of files()){let m;try{m=meta(file);}catch{continue;}
   const dir=m.cwd&&real(m.cwd);
   // projectCwd null: sessions outside every registered project (for example in the home folder).
   if(m.sidechain||!dir||(projectCwd===null?others.some(o=>inside(dir,o)):!inside(dir,projectCwd)||others.some(o=>o!==projectCwd&&inside(o,projectCwd)&&inside(dir,o))))continue;
   out.push({...m,folder:projectCwd===null?dir:dir===projectCwd?'':path.relative(projectCwd,dir),live:isLive(m,info),rcName:info.names.get(m.id)||''});}
  return markSpares(out,info).sort((a,b)=>b.updated.localeCompare(a.updated)).map(({file,sidechain,...m})=>m);
 }
 function find(id){if(!uuid.test(id))return null;for(const file of files())if(path.basename(file,'.jsonl')===id){try{return meta(file);}catch{return null;}}return null;}
 // Last messages of the conversation, read from the end of the file.
 // tools=true adds the model's steps (description or first line of the command) for the live view of an open session.
 // The last `limit` messages; tool steps do not count and only the latest few steps between two messages are kept,
 // so a long run of commands never pushes the owner's prompts out of view.
 function recent(items,limit){
  const out=[];let said=0,steps=0;
  for(let i=items.length-1;i>=0&&said<limit;i--){const x=items[i];
   if(x.role==='tool'){if(steps++<6)out.push(x);continue;}
   steps=0;said++;out.push(x);}
  return out.reverse();
 }
 // Background work the session started and that has not reported back: shell commands (run_in_background), agents
 // and monitors. Each launch result names its task id; the task-notification with that id (or TaskStop) ends it.
 function backgroundTasks(list){
  const uses=new Map(),tasks=new Map(),now=Date.now();
  const textOf=c=>typeof c==='string'?c:Array.isArray(c)?c.map(x=>typeof x?.text==='string'?x.text:typeof x?.content==='string'?x.content:'').join('\n'):'';
  for(const d of list){if(d.isSidechain)continue;const c=d.message?.content;
   if(d.type==='assistant'&&Array.isArray(c))for(const x of c){if(x.type!=='tool_use')continue;uses.set(x.id,x);if(x.name==='TaskStop'&&x.input?.task_id)tasks.delete(String(x.input.task_id));}
   if(d.type==='user'&&Array.isArray(c))for(const x of c){if(x.type!=='tool_result')continue;const u=uses.get(x.tool_use_id);if(!u)continue;const t=textOf(x.content);
    const id=t.match(/running in background with ID: (\w+)/)?.[1]||t.match(/^Monitor started \(task (\w+)/m)?.[1]||(/Async agent launched/.test(t)?t.match(/agentId: ?(\w+)/)?.[1]:null);if(!id)continue;
    const i=u.input||{},minutes=Number(t.match(/expires in (\d+)m/)?.[1]||0);
    tasks.set(id,{id,kind:u.name==='Agent'?'agent':u.name==='Monitor'?'monitor':'command',title:String(i.description||i.command||i.prompt||u.name).split('\n')[0].slice(0,140),started:d.timestamp,...(minutes?{expires:new Date(Date.parse(d.timestamp)+minutes*60000).toISOString()}:{})});}
   const note=d.type==='user'?textOf(c):d.type==='attachment'&&d.attachment?.type==='queued_command'?textOf(d.attachment.prompt):'';
   for(const n of note.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)){const id=n[1].match(/<task-id>(\w+)<\/task-id>/)?.[1];
    if(id&&(/<status>(completed|failed|killed|stopped|cancelled)<\/status>/.test(n[1])||/Monitor (expired|stream ended)|stream ended/.test(n[1])))tasks.delete(id);}
  }
  return [...tasks.values()].filter(t=>now-Date.parse(t.started)<86400000&&!(t.expires&&Date.parse(t.expires)<now));
 }
 function history(id,limit=40,{tools=false}={}){
  const m=find(id);if(!m)return null;
  const start=Math.max(0,m.size-4194304),items=[];
  const list=entries(chunk(m.file,start,m.size-start),start>0);
  for(const d of list){
   if(d.isSidechain)continue;
   const p=promptText(d);if(p){if(!items.slice(-6).some(x=>x.role==='user'&&x.text===p.slice(0,4000)))items.push({role:'user',text:p.slice(0,4000),time:d.timestamp});continue;}
   if(d.type==='assistant'&&Array.isArray(d.message?.content)){
    if(tools)for(const x of d.message.content)if(x.type==='tool_use'){const i=x.input||{},line=String(i.description||i.command||i.file_path||i.pattern||i.query||'').split('\n')[0].slice(0,160);items.push({role:'tool',text:(x.name==='Bash'?'':x.name+(line?' · ':''))+line,time:d.timestamp});}
    const text=d.message.content.filter(x=>x.type==='text').map(x=>x.text).join('\n').trim();if(!text)continue;
    const last=items.at(-1);if(last?.role==='assistant'&&last.message===d.message.id)last.text=(last.text+'\n'+text).slice(0,6000);
    else items.push({role:'assistant',text:text.slice(0,6000),time:d.timestamp,message:d.message.id});
   }
  }
  const live=(()=>{const info=liveInfo(true);return isLive(m,info)||spareHost(m,info);})();
  // Background work lives in the session's process: a closed session has none left.
  return {session:{id:m.id,title:m.title,cwd:m.cwd,size:m.size,updated:m.updated,turnOpen:m.turnOpen,live,background:live?backgroundTasks(list):[]},messages:recent(items,limit).map(({message,...x})=>x),truncated:items.filter(x=>x.role!=='tool').length>limit||start>0};
 }
 // live(id) guards each turn of a moved session; isLive(meta) also covers Remote Control servers.
 // Key sessions of the server, whatever folder they ran in: every session that was ever in Remote Control or is open now.
 function key({fresh=false}={}){
  const info=liveInfo(fresh),out=[];
  for(const file of files()){let m;try{m=meta(file);}catch{continue;}
   if(m.sidechain||m.service||!m.cwd)continue;const live=isLive(m,info);if(!m.rc&&!live)continue;
   const {file:_,sidechain,...x}=m;out.push({...x,live,rcName:info.names.get(m.id)||''});}
  return markSpares(out,info).sort((a,b)=>b.updated.localeCompare(a.updated));
 }
 return {key,list,find,history,live:id=>{const info=liveInfo(true);if(info.ids.has(id))return true;const m=find(id);return Boolean(m)&&guardLive(m,info);},isLive:m=>guardLive(m,liveInfo(true))};
}
