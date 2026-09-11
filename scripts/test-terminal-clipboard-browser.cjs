const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const root = require('node:path').resolve(__dirname, '..');
const html = `<!doctype html><link rel="stylesheet" href="/xterm.css"><style>body{background:#202124;color:white}.terminal-toolbar{display:flex;gap:12px;padding:10px}#host{width:900px;height:400px}dialog{width:650px}textarea{width:95%;height:220px}</style><div class="terminal-toolbar"></div><div id="terminal-pane"><div id="xterm-container"><div id="host"></div></div></div><script src="/xterm.js"></script><script src="/clipboard.js"></script><script>window.term=new Terminal({cols:80,rows:20,fontSize:16});term.open(document.getElementById('host'));window.handle=TerminalClipboard.attach(term,document.getElementById('host'));window.sent=[];term.onData(d=>sent.push(d));term.write('中文复制测试 hello world\\r\\nsecond line');term.focus();</script>`;
const server = http.createServer((req,res) => {
  const files = { '/xterm.css': require.resolve('@xterm/xterm/css/xterm.css'), '/xterm.js': require.resolve('@xterm/xterm'), '/clipboard.js': root + '/public/js/terminal-clipboard.js' };
  res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : req.url.endsWith('.js') ? 'text/javascript' : 'text/html');
  res.setHeader('Content-Type', res.getHeader('Content-Type') + '; charset=utf-8');
  res.end(files[req.url] ? fs.readFileSync(files[req.url]) : html);
});
(async () => {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  try {
    const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']});
    await context.addInitScript(()=>Object.defineProperty(navigator,'platform',{get:()=> 'MacIntel'}));
    const page=await context.newPage();
    const errors=[];page.on('pageerror', e=>errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(()=>window.term && term.buffer.active.getLine(0)?.translateToString().includes('hello'));
    await page.evaluate(()=>{term.select(0,0,25);term.focus();});
    const selected=await page.evaluate(()=>term.getSelection());
    await page.keyboard.press('Meta+c');
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),selected);
    await page.evaluate(()=>{term.clearSelection();term.focus();});
    await page.keyboard.press('Control+c');
    assert.ok((await page.evaluate(()=>sent)).includes('\x03'));
    // Enable full-screen + SGR mouse mode like an interactive terminal application.
    await page.evaluate(()=>new Promise(r=>term.write('\x1b[?1049h\x1b[?1000h\x1b[?1006hMouse mode 中文 hello world',r)));
    await page.evaluate(()=>new Promise(r=>term.write("\x1b[HMouse mode 中文 hello world",r)));
    const box=await page.locator('.xterm-screen').boundingBox();
    await page.keyboard.down('Alt');
    await page.mouse.move(box.x+2,box.y+10);await page.mouse.down();
    await page.mouse.move(box.x+220,box.y+10,{steps:8});await page.mouse.up();
    await page.keyboard.up('Alt');
    const mouseSelected=await page.evaluate(()=>term.getSelection());
    assert.ok(mouseSelected.includes('Mouse mode'),JSON.stringify(mouseSelected));
    await page.getByRole('button',{name:'复制选中内容',exact:true}).click();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),mouseSelected);
    // OSC 52 split over delayed writes must not write until explicit approval.
    const payload=Buffer.from('远程程序\nhello ✓').toString('base64');
    await page.evaluate(async payload=>{
      await new Promise(r=>term.write('\x1b]52;c;'+payload.slice(0,5),r));
      await new Promise(r=>setTimeout(r,250));
      await new Promise(r=>term.write(payload.slice(5)+'\x07',r));
    },payload);
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),mouseSelected);
    await page.getByRole('button',{name:'查看程序复制请求'}).click();
    assert.equal(await page.locator('dialog textarea').inputValue(),'远程程序\nhello ✓');
    // A second request cannot replace the contents already presented for approval.
    await page.evaluate(()=>new Promise(r=>term.write('\x1b]52;c;ZXZpbA==\x07',r)));
    assert.equal(await page.locator('dialog textarea').inputValue(),'远程程序\nhello ✓');
    await page.getByRole('button',{name:'确认复制',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('dialog'));
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'远程程序\nhello ✓');
    // A replayed request must not reappear.
    await page.evaluate(payload=>new Promise(r=>handle.writeHistory('\x1b]52;c;'+payload+'\x07',r)),payload);
    assert.equal(await page.getByRole('button',{name:'查看程序复制请求'}).isVisible(),false);
    assert.deepEqual(errors,[]);
    console.log('PASS: real Chromium + xterm: Cmd+C, Ctrl+C, macOS Option selection in mouse/alternate mode, toolbar copy, delayed split OSC 52 approval, immutable preview, history suppression.');
  } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
