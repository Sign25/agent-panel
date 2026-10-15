import {realpathSync} from 'node:fs';
import path from 'node:path';
export function externalSessions(db,nodeId){
 db.exec('CREATE TABLE IF NOT EXISTS external_sessions(id TEXT PRIMARY KEY,cwd TEXT NOT NULL,name TEXT NOT NULL,permissions TEXT NOT NULL,seen TEXT NOT NULL)');
 function register(b){
  if(typeof b.session_id!=='string'||!/^[a-zA-Z0-9-]{8,128}$/.test(b.session_id)||typeof b.cwd!=='string'||!path.isAbsolute(b.cwd))throw Error('Invalid Claude session');
  // Only the session's hook sets its folder; a bridge command runs in whatever folder the shell was in (cd).
  const id='claude-'+b.session_id,old=db.prepare('SELECT * FROM external_sessions WHERE id=?').get(id),cwd=old&&!b.hook?old.cwd:realpathSync(b.cwd);
  const permissions=['plan','read-only'].includes(b.permission_mode)?'read-only':b.permission_mode?'workspace':old?.permissions||'read-only';
  // The session's own name (Remote Control name or title, sent by the bridge). The folder name is only a last resort
  // and never replaces a real name: several sessions share one folder.
  const folderName=path.basename(cwd)||cwd,given=typeof b.session_title==='string'&&b.session_title.trim()?b.session_title.trim():'';
  const name=String(given||(old&&old.name!==folderName?old.name:'')||folderName).slice(0,150);
  db.prepare('INSERT INTO external_sessions VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET cwd=excluded.cwd,name=excluded.name,permissions=excluded.permissions,seen=excluded.seen').run(id,cwd,name,permissions,new Date().toISOString());
  return id;
 }
 function info(id){const s=db.prepare('SELECT * FROM external_sessions WHERE id=?').get(id);return s&&{id:s.id,session_id:s.id,name:s.name,status:Date.now()-Date.parse(s.seen)<300000?'running':'interrupted',agent:'claude',permissions:s.permissions};}
 function list(){return db.prepare('SELECT * FROM external_sessions ORDER BY seen DESC').all().map(s=>({id:nodeId+':'+s.id,host:nodeId,project:null,projectName:s.name,cwd:s.cwd,agent:'claude',title:s.name,status:'external',source:'claude-external'}));}
 return {register,info,list};
}
