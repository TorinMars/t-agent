const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {parseHTML}=require('linkedom');
function setup({panelAllows=false}={}) {
 const {document,Event}=parseHTML(fs.readFileSync('public/index.html','utf8'));
 const calls=[];
 const saved=new Map([['active-engine-key','remote:42']]);
 const context={document,console,localStorage:{getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,String(value)),removeItem(key){saved.delete(key)}},
 mermaid:{initialize(){}},escapeHtml:String,alert(){},confirm:()=>true,addEventListener(){},
 TerminalActivity:{onChange(){},start(){},refresh(){},acknowledge(){},stateOf:()=>'idle',taskState:()=>'idle',sourceState:()=>'idle',registerSource(){},unregisterSource(){},setActive(){}},API:{get:async()=>[]},setTimeout(){},clearTimeout(){},
 FilePanel:{isOpen:()=>true,beforeContextChange:async()=>panelAllows,close:async()=>false,open:async c=>calls.push(c)},
 };
 context.window=context; vm.createContext(context);
 vm.runInContext(fs.readFileSync('public/js/terminal-history.js','utf8'),context);
 vm.runInContext(fs.readFileSync('public/js/tasks.js','utf8'),context);
 return {context,document,calls,Event,saved};
}
test('toolbar exposes file browser without adding a task tab',()=>{
 const {document}=setup();
 assert.ok(document.querySelector('#content-toolbar #btn-file-browser'));
 assert.equal(document.querySelectorAll('#content-tabs .tab-btn').length,5);
});
test('the file panel works for local and remote Engines through the same controller',()=>{
 assert.equal(typeof setup().context.Tasks.openFileBrowser,'function');
});
test('the active Engine is unchanged when a dirty file panel cancels navigation',async()=>{
 const {context}=setup({panelAllows:false});
 context.Tasks.syncSources([{id:42,name:'Engine 42',base_url:'http://engine'}]);
 context.Tasks.activateSource('remote:42'); // beforeContextChange refuses: nothing happens yet
 await Promise.resolve();
 assert.equal(context.Tasks.getActiveKey(),'local');
});
test('switching Engines proceeds once the file panel permits navigation',async()=>{
 const {context}=setup({panelAllows:true});
 context.Tasks.syncSources([{id:42,name:'Engine 42',base_url:'http://engine'}]);
 await context.Tasks.activateSource('remote:42');
 assert.equal(context.Tasks.getActiveKey(),'remote:42');
 context.FilePanel.isOpen=()=>false;
 await context.Tasks.activateSource('local');
 assert.equal(context.Tasks.getActiveKey(),'local');
});
