import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {sessionWaker} from '../session-wake.mjs';
test('panel mail wakes the right Claude session in its tmux pane, once per message',async()=>{
 const dir=mkdtempSync(tmpdir()+'/panel-wake-'),sock=dir+'/tmux.sock',a='aaaaaaaa-1111-4111-8111-111111111111',b='bbbbbbbb-2222-4222-8222-222222222222';
 const t=(...args)=>execFileSync('tmux',['-S',sock,...args],{encoding:'utf8'});
 // Two "Claude" processes in the same folder, each in its own pane, each echoing what is typed.
 for(const [name,id] of [['one',a],['two',b]])t('new-session','-d','-s',name,'-c',dir,'-x','200','-y','20',`exec -a claude node -e 'process.stdout.write("❯ ");process.stdin.on("data",d=>process.stdout.write(d+"❯ "))' ${id}`);
 await new Promise(r=>setTimeout(r,500));
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE external_sessions(id TEXT PRIMARY KEY,cwd TEXT,name TEXT,permissions TEXT,seen TEXT)');
 db.prepare('INSERT INTO external_sessions VALUES (?,?,?,?,?)').run('claude-'+a,dir,'api-worker','workspace','2026-10-09T10:00:00Z');
 db.prepare('INSERT INTO external_sessions VALUES (?,?,?,?,?)').run('claude-'+b,dir,'staff','workspace','2026-10-09T11:00:00Z');
 const w=sessionWaker({db,env:{PANEL_TMUX_SOCKETS:sock}});
 try{
  // A reply goes to the session that wrote the original message, not to the most recently active one.
  assert.deepEqual(w.wake({cwd:dir,ids:[a],message:'m1',text:'wake-one'}),{session:a,name:'api-worker'});
  await new Promise(r=>setTimeout(r,300));
  assert.match(t('capture-pane','-p','-t','one'),/wake-one/);assert.doesNotMatch(t('capture-pane','-p','-t','two'),/wake-one/);
  assert.deepEqual(w.wake({cwd:dir,ids:[a],message:'m1',text:'wake-again'}),{already:true});
  // Without a known writer, the most recently active session of the folder.
  assert.equal(w.wake({cwd:dir,ids:[],message:'m2',text:'wake-two'}).name,'staff');
  assert.equal(w.wake({cwd:'/nowhere',ids:[],message:'m3',text:'x'}),null);
  // Mail addressed to one session wakes only that session; a session without a pane is not replaced by a neighbour.
  assert.deepEqual(w.wake({cwd:dir,ids:['dddddddd-4444-4444-8444-444444444444'],exact:true,message:'m4',text:'wake-exact'}),{nopane:true},'a known session with no terminal to type into is reported');
  await new Promise(r=>setTimeout(r,300));assert.doesNotMatch(t('capture-pane','-p','-t','two'),/wake-exact/);
  // The owner's message from the panel chat is pasted into that session's pane, line breaks included.
  assert.equal(await w.say({id:b,text:'первая строка\nвторая строка'}),true);await new Promise(r=>setTimeout(r,300));
  const pane=t('capture-pane','-p','-t','two');assert.match(pane,/первая строка/);assert.match(pane,/вторая строка/);assert.doesNotMatch(t('capture-pane','-p','-t','one'),/первая строка/);
  assert.equal(await w.say({id:'cccccccc-3333-4333-8333-333333333333',text:'x'}),false);
  // A long message goes through stdin, past tmux's command length limit.
  const long='я'.repeat(12000);assert.equal(await w.say({id:b,text:long}),true);
  // The owner's unsent draft (or a permission dialog) is never typed over or answered.
  t('send-keys','-t','one','-l','черновик владельца');await new Promise(r=>setTimeout(r,300));
  assert.deepEqual(await w.say({id:a,text:'чужой текст'}),{draft:'черновик владельца'});assert.equal(w.wake({cwd:dir,ids:[a],message:'m5',text:'wake-busy'}),null);
  await new Promise(r=>setTimeout(r,200));assert.doesNotMatch(t('capture-pane','-p','-t','one'),/чужой текст|wake-busy/);
  // Claude Code's prompt sign is followed by a no-break space: text after it is a draft, not a dialog.
  const nb='12345678-8888-4888-8888-888888888888';
  t('new-session','-d','-s','nbsp','-c',dir,'-x','200','-y','20',`exec -a claude node -e 'process.stdout.write("❯\u00a0[Image #6]Приложенные файлы\\n────────\\n");setInterval(()=>{},1000)' ${nb}`);await new Promise(r=>setTimeout(r,500));
  assert.deepEqual(await w.say({id:nb,text:'x'}),{draft:'[Image #6]Приложенные файлы'});
  // With the owner's consent the leftover text is cleared and the message goes in; files follow the text as paths.
  assert.equal(await w.say({id:a,text:'замена',files:[{name:'shot.png',path:'/tmp/shot.png'}],replace:true}),true);
  {const pane=t('capture-pane','-p','-t','one');assert.match(pane,/замена/);assert.match(pane,/- shot\.png: \/tmp\/shot\.png/);}
  // A prompt that swallows Enter (Claude Code still attaching an image) gets Enter again; one that never empties is reported.
  const slow='ffffffff-6666-4666-8666-666666666666',stuck='abababab-7777-4777-8777-777777777777';
  writeFileSync(dir+'/slow.js',`let n=0,buf="";process.stdin.setRawMode(true);process.stdout.write("❯ ");process.stdin.on("data",d=>{const s=d.toString();if(s==="\\r"){if(++n<2||${JSON.stringify('NEVER')}===process.argv[2])return;process.stdout.write("\\r\\n"+buf+"\\r\\n❯ ");buf="";return;}buf+=s.replace(/\\x1b\\[20[01]~/g,"");process.stdout.write(s.replace(/\\x1b\\[20[01]~/g,""));})`);
  t('new-session','-d','-s','slow','-c',dir,'-x','200','-y','20',`exec -a claude node ${dir}/slow.js ${slow}`);
  t('new-session','-d','-s','stuck','-c',dir,'-x','200','-y','20',`exec -a claude node ${dir}/slow.js NEVER ${stuck}`);await new Promise(r=>setTimeout(r,600));
  assert.equal(await w.say({id:slow,text:'с картинкой'}),true);assert.match(t('capture-pane','-p','-t','slow'),/с картинкой\s*\n❯/);
  assert.equal(await w.say({id:stuck,text:'не уйдёт'}),'stuck');
  // A question on the session's screen: parsed into options, answered with arrow keys from the highlighted option.
  const q='eeeeeeee-5555-4555-8555-555555555555',keys=dir+'/keys.log';
  const screen=['────────',' ☐ Проверка','│ Как проверить диалог?','❯ 1. Браузер (Recommended)','     Ложный микрофон.','  2. Новый APK','  3. Оба варианта','  4. Type something.','────────','  5. Chat about this','Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\\n');
  writeFileSync(dir+'/dialog.js',`process.stdout.write("${screen}");process.stdin.setRawMode(true);process.stdin.on("data",d=>require("fs").appendFileSync(${JSON.stringify(keys)},d.toString("hex")+" "))`);
  t('new-session','-d','-s','ask','-c',dir,'-x','200','-y','30',`exec -a claude node ${dir}/dialog.js ${q}`);await new Promise(r=>setTimeout(r,600));
  const d=w.dialog(q);assert.equal(d.question,'Как проверить диалог?');assert.equal(d.title,'Проверка');assert.deepEqual(d.options.map(o=>o.n),[1,2,3,4,5]);assert.equal(d.options[0].description,'Ложный микрофон.');assert.equal(d.free,3);
  assert.equal(w.answer({id:q,option:3,expect:'Другой вопрос'}),'changed');
  assert.equal(w.answer({id:q,option:3,expect:d.question}),true);await new Promise(r=>setTimeout(r,300));
  assert.equal(readFileSync(keys,'utf8').trim(),'1b5b42 1b5b42 0d');
  assert.equal(w.dialog(a),null,'a plain prompt is not a dialog');
  // The options identify the dialog (the text above them can hold a running command's timer); unnumbered choices parse too.
  assert.equal(w.answer({id:q,option:1,expect:'Совсем другие|варианты'}),'changed');
  const trust=w.parseDialog(' Quick safety check: Is this a project you trust?\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel\n');
  assert.deepEqual(trust.options.map(o=>o.label),['No, exit','Yes, I trust this folder']);assert.equal(trust.selected,0);
  // The review step of a multi-question prompt has no key hints; its numbered choice still makes it a dialog, the chosen answers show.
  const review=w.parseDialog('────────\n←  ☒ Демо  ✔ Submit  →\nReview your answers\n ● Какой кабинет?\n   → Кабинет продавца\nReady to submit your answers?\n❯ 1. Submit answers\n  2. Cancel\n──────── api-worker ─\n');
  assert.deepEqual(review.options.map(o=>o.label),['Submit answers','Cancel']);assert.match(review.question,/→ Кабинет продавца/);
  assert.equal(w.parseDialog('● План:\n  1. Первое\n  2. Второе\n────────\n❯ \n────────\n'),null,'a numbered list in an answer is not a dialog');
 }finally{try{t('kill-server');}catch{}rmSync(dir,{recursive:true,force:true});}
});
