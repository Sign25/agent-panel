import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import http from 'node:http';
import {createHmac} from 'node:crypto';
import {tmpdir} from 'node:os';
import {federation} from '../federation.mjs';
import {mailDispatcher} from '../project-mail.mjs';

function fixture(){
 const db=new DatabaseSync(':memory:'),data=mkdtempSync(tmpdir()+'/panel-project-mail-');
 db.exec(`CREATE TABLE projects(id INTEGER PRIMARY KEY,name TEXT,cwd TEXT);
 CREATE TABLE tasks(id TEXT PRIMARY KEY,session_id TEXT,project INTEGER,status TEXT,agent TEXT,permissions TEXT,prompt TEXT,created TEXT,thread TEXT,mail_message TEXT);
 INSERT INTO projects VALUES(1,'Панель','/panel'),(2,'Сайт','/bro'),(3,'Без агента','/empty');
 INSERT INTO tasks VALUES('a','session-a',1,'running','codex','workspace','Work A','2026-01-01','thread-a',NULL),('b','session-b',2,'completed','claude','workspace','Work B','2026-01-01','thread-b',NULL);`);
 const mesh=federation({db,data,nodeId:'local',localInfo:{},origin:'https://panel.test'});
 return {db,mesh,cap:{host:'local',task:'a',signature:mesh.sign('a')},close(){db.close();rmSync(data,{recursive:true,force:true});}};
}
test('stable project addresses, task identity, scoped inbox, request-reply correlation and limits',async()=>{
 const f=fixture();try{
  const catalog=await f.mesh.tool(f.cap,'projects_list');assert.equal(catalog.projects.length,3);
  const [a,b]=catalog.projects;assert.equal(catalog.self,a.id);assert.equal(b.autoReply,true);assert.equal(catalog.projects[2].autoReply,false);
  f.db.prepare("UPDATE projects SET name='Новое имя',cwd='/new' WHERE id=1").run();assert.equal(f.mesh.mail.address(1),a.id);
  // A letter leaves from the writing session itself, so the answer comes back to that chat, not to the project.
  const m=await f.mesh.tool(f.cap,'message_send',{recipient:b.id,body:'Контракт API?',requestKey:'query'});assert.equal(m.sender,'local:session-a');
  assert.equal(f.db.prepare('SELECT sender_session,recipient_name FROM agent_messages WHERE id=?').get(m.id).recipient_name,'Сайт');
  // The directory lists sessions (not projects) with what they work on.
  f.db.prepare("UPDATE tasks SET created=? WHERE id='b'").run(new Date().toISOString());
  const dir=await f.mesh.tool(f.cap,'sessions_list');assert.equal(dir.self,'local:session-a');assert.equal(dir.selfName,'Панель');assert.ok(dir.sessions.some(x=>x.address==='local:session-b'&&x.name==='Сайт'&&x.topic==='Work B'));assert.match(dir.rule,/конкретной сессии/);assert.equal(m.kind,'request');assert.equal(m.root_id,m.id);
  assert.equal((await f.mesh.tool(f.cap,'message_send',{recipient:b.id,body:'Контракт API?',requestKey:'query'})).id,m.id);
  f.db.prepare("UPDATE tasks SET status='running',mail_message=? WHERE id='b'").run(m.id);
  const capB={host:'local',task:'b',signature:f.mesh.sign('b')};assert.equal((await f.mesh.tool(capB,'inbox_read'))[0].id,m.id);
  await f.mesh.tool(f.cap,'message_ack',{ids:[m.id]});assert.equal(f.db.prepare('SELECT read_at FROM agent_messages WHERE id=?').get(m.id).read_at,null);
  const reply=await f.mesh.tool(capB,'message_send',{recipient:m.sender,body:'JSON v2',requestKey:'response',replyTo:m.id});assert.equal(reply.sender,b.id);assert.equal(reply.kind,'reply');assert.equal(reply.root_id,m.id);assert.ok(f.db.prepare('SELECT answered_at FROM agent_messages WHERE id=?').get(m.id).answered_at);
  assert.equal((await f.mesh.tool(f.cap,'inbox_read'))[0].body,'JSON v2');
  await assert.rejects(f.mesh.tool(f.cap,'message_send',{recipient:b.id,body:'Forged reply',requestKey:'forged',replyTo:m.id}),/соответствует/);
  f.db.prepare('UPDATE agent_messages SET hop=8 WHERE id=?').run(m.id);
  await assert.rejects(f.mesh.tool(capB,'message_send',{recipient:a.id,body:'Loop',requestKey:'loop'}),/переходов/);
 }finally{f.close();}
});

test('durable dispatcher resumes once, queues busy projects, returns final response and avoids reply loops',async()=>{
 const f=fixture();try{
  const [a,b]=f.mesh.mail.localProjects();let time=Date.now(),busy=true,complete=false,launches=0;
  const m=await f.mesh.send(a.id,{recipient:b.id,body:'Вопрос',requestKey:'q'});
  const opts={db:f.db,send:f.mesh.send,now:()=>time,deliver:async message=>{if(busy)return {wait:'Занят'};launches++;return {id:'delivery-'+message.id};},info:async()=>({status:complete?'completed':'running',answer:'Ответ получателя'})};
  const dispatcher=mailDispatcher(opts);await dispatcher.tick();assert.equal(launches,0);assert.equal(f.db.prepare('SELECT state FROM mail_dispatch').get().state,'queued');
  busy=false;time+=11000;await dispatcher.tick();await dispatcher.tick();assert.equal(launches,1);assert.ok(f.db.prepare('SELECT delivered_at FROM agent_messages WHERE id=?').get(m.id).delivered_at);
  complete=true;await mailDispatcher(opts).tick();const reply=f.db.prepare('SELECT * FROM agent_messages WHERE reply_to=?').get(m.id);assert.equal(reply.body,'Ответ получателя');assert.equal(reply.recipient,a.id);
  await dispatcher.tick();await dispatcher.tick();assert.equal(launches,2);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM agent_messages').get().n,2);assert.equal(f.db.prepare('SELECT state FROM mail_dispatch WHERE message=?').get(reply.id).state,'completed');
  const expired=await f.mesh.send(a.id,{recipient:b.id,body:'Late',requestKey:'late'});f.db.prepare('UPDATE agent_messages SET deadline=? WHERE id=?').run(new Date(time-1000).toISOString(),expired.id);await dispatcher.tick();assert.equal(f.db.prepare('SELECT state FROM mail_dispatch WHERE message=?').get(expired.id).state,'expired');
 }finally{f.close();}
});

test('mail to a panel chat or a terminal session is dispatched too, not only project mail',async()=>{
 const f=fixture();try{
  const [a]=f.mesh.mail.localProjects();const delivered=[];
  const m=await f.mesh.send(a.id,{recipient:'local:session-b',body:'Лично чату',requestKey:'chat'});
  f.db.prepare("INSERT INTO agent_messages(id,sender,recipient,body,created,request_key) VALUES ('o','owner','owner','x',?,'o')").run(new Date().toISOString());
  const dispatcher=mailDispatcher({db:f.db,send:f.mesh.send,deliver:async message=>{delivered.push(message.recipient);return {id:'chat-turn'};},info:async()=>({status:'running'})});
  await dispatcher.tick();assert.deepEqual(delivered,['local:session-b']);assert.ok(f.db.prepare('SELECT delivered_at FROM agent_messages WHERE id=?').get(m.id).delivered_at);
 }finally{f.close();}
});

test('lost launch response retries same request, and failed processing does not create an answer',async()=>{
 const f=fixture();try{
  const [a,b]=f.mesh.mail.localProjects();const m=await f.mesh.send(a.id,{recipient:b.id,body:'Q',requestKey:'q'});let time=Date.now(),count=0;const keys=[];
  const dispatcher=mailDispatcher({db:f.db,now:()=>time,send:f.mesh.send,deliver:async message=>{keys.push(message.id);if(++count===1)throw Error('response lost');return {id:'same-task'};},info:async()=>({status:'failed'})});
  await dispatcher.tick();assert.equal(f.db.prepare('SELECT state FROM mail_dispatch').get().state,'queued');time+=6000;await dispatcher.tick();await dispatcher.tick();assert.deepEqual(keys,[m.id,m.id]);assert.equal(f.db.prepare('SELECT state FROM mail_dispatch').get().state,'failed');assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM agent_messages').get().n,1);
 }finally{f.close();}
});

test('remote project catalog stays addressable offline and signed remote actors use their project mailbox',async()=>{
 const f=fixture();let online=true;
 const project={id:'dev:project-stable',host:'dev',project:7,projectName:'Remote',cwd:'/remote',agent:'claude',status:'completed',lastTask:'remote-task'};
 const server=http.createServer((req,res)=>{
  assert.equal(req.headers['x-panel-node-token'],'fixture-key');res.setHeader('Content-Type','application/json');
  if(!online){res.writeHead(503);res.end('{}');return;}
  res.end(JSON.stringify(req.url.startsWith('/api/task-info')?{id:'remote-task',project:7,session_id:'new-native-session',status:'running',permissions:'workspace'}:[project]));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const data=mkdtempSync(tmpdir()+'/panel-remote-catalog-');
  try{
   writeFileSync(data+'/key','fixture-key');writeFileSync(data+'/nodes.json',JSON.stringify([{id:'dev',name:'dev',tokenFile:data+'/key',endpoint:'http://127.0.0.1:'+server.address().port}]));
   const mesh=federation({db:f.db,data,nodeId:'local',localInfo:{},origin:'https://panel.test'});
   const cap={host:'local',task:'a',signature:mesh.sign('a')};
   const directory=await mesh.tool(cap,'projects_list');assert.equal(directory.projects.length,4);
   online=false;const offline=await mesh.projectsDirectory();assert.equal(offline.projects.find(p=>p.host==='dev').status,'offline');
   const queued=await mesh.tool(cap,'message_send',{recipient:project.id,body:'Offline first message',requestKey:'offline-first'});assert.equal(queued.recipient,project.id);
   online=true;const remoteCap={host:'dev',task:'remote-task',signature:createHmac('sha256','fixture-key').update('remote-task').digest('hex')};
   const inbox=await mesh.tool(remoteCap,'inbox_read');assert.equal(inbox[0].id,queued.id);
   const answer=await mesh.tool(remoteCap,'message_send',{recipient:queued.sender,body:'Remote answer',requestKey:'answer',replyTo:queued.id});assert.equal(answer.sender,project.id);
  }finally{rmSync(data,{recursive:true,force:true});}
 }finally{await new Promise(r=>server.close(r));f.close();}
});
