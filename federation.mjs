import {projectMail} from './project-mail.mjs';
import {externalSessions} from './external-sessions.mjs';
import {readFileSync,existsSync,writeFileSync} from 'node:fs';
import {createHmac,randomBytes,timingSafeEqual,randomUUID} from 'node:crypto';
import path from 'node:path';
export function secureEqual(a,b){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);}
export function federation({db,data,nodeId,localInfo,origin,live=()=>true,topicOf=()=>''}){
 const tokenPath=path.join(data,'node-token');if(!existsSync(tokenPath))writeFileSync(tokenPath,randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});
 const secret=readFileSync(tokenPath,'utf8').trim();
 function nodes(){return existsSync(path.join(data,'nodes.json'))?JSON.parse(readFileSync(path.join(data,'nodes.json'),'utf8')):[];}
 const external=externalSessions(db,nodeId);
 const sign=task=>createHmac('sha256',secret).update(task).digest('hex');
 db.exec(`CREATE TABLE IF NOT EXISTS agent_messages(id TEXT PRIMARY KEY,sender TEXT NOT NULL,recipient TEXT NOT NULL,body TEXT NOT NULL,created TEXT NOT NULL,read_at TEXT,request_key TEXT NOT NULL,reply_to TEXT,UNIQUE(sender,request_key));`);
 const mail=projectMail({db,nodeId});
 // Every addressable session of this server: terminal sessions (host:claude-<uuid>) and panel chats (host:<chain>).
 // name, topic, updated and open describe it for the other agents, so they can write to the session that does the work.
 function localSessions(){
  const projectOf=cwd=>db.prepare('SELECT id,name FROM projects WHERE cwd=?').get(cwd);
  const recent=Date.now()-7*86400000;
  const terminal=db.prepare('SELECT * FROM external_sessions ORDER BY seen DESC').all().map(s=>{const p=projectOf(s.cwd);
   // What the session works on: its latest prompt (only for recent sessions; reading old session files is not worth it).
   let topic='';if(Date.parse(s.seen)>recent){try{topic=String(topicOf(s.id.replace(/^claude-/,''))||'').split('\n')[0].slice(0,100);}catch{}}
   return {id:nodeId+':'+s.id,host:nodeId,project:p?.id??null,projectName:p?.name||s.name,cwd:s.cwd,agent:'claude',title:s.name,name:s.name,topic,updated:s.seen,open:live(s.id.replace(/^claude-/,'')),kind:'terminal',status:'external',source:'claude-external'};});
  const chats=db.prepare(`SELECT t.*,p.name AS project_name,p.cwd FROM tasks t JOIN projects p ON p.id=t.project WHERE t.id=(SELECT t2.id FROM tasks t2 WHERE t2.session_id=t.session_id ORDER BY t2.created DESC,t2.rowid DESC LIMIT 1) ORDER BY t.created DESC LIMIT 300`).all().map(t=>{
   let root=null;try{root=db.prepare('SELECT source_session,prompt,fork FROM tasks WHERE session_id=? AND source_session IS NOT NULL ORDER BY created LIMIT 1').get(t.session_id);}catch{}
   const original=root?.source_session&&db.prepare('SELECT name FROM external_sessions WHERE id=?').get('claude-'+root.source_session)?.name;
   // A copy of a terminal session the panel does not know by name is simply the project's chat.
   const base=root&&original?original:t.project_name;
   let own=null;try{own=db.prepare("SELECT title FROM session_titles WHERE agent='chat' AND id=?").get(t.session_id)?.title;}catch{}
   const name=own||(root&&Number(root.fork)===1&&original?base+' (копия в панели)':base);
   const named=Boolean(own);
   // What the chat was started with: an unnamed chat is titled by it, as in the Claude app.
   let first='';try{first=String(db.prepare('SELECT prompt FROM tasks WHERE session_id=? AND mail_message IS NULL ORDER BY created,rowid LIMIT 1').get(t.session_id)?.prompt||'').replace(/^Сессия из терминала:\s*/,'').split('\n')[0].slice(0,80);}catch{}
   const topic=t.mail_message?'письмо от другой сессии':String(t.prompt||'').split('\n')[0].slice(0,100);
   return {id:nodeId+':'+t.session_id,host:nodeId,project:t.project,projectName:t.project_name,cwd:t.cwd,agent:t.agent||'codex',title:t.prompt.slice(0,100),name,named,first,topic,updated:t.created,open:['starting','running','stopping'].includes(t.status),kind:'panel',status:t.status,lastTask:t.id};});
  return [...terminal,...chats];
 }
 // The sessions worth writing to: open now or active in the last 7 days, newest first.
 async function contacts(){const d=await directory();const since=Date.now()-7*86400000;
  return {sessions:d.sessions.filter(s=>s.name&&(s.open||Date.parse(s.updated||0)>since)).sort((a,b)=>Number(b.open)-Number(a.open)||String(b.updated).localeCompare(String(a.updated))).slice(0,40)
   .map(s=>({address:s.id,name:s.name,server:nodes().find(n=>n.id===s.host)?.name||(s.host===nodeId?localInfo?.name||s.host:s.host),project:s.projectName||null,topic:s.topic||'',updated:s.updated||null,open:Boolean(s.open),kind:s.kind||null})),errors:d.errors};}
 async function remote(node,resource,{method='GET',body,headers={}}={}){
  if(!/^(settings|projects|tasks|events|stop|approval|git|uploads|node-info|session-directory|project-directory|mail-deliver|task-info|agents|project-map|claude-sessions|claude-sessions\/attach|claude-sessions\/history|agent-sessions|agent-sessions\/attach|agent-sessions\/history|agent-sessions\/summary|agent-sessions\/active|agent-sessions\/title|agent-sessions\/key|agent-sessions\/open|agent-sessions\/say|agent-sessions\/answer|tasks\/inject|tasks\/transcript|projects\/main|files\/image|chats\/new|chats\/title|claude-usage)(\?|$)/.test(resource))throw Error('Недоступный маршрут узла');
  const key=readFileSync(node.tokenFile,'utf8').trim();
  return fetch(node.endpoint+'/api/'+resource,{method,headers:{origin,'X-Panel-Node-Token':key,...headers},body,signal:AbortSignal.timeout(resource.startsWith('settings')?45000:/^(project-directory|task-info|mail-deliver)/.test(resource)?5000:30000)});
 }
 async function directory(){const results=await Promise.all(nodes().map(async n=>{try{const res=await remote(n,'session-directory');if(!res.ok)throw Error('HTTP '+res.status);return {sessions:await res.json()};}catch{return {sessions:[],error:{host:n.id,name:n.name,error:'Нет связи с узлом'}};}}));return {sessions:[...localSessions(),...results.flatMap(x=>x.sessions)],errors:results.filter(x=>x.error).map(x=>x.error)};}
 async function projectsDirectory(){mail.remember(mail.localProjects());const results=await Promise.all(nodes().map(async n=>{try{const res=await remote(n,'project-directory');if(!res.ok)throw Error();const projects=await res.json();mail.remember(projects);return {projects};}catch{return {projects:mail.cached(n.id),error:{host:n.id,name:n.name,error:'Нет связи с узлом'}};}}));return {projects:[...mail.localProjects(),...results.flatMap(x=>x.projects)],errors:results.filter(x=>x.error).map(x=>x.error)};}
 async function taskInfo(host,id){
  if(host===nodeId&&id.startsWith('claude-')){const t=external.info(id),s=db.prepare('SELECT cwd FROM external_sessions WHERE id=?').get(id);return t&&{...t,project:db.prepare('SELECT id FROM projects WHERE cwd=?').get(s.cwd)?.id};}
  if(host===nodeId){
   const t=db.prepare('SELECT * FROM tasks WHERE id=?').get(id);if(!t)return null;
   let answer='';
   if(t.status==='completed'&&db.prepare("SELECT name FROM sqlite_master WHERE name='events'").get()){
    const events=db.prepare('SELECT body FROM events WHERE task=? ORDER BY id').all(id).map(row=>{try{return JSON.parse(row.body);}catch{return {};}});
    const answers=events.filter(e=>e.method==='item/completed'&&e.params?.item?.type==='agentMessage');
    const final=answers.filter(e=>e.params.item.phase==='final_answer').at(-1)||answers.at(-1);answer=final?.params.item.text||'';
    if(!answer){const chunks=new Map();for(const e of events)if(e.method==='item/agentMessage/delta')chunks.set(e.params.itemId,(chunks.get(e.params.itemId)||'')+e.params.delta);answer=[...chunks.values()].at(-1)||'';}
   }
   // A panel chat forked from a terminal session that is registered here is a copy: the original keeps the project mailbox.
   let root=null;try{root=db.prepare('SELECT source_session,fork FROM tasks WHERE session_id=? AND source_session IS NOT NULL ORDER BY created LIMIT 1').get(t.session_id||t.id);}catch{} // older schemas have no session columns
   // Once the original is closed, the copy is the only one left: it takes the project mailbox back.
   const original=root&&Number(root.fork)===1&&db.prepare('SELECT name FROM external_sessions WHERE id=?').get('claude-'+root.source_session);
   if(original&&!live(root.source_session))return {...t,answer,copyOf:null};
   return {...t,answer,copyOf:original?original.name:null};
  }
  const node=nodes().find(n=>n.id===host);if(!node)return null;const res=await remote(node,'task-info?id='+encodeURIComponent(id));return res.ok?res.json():null;
 }
 async function actor(cap){
  const {host,task,signature}=cap||{};if(typeof host!=='string'||typeof task!=='string'||typeof signature!=='string')throw Error('Недопустимый адрес сессии');
  const node=nodes().find(n=>n.id===host);const key=host===nodeId?secret:node&&readFileSync(node.tokenFile,'utf8').trim();
  if(!key||!secureEqual(signature,createHmac('sha256',key).update(task).digest('hex')))throw Error('Недопустимый доступ сессии');
  const info=await taskInfo(host,task);if(!info||!['starting','running','stopping'].includes(info.status))throw Error('Сессия сейчас не выполняется');
  let projectAddress;if(info.project!=null){if(host===nodeId)projectAddress=mail.address(info.project);else {projectAddress=db.prepare('SELECT address FROM mail_projects WHERE host=? AND project=?').get(host,info.project)?.address;if(!projectAddress){await projectsDirectory();projectAddress=db.prepare('SELECT address FROM mail_projects WHERE host=? AND project=?').get(host,info.project)?.address;}}}// The writer's own name: a terminal session's name, otherwise the project's.
  if(info.copyOf)projectAddress=null;
  const name=info.copyOf?info.copyOf+' (копия в панели)':info.name||(projectAddress&&(db.prepare('SELECT name FROM mail_projects WHERE address=?').get(projectAddress)?.name||mail.localProjects().find(p=>p.id===projectAddress)?.name))||null;
  return {id:host+':'+info.session_id,name,projectAddress,mailMessage:info.mail_message,readOnly:info.permissions==='read-only'};
 }
 async function send(sender,args){
  const {recipient,body,requestKey,replyTo=null}=args;
  if(typeof body!=='string'||!body.trim()||body.length>12000||typeof requestKey!=='string'||!requestKey||requestKey.length>128)throw Error('Сообщение до 12000 символов и ключ запроса обязательны');
  if(typeof recipient!=='string'||recipient===sender)throw Error('Укажите другую сессию');
  const old=db.prepare('SELECT * FROM agent_messages WHERE sender=? AND request_key=?').get(sender,requestKey);
  if(old){if(old.recipient!==recipient||old.body!==body.trim()||old.reply_to!==replyTo)throw Error('Ключ уже использован для другого сообщения');return old;}
  const host=recipient.split(':')[0],id=recipient.slice(host.length+1);
  let found;if(recipient==='owner'&&replyTo){const parent=db.prepare('SELECT * FROM agent_messages WHERE id=?').get(replyTo);found=parent?.sender==='owner'&&parent?.recipient===sender;}else if(id.startsWith('project-')){found=host===nodeId?mail.localProjects().some(p=>p.id===recipient):db.prepare('SELECT address FROM mail_projects WHERE address=?').get(recipient);if(!found){await projectsDirectory();found=db.prepare('SELECT address FROM mail_projects WHERE address=?').get(recipient);}}else if(host===nodeId)found=localSessions().some(s=>s.id===recipient);else{
   const node=nodes().find(n=>n.id===host);if(!node)throw Error('Сервер не зарегистрирован');
   // Persist recipients seen in previous messages; queue remains usable while the node is offline.
   found=db.prepare('SELECT id FROM agent_messages WHERE recipient=? OR sender=? LIMIT 1').get(recipient,recipient);
   if(!found){const res=await remote(node,'session-directory');if(!res.ok)throw Error('Не удалось проверить адресата');found=(await res.json()).some(s=>s.id===recipient);}
  }
  if((!id&&recipient!=='owner')||!found)throw Error('Сессия адресата не найдена');
  if(replyTo){const parent=db.prepare('SELECT * FROM agent_messages WHERE id=?').get(replyTo);if(!parent||parent.recipient!==sender||parent.sender!==recipient)throw Error('Ответ не соответствует исходному сообщению');}
  if(db.prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE recipient=? AND read_at IS NULL').get(recipient).n>=200)throw Error('Очередь адресата заполнена');
  const inherited=replyTo?db.prepare('SELECT * FROM agent_messages WHERE id=?').get(replyTo):args.sourceMessage?db.prepare('SELECT * FROM agent_messages WHERE id=?').get(args.sourceMessage):null;
  const hop=inherited?(inherited.hop||0)+1:0;if(hop>8)throw Error('Достигнут предел межпроектных переходов');const kind=replyTo?'reply':args.kind==='note'?'note':'request';
  if(inherited?.root_id&&db.prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE root_id=?').get(inherited.root_id).n>=16)throw Error('Достигнут предел сообщений одного запроса');
  const message={id:randomUUID(),sender,recipient,body:body.trim(),created:new Date().toISOString(),request_key:requestKey,reply_to:replyTo};
  db.prepare('INSERT OR IGNORE INTO agent_messages(id,sender,recipient,body,created,request_key,reply_to) VALUES (?,?,?,?,?,?,?)').run(message.id,sender,recipient,message.body,message.created,requestKey,replyTo);
  const saved=db.prepare('SELECT * FROM agent_messages WHERE sender=? AND request_key=?').get(sender,requestKey);
  if(saved.recipient!==recipient||saved.body!==body.trim()||saved.reply_to!==replyTo)throw Error('Ключ уже использован для другого сообщения');
  db.prepare('UPDATE agent_messages SET kind=?,root_id=?,hop=?,deadline=? WHERE id=?').run(kind,inherited?.root_id||inherited?.id||saved.id,hop,inherited?.deadline||new Date(Date.now()+86400000).toISOString(),saved.id);
  if(replyTo)db.prepare('UPDATE agent_messages SET answered_at=COALESCE(answered_at,?) WHERE id=?').run(new Date().toISOString(),replyTo);
  return db.prepare('SELECT * FROM agent_messages WHERE id=?').get(saved.id);
 }
 async function tool(cap,name,args={}){
  const from=await actor(cap);
  if(name==='sessions_list'){const c=await contacts();return {...c,self:from.id,selfName:from.name,projectAddress:from.projectAddress,rule:'Пишите конкретной сессии по её address. Адрес проекта — только если не знаете, какая сессия занимается вопросом: письмо получит основная сессия проекта.'};}
  if(name==='projects_list'){const catalog=await projectsDirectory();return {...catalog,self:from.projectAddress||from.id,selfName:from.name,selfSession:from.id};}
  if(name==='inbox_read')return mail.inbox([from.id,...(from.projectAddress?[from.projectAddress]:[])]);
  if(name==='message_ack'){
   if(!Array.isArray(args.ids)||args.ids.length>50)throw Error('Некорректный список сообщений');
   for(const address of [from.id,from.projectAddress].filter(Boolean))for(const id of args.ids)db.prepare('UPDATE agent_messages SET read_at=COALESCE(read_at,?) WHERE id=? AND recipient=?').run(new Date().toISOString(),id,address);
   return {ok:true};
  }
  if(name==='message_send'){if(from.readOnly)throw Error('Отправка недоступна в режиме только чтения');const parent=args.replyTo&&db.prepare('SELECT * FROM agent_messages WHERE id=?').get(args.replyTo);const sender=parent&&[from.id,from.projectAddress].includes(parent.recipient)?parent.recipient:from.id;// Remember which terminal session wrote it, so a reply can wake that session and not another one in the same folder.
 const sent=await send(sender,{...args,sourceMessage:from.mailMessage});if(sent?.id){db.prepare('UPDATE agent_messages SET sender_session=COALESCE(sender_session,?) WHERE id=?').run(from.id,sent.id);
 const to=(await contacts().catch(()=>({sessions:[]}))).sessions.find(c=>c.address===sent.recipient)?.name||db.prepare('SELECT name FROM mail_projects WHERE address=?').get(sent.recipient)?.name||(sent.recipient.startsWith(nodeId+':project-')?mail.localProjects().find(p=>p.id===sent.recipient)?.name:null);
 if(to)db.prepare('UPDATE agent_messages SET recipient_name=COALESCE(recipient_name,?) WHERE id=?').run(String(to).slice(0,100),sent.id);if(from.name)db.prepare('UPDATE agent_messages SET sender_name=COALESCE(sender_name,?) WHERE id=?').run(String(from.name).slice(0,100),sent.id);}return sent;}
  throw Error('Неизвестный инструмент');
 }
 return {mail,projectsDirectory,external,secret,sign,nodes,remote,directory,contacts,tool,send,localSessions,localInfo,taskInfo};
}
