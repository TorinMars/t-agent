// The script of pages/record.html (served as /rec.js): a request on load, a live region, a toast with secrets, a dialog and many nodes.
fetch('/xhr?first=1').then(r => r.json()).then(v => { window.first = v; });
document.querySelector('#refresh').addEventListener('click', () => { document.querySelector('#log').textContent = 'List refreshed'; });
document.querySelector('#save').addEventListener('click', () => {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.setAttribute('role', 'alert');
  toast.textContent = 'Saved with key eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl and Bearer abcdefgh12345678';
  document.body.appendChild(toast);
  document.querySelector('#dlg').show();
});
document.querySelector('#many').addEventListener('click', () => {
  const box = document.querySelector('#more');
  for (let i = 1; i <= 5; i++) {
    const h = document.createElement('h3');
    h.textContent = `Section ${i} ${'long words '.repeat(30)}`;
    box.appendChild(h);
  }
  for (let i = 1; i <= 30; i++) {
    const b = document.createElement('button');
    b.textContent = `Item ${i}`;
    box.appendChild(b);
  }
});
