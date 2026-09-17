const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
(async () => {
  const browser = await chromium.launch({headless:true, ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH}: {})});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:600}});
    await page.setContent(fs.readFileSync(path.join(root,'public/index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace(/<link\b[^>]*>/g,''));
    await page.addStyleTag({content:fs.readFileSync(path.join(root,'public/css/style.css'),'utf8')});
    await page.evaluate(() => {
      document.querySelector('#terminal-pane').style.display='flex';
      document.querySelector('#preview-pane').style.display='none';
      document.querySelector('#xterm-container').innerHTML='<textarea aria-label="Terminal input"></textarea>';
      window.sent=[]; window.engine='local';
      window.Tasks={sendTerminalInput:data=>sent.push(['local',data])};
      window.RemoteTasks={getActiveEngineKey:()=>engine,sendTerminalInput:data=>sent.push(['remote',data])};
    });
    await page.addScriptTag({content:fs.readFileSync(path.join(root,'public/js/terminal-keys.js'),'utf8')});
    await page.locator('[data-shortcut="option-up"]').click();
    await page.locator('[data-modifier="alt"]').click();
    await page.locator('[data-key="ArrowUp"]').click();
    assert.equal(await page.locator('[data-modifier="alt"]').getAttribute('aria-pressed'),'false');
    await page.locator('textarea').focus();
    await page.locator('[data-modifier="ctrl"]').click();
    await page.keyboard.press('c');
    assert.equal(await page.locator('textarea').inputValue(),'');
    await page.evaluate(()=>window.engine='remote:1');
    await page.locator('[data-shortcut="option-up"]').click();
    await page.locator('[data-modifier="meta"]').click();
    await page.locator('textarea').focus();
    await page.keyboard.press('a');
    assert.deepEqual(await page.evaluate(()=>sent),[['local','\x1b[1;3A'],['local','\x1b[1;3A'],['local','\x03'],['remote','\x1b[1;3A'],['remote','\x1b[97;9u']]);
    const bar=await page.locator('#terminal-keys').boundingBox();
    const viewport=await page.locator('#xterm-container').boundingBox();
    assert.ok(bar.height<=40 && bar.y>=viewport.y+viewport.height && bar.y+bar.height<=600);
    console.log('Local/remote routing, one-shot modifiers, Option+Up, physical key combinations and compact bottom layout passed.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
