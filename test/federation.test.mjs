import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import http from 'node:http';
import {createHmac} from 'node:crypto';
import {federation} from '../federation.mjs';
test('cross-node session addressing, authenticated mail, deduplication and outage persistence',async()=>{
 const data=mkdtempSync(tmpdir()+'/panel-mesh-');const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE projects(id INTEGER PRIMARY KEY,name TEXT,cwd TEXT);CREATE TABLE tasks(id TEXT PRIMARY KEY,session_id TEXT,project INTEGER,status TEXT,agent TEXT,permissions TEXT,prompt TEXT,created TEXT);INSERT INTO projects VALUES(1,'local project','/workspace');INSERT INTO tasks VALUES('local-task','local-session',1,'running','codex','workspace','Local task','2026-01-01');`);
 let online=true;
 const remoteSession={id:'dev:remote-session',host:'dev',project:1,projectName:'dev project',agent:'claude',status:'running',title:'Remote task'};
 const server=http.createServer((req,res)=>{if(!online){res.writeHead(503);res.end('{}');return;}assert.equal(req.headers['x-panel-node-token'],'test-remote-secret');res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.startsWith('/api/task-info')?{id:'remote-task',session_id:'remote-session',status:'running',permissions:'workspace'}:[remoteSession]));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 writeFileSync(data+'/remote-token','test-remote-secret');writeFileSync(data+'/nodes.json',JSON.stringify([{id:'dev',name:'dev',tokenFile:data+'/remote-token',endpoint:'http://127.0.0.1:'+server.address().port}]));
 const mesh=federation({db,data,nodeId:'local',localInfo:{},origin:'https://panel.test'});
 const cap={host:'local',task:'local-task',signature:mesh.sign('local-task')};
 try{
  assert.equal((await mesh.directory()).sessions.length,2);
  await assert.rejects(mesh.tool({...cap,signature:'fake'},'sessions_list'),/доступ/);
  const msg=await mesh.tool(cap,'message_send',{recipient:'dev:remote-session',body:'Hello dev',requestKey:'stable-request'});
  assert.equal(msg.sender,'local:local-session');
  assert.equal((await mesh.tool(cap,'message_send',{recipient:'dev:remote-session',body:'Hello dev',requestKey:'stable-request'})).id,msg.id);
  await assert.rejects(mesh.tool(cap,'message_send',{recipient:'dev:remote-session',body:'Different',requestKey:'stable-request'}),/другого/);
  const remoteCap={host:'dev',task:'remote-task',signature:createHmac('sha256','test-remote-secret').update('remote-task').digest('hex')};
  const inbox=await mesh.tool(remoteCap,'inbox_read');assert.equal(inbox.length,1);assert.equal(inbox[0].read_at,null);
  await mesh.tool(cap,'message_ack',{ids:[msg.id]});assert.equal(db.prepare('SELECT read_at FROM agent_messages').get().read_at,null);
  await mesh.tool(remoteCap,'message_ack',{ids:[msg.id]});assert.ok(db.prepare('SELECT read_at FROM agent_messages').get().read_at);
  const reply=await mesh.tool(remoteCap,'message_send',{recipient:'local:local-session',body:'Reply',requestKey:'reply',replyTo:msg.id});assert.equal(reply.reply_to,msg.id);
  assert.equal((await mesh.tool(cap,'inbox_read'))[0].body,'Reply');
  db.prepare("UPDATE tasks SET permissions='read-only'").run();await assert.rejects(mesh.tool(cap,'message_send',{recipient:'dev:remote-session',body:'Blocked',requestKey:'blocked'}),/чтения/);
  db.prepare("UPDATE tasks SET permissions='workspace'").run();online=false;
  const queued=await mesh.tool(cap,'message_send',{recipient:'dev:remote-session',body:'Wait for connection',requestKey:'offline'});assert.ok(queued.id);
  assert.equal((await mesh.directory()).errors[0].host,'dev');
  const restarted=federation({db,data,nodeId:'local',localInfo:{},origin:'https://panel.test'});assert.equal(restarted.sign('local-task'),cap.signature);
  online=true;assert.equal((await restarted.tool(remoteCap,'inbox_read')).length,2);
  const broker=http.createServer(async(req,res)=>{try{let raw='';for await(const chunk of req)raw+=chunk;const b=JSON.parse(raw);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await mesh.tool(b.cap,b.name,b.args)));}catch(e){res.writeHead(400);res.end(JSON.stringify({error:e.message}));}});
  await new Promise(r=>broker.listen(0,'127.0.0.1',r));
  const client=new Client({name:'bridge-test',version:'1.0.0'});
  try{
   await client.connect(new StdioClientTransport({command:process.execPath,args:[new URL('../mail-mcp.mjs',import.meta.url).pathname],env:{PANEL_MAIL_URL:'http://127.0.0.1:'+broker.address().port,PANEL_MAIL_CAP:JSON.stringify(cap)}}));
   assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),['inbox_read','message_ack','message_send','projects_list','sessions_list']);
   const result=await client.callTool({name:'inbox_read',arguments:{}});assert.equal(result.isError,false);assert.equal(JSON.parse(result.content[0].text)[0].body,'Reply');
   const sent=await client.callTool({name:'message_send',arguments:{recipient:'dev:remote-session',body:'Through stdio',requestKey:'stdio'}});assert.equal(sent.isError,false);assert.equal(JSON.parse(sent.content[0].text).sender,'local:local-session');
  }finally{await client.close();await new Promise(r=>broker.close(r));}
  db.prepare("UPDATE tasks SET status='completed'").run();await assert.rejects(mesh.tool(cap,'inbox_read'),/не выполняется/);
 }finally{await new Promise(r=>server.close(r));db.close();rmSync(data,{recursive:true,force:true});}
});
