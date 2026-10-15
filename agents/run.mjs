import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
// Process lifecycle shared by all agents: one detached process group per task.
export class AgentRun {
 constructor(ctx,task,cwd){this.ctx=ctx;this.task=task;this.cwd=cwd;this.approvals=new Map();this.closed=false;}
 spawn(command,args,options){
  this.proc=spawn(command,args,{...options,stdio:['pipe','pipe','ignore'],detached:true});
  this.proc.stdin.on('error',()=>this.finish('failed'));
  createInterface({input:this.proc.stdout}).on('line',line=>{let m;try{m=JSON.parse(line);}catch{return;}try{this.receive(m);}catch{}});
  return this.proc;
 }
 setThread(id){this.thread=id;this.ctx.db.prepare("UPDATE tasks SET thread=?,status='running' WHERE id=?").run(id,this.task);}
 event(body){this.ctx.event(this.task,body);}
 interrupt(){}
 finish(status){if(this.closed)return;this.closed=true;this.ctx.db.prepare('UPDATE tasks SET status=? WHERE id=?').run(['completed','interrupted','failed'].includes(status)?status:'failed',this.task);this.event({type:'status',status});this.approvals.clear();try{process.kill(-this.proc.pid,'SIGTERM');}catch{}this.killTimer=setTimeout(()=>{try{process.kill(-this.proc.pid,'SIGKILL');}catch{}this.release();},2000);this.proc.once('close',()=>{clearTimeout(this.killTimer);this.release();});}
 release(){this.ctx.runs.delete(this.task);}
}
export const filesNote=files=>files.length?'\n\nПриложенные пользователем файлы (имя и локальный путь, JSON):\n'+JSON.stringify(files.map(f=>({name:f.name,path:f.path})))+'\nИспользуй эти файлы как материалы к запросу.':'';
