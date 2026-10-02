const { chromium }=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 try{
  const page=await browser.newPage();
  await page.route('http://fixture.local/**',route=>route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'public/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link\b[^>]*>/g,'')}));
  await page.goto('http://fixture.local');
  await page.evaluate(()=>{
   window.calls=[];window.allow=false;
   window.escapeHtml=s=>String(s);
   window.Modal={show(t,html){document.querySelector('#modal-body').innerHTML=html;document.querySelector('#modal-overlay').style.display='block';},hide(){}};
   window.FilePanel={isOpen:()=>true,beforeContextChange:()=>new Promise(resolve=>setTimeout(()=>resolve(window.allow),10))};
   window.API={get:async()=>[],put:(url,body)=>{calls.push({url,body});return new Promise(()=>{});}};
  });
  const source=fs.readFileSync(path.join(root,'public/js/remote-tasks.js'),'utf8').replace('  return {\n    load,','  return {\n    _editPaths: editDocumentPaths, _editServer: server => { servers = [server]; showEdit(server.id); },\n    load,');
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addScriptTag({content:source});
  await page.evaluate(()=>RemoteTasks._editServer({id:9,name:'test',base_url:'http://example.test:14002'}));
  await page.locator('#remote-edit-save').click();
  await page.waitForTimeout(40);
  assert.equal(await page.evaluate(()=>calls.length),0,'cancelled dirty-file guard must not change server target');
  await page.evaluate(()=>{allow=true;RemoteTasks._editPaths({id:9},{id:4,work_dir:'/tasks/demo'});});
  await page.locator('#remote-path-save').click();
  await page.waitForFunction(()=>calls.length===1);
  assert.equal(await page.evaluate(()=>calls[0].url),'/api/remote-servers/9/tasks/4');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
