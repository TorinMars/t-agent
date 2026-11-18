// Copies text to the clipboard: the Clipboard API, else (plain HTTP) a hidden text area and the copy command. True when it worked.
// A module of its own (no React, no Material UI), so the screens that copy a code or a command share it without pulling in each other's chunks.
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* plain HTTP: the old way */ }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}
