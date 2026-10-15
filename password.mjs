import {scryptSync,randomBytes} from 'node:crypto';
import {writeFileSync,mkdirSync,chmodSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const dir=new URL('./data/',import.meta.url); mkdirSync(dir,{recursive:true,mode:0o700});
if(!process.stdin.isTTY) throw Error('Запустите локально в терминале');
function read(prompt){process.stdout.write(prompt);spawnSync('stty',['-echo'],{stdio:'inherit'});const chunks=[];try{const b=Buffer.alloc(1);const {readSync}=awaitImport;while(readSync(0,b,0,1,null)&&b[0]!==10)chunks.push(Buffer.from(b));}finally{spawnSync('stty',['echo'],{stdio:'inherit'});process.stdout.write('\n');}return Buffer.concat(chunks).toString('utf8').replace(/\r$/,'');}
import * as awaitImport from 'node:fs';
process.on('SIGINT',()=>{spawnSync('stty',['echo'],{stdio:'inherit'});process.stdout.write('\n');process.exit(130);});
const p=read('Новый пароль панели (минимум 14 символов): ');if(p.length<14||p!==read('Повторите пароль: '))throw Error('Пароли не совпали или слишком короткие');
const salt=randomBytes(32).toString('hex');writeFileSync(new URL('password.json',dir),JSON.stringify({salt,hash:scryptSync(p,salt,64).toString('hex')}),{mode:0o600});chmodSync(new URL('password.json',dir),0o600);console.log('Пароль сохранён. Перезапустите codex-panel; старые сессии будут сброшены.');
