const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-documents-'));
process.env.T_AGENT_DATA_DIR = path.join(root, 'data');
process.env.TASKS_BASE_DIR = path.join(root, 'default');
const db = require('../db');
const engine = require('../services/engine-tasks');
const documents = require('../services/task-documents');
const authPath = require.resolve('../middleware/auth');
require.cache[authPath] = { id:authPath, filename:authPath, loaded:true, exports:(req,res,next)=>{req.session={user:{login:'owner',work_dir:path.join(root,'default')}};next();} };
const express = require('express');
const app=express();app.use(express.json());app.use('/tasks',require('../routes/tasks'));
let server, base;
test.before(async()=>{server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;});
test.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();fs.rmSync(root,{recursive:true,force:true});});
async function request(url, method, body){const res=await fetch(base+url,{method,headers:{'Content-Type':'application/json'},body:body&&JSON.stringify(body)});assert.ok(res.ok,await res.clone().text());return res.json();}
function populated(name){const dir=path.join(root,name);fs.mkdirSync(dir,{recursive:true});for(const name of ['DESIGN.md','README.md','AGENT.md'])fs.writeFileSync(path.join(dir,name),`existing ${name}`);return dir;}
test('local task uses exact workspace and never overwrites its three documents',async()=>{
 const dir=populated('local');const task=await request('/tasks','POST',{title:'local task',work_dir:dir});
 assert.equal(task.md_path,path.join(dir,'DESIGN.md'));
 for(const [kind,name] of [['technical','DESIGN.md'],['readme','README.md'],['agent','AGENT.md']]){
  assert.equal(await (await fetch(`${base}/tasks/${task.id}/document/${kind}`)).text(),`existing ${name}`);
 }
 assert.equal(fs.existsSync(path.join(root,'default','local-task')),false);
 const next=populated('local-next');const updated=await request(`/tasks/${task.id}`,'PUT',{work_dir:next,md_path:task.md_path});
 assert.equal(updated.md_path,path.join(next,'DESIGN.md'));
 assert.equal(fs.readFileSync(path.join(dir,'DESIGN.md'),'utf8'),'existing DESIGN.md');
 fs.unlinkSync(path.join(next,'README.md'));
 assert.match(await (await fetch(`${base}/tasks/${task.id}/document/readme`)).text(),/项目说明/);
});
test('engine uses existing files and follows changed workspace for default technical document',()=>{
 const dir=populated('engine');const task=engine.createTask('owner',{title:'remote task',work_dir:dir});
 for(const [kind,name] of [['technical','DESIGN.md'],['readme','README.md'],['agent','AGENT.md']])assert.equal(engine.readDocument('owner',task.id,kind),`existing ${name}`);
 const next=path.join(root,'engine-next');const updated=engine.updateTask('owner',task.id,{work_dir:next});
 assert.equal(updated.md_path,path.join(next,'DESIGN.md'));
 for(const file of ['DESIGN.md','README.md','AGENT.md'])assert.ok(fs.existsSync(path.join(next,file)));
 fs.writeFileSync(path.join(next,'DESIGN.md'),'edited');documents.ensureDocuments(updated);assert.equal(engine.readDocument('owner',task.id,'technical'),'edited');
});
test('custom technical path remains explicit while companion documents use workspace',async()=>{
 const custom=path.join(root,'custom','plan.md');const dir=path.join(root,'custom-workspace');
 const task=await request('/tasks','POST',{title:'custom',work_dir:dir,md_path:custom});
 assert.equal(task.md_path,custom);assert.ok(fs.existsSync(custom));assert.ok(fs.existsSync(path.join(dir,'AGENT.md')));
 const updated=await request(`/tasks/${task.id}`,'PUT',{work_dir:path.join(root,'custom-next')});assert.equal(updated.md_path,custom);
});

test('legacy default DESIGN path resolves to current workspace without modifying old file',async()=>{
 const dir=populated('legacy-current');const old=populated('legacy-old');
 const result=db.prepare('INSERT INTO tasks (title,user_id,md_path,work_dir) VALUES (?,?,?,?)').run('legacy','owner',path.join(old,'DESIGN.md'),dir);
 const id=result.lastInsertRowid;fs.writeFileSync(path.join(old,'DESIGN.md'),'old document');
 assert.equal(await (await fetch(`${base}/tasks/${id}/md`)).text(),'existing DESIGN.md');
 assert.equal(engine.readDocument('owner',id,'technical'),'existing DESIGN.md');
 const listed=await request('/tasks','GET');assert.equal(listed.find(t=>t.id===id).md_path,path.join(dir,'DESIGN.md'));
 assert.equal(fs.readFileSync(path.join(old,'DESIGN.md'),'utf8'),'old document');
});
