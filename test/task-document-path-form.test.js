const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
for (const remote of [false,true]) test(`${remote?'remote':'local'} task form submits all three paths and supports clearing`,()=>{
 const {document,Event}=parseHTML(fs.readFileSync('public/index.html','utf8'));
 const calls=[];
 const context={document,console,localStorage:{getItem:()=>null,setItem(){}},addEventListener(){},
  escapeHtml:v=>String(v),mermaid:{initialize(){}},alert:message=>{throw new Error(message)},
  Modal:{show(title,body){document.getElementById('modal-body').innerHTML=body},hide(){}},
  API:{put:(url,body)=>{calls.push({url,body});return new Promise(()=>{})},get:async()=>[]},
 };
 context.window=context;vm.createContext(context);
 let source=fs.readFileSync(remote?'public/js/remote-tasks.js':'public/js/tasks.js','utf8');
 const marker=remote?'  return {\n    load,':'  return {\n    async load()';
 source=source.replace(marker,marker.replace('  return {\n',`  return {\n    _edit: ${remote?'editDocumentPaths':'showEditModal'},\n`));
 vm.runInContext(source,context);
 const task={id:1,title:'task',status:'todo',work_dir:'/project',md_path:'/project/DESIGN.md',technical_path:'/docs/DESIGN.md',readme_path:'/docs/readme.md',agent_path:'/docs/agent.md'};
 const controller=remote?context.RemoteTasks:context.Tasks;
 const open=()=>remote?controller._edit({id:2},task):controller._edit(task);
 open();
 const ids=remote?['remote-technical_path','remote-readme_path','remote-agent_path']:['f-md-path','f-readme_path','f-agent_path'];
 assert.deepEqual(ids.map(id=>document.getElementById(id).value),['/docs/DESIGN.md','/docs/readme.md','/docs/agent.md']);
 ids.forEach((id,i)=>document.getElementById(id).value=`/changed/${i}.md`);
 document.getElementById(remote?'remote-path-save':'f-submit').dispatchEvent(new Event('click'));
 assert.equal(calls[0].body.technical_path,'/changed/0.md');assert.equal(calls[0].body.readme_path,'/changed/1.md');assert.equal(calls[0].body.agent_path,'/changed/2.md');
 open();ids.forEach(id=>document.getElementById(id).value='');
 document.getElementById(remote?'remote-path-save':'f-submit').dispatchEvent(new Event('click'));
 assert.equal(calls[1].body.technical_path,null);assert.equal(calls[1].body.readme_path,null);assert.equal(calls[1].body.agent_path,null);
});
