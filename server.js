require('dotenv').config();
const express = require('express');
const compression = require('compression');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const WebSocket = require('ws');
const config = require('./config');
const db = require('./db');
const SqliteStore = require('./db/session-store');
const terminal = require('./routes/terminal');
const updates = require('./services/update-manager');
const { consumeTerminalTicket, pruneExpiredTickets } = require('./services/terminal-tickets');
const { handleRemoteTerminalUpgrade } = require('./services/remote-terminal-proxy');
const { ensureSingleUser } = require('./services/single-user');
const { getClientAuth, safeReturnTo, isSecureClientCookie, SESSION_TTL } = require('./services/client-auth');
const requireAuth = require('./middleware/auth');
const clientOrigin = require('./middleware/client-origin');
const { frameAncestors, clientCookieSameSite } = require('./lib/client-embedding');
const { createLoginGate, createUnknownPageRedirect } = require('./lib/login-gate');
const { createAccessGate, upgradeAllowed } = require('./lib/access-gate');

const app = express();

// When BT Panel/Nginx forwards to this service after terminating HTTPS, it passes the original protocol
// in X-Forwarded-Proto. Trust one proxy hop so that secure session cookies
// are written correctly when the site is accessed through an HTTPS domain.
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set('Content-Security-Policy', frameAncestors(config.clientFrameOrigins));
  next();
});

function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

// Agent hooks inside a terminal report activity here; authenticated by the
// per-terminal token in the PTY environment, so it sits outside the session/API auth.
app.post('/hooks/terminal-activity', (req, res) => {
  const status = terminal.reportHook(Number(req.query.task), req.query.terminal, req.get('x-ta-token'), String(req.query.event || ''));
  res.status(status).end();
});

app.use(express.json({ limit: '32mb' }));
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
  name: config.clientSessionCookieName,
  store: new SqliteStore(db),
  secret: config.sessionSecret,
  resave: false,
  rolling: true,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL,
  },
});

app.use(sessionMiddleware);
app.use((req, res, next) => {
  // Local enrollment also works in production over direct loopback HTTP.
  // Remote HTTP requires an explicit opt-in; HTTPS always keeps Secure cookies.
  req.session.cookie.secure = isSecureClientCookie(req);
  req.session.cookie.sameSite = clientCookieSameSite(req, config.clientFrameOrigins);
  getClientAuth().renew(req.session);
  next();
});
// In local-only / mode-not-chosen state, non-local requests always get 404; in local-only mode sessions from this machine are trusted automatically.
app.use(createAccessGate({ getMode: () => getClientAuth().accessMode() }));
// When logged out only the login entrance and machine endpoints are open; everything else returns 404.
app.use(createLoginGate({ loginPath: config.loginPath, isAuthenticated: session => getClientAuth().authenticated(session) }));

// Only browser-facing APIs require the Client session; the legacy /api/remote/v1
// and standard /v1 Engine APIs retain independent Bearer-token authentication.
app.use('/api', (req, res, next) => {
  if (req.path === '/remote/v1' || req.path.startsWith('/remote/v1/')) return next();
  clientOrigin(req, res, () => requireAuth(req, res, next));
});

app.get('/api/local-ip', (req, res) => {
  res.json({ ip: getLocalIP(), port: config.port });
});

const authRouter = require('./routes/auth');
app.use('/auth', authRouter);
app.use(config.loginPath, authRouter);
app.use('/api/tasks/:id/agent', require('./routes/agent-chat').createAgentChatRouter());
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/task-groups', require('./routes/task-groups'));
app.use('/api/bookmarks', require('./routes/bookmarks'));
app.use('/api/system', require('./routes/system'));
app.use('/api/oss', require('./routes/oss').createOssRouter());
app.use('/api/environment', require('./routes/environment').createEnvironmentRouter());
app.use('/api/translate', require('./routes/translate').createTranslateRouter());
app.use('/api/pm2', require('./routes/pm2').createPm2Router());
app.use('/api/apps', require('./routes/apps').createAppsRouter());
const frpRouter = require('./routes/frp').createFrpRouter();
app.use('/api/frp', frpRouter);
const sshTunnelRouter = require('./routes/ssh-tunnel').createSshTunnelRouter();
app.use('/api/ssh-tunnel', sshTunnelRouter);
app.use('/api/agent-config', require('./routes/agent-config').createClientRouter({ db: require('./db'), sessionSecret: require('./config').sessionSecret }));
app.use('/api/file-sync', require('./routes/file-sync').browser);
app.use('/api/remote-servers', require('./routes/remote-servers'));
app.use('/api/remote-tokens', require('./routes/remote-tokens'));
app.use('/api/remote/v1', require('./routes/remote-api'));
// Standard Engine API. The Client package bundles it by default and exposes the same protocol as a standalone Engine.
app.use('/v1', require('./routes/engine-v1'));

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toSafeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function getSharedTask(token) {
  return require('./services/task-documents').resolveTask(db.prepare('SELECT * FROM tasks WHERE share_token = ?').get(token));
}

// Resolve a shared document relative to the task's root Markdown directory.
// This keeps a share link from exposing files outside that directory.
function readSharedMarkdown(task, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath) return null;
  const normalized = path.posix.normalize(relativePath);
  if (normalized === '.' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) return null;

  const rootDir = path.resolve(path.dirname(task.md_path));
  const filePath = path.resolve(rootDir, ...normalized.split('/'));
  if (!filePath.startsWith(rootDir + path.sep) || !filePath.endsWith('.md')) return null;

  try {
    return { content: fs.readFileSync(filePath, 'utf8'), relativePath: normalized };
  } catch (e) {
    return null;
  }
}

function sendSharedMarkdown(res, task, token, content, currentPath = '') {
  const escaped = toSafeJson(content);
  const safeTitle = escapeHtml(task.title);
  res.type('html').send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${safeTitle}</title>
  <script src="/vendor/marked/marked-15.0.12.min.js"></script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#fff;color:#1f2328;line-height:1.7;height:100vh;display:flex;flex-direction:column;overflow:hidden}
    .header{padding:12px 24px;border-bottom:1px solid #e8ecf0;display:flex;align-items:center;gap:12px;flex-shrink:0}
    .header h1{font-size:16px;font-weight:600}
    .badge{font-size:11px;padding:2px 8px;border-radius:10px;background:#f6f8fa;border:1px solid #e8ecf0;color:#656d76}
    .layout{display:flex;flex:1;overflow:hidden}
    .preview{flex:1;overflow-y:auto;padding:32px 40px 60px}
    .toc{width:220px;flex-shrink:0;border-left:1px solid #e8ecf0;overflow-y:auto;padding:16px 0;background:#fafbfc}
    .toc-title{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:#656d76;padding:0 14px 10px;border-bottom:1px solid #e8ecf0;margin-bottom:8px}
    .toc-item{display:block;padding:4px 14px;font-size:12px;color:#656d76;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-left:2px solid transparent;transition:color .1s,border-color .1s,background .1s;line-height:1.4}
    .toc-item:hover{color:#1f2328;background:#f0f2f4}
    .toc-item.active{color:#0969da;border-left-color:#0969da;background:rgba(9,105,218,.05)}
    .toc-item[data-level="1"]{padding-left:14px;font-weight:600}
    .toc-item[data-level="2"]{padding-left:22px}
    .toc-item[data-level="3"]{padding-left:30px}
    .toc-item[data-level="4"]{padding-left:38px}
    h1,h2,h3,h4{color:#1f2328;margin:1.2em 0 .5em;line-height:1.3;scroll-margin-top:12px}
    h1{font-size:22px;border-bottom:1px solid #e8ecf0;padding-bottom:8px}
    h2{font-size:18px;border-bottom:1px solid #f0f2f4;padding-bottom:5px}
    h3{font-size:16px} h4{font-size:14px}
    p{margin:.5em 0} a{color:#0969da;text-decoration:none} a:hover{text-decoration:underline}
    code{background:#f6f8fa;border:1px solid #e8ecf0;border-radius:4px;padding:1px 5px;font-size:13px;font-family:monospace}
    pre{background:#f6f8fa;border:1px solid #e8ecf0;border-radius:6px;padding:14px;overflow-x:auto;margin:8px 0}
    pre code{background:none;border:none;padding:0}
    ul,ol{padding-left:22px;margin:.5em 0}
    blockquote{border-left:3px solid #e8ecf0;padding-left:14px;color:#656d76;margin:.5em 0}
    table{border-collapse:collapse;width:100%;margin:.5em 0}
    th,td{border:1px solid #e8ecf0;padding:6px 12px}
    th{background:#f6f8fa} img{max-width:100%}
    ::-webkit-scrollbar{width:5px} ::-webkit-scrollbar-thumb{background:#e0e0e0;border-radius:3px}
  </style>
  <link rel="stylesheet" href="/css/markdown.css">
  <script src="/js/markdown-view.js"></script>
  <script src="/js/i18n.js"></script>
  <script src="/js/i18n-zh-server.js"></script>
</head>
<body>
  <div class="header">
    <h1>${safeTitle}</h1>
    <span class="badge">Read-only share</span>
  </div>
  <div class="layout">
    <div class="preview" id="preview"></div>
    <div class="toc" id="toc" style="display:none">
      <div class="toc-title">Directory</div>
      <div id="toc-list"></div>
    </div>
  </div>
  <script>
    // mermaid is about 5 MB and is only loaded when the page contains diagrams.
    function ensureMermaid(){
      if (window.mermaid) return Promise.resolve();
      return new Promise(function(resolve,reject){
        var script=document.createElement('script');
        script.src='/vendor/mermaid/mermaid-12.1.0.min.js';
        script.onload=resolve; script.onerror=reject;
        document.head.appendChild(script);
      });
    }
    var shareToken = ${toSafeJson(token)};
    var currentPath = ${toSafeJson(currentPath)};
    function resolveRelativePath(href) {
      var base = currentPath ? currentPath.slice(0, currentPath.lastIndexOf('/') + 1) : '';
      var parts = (base + href).split('/');
      var resolved = [];
      for (var i = 0; i < parts.length; i++) {
        if (!parts[i] || parts[i] === '.') continue;
        if (parts[i] === '..') { resolved.pop(); continue; }
        resolved.push(parts[i]);
      }
      return resolved.join('/');
    }
    marked.use({renderer:{
      code({text,lang}){if(lang==='mermaid')return '<div class="mermaid">'+text+'</div>';return false;},
      link({href,title,text}){
        var t=title?' title="'+title+'"':'';
        var hashIndex=href.indexOf('#');
        var pathPart=hashIndex>=0?href.slice(0,hashIndex):href;
        var hash=hashIndex>=0?href.slice(hashIndex):'';
        if (!/^(?:[a-z][a-z0-9+.-]*:|\\/|#)/i.test(href) && /\\.md$/i.test(pathPart)) {
          var target=resolveRelativePath(pathPart);
          return '<a href="/share/'+encodeURIComponent(shareToken)+'/file?path='+encodeURIComponent(target)+hash+'"'+t+'>'+text+'</a>';
        }
        return '<a href="'+href+'"'+t+' target="_blank" rel="noopener noreferrer">'+text+'</a>';
      }
    }});

    var preview = document.getElementById('preview');
    preview.innerHTML = marked.parse(${escaped});
    MarkdownView.enhance(preview);
    var diagrams = preview.querySelectorAll('.mermaid');
    if (diagrams.length) ensureMermaid().then(function(){
      mermaid.initialize({startOnLoad:false,theme:'default'});
      return mermaid.run({nodes:diagrams});
    });

    // assign heading ids
    var counts = {};
    preview.querySelectorAll('h1,h2,h3,h4').forEach(function(h){
      var base = h.textContent.trim().replace(/\\s+/g,'-').replace(/[^\\w\\u4e00-\\u9fa5-]/g,'');
      counts[base] = (counts[base]||0)+1;
      h.id = counts[base]>1 ? base+'-'+counts[base] : base;
    });

    // build toc
    var headings = Array.from(preview.querySelectorAll('h1,h2,h3,h4'));
    if(headings.length){
      document.getElementById('toc').style.display='flex';
      document.getElementById('toc').style.flexDirection='column';
      var tocList = document.getElementById('toc-list');
      headings.forEach(function(h){
        var item = document.createElement('div');
        item.className='toc-item';
        item.dataset.level=h.tagName[1];
        item.dataset.target=h.id;
        item.textContent=h.textContent.trim();
        item.title=h.textContent.trim();
        item.addEventListener('click',function(){h.scrollIntoView({behavior:'smooth',block:'start'});});
        tocList.appendChild(item);
      });

      // scroll spy
      var observer = new IntersectionObserver(function(entries){
        var visible = entries.filter(function(e){return e.isIntersecting;});
        if(!visible.length) return;
        var top = visible.reduce(function(a,b){return a.boundingClientRect.top<b.boundingClientRect.top?a:b;});
        tocList.querySelectorAll('.toc-item').forEach(function(i){i.classList.toggle('active',i.dataset.target===top.target.id);});
      },{root:preview,rootMargin:'0px 0px -70% 0px',threshold:0});
      headings.forEach(function(h){observer.observe(h);});
      if(headings[0]) tocList.querySelector('[data-target="'+headings[0].id+'"]').classList.add('active');
    }
  </script>
</body>
</html>`);
}

app.get('/share/:token', (req, res) => {
  const task = getSharedTask(req.params.token);
  if (!task || !task.md_path) return res.status(404).send('The link is invalid or has expired');
  try {
    sendSharedMarkdown(res, task, req.params.token, fs.readFileSync(task.md_path, 'utf8'));
  } catch (e) {
    res.status(404).send('File does not exist');
  }
});

app.get('/share/:token/file', (req, res) => {
  const task = getSharedTask(req.params.token);
  if (!task || !task.md_path) return res.status(404).send('The link is invalid or has expired');
  const file = readSharedMarkdown(task, req.query.path);
  if (!file) return res.status(404).send('The Markdown file does not exist or is not accessible');
  sendSharedMarkdown(res, task, req.params.token, file.content, file.relativePath);
});

// Phones and computers get two separate pages: /h5 (tasks, phone terminals, image upload, translate and send) and /web.
const PHONE_USER_AGENT = /iPhone|iPod|Android.+Mobile|Windows Phone|HarmonyOS.+Mobile|Mobile Safari/i;

function sendClientPage(req, res, page = 'index.html') {
  res.set('Cache-Control', 'no-store');
  const auth = getClientAuth().ready(req.session);
  const returnTo = safeReturnTo(req.path);
  if (auth.setupRequired) return res.redirect(`${config.loginPath}/setup?return_to=${encodeURIComponent(returnTo)}`);
  if (auth.loginRequired) return res.redirect(`${config.loginPath}?return_to=${encodeURIComponent(returnTo)}`);
  req.session.user = ensureSingleUser();
  let html = fs.readFileSync(path.join(__dirname, 'public', page), 'utf8');
  const assetVersion = encodeURIComponent(JSON.parse(fs.readFileSync(path.join(__dirname, 'VERSION.json'), 'utf8')).app_version);
  html = html.replace(/(src|href)="(\/(?:js|css|vendor)\/[^"?]+\.(?:js|css))"/g, `$1="$2?v=${assetVersion}"`);
  html = html.replace('</head>', `<meta name="t-agent-login-path" content="${escapeHtml(config.loginPath)}">\n</head>`);
  res.type('html').send(html);
}

app.get('/', (req, res) => (PHONE_USER_AGENT.test(req.get('User-Agent') || '') ? res.redirect('/h5') : sendClientPage(req, res)));
app.get('/web', (req, res) => sendClientPage(req, res));
app.get('/h5', (req, res) => sendClientPage(req, res, 'h5.html'));
app.get('/index.html', (req, res) => res.redirect('/web'));
app.get('/h5.html', (req, res) => res.redirect('/h5'));
app.get('/login.html', (req, res) => res.redirect(config.loginPath));
// Static middleware decodes paths: encoded /index%2ehtml must not evade the
// explicit page routes above. Do not allow implicit directory index documents.
app.use((req, res, next) => {
  let pathname;
  try { pathname = decodeURIComponent(req.path); } catch { return res.sendStatus(400); }
  if (path.extname(pathname).toLowerCase() !== '.html') return next();
  const auth = getClientAuth().ready(req.session);
  res.set('Cache-Control', 'no-store');
  if (auth.setupRequired) return res.redirect(`${config.loginPath}/setup`);
  if (auth.loginRequired) return res.redirect(config.loginPath);
  next();
});
// Third-party library file names carry a version and their content is fixed: cache them for a long time, and enable gzip for /vendor (mermaid is about 5 MB).
// Compression is limited to /vendor so streaming endpoints such as SSE are not buffered.
app.use('/vendor', compression(), express.static(path.join(__dirname, 'public', 'vendor'), {
  index: false,
  setHeaders(res, file) {
    if (/-\d+\.\d+\.\d+(?:\.min)?\.(?:js|css)$/.test(file)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  },
}));
// The page rewrites its own /js and /css URLs with ?v=<app version> (see sendClientPage), so a versioned request names content that cannot change until the
// next release: it is cached for a year and never revalidated. Unversioned requests keep revalidating. Scripts and styles are gzipped (only these two
// prefixes, so streaming endpoints such as SSE are never buffered); small static files like the icons and manifest are cached for a day.
const VERSION_QUERY = /^[\w.-]{1,40}$/;
app.use(['/js', '/css'], compression());
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders(res, file) {
    const version = res.req && res.req.query && res.req.query.v;
    if (/\.(?:js|css)$/.test(file) && typeof version === 'string' && VERSION_QUERY.test(version)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    else if (/\.(?:png|ico|svg|webmanifest)$|manifest[\w-]*\.json$/.test(file)) res.setHeader('Cache-Control', 'public, max-age=86400');
  },
}));
// A logged-in person who opens a wrong page address goes to the home page; everyone else keeps getting 404.
app.use(createUnknownPageRedirect({ loginPath: config.loginPath, isAuthenticated: session => getClientAuth().authenticated(session) }));

// HTTP server + WebSocket server
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
app.locals.disconnectClientSession = sid => {
  for (const ws of wss.clients) if (ws.clientSessionId === sid) ws.close(1008, 'Authentication required');
};
app.locals.disconnectAllClientSessions = () => {
  for (const ws of wss.clients) if (ws.clientSessionId) ws.close(1008, 'Authenticator changed');
};

// Open browser terminals must not outlive logout or the authentication session.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.clientSessionId) continue;
    const row = db.prepare('SELECT sess, expired FROM sessions WHERE sid = ?').get(ws.clientSessionId);
    let valid = false;
    try { valid = row && row.expired > Date.now() && getClientAuth().authenticated(JSON.parse(row.sess)); } catch {}
    if (!valid) ws.close(1008, 'Authentication required');
  }
}, 30000).unref();

function browserUpgrade(req, socket, head, callback) {
  const origin = req.headers.origin;
  const allowedOrigins = [`http://${req.headers.host}`, `https://${req.headers.host}`];
  if (!origin || !allowedOrigins.includes(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  const fakeRes = { getHeader: () => {}, setHeader: () => {}, end: () => {} };
  sessionMiddleware(req, fakeRes, () => {
    if (!getClientAuth().authenticated(req.session)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      return socket.destroy();
    }
    req.session.user = ensureSingleUser();
    callback(req.session.user);
  });
}
server.on('upgrade', (req, socket, head) => {
  if (!upgradeAllowed(req, getClientAuth().accessMode())) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    return socket.destroy();
  }
  const engineUrl = new URL(req.url, 'http://engine.local');
  const engineMatch = engineUrl.pathname.match(/^\/v1\/terminal-sessions\/(\d+)\/stream$/);
  if (engineMatch) {
    pruneExpiredTickets();
    const authorization = consumeTerminalTicket(engineUrl.searchParams.get('ticket'));
    if (!authorization || Number(engineMatch[1]) !== authorization.taskId) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      terminal.handleWs(ws, req, { login: authorization.principalId }, authorization.taskId, authorization.terminalId);
    });
    return;
  }
  if (engineUrl.pathname.match(/^\/api\/remote-servers\/\d+\/terminal\/ws$/)) {
    browserUpgrade(req, socket, head, user => {
      handleRemoteTerminalUpgrade(req, socket, head, wss, user).catch(() => {
        if (!socket.destroyed) socket.destroy();
      });
    });
    return;
  }
  if (engineUrl.pathname !== '/terminal/ws') {
    socket.destroy();
    return;
  }
  browserUpgrade(req, socket, head, user => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.clientSessionId = req.sessionID;
      terminal.handleWs(ws, req, user);
    });
  });
});

server.listen(config.port, config.host, () => {
  const listeningPort = server.address().port;
  const anyHost = ['0.0.0.0', '::', '', 'localhost'].includes(config.host);
  terminal.setHookEndpoint(`http://${anyHost ? '127.0.0.1' : config.host}:${listeningPort}/hooks/terminal-activity`);
  console.log(`Server running at http://localhost:${listeningPort}`);
  frpRouter.service.autoStart();
  sshTunnelRouter.service.autoStart();
  console.log(`             LAN: http://${getLocalIP()}:${listeningPort}`);
  const clientAuth = getClientAuth();
  if (clientAuth.accessMode() === 'local') {
    console.log('Access mode: local access only (no verification). Change it to authenticator + external access under Settings → Access mode.');
  } else if (clientAuth.accessMode() === 'unset') {
    console.log(`Access mode not chosen yet: open http://127.0.0.1:${listeningPort}/ in a browser on this machine and choose “Authenticator + external access” or “Local access only”.`);
    console.log('If you cannot open a browser on this machine (for example on a remote server), run node scripts/client-auth-setup.js in a terminal on the server to bind an authenticator and enable external access.');
  } else if (!clientAuth.status().bound) {
    console.log('No authenticator is bound to the Client; one must be bound before Web / H5 can be used.');
    console.log('Run node scripts/client-auth-setup.js in a terminal on the server to complete the first binding (it can be run remotely over SSH); no initial password or setup code is needed.');
    console.log(`You can also open http://127.0.0.1:${listeningPort}/auth/setup (a local or remote address both work) and scan the QR code to bind.`);
  }
  updates.start();
});

// Do not let frpc become an orphan process after the Client exits.
process.on('exit', () => { frpRouter.service.stop(); sshTunnelRouter.service.stop(); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));
