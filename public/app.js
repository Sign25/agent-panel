const $ = id => document.getElementById(id);
// i18n.js may fail to load on a flaky network: keep the Russian interface working.
if(typeof tr!=='function'){window.I18N={};window.lang='ru';window.tr=(text,vars)=>vars?String(text).replace(/\{(\w+)\}/g,(m,k)=>vars[k]??m):text;window.locale=()=>'ru';window.startTranslation=()=>{};}
// All interface icons reference the local SVG sprite; labels stay as text nodes.
function uiIcon(name,extra=''){
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
 for(const [key,value] of Object.entries({class:'ui-icon'+(extra?' '+extra:''),width:'18',height:'18',viewBox:'0 0 24 24','aria-hidden':'true',focusable:'false'}))svg.setAttribute(key,value);
 svg.dataset.icon=name;const use=document.createElementNS('http://www.w3.org/2000/svg','use');use.setAttribute('href','#icon-'+name);svg.append(use);return svg;
}
function iconLabel(target,name,text){
 text=tr(text);
 const old=target.querySelector(':scope > .ui-label');if(target.firstElementChild?.dataset.icon===name&&old?.textContent===text)return;
 const label=document.createElement('span');label.className='ui-label';label.textContent=text;target.replaceChildren(uiIcon(name),label);
}
// Agents come from the server registry; older nodes only list ids, so known names are a fallback.
const knownAgents={codex:{id:'codex',name:'Codex',vendor:'OpenAI',icon:'code',connection:'Локальный Codex app-server через stdio'},claude:{id:'claude',name:'Claude Code',vendor:'Anthropic',icon:'claude',connection:'Локальный Claude Code через SDK'}};
function agentMeta(id){return currentHost()?.agentInfo?.find(a=>a.id===id)||knownAgents[id]||{id,name:id,vendor:'',icon:'tools',connection:''};}
const agentIcon=agent=>agentMeta(agent).icon;
const requestToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');
const activeStatuses = ['starting', 'running', 'stopping'];
const effortLabels = {default:'Автоматически',none:'Без рассуждения',minimal:'Минимальный',low:'Низкий',medium:'Средний',high:'Высокий',xhigh:'Очень высокий',max:'Максимальный',ultra:'Ультра'};
let csrf = '', selected = null, after = 0, tasks = [], busy = false, settings = null;
let activeItems = new Map(), approvalCount = 0, polling = false, submitting = false, connectionFailed = false;
let preferences = {}, historySignature = '', approvalSignature = '';
let draftProject = '', viewGeneration = 0, eventRequest = null;
let selectedAgent='claude', settingsGeneration=0;
let selectedHost='local',hostList=[{id:'local',name:'',address:'',agents:['claude']}],brand={name:'Панель агентов',mark:'',subtitle:''};
try{selectedHost=sessionStorage.getItem('panel-host')||'local';}catch{}
const currentHost=()=>hostList.find(h=>h.id===selectedHost)||hostList[0];
const agentName = agent => agentMeta(agent).name;
function preferenceKey(agent=selectedAgent){return agent+'-panel-settings'+(selectedHost==='local'?'':':'+selectedHost);}
function defaultAgent(){let value='claude';try{value=localStorage.getItem('panel-default-agent:'+selectedHost)||(selectedHost==='local'?localStorage.getItem('panel-default-agent'):null)||value;}catch{}return currentHost()?.agents?.includes(value)?value:(currentHost()?.agents?.[0]||'claude');}
let attachments = [], uploading = false;
const messageText = new WeakMap();
const statusLabels = {starting:'Запуск',running:'Работает',completed:'Завершено',failed:'Ошибка',interrupted:'Остановлено',stopping:'Остановка'};
try { const saved = JSON.parse(localStorage.getItem('codex-panel-settings') || '{}'); if (saved && typeof saved === 'object' && !Array.isArray(saved)) preferences = saved; } catch {}
function indicator(id, text, state) { text=tr(text); if ($(id).textContent !== text) $(id).textContent = text; $(id).dataset.state = state; }
function options(id, values, value) {
  $(id).replaceChildren();
  for (const [key, label] of values) { const o = document.createElement('option'); o.value = key; o.textContent = label; $(id).append(o); }
  if (values.some(v => v[0] === value)) $(id).value = value;
}
function reasoning(value) {
  const model = settings.models.find(m => m.model === $('model').value);
  if (!model) return;
  const efforts = model.supportedReasoningEfforts || [];
  options('reasoning', efforts.map(e => [e.reasoningEffort, effortLabels[e.reasoningEffort] || e.reasoningEffort]), value || model.defaultReasoningEffort);
}
function settingsSummary() {
  if (!settings) return;
  const model = settings.models.find(m => m.model === $('model').value);
  const permission = settings.permissions.find(p => p.id === $('permissions').value);
  $('permissionHelp').textContent = tr(permission?.description || '');
  $('settingsSummary').textContent = [model?.displayName || model?.model, tr(effortLabels[$('reasoning').value]||''), tr(permission?.label||'')].filter(Boolean).join(' · ');
}
function saveSettings() {
  const reasoningByModel = {...(preferences.reasoningByModel || {}), [$('model').value]: $('reasoning').value};
  preferences = {model:$('model').value, reasoning:$('reasoning').value, permissions:$('permissions').value, reasoningByModel};
  try { localStorage.setItem(preferenceKey(), JSON.stringify(preferences)); $('settingsSaved').textContent = 'Выбор сохранён в этом браузере'; }
  catch { $('settingsSaved').textContent = 'Браузер не разрешает сохранение настроек'; }
  settingsSummary();
}
async function loadSettings(agent=selectedAgent) {
  const generation=++settingsGeneration;selectedAgent=agent;$('agent').value=agent;settings=null;updateActivity();
  try{const saved=JSON.parse(localStorage.getItem(preferenceKey())||'{}');preferences=saved&&typeof saved==='object'&&!Array.isArray(saved)?saved:{};}catch{preferences={};}
  let result;try{result=await api('settings?agent='+agent);}catch(e){if(generation===settingsGeneration){$('settingsSummary').textContent='Настройки агента недоступны';error(e);}return;}
  if(generation!==settingsGeneration)return;
  settings=result;
  if (!settings.models?.length) {settings=null;error(Error('Список моделей агента недоступен'));return;}
  options('model', settings.models.map(m => [m.model, m.displayName || m.model]), settings.models.some(m => m.model === preferences.model) ? preferences.model : (settings.models.find(m => m.isDefault)?.model || settings.models[0].model));
  options('permissions', settings.permissions.map(p => [p.id, p.label]), settings.permissions.some(p => p.id === preferences.permissions) ? preferences.permissions : 'workspace');
  reasoning(preferences.reasoningByModel?.[$('model').value] || (preferences.model === $('model').value ? preferences.reasoning : undefined));
  settingsSummary();updateActivity();projectLabels();
  indicator('connection', 'Панель на связи', 'connected');
}
async function switchAgent(agent){
  if(submitting||uploading||agent===selectedAgent||!currentHost()?.agents?.includes(agent)){$('agent').value=selectedAgent;renderAgentSwitch();return;}
  try{localStorage.setItem('panel-default-agent:'+selectedHost,agent);}catch{}await loadSettings(agent);
}
$('agent').onchange=()=>switchAgent($('agent').value);
// Segmented AI switch in the composer mirrors the select in the settings dialog.
function renderAgentSwitch(){
  const box=$('agentSwitch');if(!box)return;const agents=currentHost()?.agents||[];
  const signature=JSON.stringify([agents,selectedAgent,submitting||uploading,agents.map(agentName)]);if(box.dataset.signature===signature)return;box.dataset.signature=signature;
  box.replaceChildren();box.hidden=agents.length<2;
  for(const agent of agents){const b=document.createElement('button');b.type='button';b.className='agent-option';b.dataset.agent=agent;b.setAttribute('aria-pressed',String(agent===selectedAgent));b.title=agentName(agent);b.disabled=submitting||uploading;iconLabel(b,agentIcon(agent),agentName(agent));b.onclick=()=>switchAgent(agent);box.append(b);}
}
$('model').onchange = () => { reasoning(preferences.reasoningByModel?.[$('model').value]); saveSettings(); };
$('permissions').onchange = saveSettings;
$('reasoning').onchange = saveSettings;
function apiPath(url,host=selectedHost){return '/api/'+((['session','login','logout','hosts','meta'].includes(url.split('?')[0])||url.startsWith('communication/')||host==='local')?'':'remote/'+encodeURIComponent(host)+'/')+url;}
// Responses can arrive empty or cut off (service restart, proxy timeout, unreachable node): that is a temporary
// connection failure, not an application error. Polling retries silently; user actions get a plain message.
function transient(){const e=Error(tr('Сервер временно не ответил. Повторим автоматически.'));e.transient=true;return e;}
async function readJson(r){const text=await r.text();if(!text)throw transient();try{return JSON.parse(text);}catch{throw transient();}}
async function api(url, data) {
  const host=selectedHost;let r;
  try { r = await fetch(apiPath(url,host), {method:data ? 'POST' : 'GET', headers:data ? {'Content-Type':'application/json', 'X-CSRF-Token':csrf} : {}, body:data ? JSON.stringify(data) : undefined}); }
  catch { if(host!==selectedHost){const e=Error('Сервер переключён');e.stale=true;throw e;}connectionFailed = true; indicator('connection', 'Нет связи с панелью', 'offline'); const e=Error('Нет связи с панелью. Проверяем соединение…');e.transient=true;e.user=Boolean(data);throw e; }
  let b;try{b=await readJson(r);}catch(e){if(data)e.user=true;if(host!==selectedHost){const s=Error('Сервер переключён');s.stale=true;throw s;}connectionFailed=true;indicator('connection','Нет связи с панелью','offline');throw e;}
  if(host!==selectedHost){const e=Error('Сервер переключён');e.stale=true;throw e;}
  if (!r.ok) { if (r.status === 401) { csrf = ''; settings = null; show(false); indicator('connection', 'Требуется вход', 'unknown'); } const e=Error(b.error || 'Ошибка запроса');e.status=r.status;e.copy=Boolean(b.copy);e.draft=b.draft;throw e; }
  if (settings) indicator('connection', 'Панель на связи', 'connected');
  if (connectionFailed && url === 'tasks') { connectionFailed = false; error(); }
  return b;
}
function error(e) { if(e?.stale||e?.transient&&!e.user)return; $('error').textContent = e?.message || ''; $('errorBox').hidden = !e; }
function show(ok) { $('login').hidden = ok; $('workspace').hidden = !ok; $('logout').hidden = !ok; $('projectMapButton').hidden = !ok; $('aiSettingsButton').hidden = !ok;for(const id of ['projectSearchButton','addProjectButton','communicationButton'])$(id).hidden=!ok; if (!ok) { sidebar(false); document.querySelectorAll('dialog[open]').forEach(d => d.close()); } }
function emptyChat() {
  $('messages').replaceChildren();
  const box = document.createElement('div'); box.className = 'chat-empty';
  const mark = document.createElement('span'); mark.className = 'empty-mark'; mark.append(uiIcon(agentIcon(selectedAgent))); mark.setAttribute('aria-hidden','true');
  const h = document.createElement('strong'); h.textContent = 'Над чем работаем?';
  const p = document.createElement('p'); p.textContent = 'Поставьте задачу своими словами. Агент разберётся в проекте, внесёт изменения и проверит результат.';
  const starters = document.createElement('div'); starters.className = 'starter-list';
  for (const text of ['Разобраться в устройстве проекта', 'Проверить последние изменения', 'Найти причину ошибки']) {
    const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = text;
    btn.onclick = () => { $('prompt').value = tr(text) + '. '; resizePrompt(); saveDraft(); updateActivity(); $('prompt').focus(); };
    starters.append(btn);
  }
  box.append(mark,h,p,starters); $('messages').append(box); $('toLatest').hidden = true;
  sessionSuggestions(box,viewGeneration);
}
// The live view of a Remote Control session stays the last row: new chat rows go above it.
function chatAppend(el){const m=$('messages').querySelector(':scope > .live-mirror:not([data-state=closed])');if(m&&m===$('messages').lastElementChild)$('messages').insertBefore(el,m);else $('messages').append(el);}
function chatLast(){const m=$('messages').querySelector(':scope > .live-mirror:not([data-state=closed])');return m&&m===$('messages').lastElementChild?m.previousElementSibling:$('messages').lastElementChild;}
function message(text, cls = '') {
  $('messages').querySelector('.chat-empty')?.remove();
  const el = document.createElement('section'); el.className = 'message ' + cls; const agent=tasks.find(t=>t.id===selected)?.agent||selectedAgent; if(cls!=='user')el.dataset.agent=agent;
  const head = document.createElement('div'); head.className = 'message-header'; iconLabel(head,cls==='user'?'user':agentIcon(agent),cls === 'user' ? 'Вы' : agentName(agent)); head.querySelector('.ui-label').translate=false;
  const copy = document.createElement('button'); copy.className = 'quiet'; iconLabel(copy,'copy','Копировать');
  copy.onclick = async () => { try { await navigator.clipboard.writeText(messageText.get(el) || ''); iconLabel(copy,'check','Скопировано'); setTimeout(() => iconLabel(copy,'copy','Копировать'),1800); } catch { error(Error('Не удалось скопировать. Выделите текст ответа и скопируйте его вручную.')); } };
  head.append(copy); const body = document.createElement('div'); body.className = 'message-body'; body.translate=false; el.append(head,body);
  chatAppend(el); setMessage(el,text,false); return el;
}
// Markdown is built from text nodes: model output is never interpreted as HTML.
// A picture the model shows: ![caption](/absolute/path.png) on its server. The panel serves it to the signed-in owner;
// a tap opens it full size. A web address stays a link (the panel loads nothing from other sites).
function chatImage(alt,src){
  if(!src.startsWith('/')){const a=document.createElement('a');a.textContent=alt||src;a.href=src;a.target='_blank';a.rel='noopener noreferrer';return a;}
  const url=apiPath('files/image?path='+encodeURIComponent(src)),link=document.createElement('a');link.className='chat-image';link.href=url;link.target='_blank';link.rel='noopener';
  const img=document.createElement('img');img.src=url;img.alt=alt||'';img.loading='lazy';img.decoding='async';
  img.onerror=()=>{link.classList.add('is-missing');link.textContent=tr('Картинка недоступна: {path}',{path:src});};
  link.append(img);if(alt){const cap=document.createElement('span');cap.className='chat-image-caption';cap.textContent=alt;link.append(cap);}link.title=alt||src;return link;
}
function inline(node, text) {
  const re = /(!\[[^\]]*\]\((?:\/|https?:\/\/)[^\s)]+\)|`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;
  let offset = 0;
  for (const match of text.matchAll(re)) {
    node.append(document.createTextNode(text.slice(offset,match.index)));
    const token=match[0]; let child;
    if (token.startsWith('![')) { const m=token.match(/^!\[([^\]]*)\]\((.*)\)$/); child=chatImage(m[1],m[2]); }
    else if (token.startsWith('`')) { child=document.createElement('code'); child.textContent=token.slice(1,-1); }
    else if (token.startsWith('**')) { child=document.createElement('strong'); child.textContent=token.slice(2,-2); }
    else { const m=token.match(/^\[([^\]]+)\]\((.*)\)$/); child=document.createElement('a'); child.textContent=m[1]; child.href=m[2]; child.target='_blank'; child.rel='noopener noreferrer'; }
    node.append(child); offset=match.index+token.length;
  }
  node.append(document.createTextNode(text.slice(offset)));
}
function markdown(node, text) {
  node.replaceChildren(); const lines=text.split('\n'); let i=0;
  while (i<lines.length) {
    const line=lines[i]; if (!line.trim()) { i++; continue; }
    if (line.startsWith('```')) { const pre=document.createElement('pre'),code=document.createElement('code'); const block=[]; i++; while (i<lines.length&&!lines[i].startsWith('```')) block.push(lines[i++]); i++; code.textContent=block.join('\n'); pre.append(code); node.append(pre); continue; }
    if (/^\|.*\|$/.test(line.trim()) && /^\s*\|?\s*:?-{3}/.test(lines[i+1]||'')) {
      const wrap=document.createElement('div'); wrap.className='table-scroll'; const table=document.createElement('table');
      let header=true;
      while(i<lines.length&&lines[i].trim().startsWith('|')) { const current=lines[i++]; if (/^[\s|:-]+$/.test(current)) continue; const row=document.createElement('tr'); for(const cell of current.trim().replace(/^\||\|$/g,'').split('|')) { const td=document.createElement(header?'th':'td'); inline(td,cell.trim()); row.append(td); } table.append(row); header=false; }
      wrap.append(table); node.append(wrap); continue;
    }
    if(/^\s*(?:!\[[^\]]*\]\((?:\/|https?:\/\/)[^\s)]+\)\s*)+$/.test(line)) { const gallery=document.createElement('div'); gallery.className='chat-gallery'; while(i<lines.length&&/^\s*(?:!\[[^\]]*\]\((?:\/|https?:\/\/)[^\s)]+\)\s*)+$/.test(lines[i])) { for(const m of lines[i++].matchAll(/!\[([^\]]*)\]\(([^\s)]+)\)/g)) gallery.append(chatImage(m[1],m[2])); } node.append(gallery); continue; }
    const heading=line.match(/^#{1,6}\s+(.+)/); if(heading) { const h=document.createElement('h3'); inline(h,heading[1]); node.append(h); i++; continue; }
    if(/^\s*(?:[-*]|\d+\.)\s+/.test(line)) { const ordered=/^\s*\d+\./.test(line); const list=document.createElement(ordered?'ol':'ul'); while(i<lines.length&&/^\s*(?:[-*]|\d+\.)\s+/.test(lines[i])) { const li=document.createElement('li'); inline(li,lines[i++].replace(/^\s*(?:[-*]|\d+\.)\s+/,'')); list.append(li); } node.append(list); continue; }
    const p=document.createElement('p'); const block=[lines[i++]]; while(i<lines.length&&lines[i].trim()&&!/^(?:#|```|\s*[-*] |\s*\d+\. |\||\s*!\[)/.test(lines[i])) block.push(lines[i++]); inline(p,block.join('\n')); node.append(p);
  }
}
function setMessage(el,text,formatted) { messageText.set(el,text); const body=el.querySelector('.message-body'); body.classList.toggle('formatted',formatted); if(formatted) markdown(body,text); else body.textContent=text; }
async function refresh() {
  await loadSettings(defaultAgent());
  const projects = await api('projects'), old = $('projects').value || readSession('panel-project');
  $('projects').replaceChildren();
  for (const p of projects) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; o.title = p.cwd; o.dataset.main = p.main_session||''; $('projects').append(o); }
  if (projects.some(p => String(p.id) === old)) $('projects').value = old;
  draftProject = $('projects').value; projectLabels();
  await history();
  const saved = tasks.find(t => String(t.project) === draftProject);
  const running = tasks.find(t => String(t.project) === $('projects').value && activeStatuses.includes(t.status));
  if (!selected && (saved || running)) { restoreDraft(); await choose(saved || running); } else if (!selected) { emptyChat(); restoreDraft(); }
}
// Background work of the open session (commands, agents, monitors still running): a header counter with the list.
// A panel chat's running turn reports its background work in events (background/changed); a mirror reads it from the session.
let chatBackground={task:null,tasks:[]};
function renderBackground(){
 const own=chatBackground.task===selected&&tasks.find(t=>t.id===selected)?.status==='running'?chatBackground.tasks:[];
 const list=mirrorTarget?.background?.length?mirrorTarget.background:own,menu=$('backgroundMenu');if(!menu)return;
 const signature=JSON.stringify(list.map(t=>[t.id,t.title]));if(menu.dataset.signature===signature)return;menu.dataset.signature=signature;
 menu.hidden=!list.length;if(!list.length)menu.open=false;$('backgroundCount').textContent=String(list.length);
 const kinds={command:['terminal','Команда'],agent:['claude','Агент'],monitor:['eye','Наблюдение']};
 $('backgroundList').replaceChildren(...list.map(t=>{const [icon,label]=kinds[t.kind]||kinds.command,row=mapElement('div',null,'background-item');row.translate=false;
  row.append(uiIcon(icon),mapElement('strong',t.title),mapElement('small',tr(label)+' · '+tr('запущена {when}',{when:ago(t.started)})+(t.expires?' · '+tr('до {time}',{time:new Date(t.expires).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}):'')));return row;}));
}
// The mail address of the open chat: a terminal session's original (its copy takes over when it is closed), else the panel chat.
function chatAddress(t){const root=tasks.find(x=>chainOf(x)===chainOf(t)&&x.source_session);return selectedHost+':'+(root&&Number(root.fork)===1?'claude-'+root.source_session:chainOf(t));}
// Mail sent to the whole project goes to its main session: the owner picks it from the chat.
function updateMainButton(){const b=$('mainSessionButton'),t=tasks.find(x=>x.id===selected),o=$('projects').selectedOptions[0];b.hidden=!t||!o;if(b.hidden)return;
 const on=o.dataset.main===chatAddress(t);b.dataset.on=String(on);b.querySelector('.ui-label').textContent=tr(on?'Основная сессия проекта · снять':'Сделать основной сессией проекта');}
$('mainSessionButton').onclick=async()=>{const t=tasks.find(x=>x.id===selected),o=$('projects').selectedOptions[0];if(!t||!o)return;const address=chatAddress(t),on=o.dataset.main===address;
 try{const p=await api('projects/main',{project:Number(o.value),address:on?null:address});o.dataset.main=p.main_session||'';updateMainButton();$('draftState').textContent=tr(on?'Письма проекту снова получает последний чат':'Письма проекту получает этот чат');error();}catch(e){error(e);}};
// "+": a new session is a server and a folder. The panel finds or makes the folder's project and opens an empty chat.
let pendingChatName='';
$('newSessionButton').onclick=()=>{const sel=$('newSessionHost');sel.replaceChildren(...hostList.map(h=>{const o=document.createElement('option');o.value=h.id;o.textContent=h.name||h.id;return o;}));sel.value=selectedHost;$('newSessionStatus').textContent='';$('newSessionDialog').showModal();$('newSessionPath').focus();};
$('newSessionForm').onsubmit=async e=>{e.preventDefault();const host=$('newSessionHost').value,button=$('newSessionForm').querySelector('button'),name=$('newSessionName').value.trim();
 button.disabled=true;$('newSessionStatus').textContent=tr('Готовим папку…');
 try{const r=await fetch(apiPath('chats/new',host),{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({cwd:$('newSessionPath').value.trim()})});const b=await readJson(r);if(!r.ok)throw Error(b.error||'Не удалось начать сессию');
  $('newSessionDialog').close();await window.openPanelProject(host,b.project);await $('new').onclick();
  pendingChatName=name;$('title').textContent=name||b.projectName;$('newSessionName').value='';sidebar(false);$('prompt').focus();
 }catch(err){$('newSessionStatus').textContent=err.message;}finally{button.disabled=false;}};
// Servers: the central panel and the VPS connected to it. Connecting runs on the panel as a job with visible steps.
let serversJobTimer=null;
async function renderServers(){
 const b=await api('servers');
 $('serversKeyCommand').textContent="mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '"+b.publicKey+"' >> ~/.ssh/authorized_keys";
 const list=$('serversList');list.replaceChildren();
 const row=(name,meta,action)=>{const li=mapElement('li',null,'servers-item');const text=mapElement('span',null,'servers-text');text.append(mapElement('strong',name),mapElement('small',meta));li.append(uiIcon('server'),text);if(action)li.append(action);list.append(li);};
 row(b.central.name||'main',tr('центральная панель')+(b.central.address?' · '+b.central.address:''));
 for(const n of b.nodes){const off=mapElement('button',null,'quiet servers-remove');off.type='button';off.textContent=tr('Отключить');
  off.onclick=async()=>{if(!confirm(tr('Отключить сервер {name}? Туннель будет остановлен, программа узла останется на сервере.',{name:n.name})))return;try{await api('servers/remove',{id:n.id});await renderServers();await loadHosts();$('refreshTree').onclick();}catch(e){error(e);}};
  row(n.name,n.address||n.id,off);}
 return b;
}
function renderServersJob(j){
 const box=$('serversJob');box.hidden=false;box.replaceChildren(...j.steps.map(s=>{const li=mapElement('li',null,'servers-job-step');li.dataset.state=s.state;li.append(mapElement('span',s.title),...(s.detail?[mapElement('small',s.detail)]:[]));return li;}));
 $('serversStatus').textContent=j.status==='running'?tr('Подключаем…'):j.status==='done'?tr('Сервер {name} подключён',{name:j.node?.name||j.target.name}):tr('Не удалось подключить: {error}',{error:j.error||''});
 $('serversStatus').dataset.state=j.status;
}
$('serversButton').onclick=async()=>{$('serversDialog').showModal();$('serversStatus').textContent='';try{await renderServers();}catch(e){$('serversStatus').textContent=e.message;}};
$('serversCopyKey').onclick=async()=>{try{await navigator.clipboard.writeText($('serversKeyCommand').textContent);$('serversStatus').dataset.state='';$('serversStatus').textContent=tr('Команда скопирована');}catch{$('serversStatus').textContent=tr('Выделите команду и скопируйте вручную');}};
$('serversForm').onsubmit=async e=>{e.preventDefault();const button=$('serversForm').querySelector('button');button.disabled=true;clearTimeout(serversJobTimer);
 try{let j=await api('servers/connect',{name:$('serverName').value,address:$('serverAddress').value,user:$('serverUser').value,port:Number($('serverPort').value)});renderServersJob(j);
  const poll=async()=>{try{j=await api('servers/job?id='+j.id);renderServersJob(j);}catch(err){$('serversStatus').textContent=err.message;}
   if(j.status==='running')serversJobTimer=setTimeout(poll,2000);else{button.disabled=false;if(j.status==='done'){await renderServers();await loadHosts();$('refreshTree').onclick();}}};
  serversJobTimer=setTimeout(poll,1500);
 }catch(err){$('serversStatus').dataset.state='failed';$('serversStatus').textContent=err.message;button.disabled=false;}};
function updateActivity() {
  renderBackground();updateMainButton();
  const chosen = tasks.find(t => t.id === selected);
  const active = tasks.find(t => String(t.project) === $('projects').value && activeStatuses.includes(t.status));
  busy = Boolean(active);
  for(const id of ['model','reasoning','permissions','settingsButton'])$(id).disabled=!settings||submitting;
  $('agent').disabled=submitting||uploading; const last=chosen?.agent||'codex';
  $('agentHint').textContent=!chosen?tr('Выберите ИИ для первого сообщения проекта.'):last===selectedAgent?tr('Ответит {agent}. ИИ можно сменить перед любым сообщением.',{agent:agentName(selectedAgent)}):tr('Следующее сообщение получит {agent}. Он продолжит свою сессию и увидит ответы {previous}.',{agent:agentName(selectedAgent),previous:agentName(last)});
  $('prompt').placeholder=mirrorTarget?.dialog?tr('Свой ответ на вопрос сессии…'):mirrorTarget?.live?tr('Сообщение для «{name}» в Remote Control…',{name:mirrorTarget.name}):selected&&(currentHost()?.agents||[]).length<2?tr('Сообщение для «{name}»…',{name:$('title').textContent}):tr('Сообщение для {agent}…',{agent:agentName(selectedAgent)}); renderAgentSwitch(); document.body.dataset.agent=selectedAgent;
  // A running Claude turn of this chat takes new messages mid-turn, as a working terminal session does.
  const joinable=Boolean(chosen&&chosen.status==='running'&&(chosen.agent||'codex')==='claude'&&!attachments.length);
  $('send').disabled = (busy&&!joinable) || !settings || submitting || uploading || (!$('prompt').value.trim() && !attachments.length);
  $('attachments').querySelectorAll('button').forEach(b=>b.disabled=submitting||uploading);
  iconLabel($('send'),submitting?'clock':'send',submitting?'Отправляем…':'Отправить');
  $('prompt').disabled = submitting; $('projects').disabled = submitting || uploading; $('hosts').disabled=submitting||uploading;
  $('new').disabled = submitting || uploading; $('attach').disabled = submitting || uploading || attachments.length >= 5;
  $('composerHint').textContent = busy ? (joinable?tr('Агент работает. Сообщение попадёт в текущий ход.'):'Агент работает. Следующее сообщение можно пока подготовить.') : (matchMedia('(pointer:coarse)').matches ? 'Enter — новая строка' : 'Enter — отправить · Shift+Enter — новая строка');
  $('stop').disabled = !chosen || !activeStatuses.includes(chosen.status); $('stop').hidden = $('stop').disabled;
  // The chat of an open Remote Control session: the header follows the original, not the last turn of its panel copy.
  if(mirrorTarget?.live&&!(chosen&&activeStatuses.includes(chosen.status))){
   if(mirrorTarget.dialog)indicator('activity','Ждёт вашего ответа','approval');
   else indicator('activity',mirrorTarget.working?'Работает в Remote Control':'Ждёт сообщения',mirrorTarget.working?'working':'idle');
   $('status').textContent='Remote Control · '+mirrorTarget.name;return;
  }
  const task = chosen && activeStatuses.includes(chosen.status) ? chosen : active || chosen;
  if (!task) { indicator('activity', 'Готов к задаче', 'idle'); $('status').textContent = 'Отправьте сообщение, чтобы начать'; return; }
  // The indicator already says what the turn is doing: the meta line names only the model, as the settings list shows it.
  $('status').textContent = settings?.models?.find(m=>m.model===task.model)?.displayName||task.model||'';
  if (task.status === 'starting') indicator('activity', 'Подключаем модель', 'thinking');
  else if (task.status === 'stopping') indicator('activity', 'Останавливаем задачу', 'working');
  else if (task.status === 'running') {
    if (task.id === selected && approvalCount) indicator('activity', 'Ожидает подтверждения', 'approval');
    else if (task.id !== selected) indicator('activity', 'В проекте выполняется задача', 'working');
    else if ([...activeItems.values()].some(t => ['commandExecution','fileChange','mcpToolCall','webSearch','dynamicToolCall'].includes(t))) indicator('activity', 'Работает с инструментами', 'working');
    else if ([...activeItems.values()].includes('agentMessage')) indicator('activity', 'Пишет ответ', 'responding');
    else if (chatBackground.task===task.id&&chatBackground.tasks.length) indicator('activity', 'Ждёт фоновые задачи', 'working');
    else indicator('activity', 'Думает', 'thinking');
  } else if (task.status === 'failed') indicator('activity', 'Ошибка выполнения', 'failed');
  else if (task.status === 'interrupted') indicator('activity', 'Задача остановлена', 'idle');
  else indicator('activity', 'Задача завершена', 'connected');
}
function renderHistory() {
  const query=$('historySearch').value.trim().toLocaleLowerCase();
  const all=tasks.filter(t => String(t.project)===$('projects').value);
  const filtered=all.filter(t => t.prompt.toLocaleLowerCase().includes(query));
  const signature=JSON.stringify([selected,query,filtered.map(t=>[t.id,t.status,t.prompt,t.agent])]);
  if(signature===historySignature) return; historySignature=signature;
  const scroll=$('history').scrollTop; const focus=document.activeElement?.dataset.task;
  $('history').replaceChildren(); $('historyCount').textContent=filtered.length;
  if(!filtered.length) { const p=document.createElement('p'); p.className='history-empty'; p.textContent=query?'Задачи не найдены. Попробуйте другое слово.':'Здесь появятся ваши задачи'; $('history').append(p); }
  for(const t of filtered) {
    const b=document.createElement('button'); b.dataset.task=t.id; b.setAttribute('aria-current',String(t.id===selected)); b.title=t.prompt;
    const title=document.createElement('span'); title.className='history-title'; title.translate=false; title.textContent=t.prompt;
    const meta=document.createElement('small'); meta.textContent=new Date(t.created).toLocaleString(locale(),{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})+' · '+agentName(t.agent)+' · '+tr(statusLabels[t.status]||t.status);
    b.append(title,meta); b.onclick=()=>choose(t).catch(error); $('history').append(b);
  }
  if(focus) $('history').querySelector('[data-task="'+CSS.escape(focus)+'"]')?.focus({preventScroll:true});
  $('history').scrollTop=scroll;
}
async function history() { const previous=tasks.find(t=>t.id===selected);const host=selectedHost;tasks=await api('tasks');if(host===notify.host)notifyTasks();else{notify.host=host;notify.statuses=new Map(tasks.map(t=>[t.id,t.status]));}const latest=tasks.find(t=>String(t.project)===$('projects').value&&(!previous||chainOf(t)===chainOf(previous)));if(latest?.mail_message&&latest.id!==selected&&previous&&!activeStatuses.includes(previous.status)&&!submitting&&!uploading)await choose(latest);renderHistory(); updateActivity(); await projectMailView(); }
async function choose(t) {
  if(submitting || uploading) return; pendingChatName='';
  saveDraft(); selected=t.id; viewGeneration++; const generation=viewGeneration; const agent=currentHost()?.agents?.includes(t.agent||'codex')?(t.agent||'codex'):defaultAgent(); const changeAgent=agent!==selectedAgent||!settings; after=0; activeItems.clear(); approvalCount=0; approvalSignature='';
  writeSession('panel-selected-'+draftProject,selected);
  $('messages').replaceChildren(); activityViews.delete($('messages')); $('stream').textContent=''; $('approvals').replaceChildren();
  $('title').textContent=chainTitle(t); $('title').title=$('projects').selectedOptions[0]?.title||'';
  projectTranscript(t,generation);
  mirrorTarget=null;
  if(t.source_session){mirrorSession(t,generation);restoreDraft(); sidebar(false); renderHistory(); updateActivity();if(changeAgent)await loadSettings(agent);if(generation!==viewGeneration)return;projectLabels();scrollLatest();return;}
  const mail=t.mail_message&&mailFromPrompt(t);
  const userMessage=mail?mailRow('in',tr('Получено от {name}',{name:mailName(mail.sender)}),mail.body):message(t.prompt,'user'); userMessage.dataset.time=t.created;if(mail){userMessage.dataset.mailId=t.mail_message;userMessage.querySelector('.mail-state').textContent=tr(mail.kind==='request'?'Запрос':'Ответ');$('messages').append(userMessage);} if(t.attachments?.length){const list=document.createElement('div');list.className='message-files';for(const f of t.attachments){const a=document.createElement('a');a.href=apiPath('uploads?id='+encodeURIComponent(f.id));a.textContent=f.name;a.download=f.name;list.append(a);}userMessage.append(list);} restoreDraft(); sidebar(false); renderHistory(); updateActivity();
  if(changeAgent)await loadSettings(agent);if(generation!==viewGeneration)return;projectLabels();
  await events(); scrollLatest();
  // A later turn of a terminal session's chat: the original's live view goes below the panel turns.
  const root=tasks.filter(x=>chainOf(x)===chainOf(t)&&x.source_session).at(-1);if(root&&generation===viewGeneration)mirrorSession(root,generation);
}
// A chat is the chain of turns of one session (session_id); several sessions can share a project folder.
const chainOf=t=>t?.session_id||t?.id;
function chainTitle(t){const chain=chainOf(t),root=tasks.filter(x=>chainOf(x)===chain&&x.source_session).at(-1);
 return root?root.prompt.replace(/^Сессия из терминала:\s*/,''):($('projects').selectedOptions[0]?.textContent||tr('Чат проекта'));}
function projectTranscript(current,generation){
 // Earlier turns read as one conversation, like the live view of a terminal session: the prompt (or the mail it answered),
 // the latest tool steps and the answers. A terminal session's chat shows its own chain; the project chat every other turn.
 const sessionChains=new Set(tasks.filter(t=>t.source_session).map(chainOf)),mine=sessionChains.has(chainOf(current));
 const older=tasks.filter(t=>String(t.project)===String(current.project)&&(mine?chainOf(t)===chainOf(current):!sessionChains.has(chainOf(t)))&&t.id!==current.id&&t.created<=current.created&&!t.source_session).reverse();
 const page=30;let shown=0;
 const more=mapElement('button',null,'quiet transcript-more');more.type='button';
 async function load(){
  const batch=older.slice(Math.max(0,older.length-shown-page),older.length-shown);shown+=batch.length;
  more.hidden=shown>=older.length;more.textContent=tr('Показать более ранние ({n})',{n:older.length-shown});
  if(!batch.length)return;
  const anchor=$('messages').scrollHeight-$('messages').scrollTop;
  const turns=batch.map(task=>{const turn=mapElement('div',null,'transcript-turn');turn.dataset.time=task.created;turn.dataset.agent=task.agent||'claude';
   const mail=task.mail_message&&mailFromPrompt(task);
   const shownMail=task.mail_message&&$('messages').querySelector('[data-mail-id="'+CSS.escape(task.mail_message)+'"]');
   if(shownMail)turn.append(shownMail);
   else if(mail){const r=mailRow('in',tr('Получено от {name}',{name:mailName(mail.sender)}),mail.body);r.dataset.mailId=task.mail_message;r.querySelector('.mail-state').textContent=tr(mail.kind==='request'?'Запрос':'Ответ');turn.append(r);}
   else turn.append(transcriptMessage('user',task.prompt));
   placeByTime(turn,task.created);return turn;});
  $('messages').prepend(more);
  try{const list=await api('tasks/transcript?ids='+batch.map(t=>encodeURIComponent(t.id)).join(','));if(generation!==viewGeneration)return;
   const byId=new Map(list.map(x=>[x.id,x]));
   batch.forEach((task,k)=>{const items=byId.get(task.id)?.items||[];for(const m of items)turns[k].append(m.role==='tool'?transcriptStep(m.text):m.role==='user'&&wakeLine(m.text)?panelNote(m.text):transcriptMessage(m.role,m.text));
    if(!items.some(m=>m.role==='assistant'))turns[k].append(mapElement('p',tr(task.status==='failed'?'Ход завершился с ошибкой.':task.status==='interrupted'?'Ход остановлен.':'Ответ не сохранён.'),'transcript-note'));});
  }catch(e){if(generation===viewGeneration)turns.at(-1)?.append(mapElement('p',e.message,'transcript-note'));}
  // Earlier turns go above what the reader is looking at: keep the view where it was.
  if(shown>batch.length)$('messages').scrollTop=$('messages').scrollHeight-anchor;
 }
 more.onclick=()=>load();
 load();
}
function transcriptMessage(role,text){const row=mapElement('div',null,'terminal-message '+role);if(role==='user'){const who=mapElement('small',null,'terminal-role');iconLabel(who,'user','Вы');row.append(who);}
 const body=mapElement('div',null,'message-body formatted');body.translate=false;markdown(body,text);row.append(body);return row;}
// The one-line nudge the panel types into a terminal session when mail arrives is not the owner's message.
const wakeLine=text=>/^Межпроектная связь панели:/.test(String(text||''));
function panelNote(text){const row=mapElement('div',null,'terminal-step panel-note');const what=String(text).match(/^Межпроектная связь панели: (.+?) \(id /)?.[1]||tr('письмо');row.append(uiIcon('message'),mapElement('span',tr('Панель: {what}',{what})));row.title=text;return row;}
function transcriptStep(text){const row=mapElement('div',null,'terminal-step');row.append(uiIcon('terminal'),mapElement('span',text||'…'));row.translate=false;return row;}
// Activity timeline: each tool call owns one stable block, shared by live and historical views.
const activityViews=new WeakMap();
function activityText(value){
 if(value==null)return '';if(typeof value==='string')return value;
 try{return JSON.stringify(value,(key,v)=>key==='data'&&typeof v==='string'&&v.length>2000?'[Двоичные данные]':v,2);}catch{return String(value);}
}
function safeActivityText(value){return activityText(value)
 .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'')
 .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,'[Закрытый ключ скрыт]')
 .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi,'$1[скрыто]')
 .replace(/((?:[\w-]*(?:token|password|passwd|api[_-]?key|secret)[\w-]*)["']?\s*[:=]\s*["']?)([^\s"',}\n]+)/gi,'$1[скрыто]');}
const firstLine=v=>{const t=String(v||'').split('\n').find(l=>l.trim())||'';return t.length>140?t.slice(0,139)+'…':t;};
function activityTitle(item){
 // Claude's Bash carries a human description; prefer it over the raw command, which stays in the details.
 if(item.input?.description)return firstLine(item.input.description);
 if(item.command)return firstLine(activityText(item.command));
 const bridge=String(item.tool||item.name||'').match(/^(?:mcp__panel_bridge__)?(message_send|inbox_read|message_ack|projects_list|sessions_list)$/);
 if(bridge&&(item.server==='panel_bridge'||String(item.tool||'').startsWith('mcp__panel_bridge__'))){let a=item.input||item.arguments||{};if(typeof a==='string'){try{a=JSON.parse(a);}catch{a={};}}
  return {message_send:tr('Отправлено → {name}',{name:mailName(a.recipient)}),inbox_read:tr('Чтение входящих'),message_ack:tr('Отметка о прочтении'),projects_list:tr('Справочник проектов'),sessions_list:tr('Список сессий')}[bridge[1]];}
 if(item.tool==='Bash'&&item.input?.command)return firstLine(item.input.command);
 if(item.type==='fileChange')return (item.changes||[]).map(c=>c.path).join(', ')||tr('Изменение файлов');
 if(item.tool)return item.tool+(item.input?.file_path?' · '+item.input.file_path:'');
 return tr({webSearch:'Поиск: {query}',imageView:'Просмотр изображения',contextCompaction:'Обновление контекста',sleep:'Ожидание',mcpToolCall:'Вызов MCP',dynamicToolCall:'Инструмент'}[item.type]||'Действие агента',{query:item.query||''});
}
function renderActivity(parent,x,context){
 const p=x.params||{},item=p.item;
 const supported=new Set(['commandExecution','fileChange','mcpToolCall','dynamicToolCall','toolCall','webSearch','imageView','contextCompaction','sleep']);
 let id=item?.id||p.itemId,kind=item?.type;
 if(x.method==='tool/summary'){id=p.id||'summary-'+(p.itemIds||[]).join(',');kind='toolCall';}
 const delta=x.method==='item/commandExecution/outputDelta'||x.method==='item/fileChange/outputDelta';
 const inputDelta=x.method==='item/toolCall/inputDelta';
 if(!id||(!(item&&supported.has(kind))&&!delta&&!inputDelta&&x.method!=='tool/summary'))return false;
 let map=activityViews.get(parent);if(!map){map=new Map();activityViews.set(parent,map);}
 let record=map.get(id);
 if(!record){
  const root=document.createElement('details');root.className='message activity-item';root.dataset.activityId=id;
  const summary=document.createElement('summary');const heading=document.createElement('span');heading.className='activity-title';const meta=document.createElement('span');meta.className='activity-meta';const preview=document.createElement('span');preview.className='activity-preview';preview.translate=false;heading.translate=false;summary.append(heading,meta,preview);
  const body=document.createElement('div');body.className='activity-content';const command=document.createElement('pre');command.className='activity-command';const output=document.createElement('pre');output.className='activity-output';const note=document.createElement('small');const download=document.createElement('button');download.type='button';download.className='quiet';iconLabel(download,'download','Скачать вывод');
  body.append(command,output,note,download);root.append(summary,body);const group=activityGroup(parent);group.list.append(root);
  record={group,root,heading,meta,preview,command,output,note,download,item:{id,type:kind||(inputDelta?'toolCall':'commandExecution')},text:'',partialInput:'',context};map.set(id,record);
  download.onclick=()=>{const blob=new Blob([safeActivityText(activityTitle(record.item))+'\n\n'+safeActivityText(record.text)],{type:'text/plain;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='agent-output.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 }
 if(item)Object.assign(record.item,item);
 if(delta)record.text+=p.delta||'';
 if(inputDelta)record.partialInput+=p.delta||'';
 if(item){
  if(typeof item.aggregatedOutput==='string')record.text=item.aggregatedOutput;
  else if(item.output!==undefined)record.text=activityText(item.output);
  else if(item.result!=null)record.text=activityText(item.result);
  else if(item.changes)record.text=item.changes.map(c=>c.path+'\n'+(c.diff||activityText(c.kind))).join('\n\n');
  if(item.error)record.text+=(record.text?'\n':'')+activityText(item.error);
  if(item.summary)record.text+=(record.text?'\n':'')+item.summary;
 }
 if(x.method==='tool/summary'){record.item.tool='Итог действий';record.item.status='completed';record.text=p.summary||'';}
 if(x.method==='item/completed'&&!item?.status)record.item.status='completed';
 const i=record.item;let status=i.status||'inProgress';
 if(i.isError||i.error||(typeof i.exitCode==='number'&&i.exitCode!==0))status='failed';
 const labels={preparing:'Подготовка',inProgress:'Выполняется',running:'Выполняется',completed:'Готово',failed:'Ошибка',declined:'Отклонено',interrupted:'Остановлено',background:'В фоне'};
 record.root.dataset.state=status;iconLabel(record.heading,{commandExecution:'terminal',fileChange:'file',webSearch:'globe',imageView:'image',sleep:'clock'}[i.type]||'tools',safeActivityText(activityTitle(i)));
 record.meta.textContent=[status==='completed'?null:tr(labels[status]||status),typeof i.durationMs==='number'?tr('{n} с',{n:(i.durationMs/1000).toFixed(1)}):typeof i.elapsedSeconds==='number'?tr('{n} с',{n:i.elapsedSeconds.toFixed(0)}):null,typeof i.exitCode==='number'?tr('код {code}',{code:i.exitCode}):null].filter(Boolean).join(' · ');
 const text=safeActivityText(record.text),tail=text.trim().split('\n').slice(-3).join('\n');record.preview.textContent=tail|| (status==='preparing'?tr('Готовит аргументы…'):status==='inProgress'?tr('Ожидаем вывод…'):'');
 record.command.textContent=safeActivityText(i.command||(i.input&&Object.keys(i.input).length?i.input:null)||i.arguments||record.partialInput||i.cwd||'');record.command.hidden=!record.command.textContent;
 record.output.textContent=text.slice(-200000);record.output.hidden=!text;record.download.hidden=!text;
 record.note.textContent=text.length>200000?'Показан конец вывода. Полный полученный текст доступен для скачивания.':'';
 if((status==='failed'||status==='declined')&&!record.errorShown){record.root.open=true;record.errorShown=true;}
 updateGroup(record.group);
 return true;
}
// Consecutive tool calls form one collapsed group: count, what runs now (or ran last), errors. Items open inside it.
function activityGroup(parent){
 const chat=parent===$('messages'),last=chat?chatLast():parent.lastElementChild;if(last?.classList.contains('activity-group'))return last._group;
 const root=mapElement('details',null,'message activity-group'),summary=mapElement('summary'),icon=mapElement('span',null,'group-icon'),title=mapElement('span',null,'group-title'),count=mapElement('small',null,'group-count'),list=mapElement('div',null,'activity-list');
 icon.append(uiIcon('terminal'));title.translate=false;summary.append(icon,title,count);root.append(summary,list);if(chat)chatAppend(root);else parent.append(root);
 root._group={root,title,count,list};return root._group;
}
function updateGroup(g){
 const items=[...g.list.children],running=items.filter(e=>['preparing','inProgress','running'].includes(e.dataset.state)),failed=items.filter(e=>['failed','declined'].includes(e.dataset.state));
 const current=running.at(-1)||items.at(-1),label=current?.querySelector('.activity-title .ui-label')?.textContent||'';
 g.title.textContent=label;g.root.dataset.state=running.length?'running':failed.length?'failed':'done';
 // An error is worth seeing at once: the group opens the first time one appears.
 if(failed.length&&!g.root.dataset.autoOpened){g.root.dataset.autoOpened='1';g.root.open=true;}
 g.count.textContent=[tr('{n} действ.',{n:items.length}),failed.length?tr('ошибок: {n}',{n:failed.length}):null].filter(Boolean).join(' · ');
}
function finishActivities(parent,status){
 const groups=new Set();for(const r of activityViews.get(parent)?.values()||[]){groups.add(r.group);if(['preparing','inProgress','running'].includes(r.item.status||'inProgress')){
  const state=status==='interrupted'?'interrupted':status==='failed'?'failed':'unknown';
  r.item.status=state;r.meta.textContent=r.meta.textContent.replace(new RegExp([tr('Подготовка'),tr('Выполняется')].join('|')),tr(state==='unknown'?'Результат не получен':state==='failed'?'Ошибка':'Остановлено'));r.root.dataset.state=state;
  }}
 for(const g of groups)if(g)updateGroup(g);
}

function agentMessage(id) {
  let el = $('messages').querySelector('[data-item="' + CSS.escape(id) + '"]');
  if (!el) { el = message(''); el.dataset.item = id; }
  return el;
}
async function events() {
  if (!selected) return;
  const generation=viewGeneration;
  if(eventRequest?.generation===generation) return eventRequest.promise;
  const promise=readEvents(generation); eventRequest={generation,promise};
  try { await promise; } finally { if(eventRequest?.promise===promise) eventRequest=null; }
}
async function readEvents(generation) {
  const task=selected, b=await api('events?task='+task+'&after='+after);
  if(task!==selected || generation!==viewGeneration) return;
  const follow=$('messages').scrollHeight-$('messages').scrollTop-$('messages').clientHeight<90;
  for (const e of b.events) {
    if(e.id<=after)continue;after = e.id; const x = e.body;
    renderActivity($('messages'),x,currentHost().name+' / '+agentName(tasks.find(t=>t.id===task)?.agent||selectedAgent));
    if (x.method === 'item/started') activeItems.set(x.params.item.id, x.params.item.type);
    if (x.method === 'item/completed') { activeItems.delete(x.params.item.id); if (x.params.item.type === 'agentMessage' && x.params.item.text) setMessage(agentMessage(x.params.item.id),x.params.item.text,true); }
    if (x.method?.startsWith('item/reasoning/')) activeItems.set(x.params.itemId, 'reasoning');
    if (x.method === 'item/agentMessage/delta') { activeItems.set(x.params.itemId,'agentMessage'); const el=agentMessage(x.params.itemId); setMessage(el,(messageText.get(el)||'')+x.params.delta,false); }
    if (x.method === 'turn/completed' || x.type === 'status') {activeItems.clear();finishActivities($('messages'),x.status||x.params?.turn?.status);}
    if (x.type === 'error') message(x.message);
    if (x.type === 'notice' && x.message) message(x.message);
    if (x.type === 'user-message') message(x.text,'user');
    if (x.method === 'background/changed') {chatBackground={task,tasks:x.params?.tasks||[]};}
    if (x.type === 'status') chatBackground={task:null,tasks:[]};
    $('stream').textContent += JSON.stringify(x,null,2) + '\n';
    if ($('stream').textContent.length > 200000) $('stream').textContent = $('stream').textContent.slice(-200000);
  }
  // Пакеты ограничены 500 событиями: догружаем до актуального состояния.
  if (follow) scrollLatest(); else latestVisibility();
  if (b.events.length === 500) return readEvents(generation);
  approvalCount=b.approvals.length;notifyApprovals(task,b.approvals);
  const signature=JSON.stringify(b.approvals);
  if(signature===approvalSignature) { updateActivity(); return; }
  approvalSignature=signature; $('approvals').replaceChildren();
  for (const a of b.approvals) {
    const d = document.createElement('div'); d.className = 'approval'; const h = document.createElement('strong'); h.textContent = 'Требуется подтверждение';
    const intro=document.createElement('p'); intro.textContent=a.params.reason || 'Проверьте действие перед выполнением.'; const p=document.createElement('pre'); p.textContent=JSON.stringify(a.params,null,2); d.append(h,intro,p);
    for (const [text,decision] of [['Разрешить один раз','accept'],['Отклонить','decline']]) {
      const btn = document.createElement('button'); btn.textContent = text; btn.onclick = async () => { d.querySelectorAll('button').forEach(b=>b.disabled=true); try { await api('approval',{task,key:a.key,decision}); approvalSignature=''; await events(); } catch(e) { d.querySelectorAll('button').forEach(b=>b.disabled=false); error(e); } }; d.append(btn);
    }
    $('approvals').append(d);
  }
  updateActivity();
}
$('loginForm').onsubmit = async e => { e.preventDefault(); try { csrf = (await api('login',{password:$('password').value})).csrf; $('password').value = ''; show(true); error(); await refresh(); } catch(e) { error(e); } };
$('logout').onclick = async () => { try { await api('logout',{}); csrf = ''; settings = null; selected = null; mirrorTarget = null; show(false); indicator('connection','Требуется вход','unknown'); } catch(e) { error(e); } };
$('projectForm').onsubmit = async e => { e.preventDefault(); try { await api('projects',{name:$('projectName').value,cwd:$('projectPath').value}); await refresh();$('addProjectDialog').close();$('projectForm').reset();$('refreshTree').onclick();error(); } catch(e) { error(e); } };
$('chatForm').onsubmit = async e => {
  e.preventDefault();
  // Until the live view has loaded (right after opening the chat, or after a turn of the copy) the original's state is
  // unknown: ask before sending, so a message for an open session never goes to its copy by mistake.
  if(mirrorTarget&&!mirrorTarget.live&&$('prompt').value.trim()&&!submitting){
   try{const h=await sessionsApi('/history?task='+encodeURIComponent(mirrorTarget.task));mirrorTarget.live=Boolean(h.session?.live);mirrorTarget.dialog=h.session?.live&&h.session?.dialog||null;}catch{}
   if(!mirrorTarget.live)$('draftState').textContent=tr('Оригинал закрыт — ответит его копия в панели');
  }
  // The chat of an open Remote Control session: the message goes to the original itself, typed into its terminal.
  if(mirrorTarget?.dialog&&!attachments.length&&$('prompt').value.trim()&&!submitting){
   if(mirrorTarget.dialog.free<0){error(Error(tr('У этого вопроса нет своего ответа: выберите вариант в чате.')));return;}
   submitting=true;updateActivity();
   try{await api('agent-sessions/answer',{task:mirrorTarget.task,text:$('prompt').value,expect:mirrorTarget.dialog.options.map(o=>o.label).join('|')});$('prompt').value='';writeSession(draftKey(),'');resizePrompt();$('draftState').textContent=tr('Ответ отправлен в терминал');mirrorTarget.poke?.();error();}
   catch(err){error(err);}finally{submitting=false;updateActivity();}
   return;
  }
  if(mirrorTarget?.live&&($('prompt').value.trim()||attachments.length)&&!uploading&&!submitting){
   submitting=true;updateActivity();const text=$('prompt').value;
   let toCopy=false;
   // Unsent text left in the session's prompt (the owner's draft in the terminal, or a message that did not go through) is
   // shown, and replaced only when the owner agrees.
   const say=replace=>api('agent-sessions/say',{task:mirrorTarget.task,text,attachments:attachments.map(f=>f.id),...(replace?{replace:true}:{})});
   try{try{await say(false);}catch(err){if(err.draft===undefined||!confirm(tr('В поле ввода сессии лежит неотправленный текст:')+'\n\n'+err.draft+'\n\n'+tr('Заменить его вашим сообщением?')))throw err;await say(true);}$('prompt').value='';attachments=[];renderAttachments();writeSession(draftKey(),'');writeSession(draftKey()+'-files','');resizePrompt();$('draftState').textContent=tr('Отправлено в Remote Control');mirrorTarget.poke?.();error();}
   catch(err){if(err.copy){toCopy=true;mirrorTarget.live=false;$('draftState').textContent=tr(err.message);}else error(err);}finally{submitting=false;updateActivity();}
   // The original closed or has no terminal: the message goes to its copy in the panel as an ordinary turn.
   if(!toCopy)return;
  }
  const running=tasks.find(t=>t.id===selected);
  if(running?.status==='running'&&(running.agent||'codex')==='claude'&&!attachments.length&&$('prompt').value.trim()&&!submitting){
   submitting=true;updateActivity();
   try{await api('tasks/inject',{task:running.id,text:$('prompt').value});$('prompt').value='';writeSession(draftKey(),'');resizePrompt();$('draftState').textContent=tr('Добавлено в текущий ход');await events();error();}
   catch(err){error(err);}finally{submitting=false;updateActivity();}
   return;
  }
  if(busy||!settings||submitting||uploading||(!$('prompt').value.trim()&&!attachments.length)) return;
  submitting=true; updateActivity(); const key=draftKey(),project=$('projects').value;
  const previous=selected,prompt=$('prompt').value;
  try {
    saveSettings(); const payload={project:Number(project),agent:selectedAgent,prompt,previous,attachments:attachments.map(f=>f.id),model:$('model').value,permissions:$('permissions').value,reasoning:$('reasoning').value};
    const content=JSON.stringify(payload);let pending;try{pending=JSON.parse(readSession(key+'-request')||'null');}catch{}
    if(!pending||pending.content!==content)pending={content,id:requestToken()};writeSession(key+'-request',JSON.stringify(pending));
    const b=await api('tasks',{...payload,requestId:pending.id});writeSession(key+'-request','');
    // A session started with "+" keeps the name the owner gave it.
    if(pendingChatName&&!previous){api('chats/title',{chain:b.id,title:pendingChatName}).catch(()=>{});pendingChatName='';}
    writeSession(key,''); writeSession(key+'-files','');
    if(project===draftProject&&previous===selected) { $('prompt').value=''; attachments=[]; renderAttachments(); resizePrompt(); }
    await history(); const task=tasks.find(t=>t.id===b.id); submitting=false;
    if(task&&project===draftProject&&previous===selected) await choose(task);
    error();
  } catch(e) { error(e); } finally { submitting=false; updateActivity(); }
};
$('new').onclick = async () => {
  if(submitting || uploading) return; saveDraft(); selected=null; mirrorTarget=null; viewGeneration++; after=0; activeItems.clear(); approvalCount=0; approvalSignature='';
  writeSession('panel-selected-'+draftProject,''); emptyChat(); $('approvals').replaceChildren(); $('stream').textContent=''; $('title').textContent=$('projects').selectedOptions[0]?.textContent||'Чат проекта'; $('title').title=''; restoreDraft(); renderHistory(); updateActivity(); sidebar(false); $('prompt').focus(); if(selectedAgent!==defaultAgent())await loadSettings(defaultAgent());
};
$('projects').onchange = async () => {
  saveDraft(); draftProject=$('projects').value; selected=null; mirrorTarget=null; viewGeneration++; after=0; activeItems.clear(); approvalCount=0; approvalSignature='';
  $('approvals').replaceChildren(); $('stream').textContent=''; $('title').textContent=$('projects').selectedOptions[0]?.textContent||'Чат проекта'; projectLabels(); emptyChat(); restoreDraft(); renderHistory(); updateActivity();
  const saved=tasks.find(t=>String(t.project)===draftProject);
  if(saved) await choose(saved); else if(selectedAgent!==defaultAgent())await loadSettings(defaultAgent());
};
$('stop').onclick = async () => { $('stop').disabled=true; try { await api('stop',{task:selected}); await history(); } catch(e) { error(e); updateActivity(); } };
$('git').onclick = async () => { $('gitDialog').showModal(); $('gitText').textContent=tr('Загружаем изменения…'); try { const b=await api('git?project='+$('projects').value); $('gitText').textContent=tr('СОСТОЯНИЕ')+'\n'+b.status+'\n'+tr('ИЗМЕНЕНИЯ')+'\n'+(b.diff||tr('Нет изменений в рабочих файлах'))+'\n'+tr('ПОДГОТОВЛЕНО К КОММИТУ')+'\n'+(b.staged||tr('Нет подготовленных изменений')); } catch(e) { $('gitText').textContent=e.message; } };
function scopedKey(key){return selectedHost==='local'||key==='panel-host'?key:'host:'+selectedHost+':'+key;}
function readSession(key) { try { return sessionStorage.getItem(scopedKey(key))||''; } catch { return ''; } }
function writeSession(key,value) { try { sessionStorage.setItem(scopedKey(key),value); return true; } catch { return false; } }
function draftKey() { return 'panel-draft-'+draftProject+'-'+(selected||'new'); }
function saveDraft() { if(!draftProject) return; const saved=writeSession(draftKey(),$('prompt').value); writeSession(draftKey()+'-files',JSON.stringify(attachments)); $('draftState').textContent=$('prompt').value?(saved?'Черновик сохранён':'Черновик не сохранён'):''; }
function restoreDraft() { $('prompt').value=readSession(draftKey()); try{const files=JSON.parse(readSession(draftKey()+'-files')||'[]');attachments=Array.isArray(files)?files.filter(f=>typeof f.id==='string'&&typeof f.name==='string').slice(0,5):[];}catch{attachments=[];} renderAttachments();resizePrompt(); $('draftState').textContent=$('prompt').value?'Черновик восстановлен':''; updateActivity(); }
function projectLabels() { updateSessionsButton(); $('projectFormHost').textContent=tr('Сервер: {host} · {address}',{host:currentHost().name,address:currentHost().address||tr('локальный')}); const mark=$('settingsButton').querySelector('.settings-agent-icon');if(mark?.dataset.icon!==agentIcon(selectedAgent))mark?.replaceWith(uiIcon(agentIcon(selectedAgent),'settings-agent-icon')); const o=$('projects').selectedOptions[0]; $('projectLabel').textContent=currentHost().name+((currentHost().agents||[]).length>1?' · '+agentName(selectedAgent):'');$('status').dataset.host=currentHost().name||''; $('projectPathLabel').textContent=o?.title||''; writeSession('panel-project',$('projects').value); }
function sidebar(open) { $('sidebar').classList.toggle('is-open',open); $('sidebarBackdrop').hidden=!open; $('toggleSidebar').setAttribute('aria-expanded',String(open)); $('sidebar').setAttribute('aria-hidden',String(!open && matchMedia('(max-width:899px)').matches)); if(open) $('closeSidebar').focus(); }
function scrollLatest() { $('messages').scrollTop=$('messages').scrollHeight; $('toLatest').hidden=true; }
function latestVisibility() { $('toLatest').hidden=$('messages').scrollHeight-$('messages').scrollTop-$('messages').clientHeight<90; }
async function loadHosts(){
  hostList=await api('hosts');if(!hostList.some(h=>h.id===selectedHost))selectedHost=hostList[0]?.id||'local';
  options('hosts',hostList.map(h=>[h.id,h.name+' · '+(h.address||tr('локальный'))]),selectedHost);
  applyHost();
}
function applyHost(){
  $('hostAddress').textContent=currentHost().address||'';
  options('agent',(currentHost().agents||[]).map(a=>[a,agentName(a)]),selectedAgent);
  writeSession('panel-host',selectedHost);
}
$('hosts').onchange=async()=>{
  if(submitting||uploading){$('hosts').value=selectedHost;return;}
  saveDraft();selectedHost=$('hosts').value;applyHost();selected=null;mirrorTarget=null;tasks=[];after=0;settings=null;draftProject='';viewGeneration++;settingsGeneration++;aiSettingsGeneration++;
  activeItems.clear();approvalCount=0;approvalSignature='';historySignature='';$('projects').replaceChildren();$('approvals').replaceChildren();$('stream').textContent='';$('title').textContent=$('projects').selectedOptions[0]?.textContent||'Чат проекта';$('prompt').value='';attachments=[];renderAttachments();emptyChat();renderHistory();updateActivity();
  try{await refresh();error();}catch(e){error(e);}
  refreshUsage();
};
let communicationRequest=null;
let mailViewRequest=false,mailCatalog=[],mailCatalogTime=0;
function mailState(m){return m.answered_at?'Получен ответ':m.delivery_state==='failed'?'Ошибка обработки':m.read_at?'Прочитано':m.delivery_state==='expired'?'Истёк срок ожидания':m.delivered_at?'Доставлено':'В очереди';}
// Mail between sessions in the chat: one collapsed line with direction, counterpart and a preview; the text opens on tap.
// The writing session's own name when known (several sessions share a project folder), else the project.
function recipientLabel(m,titles){return m.recipient_name?String(m.recipient).split(':')[0].replace(/^local$/,currentHost()?.name||'local')+' / '+m.recipient_name:mailName(m.recipient,titles);}
function senderLabel(m,titles){return m.sender_name?String(m.sender).split(':')[0].replace(/^local$/,currentHost()?.name||'local')+' / '+m.sender_name:mailName(m.sender,titles);}
function mailName(address,titles){if(address==='owner')return tr('Владелец');if(titles?.has(address))return titles.get(address);const p=mailCatalog.find(x=>x.id===address);return p?p.host+' / '+p.projectName:String(address||'');}
// Chat items with a time (earlier turns, the current prompt, mail) stay in time order; mail goes before the first later item.
function placeByTime(row,time){row.dataset.time=time;const next=[...$('messages').children].find(e=>e!==row&&e.dataset.time&&e.dataset.time>time);if(next)$('messages').insertBefore(row,next);else $('messages').append(row);}
// One quiet line per letter: direction arrow, who, what it is about, state. The full text opens below it.
const mailWho=label=>{const full=label.replace(/^(Отправлено|Получено|Sent|Received)\s*(→|от|from|to)?\s*/,'');return {full,short:full.split(' / ').at(-1)};};
// Sessions start letters with their own "A → B (11.10)." header: the row already says who wrote to whom.
const mailGist=body=>String(body||'').split('\n').find(l=>l.trim())?.replace(/^[^\n]{0,90}?→[^\n]{0,90}?\(\d{1,2}\.\d{1,2}(\.\d{2,4})?\)[.:,]?\s*/,'').slice(0,160)||'';
function mailRow(dir,label,body){
 const row=mapElement('details',null,'message project-mail');row.dataset.dir=dir;
 const summary=mapElement('summary');const tag=mapElement('span',null,'mail-dir');iconLabel(tag,dir==='out'?'send':'message',dir==='out'?'Отправлено':'Получено');
 const name=mailWho(label),who=mapElement('strong',name.short,'mail-source');who.title=name.full;who.translate=false;
 const preview=mapElement('span',mailGist(body),'mail-preview');preview.translate=false;
 summary.append(tag,who,preview,mapElement('small',null,'mail-state'));
 const text=mapElement('div',body,'message-body');text.translate=false;row.append(summary,text);return row;
}
// A turn started by mail: the panel's prompt carries the message as JSON after the explanation.
function mailFromPrompt(t){const m=t.prompt.match(/\{"sender".*\}/s);if(!m)return null;try{const x=JSON.parse(m[0]);return x&&typeof x.body==='string'?x:null;}catch{return null;}}
async function projectMailView(){
 if(!csrf||mailViewRequest||!$('projects').value)return;mailViewRequest=true;
 const host=selectedHost,project=$('projects').value,generation=viewGeneration;
 try{
  if(Date.now()-mailCatalogTime>15000){const catalog=await api('communication/projects');if(!Array.isArray(catalog.projects))return;mailCatalog=catalog.projects;mailCatalogTime=Date.now();}
  const me=mailCatalog.find(p=>p.host===host&&String(p.project)===project);if(!me)return;
  const messages=await api('communication/messages?project='+encodeURIComponent(me.id));
  if(host!==selectedHost||project!==$('projects').value||generation!==viewGeneration||!Array.isArray(messages))return;
  const titles=new Map(mailCatalog.map(p=>[p.id,p.host+' / '+p.projectName]));
  const follow=$('messages').scrollHeight-$('messages').scrollTop-$('messages').clientHeight<90;
  for(const m of [...messages].reverse()){
   if(m.sender!==me.id&&m.recipient!==me.id)continue;
   let row=$('messages').querySelector('[data-mail-id="'+CSS.escape(m.id)+'"]');const out=m.sender===me.id,other=out?m.recipient:m.sender;
   if(!row){$('messages').querySelector('.chat-empty')?.remove();row=mailRow(out?'out':'in',out?tr('Отправлено → {name}',{name:recipientLabel(m,titles)}):tr('Получено от {name}',{name:senderLabel(m,titles)}),m.body);row.dataset.mailId=m.id;placeByTime(row,m.created);}
   // A row drawn from a turn's prompt knows only the address: the mail record names the writing session.
   else{const name=mailWho(out?recipientLabel(m,titles):senderLabel(m,titles)),who=row.querySelector('.mail-source');who.textContent=name.short;who.title=name.full;}
   const state=row.querySelector('.mail-state');state.textContent=tr(mailState(m));state.title=m.delivery_error||new Date(m.created).toLocaleString(locale());
  }
  if(follow)scrollLatest();
 }catch{}finally{mailViewRequest=false;}
}
async function refreshCommunication(){
 $('communicationStatus').textContent='Загружаем сессии и журнал…';
 try{const [directory,messages]=await Promise.all([api('communication/projects').then(value=>Array.isArray(value?.projects)?value:api('communication/sessions')).catch(()=>api('communication/sessions')),api('communication/messages')]);
  let entries=directory.projects||directory.sessions||[];if(directory.projects){try{const legacy=await api('communication/sessions');entries=[...entries,...(legacy.sessions||[])];}catch{}}
  const before=$('messageRecipient').value;
  const recipients=new Map();for(const x of entries){const key=x.host+':'+x.cwd;const old=recipients.get(key);if(!old||(!old.lastTask&&x.lastTask))recipients.set(key,x);}
  options('messageRecipient',[...recipients.values()].map(x=>[x.id,x.host+' / '+x.projectName]),before);
  $('sendAgentMessage').disabled=!entries.length;
  $('communicationStatus').textContent=directory.errors.length?tr('Нет связи: {names}',{names:directory.errors.map(x=>x.name).join(', ')}):entries.length?'Свободный проект продолжит свой чат и ответит. Занятый проект получит запрос после текущего хода.':'Отправьте первое сообщение в проект, чтобы он появился среди получателей.';
  const titles=new Map(entries.map(x=>[x.id,x.host+' / '+x.projectName+' / '+agentName(x.agent)]));
  $('communicationLog').replaceChildren();
  for(const m of messages){const row=mapElement('article',null,'communication-message');const body=mapElement('p',m.body);body.translate=false;row.append(mapElement('h3',(m.sender==='owner'?tr('Владелец'):m.sender_name?senderLabel(m):titles.get(m.sender)||m.sender)+' → '+(titles.get(m.recipient)||m.recipient)),mapElement('small',new Date(m.created).toLocaleString(locale())+' · '+tr(mailState(m))),body);$('communicationLog').append(row);}
  if(!messages.length)$('communicationLog').append(mapElement('p','Сообщений пока нет.'));
 }catch(e){$('communicationStatus').textContent=e.message;}
}
$('communicationButton').onclick=()=>{sidebar(false);$('communicationDialog').showModal();refreshCommunication();};
$('refreshCommunication').onclick=refreshCommunication;
$('communicationForm').onsubmit=async e=>{e.preventDefault();const recipient=$('messageRecipient').value,body=$('agentMessage').value;
 if(!communicationRequest||communicationRequest.recipient!==recipient||communicationRequest.body!==body)communicationRequest={recipient,body,requestKey:requestToken()};
 $('sendAgentMessage').disabled=true;
 try{await api('communication/messages',communicationRequest);communicationRequest=null;$('agentMessage').value='';await refreshCommunication();}catch(e){$('communicationStatus').textContent=e.message;}finally{$('sendAgentMessage').disabled=!$('messageRecipient').options.length;}
};
$('prompt').oninput=()=>{resizePrompt();saveDraft();updateActivity();};
$('prompt').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&(!matchMedia('(pointer:coarse)').matches||e.ctrlKey||e.metaKey)){e.preventDefault();$('chatForm').requestSubmit();}};
$('historySearch').oninput=renderHistory;
$('messages').onscroll=latestVisibility; $('toLatest').onclick=scrollLatest;
$('toggleSidebar').onclick=()=>sidebar(!$('sidebar').classList.contains('is-open'));
$('closeSidebar').onclick=$('sidebarBackdrop').onclick=()=>{sidebar(false);$('toggleSidebar').focus();};
let aiSettingsGeneration=0;
function savedAgentSettings(agent) {
  try { const value=JSON.parse(localStorage.getItem(preferenceKey(agent))||'{}'); return value&&typeof value==='object'&&!Array.isArray(value)?value:{}; } catch { return {}; }
}
function agentLocation(agent) {
  const block=mapElement('div',null,'ai-location');
  const list=mapElement('dl');
  const rows=[
    ['Сервер запуска',currentHost().name],
    ['IP сервера',currentHost().address||'Локальный сервер'],
    ['Папка проекта',$('projects').selectedOptions[0]?.title||'Проект не выбран'],
    ['Поставщик модели',agentMeta(agent).vendor||'—'],
    ['Подключение',agentMeta(agent).connection||'—']
  ];
  for(const [name,value] of rows){const row=mapElement('div');row.append(mapElement('dt',name),mapElement('dd',value));list.append(row);}
  const detail=document.createElement('details');detail.append(mapElement('summary','Путь запуска агента'));
  detail.append(mapElement('code',currentHost().paths?.[agent]||'Путь не проверен'));
  block.append(list,detail);return block;
}
async function openAISettings() {
  $('aiSettingsTitle').textContent=tr('Настройки ИИ · {host}',{host:currentHost().name});
  sidebar(false);$('settingsDialog').close();$('projectMapDialog').close();
  if(!$('aiSettingsDialog').open)$('aiSettingsDialog').showModal();
  const generation=++aiSettingsGeneration;const settingsHost=selectedHost;
  $('aiSettingsPanels').replaceChildren();
  await Promise.all((currentHost().agents||[]).map(async agent=>{
    const card=document.createElement('section');card.className='ai-settings-card';card.dataset.ai=agent;
    const heading=mapElement('h3',agentName(agent));iconLabel(heading,agentIcon(agent),agentName(agent));const status=mapElement('p','Загружаем модели…','ai-catalog-status');status.setAttribute('role','status');
    const location=agentLocation(agent);card.append(heading,location,status);$('aiSettingsPanels').append(card);
    async function load() {
      if(!currentHost().agents?.includes(agent)){status.textContent='Не установлен на выбранном сервере';return;}
      status.textContent='Загружаем модели…';
      try {
        const catalog=await api('settings?agent='+agent);
        if(generation!==aiSettingsGeneration||settingsHost!==selectedHost)return;
        if(!catalog.models?.length||!catalog.permissions?.length)throw Error('Список настроек агента пуст');
        card.replaceChildren(heading,location,status);status.textContent='Список моделей загружен';
        let saved=savedAgentSettings(agent);
        const form=document.createElement('form');form.className='ai-settings-form';
        function field(name,title,values,value) {
          const id='ai-'+agent+'-'+name, label=mapElement('label',title);label.htmlFor=id;
          const select=document.createElement('select');select.id=id;select.name=name;select.required=true;
          for(const [v,t] of values){const option=mapElement('option',t);option.value=v;select.append(option);}
          if(values.some(v=>v[0]===value))select.value=value;
          form.append(label,select);return select;
        }
        const model=field('model','Модель',catalog.models.map(m=>[m.model,m.displayName||m.model]),catalog.models.some(m=>m.model===saved.model)?saved.model:(catalog.models.find(m=>m.isDefault)||catalog.models[0]).model);
        const effort=field('reasoning','Уровень рассуждения',[],null);
        function efforts() {
          const m=catalog.models.find(m=>m.model===model.value), values=m.supportedReasoningEfforts||[];
          effort.replaceChildren();for(const e of values){const option=mapElement('option',effortLabels[e.reasoningEffort]||e.reasoningEffort);option.value=e.reasoningEffort;effort.append(option);}
          const wanted=saved.reasoningByModel?.[model.value]||(saved.model===model.value?saved.reasoning:null)||m.defaultReasoningEffort;
          if(values.some(e=>e.reasoningEffort===wanted))effort.value=wanted;
          effort.disabled=!values.length;effort.required=!!values.length;
        }
        efforts();model.onchange=()=>{efforts();status.textContent='Есть несохранённые изменения';};
        const permission=field('permissions','Разрешения',catalog.permissions.map(p=>[p.id,p.label]),saved.permissions||'workspace');
        const help=mapElement('p',null,'ai-permission-help');help.id='ai-'+agent+'-help';permission.setAttribute('aria-describedby',help.id);
        function explain(){help.textContent=catalog.permissions.find(p=>p.id===permission.value)?.description||'';}
        explain();permission.onchange=()=>{explain();status.textContent='Есть несохранённые изменения';};effort.onchange=()=>{status.textContent='Есть несохранённые изменения';};
        const save=mapElement('button',tr('Сохранить {agent}',{agent:agentName(agent)}),'primary');save.type='submit';form.append(help,save);
        form.onsubmit=e=>{
          e.preventDefault();
          const latest=savedAgentSettings(agent);
          const value={model:model.value,reasoning:effort.value,permissions:permission.value,reasoningByModel:{...(latest.reasoningByModel||{}),[model.value]:effort.value}};
          try {localStorage.setItem(preferenceKey(agent),JSON.stringify(value));}
          catch {status.textContent='Браузер не разрешает сохранение. Настройки не изменены.';return;}
          saved=value;status.textContent='Сохранено в этом браузере';
          if(selectedAgent===agent){
            // Invalidate an older catalog request without changing the current agent/chat.
            settingsGeneration++;settings=catalog;preferences=value;
            options('model',catalog.models.map(m=>[m.model,m.displayName||m.model]),value.model);
            options('permissions',catalog.permissions.map(p=>[p.id,p.label]),value.permissions);
            reasoning(value.reasoning);settingsSummary();updateActivity();
          }
        };
        card.append(form);
      } catch(e) {
        if(generation!==aiSettingsGeneration||settingsHost!==selectedHost)return;
        status.textContent=e.message;
        const retry=mapElement('button','Повторить загрузку','quiet');retry.type='button';retry.onclick=()=>{retry.remove();load();};card.append(retry);
      }
    }
    await load();
  }));
}
$('aiSettingsButton').onclick=$('sidebarAISettings').onclick=$('allAISettings').onclick=openAISettings;
// Project maps are reference material from .panel/map.json or the panel's data/project-maps; switching views never changes the chat or agent.
function mapElement(tag, text, className) {
  const el=document.createElement(tag); if(text)el.textContent=text; if(className)el.className=className; return el;
}
let projectMapData=null,mapRequest=0;
const mapTemplate='Составь справочную схему этого проекта для рабочей панели. Изучи код и запиши файл .panel/map.json в корне проекта (UTF-8, JSON без комментариев) в формате:\n{"title":"Название","updated":"дата","sections":[{"id":"architecture","label":"Устройство","title":"…","note":"…","nodes":[["Компонент","Технология","Назначение"]],"detail":"…"},{"id":"turn","label":"Путь запроса","title":"…","nodes":[["01 · Шаг","Где","Что происходит"]]},{"id":"code","label":"Код","title":"…","rows":[["путь/","назначение"]]},{"id":"links","label":"Адреса","title":"…","links":[["Название","https://…","назначение"]]}]}\nНе включай пароли, токены и ключи. Других файлов не меняй.';
async function loadProjectMap(){
  const request=++mapRequest,project=$('projects').value;projectMapData=undefined;
  try{const b=await api('project-map?project='+encodeURIComponent(project));if(request===mapRequest)projectMapData=b.map||null;}
  catch{if(request===mapRequest)projectMapData=null;}
}
function renderProjectMap(section) {
  const option=$('projects').selectedOptions[0], cwd=(option?.title||'').replace(/\/$/,''), map=projectMapData;
  $('projectMapTitle').textContent=tr('Схемы')+' · '+(option?.textContent||tr('Проект'));
  $('projectMapPath').textContent=cwd;
  const nav=$('mapNavigation');nav.replaceChildren();const container=$('projectMapContent');container.replaceChildren();
  $('mapFooterNote').textContent=map?(map.updated?tr('Справочная схема · {date}.',{date:map.updated})+' ':'')+(map.source==='project'?tr('Файл проекта .panel/map.json.'):tr('Схема хранится в панели.'))+' '+tr('Доступность служб здесь не проверяется.'):'';
  if(map===undefined){container.append(mapElement('p',tr('Загружаем схему…')));return;}
  if(!map?.sections?.length){
    container.append(mapElement('h3',tr('Карта пока не подготовлена')),mapElement('p',tr('Схема берётся из файла .panel/map.json в папке проекта. ИИ может изучить проект и составить её; сообщение откроется в чате, проверьте его перед отправкой.')));
    const ask=mapElement('button',null,'primary');ask.type='button';iconLabel(ask,'map',tr('Попросить ИИ составить схему'));ask.onclick=()=>{$('projectMapDialog').close();$('prompt').value=tr(mapTemplate);resizePrompt();saveDraft();updateActivity();$('prompt').focus();};container.append(ask);return;
  }
  const current=map.sections.find(x=>x.id===section)||map.sections[0];
  for(const x of map.sections){const b=mapElement('button',x.label);b.type='button';b.setAttribute('aria-pressed',String(x===current));b.onclick=()=>renderProjectMap(x.id);nav.append(b);}
  nav.hidden=map.sections.length<2;
  const data=current;container.append(mapElement('h3',data.title||data.label));if(data.note)container.append(mapElement('p',data.note,'map-note'));
  if(data.nodes?.length){const flow=mapElement('ol',null,'map-flow'); for(const [title,subtitle,detail] of data.nodes){const node=mapElement('li');node.append(mapElement('h4',title),mapElement('strong',subtitle),mapElement('p',detail));flow.append(node);}container.append(flow);}
  if(data.detail)container.append(mapElement('p',data.detail,'map-detail'));
  if(data.rows?.length){const list=mapElement('dl',null,'map-code'); for(const [path,detail] of data.rows){const row=mapElement('div');row.append(mapElement('dt',path),mapElement('dd',detail));list.append(row);}container.append(list);}
  if(data.links?.length){const list=mapElement('ul',null,'map-links');for(const [title,url,detail] of data.links){let host='';try{host=new URL(url).host;}catch{continue;}const row=mapElement('li'),link=mapElement('a',title);link.href=url;link.target='_blank';link.rel='noopener noreferrer';row.append(link,mapElement('p',detail),mapElement('small',host));list.append(row);}container.append(list);}
}
$('sidebarProjectMap').onclick=$('projectMapButton').onclick=async()=>{sidebar(false);const project=$('projects').value;projectMapData=undefined;renderProjectMap();$('projectMapDialog').showModal();await loadProjectMap();if(project===$('projects').value&&$('projectMapDialog').open)renderProjectMap();};
$('mapSettings').onclick=()=>{$('projectMapDialog').close();$('settingsDialog').showModal();};
$('selectProjectButton').onclick=()=>{sidebar(false);$('selectProjectDialog').showModal();};
$('addProjectButton').onclick=()=>{sidebar(false);projectLabels();$('addProjectDialog').showModal();$('projectName').focus();};
$('settingsButton').onclick=()=>$('settingsDialog').showModal();
// Claude Code sessions started in a terminal on the server: continue them in the project chat.
// agent-sessions covers every agent; nodes on the previous release only know claude-sessions.
async function sessionsApi(route,data){try{return await api('agent-sessions'+route,data);}catch(e){if(e.message!=='Не найдено')throw e;return api('claude-sessions'+route,data);}}
async function terminalHistory(parent,task,generation){
 const status=mapElement('p',tr('Загружаем историю…'),'terminal-note');parent.append(status);const agent=task.agent||'claude';
 try{const h=await sessionsApi('/history?task='+encodeURIComponent(task.id));if(generation!==viewGeneration)return;status.remove();
  if(h.truncated)parent.append(mapElement('p',tr('Показаны последние сообщения сессии.'),'terminal-note'));
  for(const m of h.messages){const row=mapElement('div',null,'terminal-message '+m.role);row.dataset.agent=agent;const who=mapElement('small',null,'terminal-role');iconLabel(who,m.role==='user'?'user':agentIcon(agent),m.role==='user'?'Вы':agentName(agent));const body=mapElement('div',null,'message-body formatted');body.translate=false;markdown(body,m.text);row.append(...(m.role==='user'?[who]:[]),body);parent.append(row);}
  if(!h.messages.length)parent.append(mapElement('p',tr('В файле сессии нет текстовых сообщений.'),'terminal-note'));
 }catch(e){status.textContent=e.message;}
}
// Live view of an attached terminal session's original: its recent messages and steps, refreshed while the chat is open.
let mirrorTarget=null;
// A choice the open session waits for on its screen: the options as buttons; a free answer goes from the composer.
function dialogCard(target,root){
 const d=target.dialog,card=mapElement('div',null,'session-dialog');card.translate=false;
 const head=mapElement('strong',d.kind==='permission'?tr('Сессия просит разрешение'):tr('Сессия ждёт вашего ответа')+(d.title?' · '+d.title:''));
 card.append(head,mapElement('p',d.question));
 const list=mapElement('div',null,'session-dialog-options');
 for(const o of d.options){if(/^Type something/i.test(o.label))continue;
  const b=mapElement('button',null,'session-dialog-option');b.type='button';b.append(mapElement('span',o.n+'. '+o.label));if(o.description)b.append(mapElement('small',o.description));
  b.onclick=async()=>{list.querySelectorAll('button').forEach(x=>x.disabled=true);try{await api('agent-sessions/answer',{task:root.id,option:o.n,expect:d.options.map(o=>o.label).join('|')});$('draftState').textContent=tr('Ответ отправлен в терминал');target.poke?.();error();}catch(e){error(e);list.querySelectorAll('button').forEach(x=>x.disabled=false);}};
  list.append(b);}
 card.append(list);if(d.free>=0)card.append(mapElement('small',tr('Свой ответ напишите в поле ввода ниже.'),'session-dialog-hint'));
 return card;
}
function mirrorSession(root,generation){
 $('messages').querySelector('.live-mirror')?.remove();
 const name=root.prompt.replace(/^Сессия из терминала:\s*/,'');
 const box=mapElement('details',null,'message terminal-session live-mirror');box.dataset.agent=root.agent||'claude';box.open=true;box.dataset.time='9999';
 const summary=mapElement('summary');iconLabel(summary,'terminal',name);summary.querySelector('.ui-label').translate=false;
 const state=mapElement('small',tr('Загружаем…'),'terminal-mode');summary.append(state);
 const content=mapElement('div',null,'terminal-history');box.append(summary,content);$('messages').append(box);
 const target={task:root.id,name,live:false};mirrorTarget=target;let last='',timer=null;
 async function load(){
  if(generation!==viewGeneration||!box.isConnected){clearTimeout(timer);return;}
  try{const h=await sessionsApi('/history?task='+encodeURIComponent(root.id)+'&tools=1');if(generation!==viewGeneration)return;
   const s=h.session||{};
   // An open session the panel cannot type into (a background or console session) is shown like a closed one: its copy answers.
   if(s.live&&s.typable===false){s.live=false;s.untypable=true;}
   target.live=Boolean(s.live);target.background=s.live&&Array.isArray(s.background)?s.background:[];target.dialog=s.live&&s.dialog||null;target.working=Boolean(s.live&&s.turnOpen&&!target.dialog);
   state.replaceChildren();if(target.dialog)state.textContent=tr('ждёт вашего ответа');else if(s.live&&s.turnOpen){state.append(mapElement('span',null,'working-bars'),document.createTextNode(' '+tr('работает в Remote Control')));}
   else state.textContent=tr(s.live?'в Remote Control · ждёт сообщения':s.untypable?'открыта без терминала · отвечает копия в панели':'закрыта · ответит копия в панели');
   // Newer panel turns (the copy answered while the original was quiet) stay below: the live view takes its place by time.
   const newer=s.live&&[...$('messages').children].some(e=>e!==box&&e.dataset.time&&e.dataset.time!=='9999'&&e.dataset.time>(s.updated||''));
   if(s.live&&newer&&box.dataset.time!==s.updated){box.dataset.time=s.updated||'';const next=[...$('messages').children].find(e=>e!==box&&(!e.dataset.time||e.dataset.time>box.dataset.time));if(next)$('messages').insertBefore(box,next);}
   else if(s.live&&!newer&&box.dataset.state!=='closed'&&box.dataset.time!=='9999'){box.dataset.time='9999';$('messages').append(box);}
   const was=box.dataset.state;box.dataset.state=s.live?(target.dialog?'live':s.turnOpen?'working':'live'):'closed';
   // A closed original is history: it folds and takes its place by time (rows of the current turn carry no time and are
   // newer), so the copy's turns stay below it.
   // An open one is the live view at the bottom.
   if(!s.live&&was!=='closed'){box.open=false;box.dataset.time=s.updated||'';const next=[...$('messages').children].find(e=>e!==box&&(!e.dataset.time||e.dataset.time>box.dataset.time));if(next)$('messages').insertBefore(box,next);}
   else if(s.live&&was==='closed'){box.open=true;box.dataset.time='9999';$('messages').append(box);}
   const sign=s.updated+'|'+s.turnOpen+'|'+h.messages.length+'|'+JSON.stringify(target.dialog);
   if(sign!==last){last=sign;const follow=$('messages').scrollHeight-$('messages').scrollTop-$('messages').clientHeight<90;content.replaceChildren();
    for(const m of h.messages){
     if(m.role==='tool'){const row=mapElement('div',null,'terminal-step');row.append(uiIcon('terminal'),mapElement('span',m.text||'…'));row.translate=false;content.append(row);continue;}
     if(m.role==='user'&&wakeLine(m.text)){content.append(panelNote(m.text));continue;}
     const row=mapElement('div',null,'terminal-message '+m.role);row.dataset.agent=root.agent||'claude';const who=mapElement('small',null,'terminal-role');iconLabel(who,m.role==='user'?'user':agentIcon(root.agent||'claude'),m.role==='user'?'Вы':name);const body=mapElement('div',null,'message-body formatted');body.translate=false;markdown(body,m.text);row.append(...(m.role==='user'?[who]:[]),body);content.append(row);}
    if(target.dialog)content.append(dialogCard(target,root));
    if(follow||target.dialog)scrollLatest();}
   updateActivity();
  }catch(e){state.textContent=e.message;}
  // poke() may have set a timer while this request was in flight: keep a single polling chain.
  clearTimeout(timer);timer=setTimeout(load,target.live?3000:15000);
 }
 target.poke=()=>{clearTimeout(timer);timer=setTimeout(load,800);};
 load();
}
function terminalBlock(task,generation){
 const box=mapElement('details',null,'message terminal-session');box.dataset.agent=task.agent||'claude';box.dataset.time=task.created;box.open=true;
 const summary=mapElement('summary');iconLabel(summary,'terminal',task.prompt);summary.querySelector('.ui-label').translate=false;
 summary.append(mapElement('small',tr(Number(task.fork)===1?'Копия · оригинал не меняется':'Перенесена в панель'),'terminal-mode'));
 const content=mapElement('div',null,'terminal-history');box.append(summary,content);$('messages').append(box);
 terminalHistory(content,task,generation).then(()=>{if(generation===viewGeneration)scrollLatest();});
}
function sizeLabel(bytes){return bytes>1048576?(bytes/1048576).toFixed(1)+' MB':Math.max(1,Math.round(bytes/1024))+' KB';}
// Sessions sheet: search, agent/open filters, groups by age; service sessions (SDK, claude -p, codex exec) hidden by default.
const sessionView={list:[],query:'',filter:'all',service:false,inactive:false,outside:false,project:'',host:''};
// Panel-side name; the session file itself is not changed. An empty name restores the original.
async function renameSession(x){const value=prompt(tr('Название сессии (пусто — исходное)'),x.title||'');if(value===null)return;try{const r=await sessionsApi('/title',{agent:x.agent,id:x.id,title:value});x.title=r.title||x.originalTitle||x.lastPrompt.slice(0,150);x.renamed=Boolean(r.title);renderSessions();refreshSessionSummary();}catch(e){$('terminalStatus').textContent=e.message;}}
// Older nodes do not send active: derive it the same way as the server (open now or changed within 7 days).
const isActive=x=>x.active??(x.live||Date.now()-Date.parse(x.updated)<7*86400000);
function ago(iso){const d=(Date.parse(iso)-Date.now())/1000,f=new Intl.RelativeTimeFormat(locale(),{numeric:'auto'});for(const [n,u] of [[60,'second'],[3600,'minute'],[86400,'hour'],[604800,'day'],[2629800,'week'],[31557600,'month']])if(Math.abs(d)<n)return f.format(Math.round(d/(n/({second:60,minute:60,hour:24,day:7,week:4.35,month:12}[u]))),u);return new Date(iso).toLocaleDateString(locale());}
async function attachSession(x,mode,status){
 const project=sessionView.project;
 try{const r=await sessionsApi('/attach',{project:Number(project),id:x.id,agent:x.agent,mode});if($('terminalDialog').open)$('terminalDialog').close();await history();const t=tasks.find(t=>t.id===r.id);if(t)await choose(t);error();refreshSessionSummary();}
 catch(e){(status||error)(e);}
}
function openAttached(x){const t=tasks.find(t=>t.source_session===x.id&&String(t.project)===sessionView.project);if(t){$('terminalDialog').close();choose(t).catch(error);}}
function sessionRow(x,compact=false){
 const row=mapElement('article',null,'terminal-item');row.dataset.agent=x.agent;
 const icon=mapElement('span',null,'terminal-icon');icon.append(uiIcon(agentIcon(x.agent)));icon.title=agentName(x.agent);
 const main=mapElement('div',null,'terminal-main');const head=mapElement('div',null,'terminal-item-head');
 const name=mapElement('strong',x.title||x.lastPrompt.slice(0,90)||x.id.slice(0,8));name.translate=false;head.append(name);
 if(x.live)head.append(mapElement('span',tr('Открыта сейчас'),'terminal-badge live'));
 if(x.attached)head.append(mapElement('span',tr(x.attached==='fork'?'Подключена копией':'Перенесена'),'terminal-badge'));
 if(x.service)head.append(mapElement('span',tr('Служебная'),'terminal-badge'));
 if(x.outside)head.append(mapElement('span',tr('Вне проекта'),'terminal-badge'));
 if(!compact){const rename=mapElement('button',null,'quiet terminal-rename');rename.type='button';rename.append(uiIcon('tools'));rename.title=tr('Переименовать');rename.setAttribute('aria-label',tr('Переименовать')+' · '+(x.title||x.id.slice(0,8)));rename.onclick=()=>renameSession(x);head.append(rename);}
 if(compact)head.querySelectorAll('.terminal-badge:not(.live)').forEach(b=>b.remove());
 main.append(head);
 if(x.lastPrompt&&x.title&&!compact){const last=mapElement('p',x.lastPrompt,'terminal-last');last.translate=false;main.append(last);}
 const info=mapElement('small',[agentName(x.agent),x.folder,ago(x.updated),compact?null:sizeLabel(x.size)].filter(Boolean).join(' · '),'terminal-meta');info.translate=false;info.title=new Date(x.updated).toLocaleString(locale())+' · '+x.id;main.append(info);
 const actions=mapElement('div',null,'terminal-actions');
 const status=e=>{$('terminalStatus').textContent=e.message;actions.querySelectorAll('button').forEach(b=>b.disabled=false);if(move)move.disabled=x.live;};
 let move=null;
 if(x.attached){const open=mapElement('button',null,'primary');open.type='button';iconLabel(open,'message','Открыть в чате');open.onclick=()=>openAttached(x);actions.append(open);}
 if(!(compact&&x.attached)){const fork=mapElement('button',null,x.attached?'quiet':'primary');fork.type='button';iconLabel(fork,'copy',compact?'Продолжить':'Продолжить копию');fork.onclick=()=>{actions.querySelectorAll('button').forEach(b=>b.disabled=true);attachSession(x,'fork',compact?null:status);};actions.append(fork);}
 if(!compact){move=mapElement('button',null,'quiet');move.type='button';iconLabel(move,'arrow-down','Перенести в панель');move.disabled=x.live;if(x.live)move.title=tr('Сессия открыта в терминале или Remote Control. Перенос возможен после её закрытия.');move.onclick=()=>{actions.querySelectorAll('button').forEach(b=>b.disabled=true);attachSession(x,'move',status);};actions.append(move);}
 row.append(icon,main,actions);return row;
}
function renderSessions(){
 const list=$('terminalList');list.replaceChildren();
 const q=sessionView.query.trim().toLocaleLowerCase(),all=sessionView.list,service=all.filter(x=>x.service).length,inactive=all.filter(x=>!x.service&&!isActive(x)).length;
 const agentsHere=[...new Set(all.map(x=>x.agent))];
 const filters=$('sessionFilters');filters.replaceChildren();
 for(const [id,label] of [['all','Все'],['live','Открытые'],...agentsHere.length>1?agentsHere.map(a=>[a,agentName(a)]):[]]){const b=mapElement('button',null,'filter-chip');b.type='button';b.textContent=tr(label);b.setAttribute('aria-pressed',String(sessionView.filter===id));b.onclick=()=>{sessionView.filter=id;renderSessions();};filters.append(b);}
 // A search looks through inactive sessions too, so an old session can always be found.
 const shown=all.filter(x=>(sessionView.service||!x.service)&&(sessionView.inactive||q||isActive(x))&&(sessionView.filter==='all'||(sessionView.filter==='live'?x.live:x.agent===sessionView.filter))&&(!q||[x.title,x.lastPrompt,x.folder,x.id].join(' ').toLocaleLowerCase().includes(q)));
 const groups=[['Открыты сейчас',shown.filter(x=>x.live)],['Последние 7 дней',shown.filter(x=>!x.live&&isActive(x))],['Неактивные',shown.filter(x=>!isActive(x))]];
 for(const [title,items] of groups){if(!items.length)continue;const section=mapElement('section',null,'terminal-group');section.append(mapElement('h3',tr(title)+' · '+items.length));for(const x of items.slice(0,60))section.append(sessionRow(x));if(items.length>60)section.append(mapElement('p',tr('Показаны 60 из {n}. Уточните поиск.',{n:items.length}),'terminal-note'));list.append(section);}
 if(!shown.length)list.append(mapElement('p',all.length?(q?tr('Ничего не найдено'):tr('Активных сессий нет. Неактивные можно показать ниже.')):tr('В папке этого проекта нет сессий из терминала.'),'terminal-empty'));
 $('toggleInactiveSessions').hidden=!inactive||Boolean(q);$('toggleInactiveSessions').textContent=tr(sessionView.inactive?'Скрыть неактивные ({n})':'Показать неактивные ({n})',{n:inactive});
 $('toggleServiceSessions').hidden=!service;$('toggleServiceSessions').textContent=tr(sessionView.service?'Скрыть служебные ({n})':'Показать служебные ({n})',{n:service});
 $('terminalStatus').textContent=tr('Активных сессий: {n}',{n:all.length-service-inactive})+(inactive?' · '+tr('неактивных: {n}',{n:inactive}):'')+(service?' · '+tr('служебных: {n}',{n:service}):'');
}
async function openTerminalSessions(){
 sidebar(false);if(!$('terminalDialog').open){$('terminalDialog').showModal();$('terminalTitle').focus();}
 const project=$('projects').value,host=selectedHost;Object.assign(sessionView,{list:[],query:'',filter:'all',service:false,inactive:false,outside:false,project,host});$('toggleOutsideSessions').hidden=false;$('toggleOutsideSessions').textContent=tr('Показать сессии вне проектов');$('sessionSearch').value='';
 $('terminalTitleProject').textContent=$('projects').selectedOptions[0]?.textContent||'';$('terminalList').replaceChildren();$('sessionFilters').replaceChildren();$('toggleServiceSessions').hidden=true;
 $('terminalStatus').textContent=tr('Ищем сессии…');
 let list;try{list=(await sessionsApi('?project='+encodeURIComponent(project))).map(x=>({agent:'claude',service:false,...x}));}
 catch(e){if(host===selectedHost)$('terminalStatus').textContent=e.message==='Не найдено'?tr('Сервер работает на прежней версии панели. Обновите узел, чтобы подключать сессии.'):e.message;return;}
 if(host!==selectedHost||project!==$('projects').value)return;
 sessionView.list=list;renderSessions();
}
$('sessionSearch').oninput=()=>{sessionView.query=$('sessionSearch').value;renderSessions();};
$('toggleServiceSessions').onclick=()=>{sessionView.service=!sessionView.service;renderSessions();};
$('toggleInactiveSessions').onclick=()=>{sessionView.inactive=!sessionView.inactive;renderSessions();};
// Sessions started outside any registered project (for example in the home folder) can be attached to this project.
$('toggleOutsideSessions').onclick=async()=>{
 const b=$('toggleOutsideSessions');if(sessionView.outside){sessionView.outside=false;sessionView.list=sessionView.list.filter(x=>!x.outside);b.textContent=tr('Показать сессии вне проектов');renderSessions();return;}
 b.disabled=true;try{const extra=(await sessionsApi('?project='+encodeURIComponent(sessionView.project)+'&outside=1')).map(x=>({agent:'claude',service:false,...x,outside:true}));
  sessionView.outside=true;sessionView.list=[...sessionView.list,...extra];b.textContent=tr('Скрыть сессии вне проектов ({n})',{n:extra.filter(x=>!x.service).length});renderSessions();}
 catch(e){$('terminalStatus').textContent=e.message;}finally{b.disabled=false;}
};
// Session counts per server, shared by the project tree, the chat toolbar and the empty chat.
const sessionSummary=new Map();
async function refreshSessionSummary(host=selectedHost){
 try{const r=await fetch(apiPath('agent-sessions/summary',host),{signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error();sessionSummary.set(host,(await readJson(r)).projects||{});}
 catch{if(!sessionSummary.has(host))sessionSummary.set(host,{});}
 updateSessionsButton();
}
function projectSessions(host,project){return sessionSummary.get(host)?.[project]||{total:0,live:0};}
function updateSessionsButton(){
 const s=projectSessions(selectedHost,$('projects').value),b=$('sessionsButton');
 b.hidden=!s.total;$('sessionsCount').textContent=s.total;b.dataset.live=String(s.live>0);
 b.title=tr('Сессии из терминала: {n}',{n:s.total})+(s.live?' · '+tr('открыто: {n}',{n:s.live}):'');
}
// The empty project chat offers to continue the latest terminal sessions.
async function sessionSuggestions(box,generation){
 const project=$('projects').value,host=selectedHost;if(!project||!projectSessions(host,project).total)return;
 let list;try{list=await sessionsApi('?project='+encodeURIComponent(project));}catch{return;}
 if(generation!==viewGeneration||host!==selectedHost||project!==$('projects').value||!box.isConnected)return;
 const work=list.filter(x=>!x.service&&isActive(x));if(!work.length)return;
 Object.assign(sessionView,{project,host});
 const panel=mapElement('section',null,'session-suggestions');const head=mapElement('div',null,'session-suggestions-head');head.append(mapElement('h3',tr('Продолжить из терминала')));
 const all=mapElement('button',null,'quiet');all.type='button';iconLabel(all,'terminal',tr('Все сессии ({n})',{n:work.length}));all.onclick=openTerminalSessions;head.append(all);panel.append(head);
 for(const x of work.slice(0,3))panel.append(sessionRow({agent:'claude',...x},true));
 box.querySelector('.starter-list')?.before(panel);
}
$('terminalSessionsButton').onclick=$('sessionsButton').onclick=openTerminalSessions;
$('activityDetails').onclick=()=>$('activityDialog').showModal();
$('dismissError').onclick=()=>error();
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
document.addEventListener('keydown',e=>{if(e.key==='Tab'&&$('sidebar').classList.contains('is-open')){const nodes=[...$('sidebar').querySelectorAll('button,input,select,summary')].filter(n=>n.getClientRects().length&&!n.disabled);const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}} if(e.key==='Escape'&&$('sidebar').classList.contains('is-open')){sidebar(false);$('toggleSidebar').focus();}});
matchMedia('(max-width:899px)').addEventListener('change',()=>sidebar(false));
function resizePrompt() { const el=$('prompt');el.style.height='auto';el.style.height=Math.min(el.scrollHeight,parseFloat(getComputedStyle(el).maxHeight))+'px'; }
function renderAttachments() {
 $('attachments').replaceChildren();
 for(const f of attachments){const chip=document.createElement('div');chip.className='attachment';const label=document.createElement('span');label.textContent=f.name;label.title=tr('{name} · {size} КБ',{name:f.name,size:Math.ceil(f.size/1024)});label.translate=false;const remove=document.createElement('button');remove.type='button';remove.className='quiet';remove.append(uiIcon('close'));remove.setAttribute('aria-label',tr('Убрать {name}',{name:f.name}));remove.disabled=submitting||uploading;remove.onclick=()=>{attachments=attachments.filter(x=>x.id!==f.id);renderAttachments();saveDraft();updateActivity();};chip.append(label,remove);$('attachments').append(chip);}
}
async function attachFiles(files) {
 if(submitting||uploading||!files.length)return;
 if(files.length+attachments.length>5){error(Error('Можно приложить до 5 файлов к сообщению'));return;}
 if(files.some(f=>f.size>10*1024*1024)){error(Error('Каждый файл должен быть не больше 10 МБ'));return;}
 uploading=true;updateActivity();renderAttachments();$('uploadStatus').hidden=false;const key=draftKey(),project=draftProject,session=csrf;
 try{for(let i=0;i<files.length;i++){const f=files[i];$('uploadStatus').textContent=tr('Загружаем {i} из {n}: {name}',{i:i+1,n:files.length,name:f.name});
 const response=await fetch(apiPath('uploads?project='+encodeURIComponent(project)+'&name='+encodeURIComponent(f.name)),{method:'POST',headers:{'Content-Type':'application/octet-stream','X-CSRF-Token':session},body:f,signal:AbortSignal.timeout(120000)});
 const result=await readJson(response);if(!response.ok)throw Error(result.error||'Не удалось загрузить файл');
 if(session!==csrf||key!==draftKey())return;attachments.push(result);saveDraft();renderAttachments();}error();
 }catch(e){error(Error(e.name==='TimeoutError'?'Загрузка заняла слишком много времени. Попробуйте ещё раз.':e.message));}
 finally{uploading=false;$('uploadStatus').hidden=true;$('fileInput').value='';renderAttachments();updateActivity();}
}
$('attach').onclick=()=>$('fileInput').click();
$('fileInput').onchange=()=>attachFiles([...$('fileInput').files]);
$('prompt').addEventListener('paste',e=>{const files=[...e.clipboardData.files];if(files.length){e.preventDefault();attachFiles(files);}});
$('chatForm').addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();});
$('chatForm').addEventListener('drop',e=>{if(e.dataTransfer.files.length){e.preventDefault();attachFiles([...e.dataTransfer.files]);}});
window.addEventListener('resize',resizePrompt);
// After an update of the interface the open tab reloads itself (the draft and its files stay in sessionStorage), so a
// tablet left open for days never sends messages through old code. Not while the owner is typing, sending or in a dialog.
let build='';
async function checkBuild(){
 if(!build||submitting||uploading||document.querySelector('dialog[open]')||(!document.hidden&&document.activeElement===$('prompt')&&$('prompt').value))return;
 try{const r=await fetch('/api/meta',{cache:'no-store'});if(!r.ok)return;const b=await readJson(r);if(b.build&&b.build!==build){saveDraft();location.reload();}}catch{}
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)checkBuild();});
setInterval(checkBuild,300000);
// Installation name and mark come from data/config.json on the server.
async function loadMeta(){
  try{const r=await fetch('/api/meta');if(!r.ok)return;const b=await readJson(r);brand={...brand,...b.brand};build=b.build||'';
   try{if(!localStorage.getItem('panel-language')&&b.language&&b.language!==lang&&(b.language==='ru'||I18N[b.language])){localStorage.setItem('panel-language',b.language);location.reload();return;}}catch{}
  }catch{return;}
  $('brandName').textContent=tr(brand.name);$('brandSubtitle').textContent=tr(brand.subtitle||'');$('brandSubtitle').hidden=!brand.subtitle;document.title=tr(brand.name);
  if(brand.mark){$('brandMark').textContent=brand.mark;$('brandMark').classList.add('has-letter');}
}
$('languageLabel').textContent=lang==='ru'?'English':'Русский';$('languageLabel').translate=false;
$('languageButton').onclick=()=>{try{localStorage.setItem('panel-language',lang==='ru'?'en':'ru');}catch{}location.reload();};
startTranslation();
// Claude plan limits of the selected server's account, in the header: weekly window first, 5-hour window next to it.
let usageRequest=0;
function resetLabel(iso){if(!iso)return '';const d=new Date(iso),days=(d-Date.now())/86400000;return days<1?d.toLocaleTimeString(locale(),{hour:'2-digit',minute:'2-digit'}):d.toLocaleString(locale(),{weekday:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});}
async function refreshUsage(){
 const b=$('claudeUsage'),request=++usageRequest,host=selectedHost;
 if(!csrf||!currentHost()?.agents?.includes('claude')){b.hidden=true;return;}
 let u;try{u=await api('claude-usage');}catch{return;}
 if(request!==usageRequest||host!==selectedHost)return;
 if(!u?.available||!u.seven_day){b.hidden=true;return;}
 const w=u.seven_day,f=u.five_hour,level=w.percent>=90?'high':w.percent>=70?'warn':'ok';
 b.replaceChildren();b.dataset.level=level;b.style.setProperty('--used',Math.min(100,w.percent)+'%');
 const label=mapElement('span',tr('Claude · неделя'),'usage-label'),value=mapElement('strong',Math.round(w.percent)+'%'),bar=mapElement('span',null,'usage-bar'),reset=mapElement('small',tr('сброс {when}',{when:resetLabel(w.resetsAt)}),'usage-reset');
 b.append(label,bar,value,reset);if(f)b.append(mapElement('small',tr('5 ч: {n}%',{n:Math.round(f.percent)}),'usage-five'));
 b.title=tr('Лимит подписки Claude на сервере {host}: неделя {w}% (сброс {wr}){five}. Обновляется раз в 5 минут.',{host:currentHost().name,w:Math.round(w.percent),wr:resetLabel(w.resetsAt),five:f?tr(', 5 часов {n}% (сброс {r})',{n:Math.round(f.percent),r:resetLabel(f.resetsAt)}):''});
 b.setAttribute('aria-label',b.title);b.hidden=false;
}
$('claudeUsage').onclick=refreshUsage;
setInterval(()=>{if(!document.hidden)refreshUsage();},300000);
sidebar(false);
emptyChat();
loadMeta();
(async () => { try { csrf = (await api('session')).csrf; show(true); await loadHosts(); await refresh(); refreshUsage(); } catch(e) { if (csrf) error(e); else { show(false); indicator('connection','Требуется вход','unknown'); } } })();
// A hidden tab does not poll; returning to it refreshes at once.
// Browser notifications: a finished task or a pending approval while the panel is not in front.
// Phones and tablets show them only through a service worker; iPad needs the panel added to the home screen.
const notify={enabled:false,statuses:new Map(),approvals:new Set(),hiddenPoll:0};
try{notify.enabled=localStorage.getItem('panel-notify')==='1'&&'Notification' in window&&Notification.permission==='granted';}catch{}
const swReady='serviceWorker' in navigator?navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).catch(()=>null):Promise.resolve(null);
navigator.serviceWorker?.addEventListener('message',e=>{if(e.data?.type==='open'&&e.data.data?.task){const t=tasks.find(t=>t.id===e.data.data.task);if(t&&!submitting&&!uploading)choose(t).catch(error);}});
function notifyLabel(){const b=$('notifyButton');if(!b)return;const denied='Notification' in window&&Notification.permission==='denied';iconLabel(b,'clock',denied?'Уведомления запрещены в браузере':notify.enabled?'Уведомления: включены':'Уведомления: выключены');b.setAttribute('aria-pressed',String(notify.enabled));}
async function toggleNotifications(){
 if(!('Notification' in window)){error(Error(tr('Этот браузер не поддерживает уведомления. На iPad добавьте панель на экран «Домой» и откройте её оттуда.')));return;}
 if(notify.enabled){notify.enabled=false;}else{const p=Notification.permission==='granted'?'granted':await Notification.requestPermission();notify.enabled=p==='granted';if(notify.enabled)showNotification(tr('Уведомления включены'),tr('Панель сообщит о завершении задач и запросах подтверждения.'),{});}
 try{localStorage.setItem('panel-notify',notify.enabled?'1':'0');}catch{}notifyLabel();
}
async function showNotification(title,body,data){
 if(!notify.enabled)return;const options={body,data,tag:data.tag||undefined,icon:'/icon.svg',badge:'/icon.svg'};
 try{const reg=await swReady;if(reg){await reg.showNotification(title,options);return;}new Notification(title,options);}catch{}
}
const inFront=()=>!document.hidden&&document.hasFocus();
function notifyTasks(){
 const names=new Map([...$('projects').options].map(o=>[o.value,o.textContent]));
 for(const t of tasks){const was=notify.statuses.get(t.id);notify.statuses.set(t.id,t.status);
  if(!was||!activeStatuses.includes(was)||activeStatuses.includes(t.status)||inFront())continue;
  const title={completed:'Задача завершена',failed:'Задача завершилась ошибкой',interrupted:'Задача остановлена'}[t.status]||'Задача завершена';
  showNotification(tr(title)+' · '+(names.get(String(t.project))||''),agentName(t.agent)+': '+t.prompt.split('\n')[0].slice(0,120),{task:t.id,tag:'task-'+t.id});}
}
function notifyApprovals(task,list){
 for(const a of list){if(notify.approvals.has(a.key))continue;notify.approvals.add(a.key);if(inFront())continue;
  showNotification(tr('Нужно подтверждение')+' · '+($('projects').selectedOptions[0]?.textContent||''),String(a.params?.reason||a.params?.tool||a.method||'').slice(0,140),{task,tag:'approval-'+a.key});}
}
// A hidden tab polls only when notifications are on, and then every 15 seconds.
async function poll(){ if (!csrf || polling) return; if(document.hidden){if(!notify.enabled||Date.now()-notify.hiddenPoll<15000)return;notify.hiddenPoll=Date.now();} polling = true; try { await events(); await history(); } catch(e) { if(!e.transient)error(e); } finally { polling = false; } }
$('notifyButton').onclick=toggleNotifications;notifyLabel();
document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll();});
setInterval(poll,1000);

// Active sessions on every server: running panel tasks and terminal sessions open now or changed this week.
async function openActiveSessions(){
 sidebar(false);if(!$('activeDialog').open){$('activeDialog').showModal();$('activeTitle').focus();}
 const box=$('activeList');box.replaceChildren();$('activeStatus').textContent=tr('Опрашиваем серверы…');
 let hosts;try{hosts=await api('hosts');}catch(e){$('activeStatus').textContent=e.message;return;}
 let total=0,live=0;const failed=[];
 const results=await Promise.all(hosts.map(async h=>{try{const r=await fetch(apiPath('agent-sessions/active',h.id),{signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error();return [h,await readJson(r)];}catch{failed.push(h.name);return [h,null];}}));
 for(const [h,items] of results){
  const section=mapElement('section',null,'terminal-group');const head=mapElement('h3');iconLabel(head,'server',h.name+(h.address?' · '+h.address:''));section.append(head);
  if(!items){section.append(mapElement('p',tr('Нет связи или сервер на прежней версии.'),'terminal-note'));box.append(section);continue;}
  if(!items.length){section.append(mapElement('p',tr('Активных сессий нет.'),'terminal-note'));box.append(section);continue;}
  total+=items.length;live+=items.filter(x=>x.live).length;
  for(const x of items){
   const row=mapElement('article',null,'terminal-item active-item');row.dataset.agent=x.agent;
   const ic=mapElement('span',null,'terminal-icon');ic.append(uiIcon(x.kind==='task'?'message':agentIcon(x.agent)));
   const main=mapElement('div',null,'terminal-main');const top=mapElement('div',null,'terminal-item-head');const name=mapElement('strong',x.title||x.id.slice(0,8));name.translate=false;top.append(name);
   if(x.kind==='task')top.append(mapElement('span',tr('Задача панели'),'terminal-badge live'));else if(x.live)top.append(mapElement('span',tr('Открыта сейчас'),'terminal-badge live'));
   const meta=mapElement('small',[x.projectName,agentName(x.agent),x.folder,ago(x.updated)].filter(Boolean).join(' · '),'terminal-meta');meta.translate=false;main.append(top,meta);
   const go=mapElement('button',null,'quiet');go.type='button';iconLabel(go,x.kind==='task'?'message':'terminal',x.kind==='task'?'Открыть чат':'К сессиям проекта');
   go.onclick=async()=>{$('activeDialog').close();await window.openPanelProject?.(h.id,x.project);if(selectedHost!==h.id||$('projects').value!==String(x.project))return;if(x.kind==='session')openTerminalSessions();};
   const actions=mapElement('div',null,'terminal-actions');actions.append(go);row.append(ic,main,actions);section.append(row);
  }
  box.append(section);
 }
 $('activeStatus').textContent=tr('Активных: {n}',{n:total})+(live?' · '+tr('открыто сейчас: {n}',{n:live}):'')+(failed.length?' · '+tr('нет ответа: {names}',{names:failed.join(', ')}):'');
}
$('activeSessionsButton').onclick=openActiveSessions;

// Global project navigation. Node requests are independent of the currently open chat.
(()=>{
 if(!$('projectTree'))return;
 let nodes=[],loading=false,navigating=false,signature='',expanded=new Map(),hiddenProjects=new Set(),pendingVisibility={};
 try{hiddenProjects=new Set(JSON.parse(localStorage.getItem('panel-hidden-projects')||'[]'));pendingVisibility=JSON.parse(localStorage.getItem('panel-pending-visibility')||'{}');}catch{}
 let visibilityRequest=null;
 async function syncVisibility(){if(visibilityRequest)return visibilityRequest;const work=async()=>{try{const value=await api('communication/visibility');if(!Array.isArray(value))return;hiddenProjects=new Set(value);for(const [key,hidden] of Object.entries(pendingVisibility)){if(hidden)hiddenProjects.add(key);else hiddenProjects.delete(key);await api('communication/visibility',{key,hidden});if(pendingVisibility[key]===hidden)delete pendingVisibility[key];}saveVisibility();}catch{}};visibilityRequest=work();try{await visibilityRequest;}finally{visibilityRequest=null;}}
 function saveVisibility(){try{localStorage.setItem('panel-hidden-projects',JSON.stringify([...hiddenProjects]));localStorage.setItem('panel-pending-visibility',JSON.stringify(pendingVisibility));}catch{}}
 async function hideProject(key,hidden){if(hidden)hiddenProjects.add(key);else hiddenProjects.delete(key);pendingVisibility[key]=hidden;saveVisibility();signature='';render();await syncVisibility();if(Object.keys(pendingVisibility).length)await syncVisibility();signature='';render();}
 try{expanded=new Map(JSON.parse(sessionStorage.getItem('panel-tree-expanded')||'[]'));}catch{}
 const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
 async function get(host,route){const r=await fetch(apiPath(route,host),{signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error('Нет связи');return readJson(r);}
 async function reload(){
  if(!csrf||loading)return;loading=true;for(const id of ['refreshTree','refreshProjectOverview'])$(id).disabled=true;const auth=csrf;
  try{
   await syncVisibility();const hosts=await get('local','hosts');
   await Promise.all(hosts.map(async host=>{
    refreshSessionSummary(host.id);
    try{const [projects,sessions,key]=await Promise.all([get(host.id,'projects'),get(host.id,'session-directory'),get(host.id,'agent-sessions/key').catch(()=>null)]);
     if(csrf!==auth)return;const value={host,projects,sessions,key};const i=nodes.findIndex(n=>n.host.id===host.id);if(i<0)nodes.push(value);else nodes[i]=value;
    }catch{if(csrf!==auth)return;const i=nodes.findIndex(n=>n.host.id===host.id);if(i<0)nodes.push({host,projects:[],sessions:[],offline:true});else nodes[i].offline=true;}
    nodes.sort((a,b)=>hosts.findIndex(h=>h.id===a.host.id)-hosts.findIndex(h=>h.id===b.host.id));render();
   }));
   if(csrf!==auth)return;nodes=nodes.filter(n=>hosts.some(h=>h.id===n.host.id));
   $('treeStatus').textContent=tr(nodes.some(n=>n.offline)?'Часть VPS недоступна. Показаны последние данные.':'{hosts} VPS · {projects} проектов · один чат на проект',{hosts:nodes.length,projects:nodes.reduce((sum,n)=>sum+n.projects.length,0)});render();
  }catch{$('treeStatus').textContent='Не удалось обновить дерево';}finally{loading=false;for(const id of ['refreshTree','refreshProjectOverview'])$(id).disabled=false;}
 }
 function branch(label,key,cls,forceOpen=false,openByDefault=true){const d=el('details',undefined,cls);d.open=forceOpen||(expanded.get(key)??openByDefault);const summary=el('summary',label);if(cls==='tree-host'){summary.textContent='';summary.append(el('span',label,'tree-host-name'),el('small','','tree-host-count'),uiIcon('chevron','tree-chevron'));}d.append(summary);d.ontoggle=()=>{expanded.set(key,d.open);try{sessionStorage.setItem('panel-tree-expanded',JSON.stringify([...expanded]));}catch{}};return d;}
 window.openPanelProject=(host,project)=>openProject(host,project);
 const showInactive=new Set();
 function chatRow(n,c,search){
  const chain=String(c.id).slice(n.host.id.length+1),row=el('div',undefined,'tree-session tree-key tree-chat');
  const open=el('button',undefined,'tree-open');open.dataset.treeKey=(search?'search-chat:':'chat:')+n.host.id+':'+chain;
  const working=c.open||n.host.id===selectedHost&&tasks.some(t=>chainOf(t)===chain&&activeStatuses.includes(t.status));
  const state=working?'working':Date.now()-Date.parse(c.updated||0)<7*86400000?'chat':'closed';
  const dot=el('span',undefined,'tree-state');dot.dataset.state=state;dot.setAttribute('aria-label',tr({working:'Модель сейчас работает',chat:'работает в чате панели',closed:'закрыта'}[state]));
  const [main,...rest]=String(c.name||c.projectName||'').split(' · ');
  const label=el('span',undefined,'tree-project-label'),text=el('span',undefined,'tree-key-text'),name=el('span',main,'tree-project-name');name.translate=false;
  const sub=el('small',[rest.join(' · '),c.topic,ago(c.updated)].filter(Boolean).join(' · '),'tree-key-sub');sub.translate=false;text.append(name,el('span',rest.length?' · '+rest.join(' · '):'','tree-key-sep'),sub);
  label.append(dot,text);
  if(working){const w=el('small',undefined,'tree-working');w.append(el('span',undefined,'working-bars'));w.title=tr('Модель сейчас работает');label.append(w);}
  open.append(label);open.title=[c.name,c.projectName,c.cwd,c.topic,ago(c.updated)].filter(Boolean).join(' · ');
  const current=tasks.find(t=>t.id===selected);open.setAttribute('aria-current',String(n.host.id===selectedHost&&Boolean(current)&&chainOf(current)===chain));
  open.disabled=Boolean(n.offline);open.onclick=()=>openChat(n.host.id,c.project,chain,open);
  row.append(open);return row;
 }
 async function openChat(host,project,chain,button){
  if(submitting||uploading||navigating)return;button.disabled=true;
  try{await openProject(host,project);await history();const last=tasks.find(t=>chainOf(t)===chain);if(last&&last.id!==selected)await choose(last);signature='';reload();}
  catch(e){error(e);}finally{button.disabled=false;}
 }
 function keyRow(n,x,search){
  const row=el('div',undefined,'tree-session tree-key');row.dataset.agent=x.agent;
  const open=el('button',undefined,'tree-open');open.dataset.treeKey=(search?'search-key:':'key:')+n.host.id+':'+x.id;
  // Left: the state as a coloured dot. Middle: the name, its qualifier (after " · ") on a second line. Right: work, a
  // question, or how long ago a closed session was used. The agent mark only when the server runs several AIs.
  const working=x.working||x.chatOpen||n.host.id===selectedHost&&x.chain&&tasks.some(t=>chainOf(t)===x.chain&&activeStatuses.includes(t.status));
  // A closed terminal session that is continued in the panel chat is in use, not closed: its chat's latest turn counts.
  const recentChat=x.chatUpdated&&Date.now()-Date.parse(x.chatUpdated)<7*86400000;
  const state=working?'working':x.waiting?'waiting':x.live?'live':recentChat?'chat':'closed';
  const dot=el('span',undefined,'tree-state'+(state==='live'?' tree-live':''));dot.dataset.state=state;
  dot.setAttribute('aria-label',tr({working:'Модель сейчас работает',waiting:'Ждёт вашего ответа',live:'открыта',chat:'работает в чате панели',closed:'закрыта'}[state]));
  if(state==='live')dot.title=tr('Открыта сейчас')+(x.rcName?' · Remote Control «'+x.rcName+'»':'');
  // The project is worth a line only when the server's sessions come from different projects.
  const mixed=new Set((Array.isArray(n.key)?n.key:[]).map(k=>k.projectName)).size>1;
  const [main,...rest]=String(x.title||'').split(' · '),qualifier=rest.join(' · ')||(mixed&&x.projectName&&x.projectName!==x.title&&x.projectName!==main?x.projectName:'');
  const label=el('span',undefined,'tree-project-label'),text=el('span',undefined,'tree-key-text'),name=el('span',main,'tree-project-name');name.translate=false;text.append(name);
  // A closed session tells when it was last used on its second line, so the name keeps the full width.
  const when=state==='closed'?ago(x.updated):state==='chat'?tr('чат панели · {when}',{when:ago(x.chatUpdated)}):'';
  if(qualifier||when){const sep=el('span',' · ','tree-key-sep'),sub=el('small',qualifier,'tree-key-sub');sub.translate=false;if(when){if(qualifier)sub.append(' · ');sub.append(el('span',when,'tree-ago'));}text.append(sep,sub);}
  label.append(dot);
  if((n.host.agents||[]).length>1){const mark=el('span',undefined,'tree-key-icon');mark.append(uiIcon(agentIcon(x.agent)));label.append(mark);}
  label.append(text);
  if(working){const w=el('small',undefined,'tree-working');w.append(el('span',undefined,'working-bars'));w.title=tr('Модель сейчас работает');w.setAttribute('aria-label',w.title);label.append(w);}
  else if(x.waiting){const q=el('small','?','tree-waiting');q.title=tr('Ждёт вашего ответа');q.setAttribute('aria-label',q.title);label.append(q);}
  open.append(label);open.title=[x.title,x.rcName&&x.rcName!==x.title?'Remote Control: '+x.rcName:'',x.projectName,x.cwd,ago(x.updated)].filter(Boolean).join(' · ');
  const current=tasks.find(t=>t.id===selected);open.setAttribute('aria-current',String(n.host.id===selectedHost&&Boolean(x.chain)&&Boolean(current)&&chainOf(current)===x.chain));
  open.disabled=Boolean(n.offline);open.onclick=()=>openKeySession(n.host.id,x,open);
  row.append(open);return row;
 }
 // Opens a session as a chat: the server attaches it (copy if open, move if closed) to its project and the panel opens that chat.
 async function openKeySession(host,x,button){
  if(submitting||uploading||navigating)return;button.disabled=true;
  try{let project=x.project;
   if(!x.attached){const r=await fetch(apiPath('agent-sessions/open',host),{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({agent:x.agent,id:x.id})});const b=await readJson(r);if(!r.ok)throw Error(b.error||'Не удалось открыть сессию');project=b.project;x.attached=true;x.project=project;}
   await openProject(host,project);
   // openProject shows the project's latest chat; switch to this session's own chain.
   await history();const root=tasks.filter(t=>t.source_session===x.id).at(-1)||tasks.find(t=>t.thread===x.id);const chain=root&&chainOf(root);const last=chain&&tasks.find(t=>chainOf(t)===chain);if(last&&last.id!==selected)await choose(last);
   signature='';reload();
  }catch(e){error(e);}finally{button.disabled=false;}
 }
 async function openProject(host,project,session){
  if(submitting||uploading||navigating)return;navigating=true;
  try{
   if(!hostList.some(h=>h.id===host))await loadHosts();
   if(selectedHost!==host){$('hosts').value=host;await $('hosts').onchange();if(selectedHost!==host||!settings)throw Error('Не удалось открыть сервер');}
   if(![...$('projects').options].some(o=>o.value===String(project))){await refresh();}
   if($('projects').value!==String(project)){$('projects').value=String(project);await $('projects').onchange();}
   await history();const latest=tasks.find(t=>String(t.project)===String(project));
   if(latest)await choose(latest);else await $('new').onclick();
   sidebar(false);if($('projectSearchDialog').open)$('projectSearchDialog').close();render();
  }catch(e){error(e);}finally{navigating=false;}
 }
 async function writeTo(session){
  sidebar(false);if($('projectSearchDialog').open)$('projectSearchDialog').close();$('communicationDialog').showModal();await refreshCommunication();
  if([...$('messageRecipient').options].some(o=>o.value===session.id)){$('messageRecipient').value=session.id;$('agentMessage').focus();}
  else $('communicationStatus').textContent='Сессия сейчас недоступна. Обновите журнал после восстановления связи.';
 }
 function projectAI(node,project){
  const live=node.host.id===selectedHost?tasks.filter(t=>String(t.project)===String(project.id)):[];
  const seen=new Set(live.map(t=>t.id));
  const known=[...live,...project.sessions.filter(s=>s.lastTask&&!seen.has(s.lastTask))];
  const working=known.filter(s=>['starting','running','stopping'].includes(s.status));
  const source=working.length?working:known.length?[known[0]]:project.sessions;
  const agents=[...new Set(source.map(s=>s.agent||'codex'))];
  return {agents,label:agents.length?agents.map(agentName).join(' + '):'ИИ не выбран',state:working.length?'working':agents.length?'idle':'unassigned',description:working.length?'Работает сейчас':known.length?'ИИ последней задачи':agents.length?'ИИ подключённых сессий':'ИИ не выбран'};
 }
 function renderTree(root,query,search=false){
  const scroll=root.scrollTop,focus=root.contains(document.activeElement)?document.activeElement?.dataset.treeKey:null;root.replaceChildren();
  for(const n of nodes){
   const groups=n.projects.map(p=>({...p,sessions:[]}));
   for(const s of n.sessions){let group=groups.find(p=>s.project!=null?String(p.id)===String(s.project):p.cwd===s.cwd);if(!group){group={id:null,name:s.projectName||s.cwd,cwd:s.cwd,sessions:[]};groups.push(group);}group.sessions.push(s);}
   const hostMatch=(n.host.name+' '+n.host.address).toLocaleLowerCase().includes(query);
   const visible=groups.filter(p=>search&&$('showHiddenProjects').checked||!hiddenProjects.has(n.host.id+':'+p.cwd)).map(p=>{const all=hostMatch||(p.name+' '+p.cwd+' '+projectAI(n,p).label).toLocaleLowerCase().includes(query);return {...p,sessions:p.sessions,show:all||p.sessions.some(s=>(s.title+' '+s.agent+' '+s.id).toLocaleLowerCase().includes(query))};}).filter(p=>p.show)
    // Only registered projects. Folders known only from terminal sessions (worktrees, /tmp) are those same sessions.
    .filter(p=>p.id!=null)
    // A project opened from a session row is reached through that row; in the sidebar it is not repeated.
    .filter(p=>search||!(Array.isArray(n.key)&&n.key.some(k=>k.attached&&String(k.project)===String(p.id))));
   if(query&&!visible.length&&!hostMatch&&!(Array.isArray(n.key)?n.key:[]).some(x=>[x.title,x.rcName,x.projectName,x.cwd].join(' ').toLocaleLowerCase().includes(query)))continue;
   const hd=branch(n.host.name,(search?'search:':'')+'host:'+n.host.id,'tree-host',search);root.append(hd);hd.querySelector('summary').title=n.host.name+(n.host.address?' · '+n.host.address:'');
   if(n.offline)hd.append(el('p','Нет связи с VPS','tree-status'));
   // Sessions first: everything that worked through Remote Control or is open now, in any folder of the server.
   if(Array.isArray(n.key)){
    const match=x=>!query||hostMatch||[x.title,x.rcName,x.projectName,x.cwd].join(' ').toLocaleLowerCase().includes(query);
    const sessions=Array.isArray(n.sessions)?n.sessions:[];
    for(const x of n.key){const chat=x.chain&&sessions.find(c=>c.kind==='panel'&&c.id===n.host.id+':'+x.chain);x.chatUpdated=chat?.updated||null;x.chatOpen=Boolean(chat?.open);if(chat&&Date.now()-Date.parse(chat.updated)<7*86400000)x.active=true;}
    const all=n.key.filter(match),showOld=search&&query||showInactive.has(n.host.id),shown=all.filter(x=>showOld||x.active);let hiddenCount=all.length-shown.length;
    for(const x of shown)hd.append(keyRow(n,x,search));
    // Chats started in the panel (not attached to a terminal session) are sessions too: one row each.
    const attachedIds=new Set(n.key.map(k=>k.chain).filter(Boolean)),recentLimit=Date.now()-7*86400000;
    const chats=sessions.filter(c=>c.kind==='panel'&&!attachedIds.has(String(c.id).slice(n.host.id.length+1))&&(!query||hostMatch||[c.name,c.topic,c.projectName].join(' ').toLocaleLowerCase().includes(query)));
    // A row for a chat that is a session of its own: working now, named by the owner, or the project's latest chat.
    // One-off older chats of a project stay under "inactive".
    // The latest chat of a project counts the chats of its terminal sessions too: an older one-off chat stays inactive.
    const latest=new Map();for(const c of sessions.filter(c=>c.kind==='panel')){const k=String(c.project);if(!latest.has(k)||String(c.updated)>String(latest.get(k).updated))latest.set(k,c);}
    const recentChats=chats.filter(c=>c.open||(c.named||latest.get(String(c.project))===c)&&Date.parse(c.updated||0)>recentLimit),oldChats=chats.filter(c=>!recentChats.includes(c));
    for(const c of [...recentChats,...(showOld?oldChats:[])].sort((a,b)=>String(b.updated).localeCompare(String(a.updated))))hd.append(chatRow(n,c,search));
    n.oldChats=oldChats.length;n.chatProjects=new Set(recentChats.map(c=>String(c.project)));
    const openCount=n.key.filter(x=>x.live).length;hd.querySelector('.tree-host-count').textContent=openCount?tr('открыто: {n}',{n:openCount}):'';
    hiddenCount+=showOld?0:n.oldChats;
    if(!all.length&&!n.key.length&&!sessions.some(c=>c.kind==='panel')&&!query)hd.append(el('small',tr('Сессий пока нет'),'tree-empty'));
    if(hiddenCount||showInactive.has(n.host.id)&&(all.some(x=>!x.active)||n.oldChats)){const more=el('button',undefined,'tree-more');more.textContent=tr(showOld?'Скрыть неактивные':'Ещё неактивные: {n}',{n:hiddenCount});more.prepend(uiIcon('chevron'));more.dataset.open=String(showOld);more.onclick=()=>{if(showInactive.has(n.host.id))showInactive.delete(n.host.id);else showInactive.add(n.host.id);signature='';render();};hd.append(more);}
   }
   // A project's own chat (not a terminal session's) reads like a session: working, used lately, or idle.
   const attachedChains=new Set((Array.isArray(n.key)?n.key:[]).map(k=>k.chain).filter(Boolean));
   const chatOf=p=>{const own=(Array.isArray(n.sessions)?n.sessions:[]).filter(c=>c.kind==='panel'&&String(c.project)===String(p.id)&&!attachedChains.has(String(c.id).slice(n.host.id.length+1)));
    const running=own.some(c=>c.open)||n.host.id===selectedHost&&tasks.some(t=>String(t.project)===String(p.id)&&activeStatuses.includes(t.status)&&!attachedChains.has(chainOf(t)));
    const updated=own.map(c=>c.updated).filter(Boolean).sort().at(-1)||null;return {running,updated,recent:Boolean(updated)&&Date.now()-Date.parse(updated)<7*86400000};};
   // Projects are folders to start in; their chats are listed above as sessions.
   const lively=[],idle=visible.filter(p=>search||!n.chatProjects?.has(String(p.id)));
   const projBox=Array.isArray(n.key)&&idle.length?branch(tr('Проекты')+' · '+idle.length,(search?'search:':'')+'projects:'+n.host.id,'tree-projects',Boolean(search&&query),false):hd;
   for(const p of [...lively,...idle]){const box=lively.includes(p)?hd:projBox;
    const key=n.host.id+':'+p.cwd,row=el('div',undefined,'tree-session tree-project');
    const target=p.mail_id?{id:n.host.id+':project-'+p.mail_id}:p.sessions.find(s=>s.lastTask)||p.sessions[0];
    const open=el('button',undefined,'tree-open');open.dataset.treeKey=(search?'search-project:':'project:')+key;
    const ai=projectAI(n,p),label=el('span',undefined,'tree-project-label'),name=el('span',p.name,'tree-project-name'),path=el('small',p.cwd,'tree-path'),badge=el('small',ai.label,'tree-agent');
    badge.dataset.state=ai.state;badge.title=tr(ai.description);badge.setAttribute('aria-label',tr(ai.label)+' · '+tr(ai.description));
    if(ai.state!=='unassigned')badge.prepend(uiIcon(agentIcon(ai.agents[0])));name.translate=false;path.translate=false;
    const chat=chatOf(p),pstate=chat.running?'working':chat.recent?'chat':'closed',dot=el('span',undefined,'tree-state');dot.dataset.state=pstate;
    const [pmain,...prest]=String(p.name).split(' · '),pqual=prest.join(' · ');name.textContent=pmain;
    const text=el('span',undefined,'tree-key-text'),sub=el('small',[pqual,chat.updated?tr('чат проекта · {when}',{when:ago(chat.updated)}):tr('чат проекта')].filter(Boolean).join(' · '),'tree-key-sub');text.append(name,el('span',pqual?' · '+pqual:'','tree-key-sep'),sub);label.append(dot,text);
    if(chat.running){const w=el('small',undefined,'tree-working');w.append(el('span',undefined,'working-bars'));w.title=tr('Модель сейчас работает');label.append(w);}const meta=el('span',undefined,'tree-meta');meta.append(path,badge);open.append(label,meta);if(ai.state==='unassigned')badge.hidden=true;else badge.dataset.agent=ai.agents[0];open.title=p.cwd+' · '+tr(ai.label)+' · '+tr(ai.description);
    open.setAttribute('aria-label',p.name+' · '+tr(ai.label)+' · '+tr(ai.description));
    // Only one highlight: a project row is current only when its own chat (not a terminal session's chat) is open.
    const cur=tasks.find(t=>t.id===selected),sessionChat=Boolean(cur)&&tasks.some(t=>chainOf(t)===chainOf(cur)&&t.source_session);
    open.setAttribute('aria-current',String(n.host.id===selectedHost&&String(p.id)===draftProject&&!sessionChat));
    open.disabled=Boolean(n.offline);
    open.onclick=()=>p.id!=null?openProject(n.host.id,p.id):target&&writeTo(target);
    const send=el('button',undefined,'tree-write');send.append(uiIcon('message'));send.title=tr('Написать проекту {name}',{name:p.name});send.dataset.treeKey=(search?'search-write-project:':'write-project:')+key;send.setAttribute('aria-label',tr('Написать проекту {name}',{name:p.name}));send.disabled=!target;send.onclick=()=>writeTo(target);
    const visibility=el('button',undefined,'tree-hide');const hidden=hiddenProjects.has(key);visibility.append(uiIcon(hidden?'eye':'eye-off'));visibility.title=tr(hidden?'Показать проект {name}':'Скрыть проект {name}',{name:p.name});visibility.setAttribute('aria-label',visibility.title);visibility.dataset.treeKey=(search?'search-':'')+'hide-project:'+key;visibility.onclick=()=>hideProject(key,!hidden);if(hidden){row.classList.add('project-hidden');badge.hidden=false;badge.append(document.createTextNode(' · '+tr('Скрыт')));}const counts=p.id!=null?projectSessions(n.host.id,p.id):{total:0};
    if(counts.total){const term=el('button',undefined,'tree-terminal');term.append(uiIcon('terminal'),el('span',String(counts.total)));term.dataset.live=String(counts.live>0);term.title=tr('Сессии из терминала: {n}',{n:counts.total})+(counts.live?' · '+tr('открыто: {n}',{n:counts.live}):'');term.setAttribute('aria-label',term.title+' · '+p.name);term.dataset.treeKey=(search?'search-terminal:':'terminal:')+key;term.onclick=async()=>{await openProject(n.host.id,p.id);if(selectedHost===n.host.id&&$('projects').value===String(p.id))openTerminalSessions();};row.classList.add('has-terminal');row.append(open,term,send,visibility);}
    else row.append(open,send,visibility);
    box.append(row);
   }
   if(projBox!==hd&&idle.length)hd.append(projBox);
   if(!visible.length&&projBox===hd)hd.append(el('small','Нет проектов или подключённых сессий','tree-empty'));
  }
  if(!root.childElementCount)root.append(el('p',query?'Ничего не найдено':'Сессии появятся после подключения','tree-status'));
  if(focus)root.querySelector('[data-tree-key="'+CSS.escape(focus)+'"]')?.focus({preventScroll:true});root.scrollTop=scroll;
 }
 function render(){
  if(!csrf){nodes=[];$('projectTree').replaceChildren();$('projectSearchResults').replaceChildren();signature='';return;}
  const query=$('treeSearch').value.trim().toLocaleLowerCase(),searchOpen=$('projectSearchDialog').open;
  const next=JSON.stringify([tasks.filter(t=>activeStatuses.includes(t.status)).map(t=>t.id),[...sessionSummary],nodes,[...hiddenProjects],$('showHiddenProjects').checked,query,searchOpen,selectedHost,selected,draftProject,tasks.map(t=>[t.id,t.project,t.agent,t.status])]);if(next===signature)return;signature=next;
  renderTree($('projectTree'),'');
  if(searchOpen)renderTree($('projectSearchResults'),query,true);
 }
 $('showHiddenProjects').onchange=()=>{signature='';render();};
 $('treeSearch').oninput=render;$('refreshTree').onclick=$('refreshProjectOverview').onclick=reload;
 $('projectSearchButton').onclick=()=>{sidebar(false);$('projectSearchDialog').showModal();signature='';render();$('treeSearch').focus();};
 $('projectSearchDialog').addEventListener('close',()=>{$('treeSearch').value='';$('projectSearchResults').replaceChildren();signature='';render();});
 $('treeSearch').onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();$('projectSearchDialog').close();}else if(e.key==='Enter'){e.preventDefault();$('projectSearchResults').querySelector('.tree-open:not(:disabled)')?.click();}};
 // Working indicators: key sessions of every server are refreshed every 6 seconds, the rest of the tree every 15.
 let keyBusy=false;setInterval(async()=>{if(!csrf||document.hidden||keyBusy||loading||!nodes.length)return;keyBusy=true;
  try{await Promise.all(nodes.filter(n=>!n.offline&&Array.isArray(n.key)).map(async n=>{try{n.key=await get(n.host.id,'agent-sessions/key');}catch{}}));render();}finally{keyBusy=false;}},6000);
 let last=0;setInterval(()=>{if(!csrf){render();return;}if(document.hidden)return;render();if(Date.now()-last>15000){last=Date.now();reload();}},1000);
})();

// Native menus retain keyboard navigation and close when an action is chosen.
document.addEventListener('click',e=>{document.querySelectorAll('.action-menu[open]').forEach(menu=>{if(!menu.contains(e.target)||e.target.closest('button'))menu.open=false;});});
document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelectorAll('.action-menu[open]').forEach(menu=>{menu.open=false;menu.querySelector('summary').focus();});});
// Follow the visible viewport when the tablet keyboard overlays the layout.
function fitTabletViewport(){document.documentElement.style.setProperty('--viewport-height',(window.visualViewport?.height||innerHeight)+'px');}
window.visualViewport?.addEventListener('resize',fitTabletViewport);window.addEventListener('resize',fitTabletViewport);fitTabletViewport();
