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
      window.opened=[];
      window.AgentChat={AGENTS:{claude:{label:'Claude'},codex:{label:'Codex'}},choices:async()=>[],open:async(api,base,agent,choice,title)=>{opened.push({agent,choice,title});throw new Error('stub');}};
      window.TerminalTabs={onScopeChange(){},setChats(){},context:()=>({scope:'/api/tasks/1',taskId:1,sourceKey:'local'}),agentSessions:async agent=>{requested.push(agent);return [{id:'s-1',title:'Fix the build'},{id:'s-2',title:'Write docs'}];}};
    });
    await page.addScriptTag({content:fs.readFileSync(path.join(root,'public/js/app.js'),'utf8')});
    const items = () => page.locator('.terminal-new-menu li').allTextContents();

    await page.click('#btn-terminal-new');
    assert.deepEqual(await items(), ['New Terminal','Claude session','Codex session','Claude agent','Codex agent']);
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
    assert.deepEqual(await items(), ['New Terminal','Claude session','Codex session','Claude agent','Codex agent']);

    await page.click('.terminal-new-menu li:text-is("Claude session")');
    await page.click('.terminal-new-menu li:text-is("Write docs")');
    await page.waitForFunction(() => created.length === 2);
    assert.deepEqual(await page.evaluate(() => created[1]), {agent:'claude', session_id:'s-2'});

    await page.click('#btn-terminal-new');
    await page.click('.terminal-new-menu li:text-is("Claude session")');
    await page.click('.terminal-new-menu li:text-is("New Claude session")');
    await page.waitForFunction(() => created.length === 3);
    assert.deepEqual(await page.evaluate(() => created[2]), {agent:'claude'});

    // The optional name field: empty keeps the default (no title is sent), a name is trimmed and sent, it survives going into a submenu, and Enter creates.
    const name = '.terminal-new-menu input.terminal-new-name';
    await page.click('#btn-terminal-new');
    assert.equal(await page.getAttribute(name, 'placeholder'), 'Name (optional)');
    assert.equal(await page.getAttribute(name, 'maxlength'), '40');
    await page.fill(name, '   ');
    await page.click('.terminal-new-menu li:text-is("New Terminal")');
    await page.waitForFunction(() => created.length === 4);
    assert.deepEqual(await page.evaluate(() => created[3]), {}, 'a blank name keeps the default name');

    await page.click('#btn-terminal-new');
    assert.equal(await page.inputValue(name), '', 'the field starts empty each time the menu opens');
    await page.fill(name, '  Build  log ');
    await page.click('.terminal-new-menu li:text-is("New Terminal")');
    await page.waitForFunction(() => created.length === 5);
    assert.deepEqual(await page.evaluate(() => created[4]), {title:'Build log'});

    await page.click('#btn-terminal-new');
    await page.fill(name, '\u8bc4\u5ba1 \u{1F680}');
    await page.click('.terminal-new-menu li:text-is("Claude session")');
    await page.waitForSelector('.terminal-new-menu li:text-is("Back")');
    assert.equal(await page.inputValue(name), '\u8bc4\u5ba1 \u{1F680}', 'the name is kept in the submenu');
    await page.focus(name);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => created.length === 6);
    assert.deepEqual(await page.evaluate(() => created[5]), {agent:'claude', title:'\u8bc4\u5ba1 \u{1F680}'}, 'Enter creates the first entry (New Claude session) with the name');

    await page.click('#btn-terminal-new');
    await page.fill(name, 'Resumed');
    await page.click('.terminal-new-menu li:text-is("Codex session")');
    await page.click('.terminal-new-menu li:text-is("Fix the build")');
    await page.waitForFunction(() => created.length === 7);
    assert.deepEqual(await page.evaluate(() => created[6]), {agent:'codex', session_id:'s-1', title:'Resumed'}, 'a resumed session takes the name too');

    await page.click('#btn-terminal-new');
    await page.focus(name);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => created.length === 8);
    assert.deepEqual(await page.evaluate(() => created[7]), {}, 'Enter in the root menu creates a plain terminal');

    await page.click('#btn-terminal-new');
    await page.fill(name, 'Chat name');
    await page.click('.terminal-new-menu li:text-is("Claude agent")');
    await page.waitForSelector('.terminal-new-menu li:text-is("New Claude chat")');
    await page.click('.terminal-new-menu li:text-is("New Claude chat")');
    await page.waitForFunction(() => opened.length === 1);
    assert.deepEqual(await page.evaluate(() => opened[0]), {agent:'claude', choice:null, title:'Chat name'}, 'a new agent chat takes the name');

    await page.click('#btn-terminal-new');
    await page.mouse.click(300, 300);
    assert.equal(await page.locator('.terminal-new-menu').count(), 0, 'an outside click closes the menu');
    const box = await (async () => { await page.click('#btn-terminal-new'); return page.locator('.terminal-new-menu').boundingBox(); })();
    assert.ok(box.x >= 0 && box.x + box.width <= 1280, 'the menu stays inside the window');
    console.log('Terminal "+" menu: plain terminal, new and resumed Claude / Codex sessions, Back, Escape, outside click and the optional name field passed.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
