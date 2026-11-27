// Pictures of a recording (frames.js and background.js; "Pictures of a recording" in docs/design/browser-extension.md). Part one runs the
// worker against a mocked Chrome: the options and their checks, a picture after an agent action and after a person's click, the masks painted
// over the secret parts, the limit, the pictures still waiting at the stop, and every case where the picture is skipped instead of sent
// unmasked. Part two runs sensitiveRects, maskPlan and encodeFrame in a real headless Chromium page (CHROME_PATH, else Playwright's own
// browser; skipped when neither can start) and checks the pixels: a password field, a secret-named field and a token in the text come out
// black, an ordinary field does not.
const {
  test
} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tick = () => new Promise(r => setImmediate(r));
const sleep = ms => new Promise(r => setTimeout(r, ms));
function signal() {
  const listeners = [];
  return {
    addListener: f => listeners.push(f),
    removeListener: f => listeners.splice(listeners.indexOf(f), 1),
    fire: (...args) => listeners.forEach(f => f(...args)),
    listeners
  };
}
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
test('pictures of a recording in the worker (mocked Chrome)', {
  timeout: 30000
}, async t => {
  const session = {
      handed: [11],
      owned: []
    },
    local = {
      token: 'tab_fixture',
      server_url: 'http://127.0.0.1:3000',
      name: 'Fixture'
    };
  const tabs = new Map([[11, {
    id: 11,
    url: 'http://localhost/login',
    title: 'Login',
    groupId: -1,
    windowId: 1,
    active: true,
    status: 'complete'
  }]]);
  const onEvent = signal(),
    onDetach = signal();
  // What the page answers to sensitiveRects (per call), and what the canvas painted.
  let rectAnswer = () => [{
    frameId: 0,
    result: {
      top: true,
      w: 1280,
      h: 800,
      rects: [{
        x: 10,
        y: 20,
        w: 100,
        h: 30
      }],
      complete: true,
      frame_count: 0,
      frames: []
    }
  }];
  const painted = [],
    shots = [];
  global.chrome = {
    storage: {
      session: {
        get: async () => session,
        set: async v => Object.assign(session, v)
      },
      local: {
        get: async () => local
      },
      onChanged: signal()
    },
    runtime: {
      id: 'fixture-extension',
      getManifest: () => require('../manifest.json'),
      onMessage: signal()
    },
    alarms: {
      create: () => {},
      onAlarm: signal()
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {}
    },
    windows: {
      update: async () => {},
      get: async id => ({
        id,
        focused: false
      })
    },
    tabs: {
      onRemoved: signal(),
      onUpdated: signal(),
      onActivated: signal(),
      onCreated: signal(),
      query: async () => [...tabs.values()],
      get: async id => {
        if (!tabs.has(id)) throw Error('missing');
        return tabs.get(id);
      },
      update: async (id, p) => Object.assign(tabs.get(id), p)
    },
    tabGroups: {
      get: async () => ({
        id: 5,
        title: 'T-Agent'
      }),
      query: async () => [],
      update: async () => {},
      onUpdated: signal()
    },
    scripting: {
      executeScript: async p => {
        if (p.func.name === 'sensitiveRects') {
          assert.equal(p.target.allFrames, true, 'every frame of the tab is searched');
          return rectAnswer();
        }
        if (p.func.name === 'pageAction') return [{
          result: {
            ok: true,
            result: {
              ref: 'e1',
              tag: 'button',
              name: 'Sign in',
              rect: {
                x: 10,
                y: 20,
                w: 100,
                h: 30
              }
            }
          }
        }];
        return [{
          result: undefined
        }];
      }
    },
    debugger: {
      onEvent,
      onDetach,
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (source, method) => {
        if (method === 'Page.captureScreenshot') {
          shots.push(source.tabId);
          return {
            data: Buffer.from(JPEG).toString('base64')
          };
        }
        return {};
      }
    }
  };
  // The worker's canvas: the picture is drawn and the masks painted (recorded here).
  const canvas = {
    OffscreenCanvas: global.OffscreenCanvas,
    createImageBitmap: global.createImageBitmap
  };
  const withCanvas = () => {
    global.createImageBitmap = async blob => {
      assert.equal(blob.type, 'image/jpeg');
      return {
        width: 1280,
        height: 800,
        close() {}
      };
    };
    global.OffscreenCanvas = class {
      constructor(width, height) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return {
          drawImage: (...a) => painted.push(['draw', ...a.slice(1)]),
          fillRect: (...a) => painted.push(['mask', ...a]),
          set fillStyle(v) {
            painted.push(['color', v]);
          }
        };
      }
      async convertToBlob(o) {
        painted.push(['encode', o.type, o.quality]);
        return new Blob([JPEG], {
          type: 'image/jpeg'
        });
      }
    };
  };
  withCanvas();
  class Socket {
    static OPEN = 1;
    constructor() {
      this.readyState = 0;
      this.messages = [];
      Socket.latest = this;
    }
    send(s) {
      this.messages.push(JSON.parse(s));
    }
    close() {
      this.readyState = 3;
    }
    open() {
      this.readyState = 1;
      this.onopen();
    }
  }
  const previousSocket = global.WebSocket;
  global.WebSocket = Socket;
  const realInterval = global.setInterval,
    realClear = global.clearInterval;
  global.setInterval = () => ({});
  global.clearInterval = () => {};
  t.after(() => {
    global.WebSocket = previousSocket;
    global.setInterval = realInterval;
    global.clearInterval = realClear;
    global.OffscreenCanvas = canvas.OffscreenCanvas;
    global.createImageBitmap = canvas.createImageBitmap;
    delete global.chrome;
  });
  const {
    dispatch,
    features
  } = await import('../background.js');
  await tick();
  const socket = Socket.latest;
  socket.open();
  const runtime = async (m, tab) => new Promise(resolve => chrome.runtime.onMessage.listeners[0](m, {
    id: chrome.runtime.id,
    tab
  }, resolve));
  const itemsOf = id => socket.messages.filter(m => m.event === 'record.items' && m.data.recording_id === id).flatMap(m => m.data.items);
  await t.test('the feature, and the options checked', async () => {
    assert(features.includes('record.frames'));
    assert(socket.messages[0].features.includes('record.frames'), 'the hello lists it');
    await assert.rejects(dispatch('record.start', {
      tab_id: 11,
      frames: 'yes'
    }), /BAD_PARAMS: frames must be true or false/);
    await assert.rejects(dispatch('record.start', {
      tab_id: 11,
      max_frames: 5
    }), /max_frames needs frames/);
    await assert.rejects(dispatch('record.start', {
      tab_id: 11,
      frames: true,
      max_frames: 501
    }), /from 1 to 500/);
    const plain = await dispatch('record.start', {
      tab_id: 11
    });
    assert.equal(plain.options.frames, undefined, 'no pictures unless asked');
    await dispatch('input.click', {
      tab_id: 11,
      target: {
        ref: 'e1'
      }
    });
    await sleep(600);
    await dispatch('record.stop', {
      recording_id: plain.recording_id
    });
    assert.equal(itemsOf(plain.recording_id).filter(i => i.kind === 'frame').length, 0);
    assert.equal(shots.length, 0);
  });
  await t.test('a masked picture after an agent action and after a click of the person; the limit; the stop takes the waiting one', async () => {
    const r = await dispatch('record.start', {
      tab_id: 11,
      frames: true,
      max_frames: 2
    });
    assert.deepEqual([r.options.frames, r.options.max_frames], [true, 2]);
    await dispatch('input.click', {
      tab_id: 11,
      target: {
        ref: 'e1'
      }
    });
    await sleep(700);
    assert.equal(shots.length, 1, 'one picture after the agent click');
    const mask = painted.filter(p => p[0] === 'mask');
    // 1280 px wide -> 640: half size; the field at 10,20 100x30 with 4 px around it.
    assert.deepEqual(mask, [['mask', 3, 8, 54, 19]]);
    assert(painted.some(p => p[0] === 'color' && p[1] === '#000'));
    assert.deepEqual(painted.find(p => p[0] === 'encode'), ['encode', 'image/jpeg', 0.5]);
    assert.deepEqual(painted.find(p => p[0] === 'draw').slice(1), [0, 0, 640, 400], 'scaled to at most 640 wide');
    // The person clicks (the page recorder's item), then the agent acts once more and goes past the limit of 2.
    await runtime({
      type: 'record.item',
      recording_id: r.recording_id,
      item: {
        at: Date.now(),
        kind: 'click',
        source: 'user',
        url: 'http://localhost/login',
        target: {
          tag: 'a',
          name: 'Help'
        }
      }
    }, tabs.get(11));
    await sleep(700);
    await dispatch('input.scroll', {
      tab_id: 11,
      dy: 300
    });
    await sleep(700);
    await dispatch('input.press', {
      tab_id: 11,
      key: 'Enter'
    });
    await dispatch('record.stop', {
      recording_id: r.recording_id
    });
    const items = itemsOf(r.recording_id);
    const frames = items.filter(i => i.kind === 'frame');
    const click = items.find(i => i.kind === 'click' && i.source === 'agent');
    const user = items.find(i => i.kind === 'click' && i.source === 'user');
    assert.equal(frames[0].for_seq, click.seq, 'the first picture follows the agent click');
    assert.equal(frames[1].for_seq, user.seq, 'the second follows the person');
    assert.deepEqual([frames[0].mime, frames[0].width, frames[0].height, frames[0].masked], ['image/jpeg', 640, 400, 1]);
    assert.equal(Buffer.from(frames[0].data_base64, 'base64')[0], 0xff, 'the JPEG goes to T-Agent in data_base64');
    assert.equal(frames[2].skipped, 'limit', 'past max_frames: one note, no picture');
    assert.equal(frames[2].data_base64, undefined);
    assert.equal(frames.length, 3, 'the limit is noted once');
    assert(frames.every(f => f.tab === 11));
  });
  await t.test('the stop takes a picture that is still waiting', async () => {
    const r = await dispatch('record.start', {
      tab_id: 11,
      frames: true
    });
    await dispatch('input.click', {
      tab_id: 11,
      target: {
        ref: 'e1'
      }
    });
    await dispatch('record.stop', {
      recording_id: r.recording_id
    });
    const frames = itemsOf(r.recording_id).filter(i => i.kind === 'frame');
    assert.equal(frames.length, 1);
    assert(frames[0].data_base64);
  });
  const skippedWith = async change => {
    const undo = change();
    try {
      const r = await dispatch('record.start', {
        tab_id: 11,
        frames: true
      });
      const before = shots.length;
      await dispatch('input.click', {
        tab_id: 11,
        target: {
          ref: 'e1'
        }
      });
      await sleep(700);
      await dispatch('record.stop', {
        recording_id: r.recording_id
      });
      const frames = itemsOf(r.recording_id).filter(i => i.kind === 'frame');
      assert.equal(frames.length, 1);
      assert.equal(frames[0].data_base64, undefined, 'never an unmasked picture');
      return {
        reason: frames[0].skipped,
        shot: shots.length > before
      };
    } finally {
      undo?.();
    }
  };
  await t.test('skipped, never unmasked: the parts cannot be searched, the page is too large, no canvas', async () => {
    const real = rectAnswer;
    const failing = await skippedWith(() => {
      rectAnswer = () => {
        throw Error('Cannot access contents of the page');
      };
      return () => {
        rectAnswer = real;
      };
    });
    assert.deepEqual(failing, {
      reason: 'mask',
      shot: false
    }, 'no capture when the secret parts cannot be found');
    const large = await skippedWith(() => {
      rectAnswer = () => [{
        frameId: 0,
        result: {
          ...real()[0].result,
          complete: false
        }
      }];
      return () => {
        rectAnswer = real;
      };
    });
    assert.equal(large.reason, 'mask');
    const noTop = await skippedWith(() => {
      rectAnswer = () => [{
        frameId: 3,
        result: real()[0].result
      }];
      return () => {
        rectAnswer = real;
      };
    });
    assert.equal(noTop.reason, 'mask', 'no answer from the top frame');
    const noCanvas = await skippedWith(() => {
      delete global.OffscreenCanvas;
      return withCanvas;
    });
    assert.equal(noCanvas.reason, 'mask');
    const timeout = await skippedWith(() => {
      const send = chrome.debugger.sendCommand;
      chrome.debugger.sendCommand = async (source, method, p) => method === 'Page.captureScreenshot' ? Promise.reject(Error('Unable to capture')) : send(source, method, p);
      return () => {
        chrome.debugger.sendCommand = send;
      };
    });
    assert.equal(timeout.reason, 'error');
  });
  await t.test('a frame with a secret part, or one that did not answer: every frame of the page is painted over', async () => {
    const real = rectAnswer;
    const top = {
      ...real()[0].result,
      rects: [],
      frame_count: 2,
      frames: [{
        x: 0,
        y: 400,
        w: 200,
        h: 100
      }, {
        x: 600,
        y: 0,
        w: 40,
        h: 40
      }]
    };
    const run = async answer => {
      rectAnswer = answer;
      painted.length = 0;
      try {
        const r = await dispatch('record.start', {
          tab_id: 11,
          frames: true
        });
        await dispatch('input.click', {
          tab_id: 11,
          target: {
            ref: 'e1'
          }
        });
        await sleep(700);
        await dispatch('record.stop', {
          recording_id: r.recording_id
        });
        return painted.filter(p => p[0] === 'mask').length;
      } finally {
        rectAnswer = real;
      }
    };
    const clean = {
      complete: true,
      rects: []
    };
    assert.equal(await run(() => [{
      frameId: 0,
      result: top
    }, {
      frameId: 4,
      result: clean
    }, {
      frameId: 5,
      result: clean
    }]), 0, 'frames without secret parts stay as they are');
    // The two frames (the same in the lookups before and after the capture).
    assert.equal(await run(() => [{
      frameId: 0,
      result: top
    }, {
      frameId: 4,
      result: {
        complete: true,
        rects: [{
          x: 1,
          y: 1,
          w: 5,
          h: 5
        }]
      }
    }, {
      frameId: 5,
      result: clean
    }]), 2, 'a password field inside a frame');
    assert.equal(await run(() => [{
      frameId: 0,
      result: top
    }, {
      frameId: 4,
      result: clean
    }]), 2, 'a frame that did not answer');
  });
});

// Part two: the real page functions in headless Chromium.
const pageSource = () => fs.readFileSync(path.join(__dirname, '..', 'frames.js'), 'utf8').replace(/^export /gm, '');
test('masking in a real page: secret parts come out black, the rest does not', {
  timeout: 60000
}, async t => {
  let chromium;
  try {
    ({
      chromium
    } = require('playwright'));
  } catch {
    t.skip('playwright is not installed');
    return;
  }
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROME_PATH ? {
        executablePath: process.env.CHROME_PATH
      } : {})
    });
  } catch (error) {
    t.skip(`no Chromium to run (set CHROME_PATH): ${String(error.message).split('\n')[0]}`);
    return;
  }
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: {
      width: 800,
      height: 600
    }
  });
  const field = 'position:absolute;left:{x}px;top:{y}px;width:200px;height:40px;border:0;background:#fff;font-size:20px';
  const at = (x, y) => field.replace('{x}', x).replace('{y}', y);
  await page.setContent(`<!doctype html><body style="margin:0;background:#ff0">
    <input id="pw" type="password" value="hunter2" style="${at(20, 20)}">
    <input id="api" name="api_key" value="abc123" style="${at(20, 100)}">
    <input id="q" name="q" value="shoes" style="${at(20, 180)}">
    <p id="tok" style="position:absolute;left:20px;top:260px;margin:0;font-size:20px;background:#fff">eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl</p>
    <input id="off" type="password" style="${at(20, 2000)}">
    <iframe id="frame" style="position:absolute;left:400px;top:20px;width:300px;height:200px;border:0" srcdoc="<input type=password style='width:100px'>"></iframe>
  </body>`);
  await page.addScriptTag({
    content: `${pageSource()}\nwindow.__frames = { sensitiveRects, maskPlan, encodeFrame, FRAME };`
  });
  const top = await page.evaluate(() => __frames.sensitiveRects());
  assert.equal(top.top, true);
  assert.equal(top.complete, true);
  assert.equal(top.rects.length, 3, 'the password, the api_key field and the token text; not the field below the fold');
  assert.equal(top.frame_count, 1);
  const inner = await page.frames()[1].evaluate(`(${pageSource().match(/function sensitiveRects\(\) \{[\s\S]*?\n\}\n/)[0]})()`);
  assert.equal(inner.rects.length, 1, 'the password field inside the frame');
  const plan = await page.evaluate(([a, b]) => __frames.maskPlan([{
    frameId: 0,
    result: a
  }, {
    frameId: 7,
    result: b
  }]), [top, inner]);
  assert.equal(plan.rects.length, 4, 'the frame is painted over too');
  const shot = (await page.screenshot({
    type: 'jpeg',
    quality: 90
  })).toString('base64');
  const colours = await page.evaluate(async ([shot, plan]) => {
    const picture = await __frames.encodeFrame(shot, plan.w, plan.h, plan.rects);
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(picture.data_base64), c => c.charCodeAt(0))], {
      type: 'image/jpeg'
    }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const scale = bitmap.width / plan.w;
    const pixel = (x, y) => [...ctx.getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1).data].slice(0, 3);
    return {
      width: picture.width,
      height: picture.height,
      password: pixel(120, 40),
      apiKey: pixel(120, 120),
      token: pixel(60, 270),
      frame: pixel(550, 120),
      search: pixel(180, 200),
      page: pixel(600, 500)
    };
  }, [shot, plan]);
  assert.deepEqual([colours.width, colours.height], [640, 480], 'at most 640 pixels wide');
  const dark = rgb => rgb.every(v => v < 40);
  for (const part of ['password', 'apiKey', 'token', 'frame']) assert(dark(colours[part]), `${part} is painted over: ${colours[part]}`);
  assert(!dark(colours.search), `an ordinary field stays: ${colours.search}`);
  assert(!dark(colours.page), `the page stays: ${colours.page}`);
});
