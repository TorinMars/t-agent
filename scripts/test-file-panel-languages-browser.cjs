const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
 try {
  const page=await browser.newPage();
  await page.addScriptTag({path:path.resolve(__dirname,'../public/vendor/monaco/monaco.js')});
  const ids=await page.evaluate(()=>monaco.languages.getLanguages().map(x=>x.id));
  for(const id of ['javascript','typescript','json','python','html','css','shell','yaml','go','rust','java','cpp','sql']) assert.ok(ids.includes(id),`${id} language must be available`);
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
