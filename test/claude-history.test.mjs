import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,utimesSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {claudeSessions} from '../claude-sessions.mjs';

test('owner prompts stay visible: queued prompts, long tool runs, non-Claude processes with the id',async()=>{
 const home=mkdtempSync(tmpdir()+'/claude-history-'),cwd=mkdtempSync(tmpdir()+'/claude-history-cwd-');
 process.env.CLAUDE_CONFIG_DIR=home;
 const id='77777777-7777-4777-8777-777777777777',line=o=>JSON.stringify(o)+'\n',at=i=>new Date(Date.UTC(2026,9,10,8,0,i)).toISOString();
 const folder=home+'/projects/'+cwd.replace(/[^a-zA-Z0-9]/g,'-');mkdirSync(folder,{recursive:true});
 let body=line({type:'user',cwd,timestamp:at(0),message:{role:'user',content:'Первая задача'}});
 // A long run of commands after the prompt.
 for(let i=1;i<60;i++)body+=line({type:'assistant',cwd,timestamp:at(i),message:{id:'a'+i,content:[{type:'tool_use',name:'Bash',input:{description:'step '+i}}]}});
 // Typed while the model was working: stored as a queued command attachment.
 body+=line({type:'attachment',cwd,timestamp:at(61),attachment:{type:'queued_command',prompt:'Добавь ещё проверку'}});
 body+=line({type:'attachment',cwd,timestamp:at(62),attachment:{type:'queued_command',prompt:'<cross-session-message from="x">чужое</cross-session-message>'}});
 // A long message pasted into the terminal arrives wrapped in <pasted_content>: it is still the owner's message.
 body+=line({type:'user',cwd,timestamp:at(62),message:{role:'user',content:'\n\n<pasted_content id="4d2d">\nДлинный вставленный текст\n</pasted_content id="4d2d">\n'}});
 body+=line({type:'assistant',cwd,timestamp:at(63),message:{id:'z',content:[{type:'text',text:'Готово'}]}});
 writeFileSync(folder+'/'+id+'.jsonl',body);
 try{
  const s=claudeSessions();
  const h=s.history(id,40,{tools:true});
  assert.deepEqual(h.messages.filter(m=>m.role==='user').map(m=>m.text),['Первая задача','Добавь ещё проверку','Длинный вставленный текст']);
  assert.ok(h.messages.filter(m=>m.role==='tool').length<=6,'only the latest steps between two messages');
  // A program that only carries the id (a dev server started from the session's shell) does not keep it open.
  const other=spawn('/bin/sh',['-c','sleep 30; echo '+id]);await new Promise(r=>setTimeout(r,300));
  assert.equal(s.live(id),false);other.kill();
  const holder=spawn(process.execPath,['-e','setTimeout(()=>{},30000)',id],{argv0:'claude'});await new Promise(r=>setTimeout(r,300));
  assert.equal(s.live(id),true);holder.kill();
  // Background work still running: launched commands, agents and monitors without their completion notice.
  const bg='99999999-9999-4999-8999-999999999999',ts=new Date(Date.now()-60000).toISOString(),use=(id,name,input)=>line({type:'assistant',cwd,timestamp:ts,message:{id:'u'+id,content:[{type:'tool_use',id,name,input}]}}),res=(id,text)=>line({type:'user',cwd,timestamp:ts,message:{role:'user',content:[{type:'tool_result',tool_use_id:id,content:text}]}});
  writeFileSync(folder+'/'+bg+'.jsonl',line({type:'user',cwd,timestamp:ts,message:{role:'user',content:'Запусти'}})
   +use('t1','Bash',{command:'npm test',description:'Run tests',run_in_background:true})+res('t1','Command running in background with ID: b1. Output is being written to: /tmp/b1.output.')
   +use('t2','Bash',{command:'sleep 1',description:'Short wait',run_in_background:true})+res('t2','Command running in background with ID: b2. Output is being written to: /tmp/b2.output.')
   +use('t3','Agent',{description:'Review',prompt:'x'})+res('t3',[{type:'text',text:'Async agent launched successfully.\nagentId: a3 (internal)'}])
   +use('t4','Monitor',{command:'tail -f log',description:'Watch log'})+res('t4','Monitor started (task m4, expires in 30m unless the source ends first).')
   +line({type:'user',cwd,timestamp:ts,message:{role:'user',content:'<task-notification>\n<task-id>b2</task-id>\n<status>completed</status>\n</task-notification>'}}));
  const holder2=spawn(process.execPath,['-e','setTimeout(()=>{},30000)',bg],{argv0:'claude'});await new Promise(r=>setTimeout(r,300));
  assert.deepEqual(s.history(bg,40).session.background.map(t=>[t.id,t.kind,t.title]),[['b1','command','Run tests'],['a3','agent','Review'],['m4','monitor','Watch log']]);
  holder2.kill();await new Promise(r=>setTimeout(r,300));assert.deepEqual(s.history(bg,40).session.background,[],'a closed session has no background work');
  // The panel's mail nudge is not what a session works on: it never becomes its name or topic.
  const nudged='abababab-abab-4bab-8bab-abababababab';
  writeFileSync(folder+'/'+nudged+'.jsonl',line({type:'user',cwd,timestamp:at(0),message:{role:'user',content:'Межпроектная связь панели: новое сообщение от «Сайт» (id x). Прочитай inbox_read'}})+line({type:'user',cwd,timestamp:at(1),message:{role:'user',content:'Разбери переписку клиентов'}}));
  assert.equal(s.find(nudged).title,'Разбери переписку клиентов');assert.equal(s.find(nudged).lastPrompt,'Разбери переписку клиентов');
  // Claude compacts an idle session and writes the summary as a user entry: that is not a new turn.
  const idle='88888888-8888-4888-8888-888888888888';
  writeFileSync(folder+'/'+idle+'.jsonl',line({type:'user',cwd,timestamp:at(0),message:{role:'user',content:'Задача'}})+line({type:'assistant',cwd,timestamp:at(1),message:{id:'q',content:[{type:'text',text:'Сделано'}]}})+line({type:'system',subtype:'turn_duration',timestamp:at(2)})
   +line({type:'system',subtype:'compact_boundary',timestamp:at(3)})+line({type:'user',cwd,isCompactSummary:true,isVisibleInTranscriptOnly:true,timestamp:at(3),message:{role:'user',content:'This session is being continued from a previous conversation.'}}));
  assert.equal(s.find(idle).turnOpen,false);
  writeFileSync(folder+'/'+idle+'.jsonl',line({type:'user',cwd,timestamp:at(4),message:{role:'user',content:'Новая задача'}}),{flag:'a'});
  assert.equal(s.find(idle).turnOpen,true);
  // An input nobody picked up (a notification injected when the daemon restarts the session) stops counting after 5 quiet minutes.
  const stale=Date.now()/1000-600;utimesSync(folder+'/'+idle+'.jsonl',stale,stale);assert.equal(s.find(idle).turnOpen,false);
 }finally{rmSync(home,{recursive:true,force:true});rmSync(cwd,{recursive:true,force:true});}
});
