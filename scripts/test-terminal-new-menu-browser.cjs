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
      window.created=[];
      window.requested=[];
      window.Tasks={newTerminal:async options=>{created.push(options);}};
      window.TerminalTabs={agentSessions:async agent=>{requested.push(agent);return [{id:'s-1',title:'Fix the build'},{id:'s-2',title:'Write docs'}];}};
    });
    await page.addScriptTag({content:fs.readFileSync(path.join(root,'public/js/app.js'),'utf8')});
    const items = () => page.locator('.terminal-new-menu li').allTextContents();

    await page.click('#btn-terminal-new');
    assert.deepEqual(await items(), ['New Terminal','Claude session','Codex session']);
    await page.click('#btn-terminal-new');
    assert.equal(await page.locator('.terminal-new-menu').count(), 0, '"+" toggles the menu');
    await page.click('#btn-terminal-new');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.terminal-new-menu').count(), 0, 'Escape closes the menu');

    await page.click('#btn-terminal-new');
    await page.click('.terminal-new-menu li:text-is("New Terminal")');
    await page.waitForFunction(() => created.length === 1);
    assert.deepEqual(await page.evaluate(() => created), [{}]);
    assert.equal(await page.locator('.terminal-new-menu').count(), 0);

    await page.click('#btn-terminal-new');
    await page.click('.terminal-new-menu li:text-is("Codex session")');
    await page.waitForSelector('.terminal-new-menu li:text-is("Back")');
    assert.deepEqual(await items(), ['New Codex session','Fix the build','Write docs','Back']);
    assert.deepEqual(await page.evaluate(() => requested), ['codex']);
    await page.click('.terminal-new-menu li:text-is("Back")');
    assert.deepEqual(await items(), ['New Terminal','Claude session','Codex session']);

    await page.click('.terminal-new-menu li:text-is("Claude session")');
    await page.click('.terminal-new-menu li:text-is("Write docs")');
    await page.waitForFunction(() => created.length === 2);
    assert.deepEqual(await page.evaluate(() => created[1]), {agent:'claude', session_id:'s-2'});

    await page.click('#btn-terminal-new');
    await page.click('.terminal-new-menu li:text-is("Claude session")');
    await page.click('.terminal-new-menu li:text-is("New Claude session")');
    await page.waitForFunction(() => created.length === 3);
    assert.deepEqual(await page.evaluate(() => created[2]), {agent:'claude'});

    await page.click('#btn-terminal-new');
    await page.mouse.click(300, 300);
    assert.equal(await page.locator('.terminal-new-menu').count(), 0, 'an outside click closes the menu');
    const box = await (async () => { await page.click('#btn-terminal-new'); return page.locator('.terminal-new-menu').boundingBox(); })();
    assert.ok(box.x >= 0 && box.x + box.width <= 1280, 'the menu stays inside the window');
    console.log('Terminal "+" menu: plain terminal, new and resumed Claude / Codex sessions, Back, Escape and outside click passed.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
