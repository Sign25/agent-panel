import {readFileSync,existsSync} from 'node:fs';
import {hostname} from 'node:os';
import path from 'node:path';
// Installation settings: data/config.json, overridden by environment variables.
// Nothing here is specific to one product; defaults describe a fresh install.
export function loadConfig(data){
 const file=path.join(data,'config.json');let saved={};
 if(existsSync(file)){saved=JSON.parse(readFileSync(file,'utf8'));if(!saved||typeof saved!=='object'||Array.isArray(saved))throw Error('data/config.json должен содержать объект');}
 const env=process.env,port=Number(env.PANEL_PORT||saved.port||8787);
 const list=v=>Array.isArray(v)?v.map(String):String(v).split(',').map(s=>s.trim()).filter(Boolean);
 return {
  port,
  origin:env.PANEL_ORIGIN||saved.origin||'http://localhost:'+port,
  nodeId:env.PANEL_NODE_ID||saved.nodeId||'local',
  nodeName:env.PANEL_NODE_NAME||saved.nodeName||hostname(),
  nodeAddress:env.PANEL_NODE_ADDRESS??saved.nodeAddress??'',
  agents:list(env.PANEL_AGENTS||saved.agents||'claude'),
  paths:{...(saved.paths||{}),...(env.CODEX_BIN?{codex:env.CODEX_BIN}:{}),...(env.CLAUDE_BIN?{claude:env.CLAUDE_BIN}:{})},
  // Projects registered on every start when their folder exists.
  projects:(Array.isArray(saved.projects)?saved.projects:[]).filter(p=>p&&typeof p.name==='string'&&typeof p.cwd==='string'&&path.isAbsolute(p.cwd)),
  brand:{name:String(saved.brand?.name||'Панель агентов').slice(0,60),mark:String(saved.brand?.mark||'').slice(0,2),subtitle:String(saved.brand?.subtitle??'Проекты, чаты и ИИ').slice(0,80)},
  language:['ru','en'].includes(saved.language)?saved.language:'ru'
 };
}
