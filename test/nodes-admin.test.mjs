import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {nodesAdmin} from '../nodes-admin.mjs';

const until=async fn=>{for(let i=0;i<200;i++){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,20));}throw Error('timeout');};

test('connecting a server: SSH checks, node install, service, hooks, tunnel and registration',async()=>{
 const dir=mkdtempSync(tmpdir()+'/panel-servers-'),data=dir+'/data',units=dir+'/systemd',root=dir+'/code';
 mkdirSync(data);mkdirSync(units);mkdirSync(root);writeFileSync(data+'/nodes.json',JSON.stringify([{id:'dev',name:'dev',address:'10.0.0.2',endpoint:'http://127.0.0.1:18788'}]));
 const calls=[];
 const run=async(cmd,args,opts={})=>{calls.push({cmd,args,input:opts.input});
  if(cmd==='ssh-keygen'){const f=args[args.indexOf('-f')+1];mkdirSync(path.dirname(f),{recursive:true});writeFileSync(f,'private');writeFileSync(f+'.pub','ssh-ed25519 AAAATEST agent-panel');return '';}
  if(cmd==='tar')return Buffer.from('tarball');
  if(cmd==='ssh'){const c=args.at(-1);
   if(c.startsWith('echo panel-ok'))return 'panel-ok\nLinux\nv22.14.0\n/usr/bin/npm\n/root/.local/bin/claude\n/usr/bin/node\n';
   if(c.includes('/api/node-info'))return '{"agents":["claude"]}';
   return '';}
  return '';};
 const systemctl=async args=>{calls.push({cmd:'systemctl',args});};
 const admin=nodesAdmin({root,data,origin:'https://panel.test',centralPort:8787,nodes:()=>JSON.parse(readFileSync(data+'/nodes.json','utf8')),run,systemdDir:units,systemctl,fetchInfo:async()=>({agents:['claude'],paths:{claude:'/root/.local/bin/claude'}}),isFree:async()=>true});
 try{
  assert.equal(await admin.publicKey(),'ssh-ed25519 AAAATEST agent-panel');
  // Bad input is refused before anything runs.
  assert.throws(()=>admin.connect({name:'x',address:'bad host!'}),/адрес/);
  assert.throws(()=>admin.connect({name:'x',address:'10.0.0.2'}),/уже подключён/);
  assert.throws(()=>admin.connect({name:'x',address:'10.0.0.9',user:'ubuntu'}),/root/);
  const job=admin.connect({name:'Shop VPS',address:'10.0.0.9',user:'root',port:2222});
  const done=await until(()=>{const j=admin.job(job.id);return j.status!=='running'&&j;});
  assert.equal(done.status,'done',JSON.stringify(done));
  assert.deepEqual(done.steps.map(s=>s.state),['done','done','done','done']);
  const node=JSON.parse(readFileSync(data+'/nodes.json','utf8')).find(n=>n.id==='shop-vps');
  assert.equal(node.endpoint,'http://127.0.0.1:18790','the next free local port');assert.equal(node.address,'10.0.0.9');assert.ok(existsSync(node.tokenFile));
  const unit=readFileSync(units+'/panel-shop-vps-tunnel.service','utf8');
  assert.match(unit,/-p 2222 /);assert.match(unit,/-L 127\.0\.0\.1:18790:127\.0\.0\.1:8788 -R 127\.0\.0\.1:18789:127\.0\.0\.1:8787 root@10\.0\.0\.9/);assert.match(unit,/StrictHostKeyChecking=yes/);
  const ssh=calls.filter(c=>c.cmd==='ssh').map(c=>c.args.at(-1));
  assert.ok(ssh.some(c=>c.includes('npm ci')),'dependencies are installed on the server');
  const service=calls.find(c=>c.cmd==='ssh'&&c.args.at(-1).includes('agent-panel-node.service'));
  assert.match(String(service.input),/PANEL_NODE_ID=shop-vps/);assert.match(String(service.input),/"PANEL_NODE_NAME=Shop VPS"/);assert.match(String(service.input),/CLAUDE_BIN=\/root\/\.local\/bin\/claude/);
  assert.equal(String(calls.find(c=>c.cmd==='ssh'&&c.args.at(-1).includes('node-token')).input),readFileSync(node.tokenFile,'utf8'),'the same token on both sides');
  assert.ok(calls.some(c=>c.cmd==='systemctl'&&c.args.join(' ')==='enable --now panel-shop-vps-tunnel.service'));
  // Disconnecting stops the tunnel and forgets the server.
  await admin.remove('shop-vps');assert.ok(!JSON.parse(readFileSync(data+'/nodes.json','utf8')).some(n=>n.id==='shop-vps'));
  assert.ok(calls.some(c=>c.cmd==='systemctl'&&c.args.join(' ')==='disable --now panel-shop-vps-tunnel.service'));
  // A server without Node.js 22.13 stops at the check, with the reason.
  const old=nodesAdmin({root,data,origin:'x',centralPort:8787,nodes:()=>[],run:async(cmd,args)=>cmd==='ssh'?'panel-ok\nLinux\nv20.1.0\n/usr/bin/npm\n/usr/bin/claude\n':'',systemdDir:units,systemctl});
  const j2=old.connect({name:'old',address:'10.0.0.10'});const failed=await until(()=>{const j=old.job(j2.id);return j.status!=='running'&&j;});
  assert.equal(failed.status,'failed');assert.match(failed.error,/22\.13/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
