const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {parseHTML}=require('linkedom');
function setup(remote=false) {
 const {document,Event}=parseHTML(fs.readFileSync('public/index.html','utf8'));
 const calls=[];
 const context={document,console,localStorage:{getItem:key=>key === 'active-engine-key' ? 'remote:42' : null,setItem(){},removeItem(){}},
 mermaid:{initialize(){}},escapeHtml:String,alert(){},confirm:()=>true,addEventListener(){},
 API:{get:async()=>[]},setTimeout(){},clearTimeout(){},
 FilePanel:{isOpen:()=>true,beforeContextChange:async()=>false,close:async()=>false,open:async c=>calls.push(c)},
 };
 context.window=context; vm.createContext(context);
 vm.runInContext(fs.readFileSync('public/js/terminal-history.js','utf8'),context);
 vm.runInContext(fs.readFileSync(remote?'public/js/remote-tasks.js':'public/js/tasks.js','utf8'),context);
 return {context,document,calls,Event};
}
test('toolbar exposes file browser without adding a task tab',()=>{
 const {document}=setup();
 assert.ok(document.querySelector('#content-toolbar #btn-file-browser'));
 assert.equal(document.querySelectorAll('#content-tabs .tab-btn').length,5);
});
test('engine selection is unchanged when dirty file panel cancels navigation',async()=>{
 const {context}=setup(true);
 await context.RemoteTasks.setActiveEngine('local');
 assert.equal(context.RemoteTasks.getActiveEngineKey(),'remote:42');
});
test('file-panel controller can request local and remote task contexts',()=>{
 assert.equal(typeof setup().context.Tasks.openFileBrowser,'function');
 assert.equal(typeof setup(true).context.RemoteTasks.openFileBrowser,'function');
});

test('returning to local engine clears remote state after file panel permits navigation',async()=>{
 const {context}=setup(true);
 context.FilePanel.isOpen=()=>false;
 let activated=0;
 context.Tasks={activateLocal(){activated++},confirmDiscardEditor:()=>true};
 await context.RemoteTasks.setActiveEngine('local');
 assert.equal(activated,1);
 assert.equal(context.RemoteTasks.isSelected(),false);
});
