import {randomUUID} from 'node:crypto';

const active=['starting','running','stopping'];
export function projectMail({db,nodeId}){
 if(!db.prepare('PRAGMA table_info(projects)').all().some(c=>c.name==='mail_id'))db.exec('ALTER TABLE projects ADD COLUMN mail_id TEXT');
 // The session that takes mail sent to the whole project (an address host:claude-<uuid> or host:<chain>); null: the latest chat.
 if(!db.prepare('PRAGMA table_info(projects)').all().some(c=>c.name==='main_session'))db.exec('ALTER TABLE projects ADD COLUMN main_session TEXT');
 db.exec(`CREATE TABLE IF NOT EXISTS mail_projects(address TEXT PRIMARY KEY,host TEXT NOT NULL,project INTEGER,name TEXT,cwd TEXT,agent TEXT,status TEXT,last_task TEXT,updated TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS project_visibility(key TEXT PRIMARY KEY,hidden INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS mail_dispatch(message TEXT PRIMARY KEY,task TEXT,state TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,next_try TEXT,updated TEXT,error TEXT);
 CREATE INDEX IF NOT EXISTS mail_recipient ON agent_messages(recipient,created);`);
 for(const [column,type] of [['kind',"TEXT NOT NULL DEFAULT 'request'"],['root_id','TEXT'],['hop','INTEGER NOT NULL DEFAULT 0'],['deadline','TEXT'],['delivered_at','TEXT'],['answered_at','TEXT'],['sender_session','TEXT'],['sender_name','TEXT'],['recipient_name','TEXT']]){
  if(!db.prepare('PRAGMA table_info(agent_messages)').all().some(c=>c.name===column))db.exec(`ALTER TABLE agent_messages ADD COLUMN ${column} ${type}`);
 }
 function localProjects(){
  for(const p of db.prepare('SELECT id FROM projects WHERE mail_id IS NULL').all())db.prepare('UPDATE projects SET mail_id=? WHERE id=? AND mail_id IS NULL').run(randomUUID(),p.id);
  return db.prepare('SELECT * FROM projects').all().map(p=>{
   const t=db.prepare('SELECT * FROM tasks WHERE project=? ORDER BY created DESC,rowid DESC LIMIT 1').get(p.id);
   return {id:nodeId+':project-'+p.mail_id,host:nodeId,project:p.id,projectName:p.name,name:p.name,cwd:p.cwd,agent:t?.agent||null,status:t?.status||'unconfigured',lastTask:t?.id||null,autoReply:!!t?.thread};
  });
 }
 function remember(projects){const insert=db.prepare('INSERT INTO mail_projects VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET host=excluded.host,project=excluded.project,name=excluded.name,cwd=excluded.cwd,agent=excluded.agent,status=excluded.status,last_task=excluded.last_task,updated=excluded.updated');for(const p of projects)insert.run(p.id,p.host,p.project,p.projectName||p.name,p.cwd,p.agent??null,p.status??'unconfigured',p.lastTask??null,new Date().toISOString());}
 function cached(host){return db.prepare('SELECT * FROM mail_projects WHERE host=?').all(host).map(p=>({id:p.address,host:p.host,project:p.project,projectName:p.name,name:p.name,cwd:p.cwd,agent:p.agent,status:'offline',lastTask:p.last_task,autoReply:false}));}
 function address(project){return localProjects().find(p=>p.project===project)?.id;}
 function inbox(addresses){return db.prepare(`SELECT * FROM agent_messages WHERE recipient IN (${addresses.map(()=>'?').join(',')}) ORDER BY (read_at IS NOT NULL),created ASC LIMIT 50`).all(...addresses);}
 function journal(address){return db.prepare('SELECT * FROM agent_messages WHERE sender=? OR recipient=? ORDER BY created ASC,rowid ASC LIMIT 300').all(address,address);}
 return {localProjects,remember,cached,address,inbox,journal};
}

// The central panel owns durable dispatch records; node launches are idempotent. Every addressed message is dispatched:
// projects and panel chats are continued, terminal sessions are woken in their tmux pane.
export function mailDispatcher({db,deliver,info,send,now=()=>Date.now()}){
 let polling=false;
 const stamp=()=>new Date(now()).toISOString();
 async function tick(){
  if(polling)return;polling=true;
  try{
   const messages=db.prepare(`SELECT m.* FROM agent_messages m LEFT JOIN mail_dispatch d ON d.message=m.id WHERE m.recipient!='owner' AND (d.state IS NULL OR d.state IN ('queued','running')) AND (d.next_try IS NULL OR d.next_try<=?) ORDER BY m.created,m.rowid LIMIT 30`).all(stamp());
   for(const m of messages){
    let d=db.prepare('SELECT * FROM mail_dispatch WHERE message=?').get(m.id);
    if(!d){db.prepare('INSERT INTO mail_dispatch(message,state,updated) VALUES (?,\'queued\',?)').run(m.id,stamp());d={state:'queued',attempts:0};}
    if(d.state==='queued'&&db.prepare('SELECT id FROM agent_messages WHERE reply_to=? LIMIT 1').get(m.id)){db.prepare("UPDATE mail_dispatch SET state='completed',updated=?,error=NULL WHERE message=?").run(stamp(),m.id);continue;}
    // Replies and notes need no answer: once the recipient has read them, delivery is complete.
    if(d.state==='queued'&&m.kind!=='request'&&m.read_at){db.prepare("UPDATE mail_dispatch SET state='completed',updated=?,error=NULL WHERE message=?").run(stamp(),m.id);continue;}
    // Sessions often answer with a new message instead of replyTo: a message from the recipient to the sender after reading
    // counts, unless it is a reply to a different request.
    if(d.state==='queued'&&m.kind==='request'&&m.read_at&&db.prepare('SELECT id FROM agent_messages WHERE sender=? AND recipient=? AND created>? AND (reply_to IS NULL OR reply_to=?) LIMIT 1').get(m.recipient,m.sender,m.read_at,m.id)){db.prepare('UPDATE agent_messages SET answered_at=COALESCE(answered_at,?) WHERE id=?').run(stamp(),m.id);db.prepare("UPDATE mail_dispatch SET state='completed',updated=?,error=NULL WHERE message=?").run(stamp(),m.id);continue;}
    if(d.state==='queued'&&m.deadline&&Date.parse(m.deadline)<now()){db.prepare("UPDATE mail_dispatch SET state='expired',updated=?,error=? WHERE message=?").run(stamp(),'Истёк срок ожидания',m.id);continue;}
    try{
     if(d.state==='running'){
      const t=await info(m.recipient.split(':')[0],d.task);
      // Unknown task (node token rotated, task gone): retry with backoff, give up after 20 attempts or the deadline.
      if(!t){if((d.attempts||0)>=20||(m.deadline&&Date.parse(m.deadline)<now())){db.prepare("UPDATE mail_dispatch SET state='failed',updated=?,error=? WHERE message=?").run(stamp(),'Задача обработки недоступна',m.id);continue;}throw Error('Задача обработки недоступна');}
      if(active.includes(t.status))continue;
      if(t.status==='completed'){
       if(m.kind==='request'&&!db.prepare('SELECT id FROM agent_messages WHERE reply_to=? LIMIT 1').get(m.id)){
        const full=t.answer||'Агент завершил обработку без текстового ответа.';const answer=full.length>12000?full.slice(0,11850)+'\n\n[Ответ сокращён. Полный текст — в чате проекта получателя.]':full;
        await send(m.recipient,{recipient:m.sender,body:answer,requestKey:'auto-reply:'+m.id,replyTo:m.id,kind:'reply'});
       }
       db.prepare('UPDATE agent_messages SET read_at=COALESCE(read_at,?) WHERE id=?').run(stamp(),m.id);
       db.prepare("UPDATE mail_dispatch SET state='completed',updated=?,error=NULL WHERE message=?").run(stamp(),m.id);
      }else db.prepare("UPDATE mail_dispatch SET state='failed',updated=?,error=? WHERE message=?").run(stamp(),'Обработка завершилась: '+t.status,m.id);
      continue;
     }
     // Do not process two deliveries for a project concurrently, including a released model process.
     if(db.prepare("SELECT d.message FROM mail_dispatch d JOIN agent_messages m ON m.id=d.message WHERE m.recipient=? AND d.state='running' LIMIT 1").get(m.recipient))continue;
     const result=await deliver(m);
     if(result.wait){db.prepare('UPDATE mail_dispatch SET next_try=?,error=?,updated=? WHERE message=?').run(new Date(now()+10000).toISOString(),result.wait,stamp(),m.id);continue;}
     db.prepare("UPDATE mail_dispatch SET task=?,state='running',next_try=NULL,error=NULL,updated=? WHERE message=?").run(result.id,stamp(),m.id);
     db.prepare('UPDATE agent_messages SET delivered_at=COALESCE(delivered_at,?) WHERE id=?').run(stamp(),m.id);
    }catch{
     // A lost HTTP response may hide a successful launch. Retry the same message ID.
     db.prepare('UPDATE mail_dispatch SET attempts=attempts+1,next_try=?,error=?,updated=? WHERE message=?').run(new Date(now()+Math.min(60000,5000*2**Math.min(d.attempts,4))).toISOString(),'Нет связи с исполнителем; повторим доставку',stamp(),m.id);
    }
   }
  }finally{polling=false;}
 }
 return {tick};
}
