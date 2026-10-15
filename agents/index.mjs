import {codexAgent} from './codex.mjs';
import {claudeAgent} from './claude.mjs';
// To add an agent: export a factory returning {id,name,vendor,connection,icon,path,catalog,createRun}
// and list it here. Optional sessions:{list,find,history,live,isLive} lets the panel continue sessions started outside it. A run implements start, receive, decide, interrupt and finish (see run.mjs).
const factories={codex:codexAgent,claude:claudeAgent};
export function agentRegistry(ctx){
 const all=new Map();for(const id of ctx.config.agents)if(factories[id])all.set(id,factories[id](ctx));
 return {
  ids:()=>[...all.keys()],
  get(id){const a=all.get(id);if(!a)throw Error(factories[id]?'Агент не установлен на этом сервере':'Неизвестный агент');return a;},
  info:()=>[...all.values()].map(a=>({id:a.id,name:a.name,vendor:a.vendor,connection:a.connection,icon:a.icon}))
 };
}
