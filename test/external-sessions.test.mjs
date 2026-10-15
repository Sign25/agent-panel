import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {federation} from '../federation.mjs';
test('external Claude sessions retain distinct addresses in the same directory and permissions across commands',async()=>{
 const data=mkdtempSync(tmpdir()+'/panel-external-'),db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE projects(id INTEGER,name TEXT,cwd TEXT);CREATE TABLE tasks(id TEXT,session_id TEXT,project INTEGER,created TEXT)');
 const mesh=federation({db,data,nodeId:'dev',localInfo:{},origin:'https://panel.test'});
 try{
 const one=mesh.external.register({session_id:'11111111-aaaa',cwd:data,session_title:'Project one',permission_mode:'default'});
 const two=mesh.external.register({session_id:'22222222-bbbb',cwd:data,session_title:'Project two',permission_mode:'plan'});
 assert.notEqual(one,two);assert.equal(mesh.localSessions().length,2);
 const cap=id=>({host:'dev',task:id,signature:mesh.sign(id)});
 const message=await mesh.tool(cap(one),'message_send',{recipient:'dev:'+two,body:'Contract changed',requestKey:'contract'});
 assert.equal((await mesh.tool(cap(two),'inbox_read'))[0].id,message.id);
 mesh.external.register({session_id:'22222222-bbbb',cwd:data});
 await assert.rejects(mesh.tool(cap(two),'message_send',{recipient:'dev:'+one,body:'No',requestKey:'blocked'}),/чтения/);
 mesh.external.register({session_id:'22222222-bbbb',cwd:data,permission_mode:'default'});
 const reply=await mesh.tool(cap(two),'message_send',{recipient:'dev:'+one,body:'Received',requestKey:'reply',replyTo:message.id});assert.equal(reply.reply_to,message.id);
 db.prepare("UPDATE external_sessions SET seen='2000-01-01'").run();await assert.rejects(mesh.tool(cap(one),'inbox_read'),/не выполняется/);
 assert.throws(()=>mesh.external.register({session_id:'../../bad',cwd:data}),/Invalid/);
 // A session keeps its own name: registering without a title, or with the folder name, never replaces it.
 const named=mesh.external.register({session_id:'33333333-cccc',cwd:data,session_title:'api-worker'});
 mesh.external.register({session_id:'33333333-cccc',cwd:data});assert.equal(mesh.external.info(named).name,'api-worker');
 const unnamed=mesh.external.register({session_id:'44444444-dddd',cwd:data});assert.equal(mesh.external.info(unnamed).name,data.split('/').pop());
 mesh.external.register({session_id:'44444444-dddd',cwd:data,session_title:'staff'});assert.equal(mesh.external.info(unnamed).name,'staff');
 // A bridge command run after cd does not move the session; only its hook sets the folder.
 mesh.external.register({session_id:'33333333-cccc',cwd:'/tmp'});assert.equal(db.prepare('SELECT cwd FROM external_sessions WHERE id=?').get(named).cwd,realpathSync(data));
 mesh.external.register({session_id:'33333333-cccc',cwd:'/tmp',hook:true});assert.equal(db.prepare('SELECT cwd FROM external_sessions WHERE id=?').get(named).cwd,'/tmp');
 }finally{db.close();rmSync(data,{recursive:true,force:true});}
});
