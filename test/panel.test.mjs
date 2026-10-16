import http from 'node:http';import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync,existsSync} from 'node:fs';import {tmpdir} from 'node:os';import {scryptSync} from 'node:crypto';import {Readable} from 'node:stream';import {spawn} from 'node:child_process';
const data=mkdtempSync(tmpdir()+'/panel-test-');process.env.PANEL_TEST='1';process.env.PANEL_AGENTS='codex,claude';process.env.PANEL_ORIGIN='https://panel.test';process.env.CLAUDE_BIN=new URL('./fake-claude.py',import.meta.url).pathname;process.env.PANEL_DATA=data;process.env.CODEX_BIN=new URL('./fake-codex.py',import.meta.url).pathname;
writeFileSync(data+'/password.json',JSON.stringify({salt:'test',hash:scryptSync('test-password-only','test',64).toString('hex')}));
const {server,db,dispatcher,deliverMail,mesh}=await import('../server.mjs');let cookie='',csrf='';
async function request(url,body,headers={}){const req=Readable.from(body?[Buffer.isBuffer(body)?body:JSON.stringify(body)]:[]);req.url='/api/'+url;req.method=body?'POST':'GET';req.headers={origin:'https://panel.test',cookie,'x-csrf-token':csrf,...headers};req.socket={remoteAddress:'test'};return new Promise(resolve=>{const h={};server.emit('request',req,{setHeader:(k,v)=>h[k]=v,writeHead:(status,extra)=>{h.status=status;Object.assign(h,extra);},end:s=>resolve({status:h.status,headers:h,body:JSON.parse(s)})});});}
const delay=()=>new Promise(r=>setTimeout(r,50));async function until(fn){for(let i=0;i<80;i++){const v=await fn();if(v)return v;await delay();}throw Error('timeout');}
test('authentication, CSRF, directory exclusion, approvals, interruption and history',async()=>{assert.equal((await request('projects')).status,401);assert.equal((await request('login',{password:'wrong'})).status,401);const login=await request('login',{password:'test-password-only'});assert.equal(login.status,200);assert.match(login.headers['Set-Cookie'],/HttpOnly; Secure; SameSite=Strict/);cookie=login.headers['Set-Cookie'].split(';')[0];csrf=login.body.csrf;assert.equal((await request('projects',{name:'test',cwd:data},{'x-csrf-token':'wrong'})).status,403);assert.equal((await request('projects',{name:'test',cwd:data},{origin:'https://evil.test'})).status,403);const projects=(await request('projects',{name:'test',cwd:data})).body,p=projects.find(p=>p.cwd===data);const start=await request('tasks',{project:p.id,prompt:'test',requestId:'first-task'});assert.equal(start.status,201);const id=start.body.id;assert.equal((await request('tasks',{project:p.id,prompt:'test',requestId:'first-task'})).body.id,id);assert.equal((await request('tasks',{project:p.id,prompt:'changed',requestId:'first-task'})).status,400);assert.equal((await request('tasks',{project:p.id,prompt:'parallel',previous:id})).status,409);const a=await until(async()=>{const r=await request('events?task='+id);return r.body.approvals[0];});assert.equal((await request('approval',{task:id,key:a.key,decision:'acceptForSession'})).status,409);assert.equal((await request('approval',{task:id,key:a.key,decision:'accept'})).status,200);await until(async()=>{const t=(await request('tasks')).body.find(t=>t.id===id);return t.status==='completed';});assert.ok((await request('events?task='+id)).body.events.some(e=>e.body.method==='item/agentMessage/delta'));await delay();const second=await until(async()=>{const r=await request('tasks',{project:p.id,prompt:'stop',previous:id});return r.status===201?r:null;});assert.equal(db.prepare('SELECT session_id FROM tasks WHERE id=?').get(second.body.id).session_id,id);await request('stop',{task:second.body.id});assert.equal((await request('tasks')).body.find(t=>t.id===second.body.id).status,'interrupted');await new Promise(r=>setTimeout(r,2200));const settings=await request('settings');assert.equal(settings.body.models[0].model,'test-model');assert.equal(settings.body.permissions.length,3);
for(const bad of [{model:'missing'},{reasoning:'ultra'},{permissions:'invalid'}])assert.equal((await request('tasks',{project:p.id,prompt:'invalid',...bad})).status,400);
for(const [permissions,sandbox,approvalPolicy] of [['read-only','read-only','untrusted'],['workspace','workspace-write','untrusted'],['full-access','danger-full-access','never']]){
 const r=await request('tasks',{project:p.id,prompt:'settings',previous:id,model:'test-model',reasoning:'high',permissions});assert.equal(r.status,201);
 const ev=await until(async()=>{const ev=(await request('events?task='+r.body.id)).body.events;return ev.some(e=>e.body.method==='test/settings')?ev:null;});
 const thread=ev.find(e=>e.body.method==='test/thread-settings').body.params;assert.equal(thread.sandbox,sandbox);assert.equal(thread.approvalPolicy,approvalPolicy);assert.equal(thread.model,'test-model');assert.equal(thread.threadId,'thread-test');
 const turn=ev.find(e=>e.body.method==='test/settings').body.params;assert.equal(turn.model,'test-model');assert.equal(turn.effort,'high');
 const task=(await request('tasks')).body.find(t=>t.id===r.body.id);assert.equal(task.permissions,permissions);assert.equal(task.reasoning,'high');
 await request('stop',{task:r.body.id});await delay();
}
await new Promise(r=>setTimeout(r,2200));
const url='uploads?project='+p.id+'&name='+encodeURIComponent('../../скрин.png');
assert.equal((await request(url,Buffer.from('x'),{cookie:''})).status,401);
assert.equal((await request(url,Buffer.from('x'),{'x-csrf-token':'wrong'})).status,403);
assert.equal((await request(url,Buffer.from('x'),{origin:'https://evil.test'})).status,403);
assert.equal((await request(url,Buffer.alloc(1),{'content-length':String(10*1024*1024+1)})).status,413);
assert.equal((await request(url,Buffer.alloc(10*1024*1024+1))).status,400);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Zb8AAAAASUVORK5CYII=','base64');
const upload=await request(url,png);assert.equal(upload.status,201);assert.equal(upload.body.name,'скрин.png');
const f=db.prepare('SELECT * FROM uploads WHERE id=?').get(upload.body.id);assert.ok(f.path.startsWith(data+'/uploads/'+f.id+'/'));assert.deepEqual(readFileSync(f.path),png);assert.equal(f.image,1);
const text=await request('uploads?project='+p.id+'&name=notes.txt',Buffer.from('material'));assert.equal(text.status,201);
for(const attachments of [['missing'],[f.id,f.id],Array(6).fill(f.id)])assert.equal((await request('tasks',{project:p.id,prompt:'files',attachments})).status,400);
const other=(await request('projects',{name:'other',cwd:'/tmp'})).body.find(x=>x.cwd==='/tmp');
// A new project may start in a folder that does not exist yet; a file, a duplicate or a relative path is explained.
{const fresh=data+'/new-landing/site';const r=await request('projects',{name:'landing',cwd:fresh});assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(r.body.some(x=>x.cwd===fresh));assert.ok(existsSync(fresh));
 assert.equal((await request('projects',{name:'again',cwd:fresh})).status,409);
 writeFileSync(data+'/plain-file','x');assert.match((await request('projects',{name:'file',cwd:data+'/plain-file'})).body.error,/файл, а не папка/);
 assert.equal((await request('projects',{name:'rel',cwd:'landing'})).status,400);}
// "+": a session in a folder; the folder and its project appear when missing, the chat gets the owner's name.
{const dir=data+'/plus/site';const r=await request('chats/new',{cwd:dir});assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(existsSync(dir));
 assert.equal((await request('chats/new',{cwd:dir})).body.project,r.body.project,'the same folder reuses its project');
 db.prepare("INSERT INTO tasks(id,project,prompt,status,created,agent,session_id,attachments) VALUES ('plus-chat',?,?,?,?,?,?,?)").run(r.body.project,'Сверстай первый экран','completed',new Date().toISOString(),'claude','plus-chat','[]');
 assert.equal((await request('chats/title',{chain:'plus-chat',title:'Лендинг'})).status,200);
 assert.equal(mesh.localSessions().find(x=>x.id==='local:plus-chat').name,'Лендинг');
 assert.equal((await request('chats/title',{chain:'nope-nope-nope',title:'x'})).status,404);
 assert.equal((await request('chats/new',{cwd:'relative'})).status,400);}
assert.equal((await request('tasks',{project:other.id,prompt:'files',attachments:[f.id]})).status,400);
const sent=await request('tasks',{project:p.id,prompt:'',attachments:[f.id,text.body.id]});assert.equal(sent.status,201);
const ev=await until(async()=>{const ev=(await request('events?task='+sent.body.id)).body.events;return ev.find(e=>e.body.method==='test/settings');});
assert.deepEqual(ev.body.params.input[1],{type:'localImage',path:f.path});assert.match(ev.body.params.input[0].text,/notes.txt/);assert.ok(ev.body.params.input[0].text.includes(f.path));
const saved=(await request('tasks')).body.find(t=>t.id===sent.body.id);assert.equal(saved.prompt,'Изучи приложенные файлы.');assert.deepEqual(saved.attachments,[upload.body,text.body]);assert.equal(saved.attachments[0].path,undefined);
await request('stop',{task:sent.body.id});await new Promise(r=>setTimeout(r,2200));const claudeCatalog=await request('settings?agent=claude');assert.equal(claudeCatalog.status,200);assert.equal(claudeCatalog.body.models[0].model,'claude-test');assert.deepEqual(claudeCatalog.body.permissions.map(x=>x.id),['read-only','workspace','auto','bypass']);
assert.equal((await request('settings?agent=unknown')).status,400);
for(const settings of [{agent:'unknown'},{agent:'claude',model:'test-model'},{agent:'claude',permissions:'full-access'},{agent:'claude',reasoning:'medium'}])assert.equal((await request('tasks',{project:p.id,prompt:'test',...settings})).status,400);
let claudeTask;
for(const decision of ['accept','decline']){
 const startClaude=await request('tasks',{project:p.id,prompt:'fixture',agent:'claude',model:'claude-test',reasoning:'high',attachments:[f.id,text.body.id],...(claudeTask?{previous:claudeTask}:{})});assert.equal(startClaude.status,201);const cid=startClaude.body.id;
 assert.equal((await request('tasks',{project:p.id,prompt:'busy',agent:'codex',previous:cid})).status,409);
 const approval=await until(async()=>{const ev=await request('events?task='+cid);return ev.body.approvals[0];});assert.equal(approval.params.tool,'Bash');
 assert.equal((await request('approval',{task:cid,key:approval.key,decision})).status,200);
 await until(async()=>(await request('tasks')).body.find(t=>t.id===cid)?.status==='completed');
 const ev=(await request('events?task='+cid)).body.events;assert.ok(ev.some(e=>e.body.method==='item/agentMessage/delta'));
 const toolResult=ev.find(e=>e.body.method==='item/completed'&&e.body.params.item.id==='tool-1');assert.equal(toolResult.body.params.item.output,'fixture tool output');assert.equal(toolResult.body.params.item.status,decision==='accept'?'completed':'failed');
 const complete=ev.find(e=>e.body.method==='item/completed'&&e.body.params.item.text);const fixture=JSON.parse(complete.body.params.item.text);
 assert.equal(fixture.decision.behavior,decision==='accept'?'allow':'deny');assert.ok(fixture.args.includes('--effort'));assert.ok(fixture.args.includes('high'));assert.equal(fixture.user.message.content[1].type,'image');assert.ok(fixture.user.message.content[0].text.includes('notes.txt'));
 if(claudeTask)assert.ok(fixture.args.some(a=>a.startsWith('--resume=')));
 const saved=(await request('tasks')).body.find(t=>t.id===cid);assert.equal(saved.agent,'claude');assert.equal(saved.thread,'11111111-1111-4111-8111-111111111111');
 claudeTask=cid;await new Promise(r=>setTimeout(r,2200));
}
// Switching the agent keeps the project chat: Codex resumes its own thread and receives the Claude turns.
const switched=await request('tasks',{project:p.id,prompt:'after switch',agent:'codex',previous:claudeTask});assert.equal(switched.status,201);
const switchEvents=await until(async()=>{const ev=(await request('events?task='+switched.body.id)).body.events;return ev.some(e=>e.body.method==='test/settings')?ev:null;});
assert.equal(switchEvents.find(e=>e.body.method==='test/thread-settings').body.params.threadId,'thread-test');
const switchText=switchEvents.find(e=>e.body.method==='test/settings').body.params.input[0].text;assert.match(switchText,/переключил ИИ/);assert.match(switchText,/Claude Code/);assert.match(switchText,/after switch/);
const switchedTask=(await request('tasks')).body.find(t=>t.id===switched.body.id);assert.equal(switchedTask.prompt,'after switch');assert.equal(db.prepare('SELECT session_id FROM tasks WHERE id=?').get(switched.body.id).session_id,db.prepare('SELECT session_id FROM tasks WHERE id=?').get(claudeTask).session_id);
// Chats of one project run side by side; one chat still runs one turn at a time.
{const dir=data+'/parallel',par=(await request('projects',{name:'parallel',cwd:dir})).body.find(x=>x.cwd===dir);
 const first=await request('tasks',{project:par.id,prompt:'first chat',agent:'codex'});assert.equal(first.status,201);
 await until(async()=>(await request('tasks')).body.find(t=>t.id===first.body.id)?.status==='running');
 const second=await request('tasks',{project:par.id,prompt:'second chat',agent:'codex'});assert.equal(second.status,201,JSON.stringify(second.body));
 const same=await request('tasks',{project:par.id,prompt:'same chat',agent:'codex',previous:first.body.id});assert.equal(same.status,409);assert.match(same.body.error,/чат/);
 for(const id of [first.body.id,second.body.id])await request('stop',{task:id});await new Promise(r=>setTimeout(r,2200));}
await request('stop',{task:switched.body.id});await new Promise(r=>setTimeout(r,2200));
assert.equal((await request('tasks',{project:p.id,prompt:'x',agent:'unknown',previous:claudeTask})).status,400);
// Installation metadata and project maps are data, not code.
const meta=await request('meta',undefined,{cookie:''});assert.equal(meta.status,200);assert.equal(typeof meta.body.brand.name,'string');assert.match(meta.body.build,/^\d+\.\d+\.\d+\.\d+$/,'interface build stamp for open tabs');
assert.deepEqual((await request('agents')).body.map(a=>a.id),['codex','claude']);
const usage=(await request('claude-usage')).body;assert.equal(usage.available,true);assert.equal(usage.seven_day.percent,21);assert.equal(usage.five_hour.percent,2);assert.equal(usage.seven_day.resetsAt,'2026-10-12T11:00:00Z');
assert.equal((await request('node-info')).body.origin,undefined);
assert.equal((await request('project-map?project='+p.id)).body.map,null);
mkdirSync(data+'/.panel');writeFileSync(data+'/.panel/map.json',JSON.stringify({title:'Fixture',sections:[{id:'a',label:'Устройство',title:'Схема',nodes:[['A','B','C']],links:[['ok','https://example.test/','d'],['bad','javascript:alert(1)','d']]}]}));
let map=(await request('project-map?project='+p.id)).body.map;assert.equal(map.source,'project');assert.equal(map.sections[0].nodes[0][2],'C');assert.equal(map.sections[0].links.length,1);
mkdirSync(data+'/project-maps');writeFileSync(data+'/project-maps/'+p.id+'.json',JSON.stringify({sections:[{title:'Panel side'}]}));
map=(await request('project-map?project='+p.id)).body.map;assert.equal(map.source,'panel');assert.equal(map.sections[0].title,'Panel side');
const read=await request('tasks',{project:p.id,prompt:'readonly',agent:'claude',permissions:'read-only'});assert.equal(read.status,201);
await until(async()=>(await request('tasks')).body.find(t=>t.id===read.body.id)?.status==='completed');
const readEvent=(await request('events?task='+read.body.id)).body.events.find(e=>e.body.method==='item/completed'&&e.body.params.item.text);const readFixture=JSON.parse(readEvent.body.params.item.text);assert.equal(readFixture.decision.behavior,'deny');assert.ok(readFixture.args.includes('--tools'));assert.ok(readFixture.args.includes('Read,Glob,Grep'));await new Promise(r=>setTimeout(r,2200));
// auto and bypass map to Claude's own permission modes; ask rules are not forced on them.
for(const [permissions,mode,danger] of [['workspace','default',false],['auto','auto',false],['bypass','bypassPermissions',true]]){
 const r=await request('tasks',{project:p.id,prompt:'mode',agent:'claude',permissions});assert.equal(r.status,201);
 const a=await until(async()=>(await request('events?task='+r.body.id)).body.approvals[0]);await request('approval',{task:r.body.id,key:a.key,decision:'accept'});
 await until(async()=>(await request('tasks')).body.find(t=>t.id===r.body.id)?.status==='completed');
 const args=JSON.parse((await request('events?task='+r.body.id)).body.events.find(e=>e.body.method==='item/completed'&&e.body.params.item.text).body.params.item.text).args;
 assert.equal(args[args.indexOf('--permission-mode')+1],mode);assert.equal(args.includes('--allow-dangerously-skip-permissions'),danger);
 assert.equal((await request('tasks')).body.find(t=>t.id===r.body.id).permissions,permissions);await new Promise(r=>setTimeout(r,2200));
}
const stopped=await request('tasks',{project:p.id,prompt:'stop',agent:'claude'});await until(async()=>(await request('events?task='+stopped.body.id)).body.approvals.length);await request('stop',{task:stopped.body.id});assert.equal((await request('events?task='+stopped.body.id)).body.approvals.length,0);assert.equal((await request('tasks')).body.find(t=>t.id===stopped.body.id).status,'interrupted');await new Promise(r=>setTimeout(r,2200));
// A message sent while a Claude turn runs joins that turn; after the turn it is refused, to be sent as a new turn.
{const j=await request('tasks',{project:p.id,prompt:'join',agent:'claude'});let a;await until(async()=>(a=(await request('events?task='+j.body.id)).body.approvals[0]));
 {const r=await request('tasks/inject',{task:j.body.id,text:'joined: ещё проверь логи'});assert.equal(r.status,200,JSON.stringify(r.body));}
 await request('approval',{task:j.body.id,key:a.key,decision:'accept'});await until(async()=>(await request('tasks')).body.find(t=>t.id===j.body.id).status==='completed');
 const ev=(await request('events?task='+j.body.id)).body.events.map(e=>e.body);assert.ok(ev.some(x=>x.type==='user-message'&&x.text==='joined: ещё проверь логи'));
 {const ans=ev.filter(x=>x.method==='item/completed'&&x.params?.item?.type==='agentMessage').map(x=>x.params.item.text).join('');assert.deepEqual(JSON.parse(ans).joined,['joined: ещё проверь логи'],ans.slice(0,300));}
 // The finished turn reads back as a conversation: the joined message, one row per tool call, the answer.
 {const tr=(await request('tasks/transcript?ids='+j.body.id+',missing')).body;assert.equal(tr.length,1);const items=tr[0].items;
  assert.deepEqual(items.filter(x=>x.role==='tool').map(x=>x.text),['echo fixture']);assert.ok(items.some(x=>x.role==='user'&&x.text==='joined: ещё проверь логи'));assert.equal(items.at(-1).role,'assistant');}
 const late=await request('tasks/inject',{task:j.body.id,text:'joined: поздно'});assert.equal(late.status,409);assert.equal(late.body.later,true);
 await new Promise(r=>setTimeout(r,2200));}
// Background work outlives the turn: the run stays open until it reports back and Claude answers the follow-up.
{const g=await request('tasks',{project:p.id,prompt:'background review',agent:'claude'});let a;await until(async()=>(a=(await request('events?task='+g.body.id)).body.approvals[0]));
 await request('approval',{task:g.body.id,key:a.key,decision:'accept'});
 await until(async()=>(await request('events?task='+g.body.id)).body.events.some(e=>e.body.method==='turn/waiting-background'));
 assert.equal((await request('tasks')).body.find(t=>t.id===g.body.id).status,'running','the run waits for its background work');
 const bg=(await request('events?task='+g.body.id)).body.events.map(e=>e.body).filter(x=>x.method==='background/changed');assert.equal(bg[0].params.tasks[0].kind,'agent');assert.equal(bg[0].params.tasks[0].title,'Review A');
 await until(async()=>(await request('tasks')).body.find(t=>t.id===g.body.id).status==='completed');
 assert.ok(JSON.stringify((await request('events?task='+g.body.id)).body.events).includes('Фоновая проверка готова'));
 await new Promise(r=>setTimeout(r,2200));}
// The chat's previous Claude session is gone from the server: the turn starts a new session instead of failing.
{db.prepare("INSERT INTO tasks(id,project,thread,prompt,status,created,model,reasoning,permissions,agent,session_id) VALUES ('gone-prev',?,?,?,?,?,?,?,?,?,?)").run(p.id,'98989898-9898-4898-8898-989898989898','old chat','completed',new Date().toISOString(),'claude-test','high','workspace','claude','gone-chain');
 const g=await request('tasks',{project:p.id,prompt:'after the session vanished',agent:'claude',model:'claude-test',reasoning:'high',previous:'gone-prev'});assert.equal(g.status,201,JSON.stringify(g.body));let a;await until(async()=>(a=(await request('events?task='+g.body.id)).body.approvals[0]));
 await request('approval',{task:g.body.id,key:a.key,decision:'accept'});await until(async()=>(await request('tasks')).body.find(t=>t.id===g.body.id).status==='completed');
 const ev=(await request('events?task='+g.body.id)).body.events.map(e=>e.body);assert.ok(ev.some(x=>x.type==='notice'&&/не найдена/.test(x.message)));
 const answer=JSON.parse(ev.filter(x=>x.method==='item/completed'&&x.params?.item?.type==='agentMessage').map(x=>x.params.item.text).join(''));assert.ok(!answer.args.some(x=>x.startsWith('--resume')),'the new session is not a resume');
 await new Promise(r=>setTimeout(r,2200));}
// Stop after a run finished must not leave the project stuck in 'stopping'.
assert.equal((await request('stop',{task:stopped.body.id})).status,200);assert.equal((await request('tasks')).body.find(t=>t.id===stopped.body.id).status,'interrupted');
// An early result for a hanging terminal turn must not end our turn before the model answers.
const dangling=await request('tasks',{project:p.id,prompt:'dangling turn',agent:'claude'});assert.equal(dangling.status,201);
const da=await until(async()=>(await request('events?task='+dangling.body.id)).body.approvals[0]);await request('approval',{task:dangling.body.id,key:da.key,decision:'accept'});
await until(async()=>(await request('tasks')).body.find(t=>t.id===dangling.body.id)?.status==='completed');
assert.ok((await request('events?task='+dangling.body.id)).body.events.some(e=>e.body.method==='item/completed'&&e.body.params.item.text));await new Promise(r=>setTimeout(r,2200));
const crashed=await request('tasks',{project:p.id,prompt:'crash',agent:'claude'});assert.equal(crashed.status,201);await until(async()=>(await request('tasks')).body.find(t=>t.id===crashed.body.id)?.status==='failed');assert.ok((await request('events?task='+crashed.body.id)).body.events.some(e=>e.body.type==='error'));await new Promise(r=>setTimeout(r,2200));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
// The central panel accepts its local session adapter (terminal Claude sessions on this server) by node token from loopback only.
{const t=readFileSync(data+'/node-token','utf8').trim(),post=(path,headers)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',origin:'https://panel.test',...headers},body:JSON.stringify({session_id:'adapter-test-1234',cwd:data})});
 assert.equal((await fetch(base+'/api/node-info',{headers:{'X-Panel-Node-Token':t}})).status,200);assert.equal((await (await fetch(base+'/api/node-info',{headers:{'X-Panel-Node-Token':t}})).json()).origin,'https://panel.test');
 const reg=await post('/api/external-session',{'X-Panel-Node-Token':t});assert.equal(reg.status,200);assert.ok((await reg.json()).cap.signature);
 assert.equal((await post('/api/external-session',{'X-Panel-Node-Token':'wrong'})).status,401);
 assert.equal((await post('/api/external-session',{'X-Panel-Node-Token':t,'X-Forwarded-For':'203.0.113.5'})).status,401);
 assert.equal((await fetch(base+'/api/projects',{headers:{'X-Panel-Node-Token':t}})).status,401);
 db.prepare("DELETE FROM external_sessions WHERE id='claude-adapter-test-1234'").run();}
const httpUpload=await fetch(base+'/api/uploads?project='+p.id+'&name=http.txt',{method:'POST',headers:{origin:'https://panel.test',cookie,'x-csrf-token':csrf,'content-type':'application/octet-stream'},body:Buffer.from('HTTP upload')});assert.equal(httpUpload.status,201);const httpFile=await httpUpload.json();
assert.equal((await fetch(base+'/api/uploads?id='+httpFile.id)).status,401);
const download=await fetch(base+'/api/uploads?id='+httpFile.id,{headers:{cookie}});assert.equal(download.headers.get('content-type'),'application/octet-stream');assert.match(download.headers.get('content-disposition'),/^attachment;/);assert.equal(await download.text(),'HTTP upload');
const upstream=http.createServer(async(req,res)=>{assert.equal(req.headers['x-panel-node-token'],'fixture-node-secret');assert.equal(req.headers.cookie,undefined);assert.equal(req.headers.origin,'https://panel.test');let raw='';for await(const c of req)raw+=c;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({path:req.url,body:raw}));});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
try{
 writeFileSync(data+'/remote-key','fixture-node-secret');writeFileSync(data+'/nodes.json',JSON.stringify([{id:'dev',name:'dev',tokenFile:data+'/remote-key',endpoint:'http://127.0.0.1:'+upstream.address().port}]));
 const proxy=base+'/api/remote/dev/';
 assert.equal((await fetch(proxy+'projects')).status,401);
 assert.equal((await fetch(proxy+'tasks',{method:'POST',headers:{cookie,origin:'https://panel.test'},body:'{}'})).status,403);
 const response=await fetch(proxy+'tasks',{method:'POST',headers:{cookie,origin:'https://panel.test','x-csrf-token':csrf},body:JSON.stringify({prompt:'proxy fixture'})});assert.equal(response.status,200);assert.equal(JSON.parse((await response.json()).body).prompt,'proxy fixture');
 assert.equal((await fetch(proxy+'logout',{headers:{cookie}})).status,502);
 const nested=await fetch(proxy+'claude-sessions/attach',{method:'POST',headers:{cookie,origin:'https://panel.test','x-csrf-token':csrf},body:JSON.stringify({mode:'fork'})});assert.equal(nested.status,200);assert.equal((await nested.json()).path,'/api/claude-sessions/attach');
 assert.equal((await fetch(proxy+'communication/messages',{headers:{cookie}})).status,404);
}finally{await new Promise(r=>upstream.close(r));}
assert.equal((await fetch(base+'/api/remote/dev/projects',{headers:{cookie}})).status,502);
writeFileSync(data+'/nodes.json','[]');
const directory=(await request('communication/projects')).body;const recipient=directory.projects.find(x=>x.project===p.id);assert.ok(recipient.id.includes(':project-'));
assert.equal((await request('communication/visibility',{key:'local:'+p.cwd,hidden:true},{'x-csrf-token':'wrong'})).status,403);
assert.deepEqual((await request('communication/visibility',{key:'local:'+p.cwd,hidden:true})).body,['local:'+p.cwd]);
assert.equal((await request('projects')).body.find(x=>x.id===p.id).cwd,p.cwd);
assert.deepEqual((await request('communication/visibility',{key:'local:'+p.cwd,hidden:false})).body,[]);
assert.equal((await request('mail-deliver',{id:'fake',recipient:recipient.id})).status,403);
// Resume the native thread with stored model, effort and permissions; no extra chat.
db.prepare('INSERT INTO tasks(id,project,thread,prompt,status,created,model,reasoning,permissions,agent,session_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('mail-seed',p.id,'thread-existing','Before mail','completed',new Date().toISOString(),'test-model','high','workspace','codex','existing-session');
process.env.PANEL_MAIL_TEST='1';
const mail=(await request('communication/messages',{recipient:recipient.id,body:'Какой API?',requestKey:'owner-mail'})).body;
await dispatcher.tick();const delivery=db.prepare('SELECT * FROM mail_dispatch WHERE message=?').get(mail.id);assert.equal(delivery.state,'running');
assert.equal((await deliverMail(mail)).id,delivery.task);
const deliveredTask=db.prepare('SELECT * FROM tasks WHERE id=?').get(delivery.task);assert.equal(deliveredTask.session_id,'existing-session');assert.equal(deliveredTask.permissions,'workspace');assert.equal(deliveredTask.model,'test-model');
const approval=await until(async()=>(await request('events?task='+delivery.task)).body.approvals[0]);
const deliveryEvents=(await request('events?task='+delivery.task)).body.events;assert.equal(deliveryEvents.find(e=>e.body.method==='test/thread-settings').body.params.threadId,'thread-existing');assert.match(deliveryEvents.find(e=>e.body.method==='test/settings').body.params.input[0].text,/projects_list/);
await request('approval',{task:delivery.task,key:approval.key,decision:'accept'});
await until(async()=>db.prepare('SELECT status FROM tasks WHERE id=?').get(delivery.task)?.status==='completed');
await dispatcher.tick();assert.equal(db.prepare('SELECT state FROM mail_dispatch WHERE message=?').get(mail.id).state,'completed');
const answer=db.prepare('SELECT * FROM agent_messages WHERE reply_to=?').get(mail.id);assert.equal(answer.recipient,'owner');assert.equal(answer.kind,'reply');assert.equal(answer.body,'Проверено');
const journal=(await request('communication/messages?project='+encodeURIComponent(recipient.id))).body;assert.equal(journal.length,2);assert.ok(journal.find(m=>m.id===mail.id).answered_at);
await new Promise(r=>setTimeout(r,2200));
db.prepare('INSERT INTO tasks(id,project,thread,prompt,status,created,model,reasoning,permissions,agent,session_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('claude-mail-seed',p.id,'11111111-1111-4111-8111-111111111111','Claude prior chat','completed',new Date().toISOString(),'claude-test','high','workspace','claude','claude-existing-session');
const claudeMail=(await request('communication/messages',{recipient:recipient.id,body:'Claude question',requestKey:'claude-owner-mail'})).body;
await dispatcher.tick();const cd=db.prepare('SELECT * FROM mail_dispatch WHERE message=?').get(claudeMail.id);
assert.equal(cd.state,'running');assert.equal(db.prepare('SELECT session_id FROM tasks WHERE id=?').get(cd.task).session_id,'claude-existing-session');
const ca=await until(async()=>(await request('events?task='+cd.task)).body.approvals[0]);await request('approval',{task:cd.task,key:ca.key,decision:'accept'});
await until(async()=>db.prepare('SELECT status FROM tasks WHERE id=?').get(cd.task)?.status==='completed');await dispatcher.tick();
const cr=db.prepare('SELECT * FROM agent_messages WHERE reply_to=?').get(claudeMail.id);assert.equal(cr.kind,'reply');assert.ok(cr.body.length<=12000);const cli=JSON.parse((await mesh.taskInfo('local',cd.task)).answer);assert.doesNotMatch(cli.user.message.content[0].text,/projects_list/);assert.match(JSON.stringify(cli.initialization),/projects_list/);assert.ok(cli.args.some(a=>a.startsWith('--resume=')));assert.equal(cli.decision.behavior,'allow');
await new Promise(r=>setTimeout(r,2200));
delete process.env.PANEL_MAIL_TEST;
// Terminal sessions: listed per project, live ones only as a copy, history from the file, fork once then continue.
process.env.CLAUDE_CONFIG_DIR=data+'/claude-home';
const sid='44444444-4444-4444-8444-444444444444',sid2='55555555-5555-4555-8555-555555555555',line=o=>JSON.stringify(o)+'\n';
const folder=data+'/claude-home/projects/'+data.replace(/[^a-zA-Z0-9]/g,'-');mkdirSync(folder,{recursive:true});
writeFileSync(folder+'/'+sid+'.jsonl',line({type:'user',cwd:data,sessionId:sid,timestamp:'2026-10-05T10:00:00Z',message:{role:'user',content:'Сделай экспорт'}})+line({type:'assistant',cwd:data,timestamp:'2026-10-05T10:00:05Z',message:{id:'m1',content:[{type:'text',text:'Экспорт готов'}]}})+line({type:'custom-title',customTitle:'Terminal work',sessionId:sid}));
writeFileSync(folder+'/'+sid2+'.jsonl',line({type:'user',cwd:data,timestamp:'2026-10-04T10:00:00Z',message:{role:'user',content:'Старая задача'}}));
writeFileSync(folder+'/66666666-6666-4666-8666-666666666666.jsonl',line({type:'user',cwd:'/tmp',message:{role:'user',content:'other project'}}));
{const other=spawn('/bin/sh',['-c','sleep 30; echo '+sid2]);await delay();assert.equal((await request('claude-sessions?project='+p.id)).body.find(x=>x.id===sid2).live,false,'a shell carrying the id is not the session');other.kill();}
const holder=spawn(process.execPath,['-e','setTimeout(()=>{},30000)',sid2],{argv0:'claude'});await delay();
let sessions=(await request('claude-sessions?project='+p.id)).body;
assert.deepEqual(sessions.map(x=>x.id),[sid,sid2]);assert.equal(sessions[0].title,'Terminal work');assert.equal(sessions[0].live,false);assert.equal(sessions[1].live,true);assert.equal(sessions[0].runCwd,undefined);
assert.equal((await request('claude-sessions/attach',{project:p.id,id:sid2,mode:'move'})).status,409);
assert.equal((await request('claude-sessions/attach',{project:p.id,id:'66666666-6666-4666-8666-666666666666',mode:'fork'})).status,404);
const attached=await request('claude-sessions/attach',{project:p.id,id:sid,mode:'fork'});assert.equal(attached.status,201);
const hist=(await request('claude-sessions/history?task='+attached.body.id)).body;assert.deepEqual(hist.messages.map(m=>m.role+':'+m.text),['user:Сделай экспорт','assistant:Экспорт готов']);
assert.equal((await request('claude-sessions?project='+p.id)).body[0].attached,'fork');
async function claudeTurn(previous,prompt){const r=await request('tasks',{project:p.id,prompt,agent:'claude',model:'claude-test',reasoning:'high',previous});assert.equal(r.status,201);
 const a=await until(async()=>(await request('events?task='+r.body.id)).body.approvals[0]);await request('approval',{task:r.body.id,key:a.key,decision:'accept'});
 await until(async()=>db.prepare('SELECT status FROM tasks WHERE id=?').get(r.body.id)?.status==='completed');
 const ev=(await request('events?task='+r.body.id)).body.events.find(e=>e.body.method==='item/completed'&&e.body.params.item.text);await new Promise(r=>setTimeout(r,2200));
 return {id:r.body.id,args:JSON.parse(ev.body.params.item.text).args,task:db.prepare('SELECT * FROM tasks WHERE id=?').get(r.body.id)};}
const forked=await claudeTurn(attached.body.id,'continue terminal');
assert.ok(forked.args.includes('--resume='+sid));assert.ok(forked.args.includes('--fork-session'));assert.equal(forked.task.thread,'33333333-3333-4333-8333-333333333333');assert.equal(forked.task.run_cwd,data);
const after=await claudeTurn(forked.id,'next');
// Live view: steps of the original come with tools=1; writing to it needs the session open in tmux.
writeFileSync(folder+'/'+sid+'.jsonl',line({type:'assistant',cwd:data,timestamp:new Date(Date.now()-600000).toISOString(),message:{id:'m2',content:[{type:'tool_use',id:'tu',name:'Bash',input:{command:'npm test',description:'Run tests'}}]}}),{flag:'a'});
const withTools=(await request('agent-sessions/history?task='+attached.body.id+'&tools=1')).body;assert.ok(withTools.messages.some(m=>m.role==='tool'&&m.text==='Run tests'));assert.equal(withTools.session.live,false);
assert.ok(!(await request('agent-sessions/history?task='+attached.body.id)).body.messages.some(m=>m.role==='tool'));
assert.equal((await request('agent-sessions/say',{task:attached.body.id,text:'привет'})).status,409);
{const r=await request('agent-sessions/answer',{task:attached.body.id,option:1,expect:'Вопрос?'});assert.equal(r.status,409,JSON.stringify(r.body));assert.match(r.body.error,/закрыт/);}
assert.equal((await request('agent-sessions/answer',{task:attached.body.id,text:''})).status,400);
{const holder=spawn(process.execPath,['-e','setTimeout(()=>{},30000)',sid],{argv0:'claude'});await delay();
 const r=await request('agent-sessions/say',{task:after.id,text:'привет'});assert.equal(r.status,409);assert.match(r.body.error,/без терминала/);assert.equal(r.body.copy,true);holder.kill();}assert.ok(after.args.includes('--resume=33333333-3333-4333-8333-333333333333'));assert.ok(!after.args.includes('--fork-session'));
holder.kill();await delay();
const moved=await request('claude-sessions/attach',{project:p.id,id:sid2,mode:'move'});assert.equal(moved.status,201);
const movedTurn=await claudeTurn(moved.body.id,'moved');assert.ok(movedTurn.args.includes('--resume='+sid2));assert.ok(!movedTurn.args.includes('--fork-session'));
// The moved session reopened in a terminal: the next panel turn is refused, so two writers never share one session.
{const reopened=spawn(process.execPath,['-e','setTimeout(()=>{},30000)',sid2],{argv0:'claude'});await delay();
 const r=await request('tasks',{project:p.id,prompt:'second writer',agent:'claude',previous:moved.body.id});assert.equal(r.status,409,JSON.stringify(r.body));reopened.kill();await delay();}
// A Remote Control server in the project folder: sessions written after it started count as open.
const sid3='77777777-7777-4777-8777-777777777777';
const rcServer=spawn(process.execPath,['-e','setTimeout(()=>{},30000)','remote-control'],{argv0:'claude',cwd:data});await new Promise(r=>setTimeout(r,300));
writeFileSync(folder+'/'+sid3+'.jsonl',line({type:'user',cwd:data,timestamp:new Date().toISOString(),message:{role:'user',content:'Remote Control work'}}));
sessions=(await request('claude-sessions?project='+p.id)).body;assert.equal(sessions.find(x=>x.id===sid3).live,true);assert.equal(sessions.find(x=>x.id===sid).live,false);
assert.equal((await request('claude-sessions/attach',{project:p.id,id:sid3,mode:'move'})).status,409);
assert.equal((await request('claude-sessions/attach',{project:p.id,id:sid3,mode:'fork'})).status,201);
rcServer.kill();
// Worktrees inside the project are listed with their folder; a nested registered project keeps its own sessions.
mkdirSync(data+'/wt/feature',{recursive:true});mkdirSync(data+'/nested');await request('projects',{name:'nested',cwd:data+'/nested'});
const wtFolder=data+'/claude-home/projects/'+(data+'/wt/feature').replace(/[^a-zA-Z0-9]/g,'-');mkdirSync(wtFolder,{recursive:true});writeFileSync(wtFolder+'/88888888-8888-4888-8888-888888888888.jsonl',line({type:'user',cwd:data+'/wt/feature',timestamp:'2026-10-06T10:00:00Z',message:{role:'user',content:'worktree'}}));
writeFileSync(folder+'/99999999-9999-4999-8999-999999999999.jsonl',line({type:'user',cwd:data+'/nested',timestamp:'2026-10-06T10:00:00Z',message:{role:'user',content:'nested'}}));
sessions=(await request('claude-sessions?project='+p.id)).body;assert.equal(sessions.find(x=>x.id==='88888888-8888-4888-8888-888888888888').folder,'wt/feature');assert.ok(!sessions.some(x=>x.id==='99999999-9999-4999-8999-999999999999'));
const nestedProject=(await request('projects')).body.find(x=>x.cwd===data+'/nested');assert.deepEqual((await request('claude-sessions?project='+nestedProject.id)).body.map(x=>x.id),['99999999-9999-4999-8999-999999999999']);
// Sessions started by programs (Agent SDK, claude -p) are service ones; the tree summary counts only work sessions.
writeFileSync(folder+'/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl',line({type:'user',cwd:data,entrypoint:'sdk-py',timestamp:'2026-10-07T10:00:00Z',message:{role:'user',content:'Review this change for security vulnerabilities.'}}));
writeFileSync(folder+'/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jsonl',line({type:'user',cwd:data,entrypoint:'cli',timestamp:'2026-08-01T10:00:00Z',message:{role:'user',content:'Старая работа'}}));
const flagged=(await request('agent-sessions?project='+p.id)).body;assert.equal(flagged.find(x=>x.id==='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').service,true);assert.equal(flagged.find(x=>x.id===sid).service,false);
const summary=(await request('agent-sessions/summary')).body.projects[p.id];assert.equal(summary.total,flagged.filter(x=>!x.service&&x.active).length);assert.equal(summary.inactive,flagged.filter(x=>!x.service&&!x.active).length);assert.ok(summary.total>0&&summary.inactive>0);
// Active: open now or changed within 7 days; injected texts are not titles.
assert.equal(flagged.find(x=>x.id==='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee').active,false);
writeFileSync(folder+'/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsonl',line({type:'user',cwd:data,entrypoint:'cli',timestamp:new Date().toISOString(),message:{role:'user',content:'<task-notification>done</task-notification>'}})+line({type:'user',cwd:data,entrypoint:'cli',timestamp:new Date().toISOString(),message:{role:'user',content:'Свежая работа'}}));
const fresh=(await request('agent-sessions?project='+p.id)).body.find(x=>x.id==='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');assert.equal(fresh.active,true);assert.equal(fresh.title,'Свежая работа');
const active=(await request('agent-sessions/active')).body;assert.ok(active.some(x=>x.kind==='session'&&x.id==='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'&&x.project===p.id));assert.ok(!active.some(x=>x.id==='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'||x.id==='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
// Panel-side names, and sessions outside every project (here '/') that can be attached to a project.
assert.equal((await request('agent-sessions/title',{agent:'claude',id:sid,title:'  Опт · shop.example '})).body.title,'Опт · shop.example');
assert.equal((await request('agent-sessions?project='+p.id)).body.find(x=>x.id===sid).title,'Опт · shop.example');
assert.equal((await request('agent-sessions/title',{agent:'claude',id:'../x',title:'x'})).status,400);
writeFileSync(folder+'/ffffffff-ffff-4fff-8fff-ffffffffffff.jsonl',line({type:'user',cwd:'/',entrypoint:'cli',timestamp:new Date().toISOString(),message:{role:'user',content:'Работа в домашней папке'}}));
assert.ok(!(await request('agent-sessions?project='+p.id)).body.some(x=>x.id==='ffffffff-ffff-4fff-8fff-ffffffffffff'));
const outside=(await request('agent-sessions?project='+p.id+'&outside=1')).body.find(x=>x.id==='ffffffff-ffff-4fff-8fff-ffffffffffff');assert.equal(outside.outside,true);assert.equal(outside.folder,'/');
const outAttach=await request('agent-sessions/attach',{project:p.id,agent:'claude',id:'ffffffff-ffff-4fff-8fff-ffffffffffff',mode:'fork'});assert.equal(outAttach.status,201);assert.equal(db.prepare('SELECT run_cwd FROM tasks WHERE id=?').get(outAttach.body.id).run_cwd,'/');
const wt=await request('claude-sessions/attach',{project:p.id,id:'88888888-8888-4888-8888-888888888888',mode:'move'});assert.equal(wt.status,201);assert.equal(db.prepare('SELECT run_cwd FROM tasks WHERE id=?').get(wt.body.id).run_cwd,data+'/wt/feature');
delete process.env.CLAUDE_CONFIG_DIR;
// Codex threads from the TUI: same project rules through the app-server protocol; a copy uses thread/fork once.
const now=Math.floor(Date.now()/1000);
process.env.CODEX_FAKE_THREADS=JSON.stringify([
 {id:'01a111cc-b070-7840-98a9-69c328861b27',cwd:data,name:'Создай панель',preview:'Создай панель',originator:'codex-tui',updatedAt:now-500,createdAt:now-900,ephemeral:false,parentThreadId:null,path:null},
 {id:'01a115a0-f68e-71b3-8e0c-960b90a78b22',cwd:data,name:null,preview:'panel own',originator:'bro_codex_panel',updatedAt:now,createdAt:now,ephemeral:false,parentThreadId:null,path:null},
 {id:'01a111eb-5d1c-7ac3-8282-e53d75379d89',cwd:'/tmp',name:'other',preview:'other',originator:'codex-tui',updatedAt:now,createdAt:now,ephemeral:false,parentThreadId:null,path:null}]);
const all=(await request('agent-sessions?project='+p.id)).body;const codexOnes=all.filter(x=>x.agent==='codex');
assert.deepEqual(codexOnes.map(x=>x.id),['01a111cc-b070-7840-98a9-69c328861b27']);
assert.ok((await request('claude-sessions?project='+p.id)).body.every(x=>x.agent==='claude'));
const codexAttach=await request('agent-sessions/attach',{project:p.id,id:'01a111cc-b070-7840-98a9-69c328861b27',agent:'codex',mode:'fork'});assert.equal(codexAttach.status,201);
assert.deepEqual((await request('agent-sessions/history?task='+codexAttach.body.id)).body.messages.map(m=>m.role+':'+m.text),['user:Собери релиз','assistant:Релиз собран']);
const codexTurn=await request('tasks',{project:p.id,prompt:'continue tui',agent:'codex',previous:codexAttach.body.id});assert.equal(codexTurn.status,201);
const codexEvents=await until(async()=>{const ev=(await request('events?task='+codexTurn.body.id)).body.events;return ev.some(e=>e.body.method==='test/settings')?ev:null;});
const forkCall=codexEvents.find(e=>e.body.method==='test/thread-settings').body.params;assert.equal(forkCall.rpc,'thread/fork');assert.equal(forkCall.threadId,'01a111cc-b070-7840-98a9-69c328861b27');assert.equal(forkCall.cwd,data);
await request('stop',{task:codexTurn.body.id});await new Promise(r=>setTimeout(r,2200));
assert.equal(db.prepare('SELECT thread FROM tasks WHERE id=?').get(codexTurn.body.id).thread,'thread-forked');
const codexNext=await request('tasks',{project:p.id,prompt:'next',agent:'codex',previous:codexTurn.body.id});
const nextCall=(await until(async()=>{const ev=(await request('events?task='+codexNext.body.id)).body.events;return ev.find(e=>e.body.method==='test/thread-settings');})).body.params;assert.equal(nextCall.rpc,'thread/resume');assert.equal(nextCall.threadId,'thread-forked');
await request('stop',{task:codexNext.body.id});await new Promise(r=>setTimeout(r,2200));
delete process.env.CODEX_FAKE_THREADS;
// Key sessions: Remote Control ones in any folder; opening one attaches it to the closest project or a new project for its folder.
process.env.CLAUDE_CONFIG_DIR=data+'/claude-home';
const rcDir=mkdtempSync('/var/tmp/panel-rc-');
writeFileSync(folder+'/12121212-1212-4212-8212-121212121212.jsonl',line({type:'bridge-session',sessionId:'12121212-1212-4212-8212-121212121212'})+line({type:'user',cwd:rcDir,entrypoint:'cli',timestamp:new Date().toISOString(),message:{role:'user',content:'Опт: проверь заказы'}}));
const keys=(await request('agent-sessions/key?fresh=1')).body;const rcKey=keys.find(x=>x.id==='12121212-1212-4212-8212-121212121212');
assert.equal(rcKey.rc,true);assert.equal(rcKey.project,null);assert.equal(rcKey.attached,false);assert.ok(!keys.some(x=>x.id==='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
const opened=await request('agent-sessions/open',{agent:'claude',id:'12121212-1212-4212-8212-121212121212'});assert.equal(opened.status,201);assert.equal(opened.body.mode,'move');
const created=db.prepare('SELECT * FROM projects WHERE id=?').get(opened.body.project);assert.equal(created.cwd,rcDir);assert.equal(created.name,'Опт: проверь заказы');
assert.equal(db.prepare('SELECT source_session FROM tasks WHERE id=?').get(opened.body.task).source_session,'12121212-1212-4212-8212-121212121212');
const again=await request('agent-sessions/open',{agent:'claude',id:'12121212-1212-4212-8212-121212121212'});assert.equal(again.status,200);assert.equal(again.body.project,opened.body.project);
const keyAfter=(await request('agent-sessions/key')).body.find(x=>x.id==='12121212-1212-4212-8212-121212121212');assert.equal(keyAfter.attached,true);assert.equal(keyAfter.chain,db.prepare('SELECT session_id FROM tasks WHERE id=?').get(opened.body.task).session_id);assert.equal(keyAfter.working,false);
// Working: an open session whose turn has started and not ended. Ten minutes old, so only the open turn counts.
{const id='13131313-1313-4313-8313-131313131313',f=folder+'/'+id+'.jsonl',t=new Date(Date.now()-600000).toISOString();
 writeFileSync(f,line({type:'bridge-session',sessionId:id})+line({type:'user',cwd:rcDir,entrypoint:'cli',timestamp:t,message:{role:'user',content:'Долгая задача'}})+line({type:'assistant',cwd:rcDir,timestamp:t,message:{id:'x',content:[{type:'tool_use',id:'t',name:'Bash',input:{}}]}}));
 const holder=spawn(process.execPath,['-e','setTimeout(()=>{},30000)',id],{argv0:'claude'});await delay();
 assert.equal((await request('agent-sessions/key?fresh=1')).body.find(x=>x.id===id).working,true);
 writeFileSync(f,line({type:'system',subtype:'turn_duration',timestamp:t}),{flag:'a'});
 assert.equal((await request('agent-sessions/key?fresh=1')).body.find(x=>x.id===id).working,false);holder.kill();}
// A Remote Control background worker ("claude bg-spare", one argv string) keeps the newest session of its folder open, even idle.
{const id='14141414-1414-4414-8414-141414141414',dir=mkdtempSync('/var/tmp/panel-spare-');
 writeFileSync(folder+'/'+id+'.jsonl',line({type:'bridge-session',sessionId:id})+line({type:'user',cwd:dir,entrypoint:'cli',timestamp:'2026-10-05T10:00:00Z',message:{role:'user',content:'Розница'}}));
 const spare=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{argv0:'claude bg-spare',cwd:dir});await new Promise(r=>setTimeout(r,300));
 assert.equal((await request('agent-sessions/key?fresh=1')).body.find(x=>x.id===id).live,true);
 assert.equal((await request('agent-sessions/open',{agent:'claude',id})).body.mode,'fork');
 spare.kill();rmSync(dir,{recursive:true,force:true});}
// Mail to the whole project goes to the main session the owner picked; a reply to a letter a session sent under the
// project's address goes back to that session.
{const dir=mkdtempSync('/var/tmp/panel-route-');const rp=(await request('projects',{name:'route',cwd:dir})).body.find(x=>x.cwd===dir);const addr=mesh.mail.address(rp.id),at=new Date().toISOString();
 const seed=(id,chain)=>db.prepare("INSERT INTO tasks(id,project,thread,prompt,status,created,model,reasoning,permissions,agent,session_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id,rp.id,'thread-'+chain,'chat '+chain,'completed',at,'claude-test','high','workspace','claude',chain);
 seed('route-main','main-chain');seed('route-writer','writer-chain');
 assert.equal((await request('projects/main',{project:rp.id,address:'elsewhere:main-chain'})).status,400);
 assert.equal((await request('projects/main',{project:rp.id,address:'local:main-chain'})).body.main_session,'local:main-chain');
 const toProject=(await request('communication/messages',{recipient:addr,body:'Кто-нибудь из проекта',requestKey:'route-main'})).body;
 await dispatcher.tick();const d1=db.prepare('SELECT * FROM mail_dispatch WHERE message=?').get(toProject.id);assert.equal(d1.state,'running',JSON.stringify(d1));
 assert.equal(db.prepare('SELECT session_id FROM tasks WHERE id=?').get(d1.task).session_id,'main-chain','the main session took the project letter');
 await until(async()=>db.prepare('SELECT status FROM tasks WHERE id=?').get(d1.task).status==='running');await request('stop',{task:d1.task});await until(async()=>!['starting','running','stopping'].includes(db.prepare('SELECT status FROM tasks WHERE id=?').get(d1.task).status));await new Promise(r=>setTimeout(r,2200));
 db.prepare("INSERT INTO agent_messages(id,sender,recipient,body,created,request_key,kind,sender_session) VALUES ('route-q',?,'local:project-elsewhere','Вопрос',?,'route-q','request','local:writer-chain')").run(addr,at);
 db.prepare("INSERT INTO mail_dispatch(message,state,updated) VALUES ('route-q','completed',?)").run(at);
 db.prepare("INSERT INTO agent_messages(id,sender,recipient,body,created,request_key,kind,reply_to) VALUES ('route-a','local:project-elsewhere',?,'Ответ',?,'route-a','reply','route-q')").run(addr,new Date().toISOString());
 await dispatcher.tick();const d2=db.prepare('SELECT * FROM mail_dispatch WHERE message=?').get('route-a');assert.equal(d2.state,'running',JSON.stringify(d2));
 assert.equal(db.prepare('SELECT session_id FROM tasks WHERE id=?').get(d2.task).session_id,'writer-chain','the reply went back to the writer, not to the main session');
 await until(async()=>db.prepare('SELECT status FROM tasks WHERE id=?').get(d2.task).status==='running');await request('stop',{task:d2.task});await until(async()=>!['starting','running','stopping'].includes(db.prepare('SELECT status FROM tasks WHERE id=?').get(d2.task).status));await new Promise(r=>setTimeout(r,2200));
 assert.equal((await request('projects/main',{project:rp.id,address:null})).body.main_session,null);
 // A letter to a closed terminal session goes to its copy in the panel.
 {const uuid='78787878-7878-4878-8878-787878787878';mesh.external.register({session_id:uuid,cwd:dir,session_title:'Closed one',hook:true});
  db.prepare("INSERT INTO tasks(id,project,thread,prompt,status,created,model,reasoning,permissions,agent,session_id,fork,source_session) VALUES ('route-copy',?,?,?,?,?,?,?,?,?,?,?,?)").run(rp.id,'thread-copy','Сессия из терминала: Closed one','completed',at,'claude-test','high','workspace','claude','closed-copy-chain',1,uuid);
  db.prepare("INSERT INTO agent_messages(id,sender,recipient,body,created,request_key,kind) VALUES ('route-closed','local:project-elsewhere',?,'Тебе',?,'route-closed','request')").run('local:claude-'+uuid,new Date().toISOString());
  await dispatcher.tick();const d3=db.prepare('SELECT * FROM mail_dispatch WHERE message=?').get('route-closed');assert.equal(d3.state,'running',JSON.stringify(d3));
  assert.equal(db.prepare('SELECT session_id FROM tasks WHERE id=?').get(d3.task).session_id,'closed-copy-chain');
  await until(async()=>db.prepare('SELECT status FROM tasks WHERE id=?').get(d3.task).status==='running');await request('stop',{task:d3.task});await until(async()=>!['starting','running','stopping'].includes(db.prepare('SELECT status FROM tasks WHERE id=?').get(d3.task).status));await new Promise(r=>setTimeout(r,2200));
  db.prepare("DELETE FROM external_sessions WHERE id=?").run('claude-'+uuid);}
 await new Promise(r=>setTimeout(r,2200));rmSync(dir,{recursive:true,force:true});}
// Servers: the central panel lists its connected VPS and its SSH key for new ones; bad input is refused before any SSH.
{const r=await request('servers');assert.equal(r.status,200);assert.match(r.body.publicKey,/^ssh-ed25519 /);assert.ok(Array.isArray(r.body.nodes));
 assert.equal((await request('servers/connect',{name:'x',address:'bad host!'})).status,400);
 assert.equal((await request('servers/job?id=nope')).status,404);}
// Pictures the model shows in a chat: raster files for the signed-in owner; SVG, the panel's own files and relative paths are refused.
{const dir=mkdtempSync('/var/tmp/panel-img-');const png=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffffff7f0009fb03fd2a86e38a0000000049454e44ae426082','hex');
 writeFileSync(dir+'/variant.png',png);writeFileSync(dir+'/x.svg','<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
 const get=q=>fetch(base+'/api/files/image?path='+encodeURIComponent(q),{headers:{cookie}});
 const ok=await get(dir+'/variant.png');assert.equal(ok.status,200);assert.equal(ok.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await ok.arrayBuffer()),png);
 assert.equal((await get(dir+'/x.svg')).status,415);assert.equal((await get('variant.png')).status,400);assert.equal((await get(dir+'/missing.png')).status,404);
 writeFileSync(data+'/secret.png',png);assert.equal((await get(data+'/secret.png')).status,403);
 assert.equal((await fetch(base+'/api/files/image?path='+encodeURIComponent(dir+'/variant.png'))).status,401,'only for the signed-in owner');
 rmSync(dir,{recursive:true,force:true});}
// A panel chat forked from an open registered terminal session is a copy: it has only its own address, never the project mailbox.
{const dir=mkdtempSync('/var/tmp/panel-copy-');const cp=(await request('projects',{name:'copy',cwd:dir})).body.find(x=>x.cwd===dir);
 mesh.external.register({session_id:'56565656-5656-4656-8656-565656565656',cwd:dir,session_title:'api-worker',hook:true});
 const at=new Date().toISOString();db.prepare("INSERT INTO tasks(id,project,thread,prompt,status,created,agent,session_id,fork,source_session) VALUES ('copy-root',?,?,?,?,?,?,?,?,?)").run(cp.id,'56565656-5656-4656-8656-565656565656','Сессия из терминала: api-worker','completed',at,'claude','copy-chain',1,'56565656-5656-4656-8656-565656565656');
 db.prepare("INSERT INTO tasks(id,project,thread,prompt,status,created,agent,session_id) VALUES ('copy-turn',?,?,?,?,?,?,?)").run(cp.id,'fork-thread','turn','running',at,'claude','copy-chain');
 const original=spawn(process.execPath,['-e','setTimeout(()=>{},30000)','56565656-5656-4656-8656-565656565656'],{argv0:'claude'});await new Promise(r=>setTimeout(r,300));
 const list=await mesh.tool({host:'local',task:'copy-turn',signature:mesh.sign('copy-turn')},'projects_list',{});
 assert.equal(list.self,'local:copy-chain');assert.equal(list.selfName,'api-worker (копия в панели)');
 // Once the original is closed, the copy takes the project mailbox back.
 original.kill();await new Promise(r=>setTimeout(r,3500));
 const after=await mesh.tool({host:'local',task:'copy-turn',signature:mesh.sign('copy-turn')},'projects_list',{});
 assert.match(after.self,/^local:project-/);
 db.prepare("UPDATE tasks SET status='completed' WHERE id='copy-turn'").run();rmSync(dir,{recursive:true,force:true});}
// A request counts as answered when, after reading it, the recipient wrote back without replyTo.
{const now=Date.now(),iso=d=>new Date(now+d).toISOString();
 db.prepare("INSERT INTO agent_messages(id,sender,recipient,body,created,read_at,request_key,kind) VALUES ('req-implicit','node2:project-x','local:project-y','q',?,?,'rk-req-implicit','request')").run(iso(-60000),iso(-50000));
 db.prepare("INSERT INTO agent_messages(id,sender,recipient,body,created,request_key,kind) VALUES ('ans-implicit','local:project-y','node2:project-x','a',?,'rk-ans-implicit','request')").run(iso(-40000));
 db.prepare("INSERT INTO mail_dispatch(message,state,updated) VALUES ('req-implicit','queued',?)").run(iso(0));
 await dispatcher.tick();assert.equal(db.prepare("SELECT state FROM mail_dispatch WHERE message='req-implicit'").get().state,'completed');assert.ok(db.prepare("SELECT answered_at FROM agent_messages WHERE id='req-implicit'").get().answered_at);}
// Replies need no answer: once read, their delivery is complete instead of expiring.
{const now=new Date().toISOString(),addr=(await request('communication/projects')).body.projects.find(x=>x.project===p.id).id;
 db.prepare("INSERT INTO agent_messages(id,sender,recipient,body,created,read_at,request_key,kind) VALUES ('reply-read','node2:project-x',?,'ok',?,?,'rk-reply-read','reply')").run(addr,now,now);
 db.prepare("INSERT INTO mail_dispatch(message,state,updated) VALUES ('reply-read','queued',?)").run(now);
 await dispatcher.tick();assert.equal(db.prepare("SELECT state FROM mail_dispatch WHERE message='reply-read'").get().state,'completed');}
rmSync(rcDir,{recursive:true,force:true});delete process.env.CLAUDE_CONFIG_DIR;
await new Promise(resolve=>server.close(resolve));db.close();rmSync(data,{recursive:true,force:true});});
