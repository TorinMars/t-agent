const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');
function setup(status, applyStatus = {stage:'completed',message:'完成'}) {
  const {document} = parseHTML(fs.readFileSync('public/index.html','utf8'));
  const calls=[];
  const context={document, calls, console, clearInterval(){}, setInterval(){return 1;},
    escapeHtml:value=>String(value).replaceAll('<','&lt;'),
    Modal:{show(title,body){document.getElementById('modal-title').textContent=title;document.getElementById('modal-body').innerHTML=body;},hide(){}},
    API:{post:async(url,body)=>{calls.push({url,body});if(url.endsWith('check-update'))return status; if(applyStatus instanceof Error)throw applyStatus; return applyStatus;},get:async()=>({error:'NPM_INSTALLING_FAILED'})}};
  vm.createContext(context);
  const source=fs.readFileSync('public/js/app.js','utf8');
  vm.runInContext(source.slice(source.indexOf('const Updates ='),source.indexOf('const ContextMenu ='))+'\nthis.Updates=Updates;',context);
  return context;
}
test('one click checks then applies without confirmation or force',async()=>{
  const ctx=setup({status:'available',is_update_admin:true,install_type:'git'});
  await ctx.Updates.oneClick();
  assert.deepEqual(ctx.calls.map(x=>x.url),['/api/system/check-update','/api/system/apply-update']);
  assert.equal(ctx.calls[1].body.confirm,true);assert.equal(ctx.calls[1].body.force,false);
  assert.equal(ctx.Updates.busy,false);
  assert.equal(ctx.document.getElementById('modal-title').textContent,'更新完成');
});
test('current, blocked and non-admin results never apply',async()=>{
  for(const status of [{status:'current'},{status:'blocked',error:'WORKTREE_DIRTY'}, {status:'available',install_type:'git',is_update_admin:false}]){
    const ctx=setup(status);await ctx.Updates.oneClick();assert.equal(ctx.calls.length,1);assert.equal(ctx.Updates.busy,false);
  }
});
test('pending update prevents duplicate requests and failures unlock the button',async()=>{
  const ctx=setup({status:'available',is_update_admin:true,install_type:'git'},{stage:'installing'});
  await Promise.all([ctx.Updates.oneClick(),ctx.Updates.oneClick()]);
  assert.equal(ctx.calls.length,2);assert.equal(ctx.Updates.busy,true);
  const failed=setup({status:'available',is_update_admin:true,install_type:'git'},new Error('failed'));
  await failed.Updates.oneClick();assert.equal(failed.Updates.busy,false);
  assert.match(failed.document.getElementById('update-progress-error').textContent,/依赖安装失败/);
});
test('代码已更新但服务还没重启：不报“已是最新”，不触发更新，显示重启方式并亮红点', async () => {
  const message = '代码已更新到 2.31.0，但服务仍在运行 2.30.5 的代码，需要重启服务才会生效';
  const ctx = setup({ status: 'restart_pending', message, is_update_admin: true, install_type: 'git' });
  await ctx.Updates.oneClick();
  assert.equal(ctx.calls.length, 1, '只检查，不会去执行更新');
  assert.equal(ctx.document.getElementById('modal-title').textContent, '需要重启服务');
  const shown = ctx.document.querySelector('.update-message').textContent;
  assert.ok(shown.includes(message));
  assert.match(shown, /pm2 restart t-agent/);
  assert.match(shown, /launchctl kickstart/);
  assert.match(shown, /systemctl restart t-agent/);
  assert.doesNotMatch(shown, /已是最新/);
  assert.equal(ctx.document.getElementById('update-dot').style.display, 'block');
  assert.equal(ctx.Updates.busy, false);

  const current = setup({ status: 'current', message: '已是最新版本' });
  await current.Updates.oneClick();
  assert.equal(current.document.getElementById('update-dot').style.display, 'none');
  assert.equal(current.Updates.needsAttention({ status: 'available' }), true);
  assert.equal(current.Updates.needsAttention({ status: 'restart_pending' }), true);
  assert.equal(current.Updates.needsAttention({ status: 'current' }), false);
});
