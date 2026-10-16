// Real CLI entrypoints, deterministic no-model scenario. Does not call a model API.
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=mkdtempSync(path.join(tmpdir(),'dao-recovery-entry-'));
const preload=path.join(root,'no-network.mjs');writeFileSync(preload,'globalThis.fetch=async()=>{throw Error("No network in entrypoint smoke");};');
const usage={promptTokens:0,completionTokens:0,cacheHitTokens:0,cacheMissTokens:0};
for(const id of ['legacy-a','legacy-b']){const dir=path.join(root,'.dao/sessions',id);mkdirSync(dir,{recursive:true});writeFileSync(path.join(dir,'state.json'),JSON.stringify({id,cwd:root,model:'deepseek-v4-pro',mode:'normal',title:id,messages:[{role:'system',content:'test'},{role:'user',content:id},{role:'assistant',content:'saved'}],usage,updatedAt:1,done:false}));}
const args=['--import',path.join(repo,'node_modules/tsx/dist/loader.mjs'),'--import',preload,path.join(repo,'src/index.ts'),'--api-key','test-only','--provider','deepseek','--eval','--no-skills','--no-hooks','--yolo','-c','legacy-a'];
const child=spawn(process.execPath,args,{cwd:root,env:{...process.env,DAO_REFLECT:'0',DAO_NO_CHECKPOINT:'1',DAO_THEME:'dark'},stdio:['pipe','pipe','pipe']});
child.stdin.end('/resume legacy-b\n/recovery\n/quit --keep-background\n');
let output='';for(const s of [child.stdout,child.stderr])s.on('data',d=>output+=d);const code=await new Promise(r=>child.once('exit',r));writeFileSync(path.join(root,'cli.log'),output);assert.equal(code,0,output);assert.match(output,/已恢复会话 legacy-b/);
for(const id of ['legacy-a','legacy-b']){const state=JSON.parse(readFileSync(path.join(root,'.dao/sessions',id,'state.json'),'utf8'));assert.equal(state.id,id);assert.equal(state.storageVersion,2);assert(state.messages.some(m=>m.role==='user'&&m.content===id));}
console.log(JSON.stringify({pass:true,entry:'REPL',evidence:root,sessions:['legacy-a','legacy-b']}));
