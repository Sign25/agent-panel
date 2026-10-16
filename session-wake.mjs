import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
// Waking an external Claude session (Remote Control in tmux) when panel mail waits for it: those sessions read
// their inbox only when a turn starts, so the panel types one short line into the session's own tmux pane.
// Services run with PrivateTmp, so the host's tmux socket is reached through /proc/1/root.
export function sessionWaker({db,env=process.env}){
 // Tests never touch the real tmux of the machine unless they pass their own socket.
 const sockets=()=>(env.PANEL_TEST==='1'&&!env.PANEL_TMUX_SOCKETS?[]:env.PANEL_TMUX_SOCKETS?env.PANEL_TMUX_SOCKETS.split(':'):[0,1000].flatMap(uid=>['/proc/1/root/tmp/tmux-'+uid+'/default','/tmp/tmux-'+uid+'/default'])).filter(s=>{try{return existsSync(s);}catch{return false;}});
 // stderr stays out of the service journal: a socket left behind by a closed tmux server is normal.
 const tmux=(sock,args)=>execFileSync('tmux',['-S',sock,...args],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']});
 function panes(){const out=[];for(const sock of [...new Set(sockets())]){try{for(const line of tmux(sock,['list-panes','-a','-F','#{pane_id} #{pane_pid}']).trim().split('\n')){const [pane,pid]=line.split(' ');if(pane)out.push({sock,pane,pid:Number(pid)});}}catch{}}return out;}
 function parent(pid){try{const s=readFileSync('/proc/'+pid+'/stat','utf8');return Number(s.slice(s.lastIndexOf(')')+2).split(' ')[1]);}catch{return 0;}}
 function paneOf(pid,list){const seen=new Set();for(let p=pid;p>1&&!seen.has(p);p=parent(p)){seen.add(p);const hit=list.find(x=>x.pid===p);if(hit)return hit;}return null;}
 // Processes of a session: claude processes started with its id. A Remote Control server or bg-spare worker has no
 // terminal prompt of its own, so it cannot be typed into.
 function processes(match){const out=[];for(const pid of readdirSync('/proc')){if(!/^\d+$/.test(pid))continue;let line,cwd;try{line=readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0').join(' ');if(!/(^|\/)claude(\s|$)/.test(line.split(' ')[0]+' '))continue;cwd=realpathSync('/proc/'+pid+'/cwd');}catch{continue;}if(/(^|\/)claude(\s|$)/.test(line.split(' ')[0]+' ')&&match(line,cwd))out.push(Number(pid));}return out;}
 // What is typed after the prompt sign: '' for an empty prompt, null when no prompt is visible or a dialog waits.
 function promptText(p){
  let screen;try{screen=execFileSync('tmux',['-S',p.sock,'capture-pane','-e','-p','-t',p.pane],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']});}catch{return null;}
  const lines=screen.split('\n').map(l=>l.replace(/\x1b\[2m.*?(?=\x1b\[(0|22)?m|$)/g,'').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g,'').replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'').replace(/[│┃]/g,'').trimEnd()).filter(l=>l.trim()).slice(-24);
  if(lines.slice(-12).some(l=>/Do you want to|Esc to cancel|❯\s*\d+\./.test(l)))return null;
  // Claude Code puts a no-break space after the prompt sign.
  const at=lines.findLastIndex(l=>/^\s*[❯>](\s|$)/.test(l));if(at<0)return null;
  // The input box: the prompt line and its continuation lines up to the rule under the box.
  const box=[lines[at].replace(/^\s*[❯>]\s?/,'')];for(const l of lines.slice(at+1)){if(/^\s*[─━]{8,}/.test(l))break;box.push(l.trim());}
  return box.join('\n').trim();
 }
 // Typing is safe only into an empty prompt: never while a permission dialog waits (Enter or a digit would answer it)
 // and never on top of the owner's unsent draft. Dim text after the prompt sign is Claude's own suggestion, not a draft.
 const idle=p=>promptText(p)==='';
 const pause=ms=>new Promise(r=>setTimeout(r,ms));
 async function until(fn,ms){for(const end=Date.now()+ms;Date.now()<end;){const v=fn();if(v)return v;await pause(250);}return fn();}
 const woke=new Map(),missed=new Map();
 const prune=()=>{const old=Date.now()-1800000;for(const m of [woke,missed])for(const [k,t] of m)if(t<old)m.delete(k);};
 // ids: candidate session uuids, most likely first; exact: only those (mail addressed to one session).
 // Returns the session that was woken, or null. A miss is retried after a minute, not on every dispatcher pass.
 function wake({cwd,ids=[],exact=false,message,text}){
  const last=woke.get(message);if(last&&Date.now()-last<1800000)return {already:true};
  const miss=missed.get(message);if(miss&&Date.now()-miss<60000)return null;
  prune();missed.set(message,Date.now());
  // Known candidate sessions and no pane for any of them: nothing to type into. Reported, so the caller can choose another
  // way; with no known session at all the answer stays "unknown" (null).
  const known=db.prepare("SELECT id,name FROM external_sessions WHERE cwd=? ORDER BY seen DESC").all(cwd).map(s=>({id:s.id.replace(/^claude-/,''),name:s.name}));
  const candidates=[...ids.map(id=>({id,name:known.find(k=>k.id===id)?.name||id.slice(0,8)})),...(exact?[]:known.filter(k=>!ids.includes(k.id)))];
  const list=panes();if(!list.length)return candidates.length?{nopane:true}:null;
  let sawPane=false;
  for(const c of candidates){
   for(const pid of processes(line=>line.includes(c.id))){const p=paneOf(pid,list);if(!p)continue;sawPane=true;
    if(!idle(p))return null;
    try{tmux(p.sock,['send-keys','-t',p.pane,'-l',text]);tmux(p.sock,['send-keys','-t',p.pane,'Enter']);woke.set(message,Date.now());missed.delete(message);return {session:c.id,name:c.name};}catch{}}
  }
  return sawPane||!candidates.length?null:{nopane:true};
 }
 // Typing the owner's message into an open session (the panel chat of a Remote Control session). Bracketed paste keeps
 // line breaks inside one prompt. Claude Code turns a pasted image path into an image and needs a moment for it: an Enter
 // sent at once is lost, so the text has to show up in the prompt first, and the prompt has to empty after Enter.
 // Returns true, 'busy' (a dialog), {draft} (unsent text in the prompt; replace clears it first), 'stuck' or false (no pane).
 async function say({id,text,files=[],replace=false}){
  const list=panes();
  for(const pid of processes(line=>line.includes(id))){const p=paneOf(pid,list);if(!p)continue;
   let now=promptText(p);if(now===null)return 'busy';
   if(now){if(!replace)return {draft:now};
    for(let i=0;i<12&&now;i++){tmux(p.sock,['send-keys','-t',p.pane,'C-u']);await pause(120);now=promptText(p);}
    if(now!=='')return now===null?'busy':{draft:now};}
   // Text first, then the file paths: each paste lands before the next one.
   for(const part of [text,files.length?'Приложенные файлы:\n'+files.map(f=>'- '+f.name+': '+f.path).join('\n'):''].filter(Boolean)){
    // load-buffer reads stdin: a long message does not hit tmux's command length limit.
    execFileSync('tmux',['-S',p.sock,'load-buffer','-b','panel-say','-'],{input:(promptText(p)?'\n':'')+part,timeout:5000,stdio:['pipe','ignore','ignore']});
    tmux(p.sock,['paste-buffer','-p','-d','-b','panel-say','-t',p.pane]);
    let last=null;await until(()=>{const v=promptText(p);const stable=v&&v===last;last=v;return stable;},6000);
   }
   for(let i=0;i<3;i++){tmux(p.sock,['send-keys','-t',p.pane,'Enter']);if(await until(()=>promptText(p)==='',4000))return true;}
   return 'stuck';}
  return false;
 }
 // A choice dialog on the session's screen (a question from the model, a permission prompt). Claude writes the question
 // into the session file only after it is answered, so the screen is the only source while it waits.
 function paneFor(id){const list=panes();for(const pid of processes(line=>line.includes(id))){const p=paneOf(pid,list);if(p)return p;}return null;}
 function screen(p){try{return execFileSync('tmux',['-S',p.sock,'capture-pane','-p','-t',p.pane],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']});}catch{return '';}}
 function parseDialog(text){
  const lines=text.split('\n').map(l=>l.replace(/\s+$/,''));let end=lines.length-1;while(end>=0&&!lines[end].trim())end--;
  // A dialog ends with its key hints; the review step of a multi-question prompt ("Ready to submit your answers?") has none,
  // so a highlighted numbered option among the last lines counts too.
  const foot=lines.slice(Math.max(0,end-4),end+1).join('\n');
  if(!/Enter to (select|confirm)|Esc to cancel/.test(foot)&&!lines.slice(Math.max(0,end-8),end+1).some(l=>/^\s*❯\s*\d+\.\s/.test(l)))return null;
  // Options: "❯ 1. Label" / "  2. Label" with indented description lines; the block starts after the last rule above them.
  let first=-1;for(let i=end;i>=0;i--){if(/^\s*(❯\s*)?1\.\s/.test(lines[i])){first=i;break;}}
  const options=[];let selected=0;
  if(first>=0)for(let i=first;i<=end;i++){const m=lines[i].match(/^\s*(❯\s*)?(\d+)\.\s+(.*)$/);
   if(m){if(m[1])selected=options.length;options.push({n:Number(m[2]),label:m[3].replace(/\s*✔$/,'').trim(),description:''});continue;}
   const t=lines[i].trim();if(!t||/^[─━╌]+/.test(t)||/Enter to (select|confirm)|Esc to cancel/.test(t))continue;
   if(options.length)options.at(-1).description=(options.at(-1).description+' '+t).trim();}
  else{
   // Unnumbered choices ("❯ No, exit / Yes, I trust this folder"): the cursor line and its neighbours at the same column.
   let cursor=-1;for(let i=end;i>=0;i--){if(/^\s*❯\s+\S/.test(lines[i])){cursor=i;break;}}if(cursor<0)return null;
   const col=lines[cursor].search(/❯/)+lines[cursor].slice(lines[cursor].search(/❯/)+1).search(/\S/)+1;
   const at=l=>l.length>col&&/\S/.test(l[col])&&!/\S/.test(l.slice(0,col).replace('❯',''));
   first=cursor;while(first>0&&at(lines[first-1]))first--;let last=cursor;while(last<end&&at(lines[last+1]))last++;
   for(let i=first;i<=last;i++){if(i===cursor)selected=options.length;options.push({n:options.length+1,label:lines[i].slice(col).trim(),description:''});}
   if(options.length<2)return null;
  }
  let top=first-1;const head=[];while(top>=0&&!/^\s*[─━]{8,}/.test(lines[top])){const t=lines[top].replace(/^\s*[│|]\s?/,'').trim();if(!/^[╌─━]+$/.test(t))head.unshift(t);top--;}
  const title=head.find(l=>/^[☐☒✔]/.test(l))?.replace(/^[☐☒✔]\s*/,'')||'';const question=head.filter(l=>l&&!/^[☐☒✔←]/.test(l)).join(' ').trim().slice(0,900);
  const free=options.findIndex(o=>/^Type something/i.test(o.label));
  return {kind:/Do you want/i.test(question)?'permission':'question',title,question,options:options.map(({n,label,description})=>({n,label,description})),selected,free};
 }
 function dialog(id){const p=paneFor(id);return p?parseDialog(screen(p)):null;}
 // Answering moves the cursor with the arrow keys from the highlighted option and confirms; a free answer is typed
 // into the "Type something" option. The screen is read again first, so a changed dialog is never answered blindly.
 function answer({id,option,text,expect}){
  const p=paneFor(id);if(!p)return 'gone';const d=parseDialog(screen(p));if(!d)return 'gone';
  // The options identify the dialog; the text above them may hold a running command's timer that changes every second.
  if(expect&&expect!==d.options.map(o=>o.label).join('|')&&expect!==d.question)return 'changed';
  const target=text!=null?d.free:d.options.findIndex(o=>o.n===Number(option));if(target<0)return 'invalid';
  const keys=target>d.selected?Array(target-d.selected).fill('Down'):Array(d.selected-target).fill('Up');
  for(const k of keys)tmux(p.sock,['send-keys','-t',p.pane,k]);
  if(text!=null)tmux(p.sock,['send-keys','-t',p.pane,'-l',String(text).replace(/[\r\n]+/g,' ')]);
  tmux(p.sock,['send-keys','-t',p.pane,'Enter']);return true;
 }
 // Whether an open session has a terminal the panel can type into (tmux); without one, only its copy can answer.
 function typable(id){return Boolean(paneFor(id));}
 return {wake,say,dialog,answer,parseDialog,typable};
}
