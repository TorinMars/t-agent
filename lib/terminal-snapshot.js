const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { randomUUID } = require('crypto');

const HISTORY_LINES = 500;
const PAGE_BYTES = 128 * 1024;

function sgr(attributes) {
  const codes = [0];
  for (const [method, code] of [['isBold', 1], ['isDim', 2], ['isItalic', 3], ['isUnderline', 4], ['isBlink', 5], ['isInverse', 7], ['isInvisible', 8], ['isStrikethrough', 9], ['isOverline', 53]]) {
    if (attributes[method]()) codes.push(code);
  }
  for (const [side, code] of [['Fg', 38], ['Bg', 48]]) {
    const color = attributes[`get${side}Color`]();
    if (attributes[`is${side}RGB`]()) codes.push(code, 2, (color >>> 16) & 255, (color >>> 8) & 255, color & 255);
    else if (attributes[`is${side}Palette`]()) codes.push(code, 5, color);
  }
  return `\x1b[${codes.join(';')}m`;
}

function decCharset(charset) {
  return charset && charset.q === '─' ? '0' : 'B';
}

// One parser per PTY, not per browser reconnect. Operations are serialized so a
// snapshot is an exact boundary between historical and live output.
class TerminalSnapshot {
  constructor(cols = 220, rows = 50) {
    this.terminal = new Terminal({ cols, rows, scrollback: HISTORY_LINES, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.terminal.loadAddon(this.serializer);
    this.pending = Promise.resolve();
    this.disposed = false;
    this.controlState = 'text';
    this.controlPrefix = '';
    this.stringKind = 'osc';
  }
  enqueue(operation) {
    this.pending = this.pending.then(() => this.disposed ? undefined : operation());
    return this.pending;
  }
  write(data, after) {
    return this.enqueue(() => new Promise(resolve => {
      this.trackControlPrefix(data);
      this.terminal.write(data, () => {
        if (!this.disposed && after) after();
        resolve();
      });
    }));
  }
  trackControlPrefix(data) {
    for (const ch of data) {
      const code = ch.codePointAt(0);
      if (code === 24 || code === 26) { this.controlState = 'text'; this.controlPrefix = ''; continue; }
      if (this.controlState === 'string') {
        if ((code === 7 && this.stringKind === 'osc') || code === 0x9c) this.controlState = 'text';
        else if (code === 27) this.controlState = 'stringEscape';
        continue;
      }
      if (this.controlState === 'stringEscape') {
        this.controlState = ch === '\\' ? 'text' : code === 27 ? 'stringEscape' : 'string';
        continue;
      }
      if (code === 27) { this.controlState = 'escape'; this.controlPrefix = ch; continue; }
      if (code === 0x9b) { this.controlState = 'csi'; this.controlPrefix = '\x1b['; continue; }
      if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) { this.controlState = 'string'; this.stringKind = code === 0x9d ? 'osc' : 'dcs'; continue; }
      if (this.controlState === 'escape') {
        this.controlPrefix += ch;
        if (ch === '[') this.controlState = 'csi';
        else if (']PX^_'.includes(ch)) { this.controlState = 'string'; this.stringKind = ch === ']' ? 'osc' : 'dcs'; }
        else if (code >= 0x30 && code <= 0x7e) this.controlState = 'text';
      } else if (this.controlState === 'csi') {
        this.controlPrefix += ch;
        if (code >= 0x40 && code <= 0x7e) this.controlState = 'text';
      }
      // Bound pathological unfinished controls independently of retained logs.
      if (this.controlPrefix.length > 4096) this.controlPrefix = '\x1b[';
    }
  }
  pendingControl() {
    // Resume an unfinished control without replaying an OSC 52 payload. An
    // unhandled OSC/DCS consumes the remainder without side effects.
    const ignoredString = this.stringKind === 'osc' ? '\x1b]777;' : '\x1bP999q';
    if (this.controlState === 'string') return ignoredString;
    if (this.controlState === 'stringEscape') return ignoredString + '\x1b';
    return this.controlState === 'text' ? '' : this.controlPrefix;
  }
  resize(cols, rows) { return this.enqueue(() => this.terminal.resize(cols, rows)); }
  snapshot(after) {
    return this.enqueue(() => after({
      data: this.serialize(),
      cols: this.terminal.cols,
      rows: this.terminal.rows,
    }));
  }
  bufferState(buffer, publicBuffer, origin = false) {
    const core = this.terminal._core;
    let data = `\x1b[?6l\x1b[${buffer.scrollTop + 1};${buffer.scrollBottom + 1}r`;
    const savedRow = Math.max(0, Math.min(this.terminal.rows - 1, buffer.savedY - buffer.ybase));
    const savedCol = Math.min(this.terminal.cols - 1, buffer.savedX);
    data += `\x1b[${savedRow + 1};${savedCol + 1}H` + sgr(buffer.savedCurAttrData) + `\x0f\x1b(${decCharset(buffer.savedCharset)}\x1b7\x1b(B`;
    if (origin) data += '\x1b[?6h';
    const row = buffer.y - (origin ? buffer.scrollTop : 0);
    data += `\x1b[${row + 1};${Math.min(buffer.x + 1, this.terminal.cols)}H`;
    if (buffer.x === this.terminal.cols) {
      // CUP clamps to the last cell and clears pending wrap. Reprinting the
      // existing last glyph re-arms wrap without changing its cells/style.
      const line = publicBuffer.getLine(publicBuffer.baseY + buffer.y);
      let column = this.terminal.cols - 1;
      let cell = line.getCell(column);
      if (cell.getWidth() === 0 && column > 0) cell = line.getCell(--column);
      data += `\x1b[${row + 1};${column + 1}H` + sgr(cell) + (cell.getChars() || ' ');
    }
    return data + sgr(core._inputHandler._curAttrData);
  }
  serialize() {
    let data = this.serializer.serialize({ scrollback: HISTORY_LINES });
    // The official 0.13 serializer omits these TUI properties. These accesses
    // are intentionally tied to the exact 5.5.0 dependency and replay tests.
    const core = this.terminal._core;
    const buffers = core._bufferService.buffers;
    const altMarker = '\x1b[?1049h\x1b[H';
    const altStart = data.indexOf(altMarker);
    if (altStart !== -1) {
      // Mode 47 enters the alternate screen without overwriting the restored
      // normal saved cursor (1049 would save it a second time).
      data = data.slice(0, altStart) + this.bufferState(buffers.normal, this.terminal.buffer.normal)
        + '\x1b[?47h\x1b[H\x1b[0m' + data.slice(altStart + altMarker.length);
    }
    data += this.bufferState(core._bufferService.buffer, this.terminal.buffer.active, this.terminal.modes.originMode);
    data += core.coreService.isCursorHidden ? '\x1b[?25l' : '\x1b[?25h';
    if (core.coreMouseService.activeEncoding === 'SGR') data += '\x1b[?1006h';
    if (core.coreMouseService.activeEncoding === 'SGR_PIXELS') data += '\x1b[?1016h';
    const charset = core._charsetService;
    // Keep DEC line drawing (including G1/SO used by curses) and its saved
    // rendition separate from Unicode glyphs emitted by the serializer.
    for (let level = 0; level < 4; level++) {
      data += `\x1b${'()*+'[level]}${decCharset(charset._charsets[level])}`;
    }
    data += ['\x0f', '\x0e', '\x1bn', '\x1bo'][charset.glevel];
    data += `\x1b${'()*+'[charset.glevel]}${decCharset(charset.charset)}`;
    return data + this.pendingControl();
  }
  dispose() {
    // Let an outstanding write callback finish before disposing its parser.
    return this.enqueue(() => { this.disposed = true; this.terminal.dispose(); });
  }
}

// Parse the entire immutable archive once, before slicing pages. This prevents
// split OSC/DCS/CSI sequences from leaking controls (including OSC 52) to clients.
// Keep raw newline boundaries even inside discarded sequences for page limits.
function archiveText(raw) {
  let state = 'text';
  const output = [];
  let chunk = '';
  const append = ch => {
    chunk += ch;
    if (chunk.length >= 8192) { output.push(chunk); chunk = ''; }
  };
  for (const ch of raw) {
    const code = ch.codePointAt(0);
    if (ch === '\n') append(ch);
    if (state === 'string') {
      if (code === 7 || code === 0x9c) state = 'text';
      else if (code === 27) state = 'stringEscape';
      continue;
    }
    if (state === 'stringEscape') {
      state = ch === '\\' ? 'text' : 'string';
      continue;
    }
    if (state === 'csi') {
      if (code >= 0x40 && code <= 0x7e) state = 'text';
      else if (code === 27) state = 'escape';
      continue;
    }
    if (state === 'escape') {
      if (ch === '[') state = 'csi';
      else if (']PX^_'.includes(ch)) state = 'string';
      else if (code >= 0x30 && code <= 0x7e) state = 'text';
      continue;
    }
    if (code === 27) state = 'escape';
    else if (code === 0x9b) state = 'csi';
    else if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) state = 'string';
    else if (ch === '\t' || (code >= 32 && !(code >= 0x7f && code <= 0x9f))) append(ch);
  }
  return output.join('') + chunk;
}

function createHistoryArchive(raw) {
  let text = null;
  const id = randomUUID();
  const initialBefore = raw.length;
  const cursors = new Set([initialBefore]);
  let windowStart = 0;
  let requests = 0;
  return {
    metadata() { return { id, before: initialBefore, hasMore: initialBefore > 0, limit: HISTORY_LINES }; },
    page(request) {
      const requestId = typeof request.requestId === 'string' && request.requestId.length <= 100
        ? request.requestId : null;
      let before = request.before;
      const now = Date.now();
      if (now - windowStart >= 1000) { windowStart = now; requests = 0; }
      if (++requests > 32) return { type: 'history-page', id, before, hasMore: before > 0, data: '', requestId, error: 'HISTORY_RATE_LIMIT' };
      if (request.id !== id || !cursors.has(before) || !Number.isInteger(before) || !requestId || before === 0) {
        return { type: 'history-page', id, before, hasMore: before > 0, data: '', requestId, error: 'INVALID_HISTORY_REQUEST' };
      }
      if (text === null) {
        text = archiveText(raw);
        raw = '';
      }
      if (before === initialBefore) before = text.length;
      let start = before;
      let bytes = 0;
      let lines = 0;
      while (start > 0) {
        let size = 1;
        const last = text.charCodeAt(start - 1);
        if (last >= 0xdc00 && last <= 0xdfff && start > 1) {
          const first = text.charCodeAt(start - 2);
          if (first >= 0xd800 && first <= 0xdbff) size = 2;
        }
        const ch = text.slice(start - size, start);
        const nextBytes = Buffer.byteLength(ch);
        if (bytes + nextBytes > PAGE_BYTES) break;
        if (ch === '\n' && start !== before && ++lines >= HISTORY_LINES) break;
        start -= size;
        bytes += nextBytes;
      }
      const data = text.slice(start, before);
      before = start;
      cursors.add(before);
      return { type: 'history-page', id, before, hasMore: before > 0, data, requestId };
    },
  };
}

module.exports = { TerminalSnapshot, createHistoryArchive, archiveText, HISTORY_LINES, PAGE_BYTES };
