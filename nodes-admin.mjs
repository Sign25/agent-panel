import {spawn} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync,chmodSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
// Connecting a VPS from the panel: the owner adds the panel's SSH key to the server, the panel checks it, installs the
// execution node (/opt/agent-panel-node), starts it and keeps an SSH tunnel to it. One job per server, with visible steps.
const CODE=['server.mjs','nodes-admin.mjs','config.mjs','federation.mjs','project-mail.mjs','session-wake.mjs','external-sessions.mjs','claude-sessions.mjs','claude-worker.mjs','claude-events.mjs','claude-session-bridge.mjs','mail-mcp.mjs','password.mjs','package.json','package-lock.json','agents','public'];
const NODE_DIR='/opt/agent-panel-node',NODE_PORT=8788,NODE_MAIL_PORT=18789;
export function nodesAdmin({root,data,origin,centralPort,nodes,run=runProcess,systemdDir='/etc/systemd/system',systemctl=args=>run('systemctl',args,{timeout:30000}),fetchInfo=defaultFetchInfo,isFree=portFree}){
 const keyFile=path.join(data,'ssh','id_ed25519'),jobs=new Map();
 async function publicKey(){
  if(!existsSync(keyFile)){mkdirSync(path.dirname(keyFile),{recursive:true,mode:0o700});await run('ssh-keygen',['-q','-t','ed25519','-N','','-C','agent-panel','-f',keyFile],{timeout:20000});}
  return readFileSync(keyFile+'.pub','utf8').trim();
 }
 const sshArgs=t=>['-i',keyFile,'-p',String(t.port),'-o','BatchMode=yes','-o','StrictHostKeyChecking=accept-new','-o','UserKnownHostsFile='+path.join(data,'ssh','known_hosts'),'-o','ConnectTimeout=10',t.user+'@'+t.address];
 const ssh=(t,command,opts={})=>run('ssh',[...sshArgs(t),command],{timeout:opts.timeout||60000,input:opts.input});
 function slug(name){const base=String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,24)||'vps';let id=base,i=2;while(id==='local'||nodes().some(n=>n.id===id))id=base+'-'+i++;return id;}
 async function freePort(){const used=nodes().map(n=>Number(String(n.endpoint).split(':').pop())).filter(Boolean);let p=Math.max(18786,...used)+2;while(!(await isFree(p)))p+=2;return p;}
 function validate(b){
  const t={name:String(b.name||'').trim().slice(0,40),address:String(b.address||'').trim(),user:String(b.user||'root').trim(),port:Number(b.port||22)};
  if(!t.name)throw Error('Укажите название сервера');
  if(!/^[A-Za-z0-9.:-]{3,253}$/.test(t.address))throw Error('Укажите адрес сервера: IP или имя хоста');
  if(!/^[a-z_][a-z0-9_-]{0,31}$/.test(t.user))throw Error('Некорректное имя пользователя SSH');
  if(t.user!=='root')throw Error('Нужен вход под root: узел ставит службу systemd');
  if(!Number.isInteger(t.port)||t.port<1||t.port>65535)throw Error('Некорректный порт SSH');
  if(nodes().some(n=>n.address===t.address))throw Error('Этот сервер уже подключён');
  return t;
 }
 function connect(body){
  const target=validate(body),job={id:randomBytes(8).toString('hex'),target,status:'running',steps:[],node:null,error:null,started:new Date().toISOString()};jobs.set(job.id,job);
  const step=async(title,fn)=>{const s={title,state:'running',detail:''};job.steps.push(s);try{const r=await fn(s);s.state='done';return r;}catch(e){s.state='failed';s.detail=String(e.message||e).slice(-600);throw e;}};
  (async()=>{
   try{
    await publicKey();
    const facts=await step('Доступ по SSH и проверка сервера',async s=>{
     const out=await ssh(target,'echo panel-ok; uname -s; (node -v || true); (command -v npm || true); (command -v claude || ls /root/.local/bin/claude /usr/local/bin/claude /usr/bin/claude 2>/dev/null | head -1 || true); (command -v node || true)');
     const lines=out.split('\n').map(x=>x.trim());if(lines[0]!=='panel-ok')throw Error('Сервер не ответил');
     const nodeVersion=lines.find(l=>/^v\d+\./.test(l)),major=Number(nodeVersion?.slice(1).split('.')[0]),minor=Number(nodeVersion?.split('.')[1]);
     if(!nodeVersion||major<22||major===22&&minor<13)throw Error('Нужен Node.js 22.13 или новее (сейчас: '+(nodeVersion||'не установлен')+')');
     const npm=lines.find(l=>/\/npm$/.test(l));if(!npm)throw Error('Не найден npm');
     const claude=lines.find(l=>/\/claude$/.test(l));if(!claude)throw Error('Не найден Claude Code: установите его и войдите (claude auth login)');
     const nodeBin=lines.filter(l=>/\/node$/.test(l)).at(-1)||'/usr/bin/node';
     s.detail=[lines[1],nodeVersion,claude].join(' · ');return {claude,nodeBin};
    });
    const id=slug(target.name),localPort=await freePort(),token=randomBytes(32).toString('hex');
    await step('Установка узла панели',async()=>{
     const tar=await run('tar',['-czf','-','-C',root,...CODE],{timeout:60000,binary:true});
     await ssh(target,`mkdir -p ${NODE_DIR}/data && chmod 700 ${NODE_DIR}/data && tar -xzf - -C ${NODE_DIR}`,{input:tar,timeout:120000});
     await ssh(target,`cd ${NODE_DIR} && npm ci --omit=dev --no-audit --no-fund --loglevel=error`,{timeout:900000});
     await ssh(target,`umask 077 && cat > ${NODE_DIR}/data/node-token`,{input:token});
    });
    await step('Служба узла и хуки сессий Claude',async()=>{
     const unit=`[Unit]\nDescription=Agent panel execution node (${id})\nAfter=network-online.target\nWants=network-online.target\n[Service]\nUser=root\nWorkingDirectory=${NODE_DIR}\nEnvironment=HOME=/root\nEnvironment=PATH=/root/.local/bin:/usr/local/bin:/usr/bin:/bin\nEnvironment=PANEL_NODE_MODE=1\nEnvironment=PANEL_NODE_ID=${id}\nEnvironment="PANEL_NODE_NAME=${target.name.replace(/[^\p{L}\p{N} ._-]/gu,'')}"\nEnvironment=PANEL_NODE_ADDRESS=${target.address}\nEnvironment=PANEL_AGENTS=claude\nEnvironment=PANEL_PORT=${NODE_PORT}\nEnvironment=CLAUDE_BIN=${facts.claude}\nEnvironment=PANEL_MAIL_URL=http://127.0.0.1:${NODE_MAIL_PORT}\nEnvironment=PANEL_ORIGIN=${origin}\nExecStart=${facts.nodeBin} ${NODE_DIR}/server.mjs\nRestart=on-failure\nRestartSec=5\nKillMode=control-group\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\n[Install]\nWantedBy=multi-user.target\n`;
     await ssh(target,'cat > /etc/systemd/system/agent-panel-node.service && systemctl daemon-reload && systemctl enable --now agent-panel-node.service',{input:unit});
     // Two hooks let terminal sessions on the server read and send panel mail; existing settings are kept, a copy is saved.
     const hooks=`const fs=require('fs'),p='/root/.claude/settings.json';const raw=fs.existsSync(p)?fs.readFileSync(p,'utf8'):'{}';const d=JSON.parse(raw);if(fs.existsSync(p))fs.copyFileSync(p,'${NODE_DIR}/data/claude-settings-before-panel.json');const command='${facts.nodeBin} ${NODE_DIR}/claude-session-bridge.mjs hook';for(const e of ['SessionStart','UserPromptSubmit']){const list=((d.hooks??={})[e]??=[]);if(!list.some(x=>(x.hooks||[]).some(h=>h.command===command)))list.push({hooks:[{type:'command',command,timeout:3}]});}fs.mkdirSync('/root/.claude',{recursive:true});fs.writeFileSync(p+'.panel-next',JSON.stringify(d,null,2)+'\\n',{mode:0o600});fs.renameSync(p+'.panel-next',p);`;
     await ssh(target,`${facts.nodeBin} -e "$(cat)"`,{input:hooks});
     for(let i=0;i<20;i++){try{const r=await ssh(target,`curl -fsS -H 'X-Panel-Node-Token: ${token}' http://127.0.0.1:${NODE_PORT}/api/node-info`);if(r.includes('"agents"'))return;}catch{}await sleep(1500);}
     throw Error('Узел не отвечает после запуска: journalctl -u agent-panel-node');
    });
    await step('Туннель и регистрация в панели',async()=>{
     mkdirSync(path.join(data,'node-keys'),{recursive:true,mode:0o700});const tokenFile=path.join(data,'node-keys',id+'.token');writeFileSync(tokenFile,token,{mode:0o600});
     const unit=`[Unit]\nDescription=Panel connection to ${id} execution node\nAfter=network-online.target\nWants=network-online.target\n[Service]\nType=simple\nExecStart=/usr/bin/ssh -N -T -i ${keyFile} -p ${target.port} -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${path.join(data,'ssh','known_hosts')} -o ConnectTimeout=10 -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -L 127.0.0.1:${localPort}:127.0.0.1:${NODE_PORT} -R 127.0.0.1:${NODE_MAIL_PORT}:127.0.0.1:${centralPort} ${target.user}@${target.address}\nRestart=always\nRestartSec=5\n[Install]\nWantedBy=multi-user.target\n`;
     writeFileSync(path.join(systemdDir,'panel-'+id+'-tunnel.service'),unit,{mode:0o644});
     await systemctl(['daemon-reload']);await systemctl(['enable','--now','panel-'+id+'-tunnel.service']);
     const endpoint='http://127.0.0.1:'+localPort;let info=null;
     for(let i=0;i<20&&!info;i++){info=await fetchInfo(endpoint,token).catch(()=>null);if(!info)await sleep(1500);}
     if(!info)throw Error('Туннель не поднялся: systemctl status panel-'+id+'-tunnel');
     const entry={id,name:target.name,address:target.address,agents:info.agents||['claude'],paths:info.paths||{claude:facts.claude},endpoint,tokenFile,ssh:{user:target.user,port:target.port}};
     const file=path.join(data,'nodes.json'),list=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):[];list.push(entry);
     writeFileSync(file+'.next',JSON.stringify(list,null,1)+'\n',{mode:0o600});renameSync(file+'.next',file);job.node=entry;
    });
    job.status='done';
   }catch(e){job.status='failed';job.error=String(e.message||e).slice(-600);}
  })();
  return job;
 }
 // Disconnecting stops the tunnel and forgets the server; the node software stays on it (it can be removed there).
 async function remove(id){
  const file=path.join(data,'nodes.json'),list=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):[];const node=list.find(n=>n.id===id);if(!node)throw Error('Сервер не найден');
  const unit='panel-'+id+'-tunnel.service';await systemctl(['disable','--now',unit]).catch(()=>{});
  writeFileSync(file+'.next',JSON.stringify(list.filter(n=>n.id!==id),null,1)+'\n',{mode:0o600});renameSync(file+'.next',file);
  return {removed:id};
 }
 const view=j=>j&&{id:j.id,status:j.status,steps:j.steps,error:j.error,node:j.node&&{id:j.node.id,name:j.node.name},target:{name:j.target.name,address:j.target.address}};
 return {publicKey,connect:b=>view(connect(b)),job:id=>view(jobs.get(id)),jobs:()=>[...jobs.values()].map(view),remove,keyFile};
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function portFree(port){return new Promise(r=>{const s=net.createServer().once('error',()=>r(false)).once('listening',()=>s.close(()=>r(true))).listen(port,'127.0.0.1');});}
async function defaultFetchInfo(endpoint,token){const r=await fetch(endpoint+'/api/node-info',{headers:{'X-Panel-Node-Token':token},signal:AbortSignal.timeout(4000)});if(!r.ok)throw Error();return r.json();}
// Runs a program; resolves with stdout (a Buffer when binary), rejects with the tail of stderr.
export function runProcess(cmd,args,{input,timeout=60000,binary=false}={}){
 return new Promise((resolve,reject)=>{const p=spawn(cmd,args,{stdio:['pipe','pipe','pipe']});const out=[],err=[];let done=false;
  const timer=setTimeout(()=>{if(!done){p.kill('SIGKILL');reject(Error(cmd+': превышено время ожидания'));}},timeout);
  p.stdout.on('data',d=>out.push(d));p.stderr.on('data',d=>err.push(d));p.on('error',e=>{done=true;clearTimeout(timer);reject(e);});
  p.on('close',code=>{done=true;clearTimeout(timer);const stdout=Buffer.concat(out);if(code===0)resolve(binary?stdout:stdout.toString('utf8'));else reject(Error(Buffer.concat(err).toString('utf8').trim().split('\n').slice(-4).join(' ')||cmd+' завершился с кодом '+code));});
  if(input!=null)p.stdin.end(input);else p.stdin.end();});
}
