import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
test('Claude hook supplies unread previews without acknowledgement and tolerates unavailable mail',async()=>{
 const dir=mkdtempSync(tmpdir()+'/panel-hook-');mkdirSync(dir+'/data');writeFileSync(dir+'/data/node-token','fixture');copyFileSync(new URL('../claude-session-bridge.mjs',import.meta.url),dir+'/bridge.mjs');
 let available=true;const calls=[];
 const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;res.setHeader('Content-Type','application/json');
 // Hooks run without the service environment: the bridge learns the panel origin from the node.
 if(req.url==='/api/node-info'){assert.equal(req.headers['x-panel-node-token'],'fixture');res.end(JSON.stringify({id:'dev',origin:'https://panel.example'}));return;}
 assert.equal(req.headers.origin,'https://panel.example');const b=JSON.parse(raw);calls.push(b);
 if(req.url==='/api/external-session'){assert.equal(req.headers['x-panel-node-token'],'fixture');res.end(JSON.stringify({cap:{host:'dev',task:'claude-'+b.session_id,signature:'fixture'},name:'api-worker',host:'node2',cwd:'/root/node2',projectName:'Node2',neighbours:['staff','ops-vps']}));return;}
 if(!available){res.writeHead(503);res.end('{}');return;}
 res.end(JSON.stringify([{id:'unread',sender:'local:project-a',body:'x'.repeat(1400),read_at:null},{id:'read',sender:'local:project-b',body:'already seen',read_at:'2026-01-01'}]));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 const run=session=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[dir+'/bridge.mjs','hook'],{env:{...process.env,PANEL_ORIGIN:'',PANEL_MANAGED_SESSION:'',PANEL_NODE_URL:url,PANEL_MAIL_URL:url}});let output='';child.stdout.on('data',b=>output+=b);child.on('error',reject);child.on('close',code=>{try{assert.equal(code,0);resolve(JSON.parse(output).hookSpecificOutput);}catch(e){reject(e);}});child.stdin.end(JSON.stringify({session_id:session,cwd:dir,permission_mode:'default',hook_event_name:'UserPromptSubmit'}));});
 try{
 const a=await run('session-first');assert.match(a.additionalContext,/dev:claude-session-first/);assert.match(a.additionalContext,/"id":"unread"/);assert.match(a.additionalContext,/"truncated":true/);assert.doesNotMatch(a.additionalContext,/already seen/);
 const b=await run('session-after-clear');assert.match(b.additionalContext,/dev:claude-session-after-clear/);assert.ok(calls.every(c=>!c.name||c.name==='inbox_read'));
 available=false;assert.match((await run('session-offline')).additionalContext,/sessions_list/);
 // Inside a panel task the command bridge refuses and points to the panel_bridge tools (no second identity).
 const refused=await new Promise(resolve=>{const c=spawn(process.execPath,[dir+'/bridge.mjs','inbox_read'],{env:{...process.env,PANEL_MANAGED_SESSION:'1',CLAUDE_CODE_SESSION_ID:'x-session',PANEL_NODE_URL:url}});let err='';c.stderr.on('data',b=>err+=b);c.stdin.end('{}');c.on('exit',code=>resolve({code,err}));});
 assert.equal(refused.code,1);assert.match(refused.err,/panel_bridge/);assert.ok(!calls.some(c=>c.session_id==='x-session'));
 // Identity: its own name, the shared project is not its name, neighbours are other sessions.
 assert.match(a.additionalContext,/^Вы — сессия Claude Code «api-worker» на сервере node2/);assert.match(a.additionalContext,/«Node2»; это не ваше имя/);assert.match(a.additionalContext,/«staff», «ops-vps» — это не вы/);
 // The hint repeats the panel addresses the hook ran with, so the agent's own calls reach the same panel.
 assert.match(a.additionalContext,new RegExp('PANEL_NODE_URL='+url.replace(/[.]/g,'\\.')+' PANEL_MAIL_URL='));
 }finally{await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});}
});
