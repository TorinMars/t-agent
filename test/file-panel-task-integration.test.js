const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {parseHTML}=require('linkedom');
function setup() {
 const {document,Event}=parseHTML(fs.readFileSync('public/index.html','utf8'));
 const calls=[];
 const context={document,console,localStorage:{getItem:()=>null,setItem(){},removeItem(){}},
 mermaid:{initialize(){}},escapeHtml:String,alert(){},confirm:()=>true,addEventListener(){},
 TerminalActivity:{onChange(){},start(){},refresh(){},acknowledge(){},stateOf:()=>'idle',taskState:()=>'idle'},API:{get:async()=>[]},setTimeout(){},clearTimeout(){},
 FilePanel:{isOpen:()=>true,beforeContextChange:async()=>false,close:async()=>false,open:async c=>calls.push(c)},
 };
 context.window=context; vm.createContext(context);
 vm.runInContext(fs.readFileSync('public/js/terminal-history.js','utf8'),context);
 vm.runInContext(fs.readFileSync('public/js/tasks.js','utf8'),context);
 return {context,document,calls,Event};
}
test('toolbar exposes file browser without adding a task tab',()=>{
 const {document}=setup();
 assert.ok(document.querySelector('#content-toolbar #btn-file-browser'));
 assert.equal(document.querySelectorAll('#content-tabs .tab-btn').length,5);
});
test('file-panel controller can request the local task context',()=>{
 assert.equal(typeof setup().context.Tasks.openFileBrowser,'function');
});
