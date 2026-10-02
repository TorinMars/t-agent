// Integration regression: real task routes, Monaco, xterm and PTY while the panel is open.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const express = require('express');
const {WebSocketServer}=require('ws');
const root=path.resolve(__dirname,'..');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'file-panel-terminal-'));
process.env.T_AGENT_DATA_DIR=path.join(scratch,'data');
process.env.TASKS_BASE_DIR=path.join(scratch,'tasks');
const auth=require.resolve('../middleware/auth');
require.cache[auth]={id:auth,filename:auth,loaded:true,exports:(req,res,next)=>{req.session={user:{login:'owner'}};next();}};
const db=require('../db');
const engine=require('../services/engine-tasks');
const terminal=require('../routes/terminal');
const task=engine.createTask('owner',{title:'Panel fixture'});
fs.writeFileSync(path.join(task.work_dir,'hello.js'),'const hello = "world";\n');
const second=engine.createTask('owner',{title:'Other fixture'});
const app=express();app.use(express.json({limit:'32mb'}));
app.use('/api/tasks',require('../routes/tasks'));
app.get('/fixture-xterm.js',(req,res)=>res.sendFile(require.resolve('@xterm/xterm')));
app.get('/fixture-fit.js',(req,res)=>res.sendFile(require.resolve('@xterm/addon-fit')));
app.get('/fixture-xterm.css',(req,res)=>res.sendFile(require.resolve('@xterm/xterm/css/xterm.css')));
app.get('/js/app.js',(req,res)=>res.type('js').send(fs.readFileSync(path.join(root,'public/js/app.js'),'utf8').split('// app.js 在其他业务脚本之前加载')[0]));
app.get('/',(req,res)=>res.type('html').send(fs.readFileSync(path.join(root,'public/index.html'),'utf8')
 .replace(/<script src="https:[^"]*marked[^\n]+/,'<script>window.marked={parse:s=>s};window.mermaid={initialize(){},run:async()=>{}};</script>')
 .replace(/<script src="https:[^"]*mermaid[^\n]+/,'')
 .replace(/https:\/\/cdn.jsdelivr.net\/npm\/@xterm\/xterm@5\/lib\/xterm.js/g,'/fixture-xterm.js')
 .replace(/https:\/\/cdn.jsdelivr.net\/npm\/@xterm\/addon-fit@0.10\/lib\/addon-fit.js/g,'/fixture-fit.js')
 .replace(/https:\/\/cdn.jsdelivr.net\/npm\/@xterm\/xterm@5\/css\/xterm.css/g,'/fixture-xterm.css')));
app.use(express.static(path.join(root,'public')));
let server,browser,wss,connections=0;
(async()=>{
 try {
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  wss=new WebSocketServer({server});
  wss.on('connection',(ws,req)=>{connections++;terminal.handleWs(ws,req,{login:'owner'});});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(id=>localStorage.setItem('selectedTaskId',String(id)),task.id);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(()=>{ const Original=window.Terminal;window.__testTerms=[];window.Terminal=class extends Original{constructor(...args){super(...args);window.__testTerms.push(this);}};return Tasks.load(); });
  await page.locator('#btn-file-browser').click();
  await page.locator('#file-panel').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('#xterm-container .xterm-screen')?.clientHeight>10);
  const geometry=await page.evaluate(()=>{
   const box=s=>document.querySelector(s).getBoundingClientRect();
   const toolbar=box('#content-toolbar'),area=box('.content-area'),panel=box('#file-panel'),terminal=box('#terminal-pane');
   return {ratio:panel.height/(area.bottom-toolbar.bottom),panelBottom:panel.bottom,terminalTop:terminal.top,terminalBottom:terminal.bottom,areaBottom:area.bottom};
  });
  assert.ok(Math.abs(geometry.ratio-.85)<.02,JSON.stringify(geometry));
  assert.ok(geometry.terminalTop>=geometry.panelBottom-1,JSON.stringify(geometry));
  assert.ok(geometry.terminalBottom<=geometry.areaBottom+1);
  await page.locator('.file-tree-row[data-path="hello.js"]').click();
  await page.waitForFunction(()=>monaco.editor.getModels().some(model=>model.uri.path.endsWith('/hello.js')));
  assert.ok(await page.locator('#file-panel-editor').isVisible(),'Monaco editor must be visible');
  await page.evaluate(()=>monaco.editor.getModels().find(model=>model.uri.path.endsWith('/hello.js')).setValue('const edited = true;\n'));
  await page.locator('#file-panel-editor textarea').focus();
  const saved=page.waitForResponse(response=>response.request().method()==='PUT'&&response.url().includes('/files/content'));
  await page.keyboard.press(process.platform==='darwin'?'Meta+s':'Control+s');
  assert.equal((await saved).status(),200);
  assert.equal(fs.readFileSync(path.join(task.work_dir,'hello.js'),'utf8'),'const edited = true;\n');
  const drag=await page.locator('#file-panel-resizer').boundingBox();
  await page.mouse.move(drag.x+drag.width/2,drag.y+drag.height/2);
  await page.mouse.down();await page.mouse.move(drag.x+drag.width/2,460,{steps:5});await page.mouse.up();
  await page.waitForFunction(()=>document.querySelector('#terminal-pane').getBoundingClientRect().height>350);
  const input=page.locator('#xterm-container .xterm-helper-textarea');
  await input.focus();await page.keyboard.type("printf 'PANEL_%s_OK\\n' 'TERMINAL'");await page.keyboard.press('Enter');
  await page.waitForFunction(()=>{const b=window.__testTerms[0]?.buffer.active;return b&&Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString()).some(line=>line?.trim()==='PANEL_TERMINAL_OK');});
  assert.equal(connections,1,'opening browser starts only one terminal connection');
  // The root integration must not close or recreate the terminal on a panel toggle.
  await page.locator('#btn-file-browser').click();
  await page.locator('#file-panel').waitFor({state:'hidden'});
  await page.locator('#btn-file-browser').click();
  await page.locator('#file-panel').waitFor({state:'visible'});
  assert.equal(connections,1,'panel toggle preserves the existing websocket');
  assert.equal(await page.locator('#content-tabs .tab-btn.active').getAttribute('data-tab'),'shell');
  await page.locator('.file-tree-row[data-path="hello.js"]').click();
  await page.waitForFunction(()=>monaco.editor.getModels().some(model=>model.uri.path.endsWith('/hello.js')));
  await page.screenshot({path:'/tmp/t-agent-file-panel.png'});
  await page.evaluate(()=>monaco.editor.getModels().find(model=>model.uri.path.endsWith('/hello.js')).setValue('unsaved draft'));
  await page.locator(`.task-nav-item[data-id="${second.id}"]`).click();
  await page.locator('[data-dialog-action="cancel"]').click();
  assert.ok(await page.locator('#file-panel').isVisible(),'cancel preserves active panel');
  await page.locator(`.task-nav-item[data-id="${second.id}"]`).click();
  await page.locator('[data-dialog-action="save"]').click();
  await page.locator('#file-panel').waitFor({state:'hidden'});
  assert.equal(fs.readFileSync(path.join(task.work_dir,'hello.js'),'utf8'),'unsaved draft');
  await page.waitForFunction(id=>document.querySelector(`.task-nav-item[data-id="${id}"]`)?.classList.contains('active'),second.id);
  assert.deepEqual(errors,[]);
 } finally {
  if(browser)await browser.close();
  terminal.closeTaskTerminals(task.id);terminal.closeTaskTerminals(second.id);
  if(wss){for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));}
  if(server)await new Promise(r=>server.close(r));
  db.close();fs.rmSync(scratch,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
