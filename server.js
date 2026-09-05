require('dotenv').config();
const express = require('express');
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

const app = express();

// 宝塔/Nginx 在 HTTPS 终止后转发到本服务时，会通过
// X-Forwarded-Proto 传递原始协议。信任一层代理，确保安全会话 Cookie
// 能在 HTTPS 域名访问时被正确写入。
app.set('trust proxy', 1);

function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

app.use(express.json({ limit: '6mb' }));
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
  store: new SqliteStore(db),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
});

app.use(sessionMiddleware);

app.get('/api/local-ip', (req, res) => {
  res.json({ ip: getLocalIP(), port: config.port });
});

app.use('/auth', require('./routes/auth'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/task-groups', require('./routes/task-groups'));
app.use('/api/bookmarks', require('./routes/bookmarks'));
app.use('/api/system', require('./routes/system'));
app.use('/api/remote-servers', require('./routes/remote-servers'));
app.use('/api/remote-tokens', require('./routes/remote-tokens'));
app.use('/api/remote/v1', require('./routes/remote-api'));
// 标准 Engine API。Client 安装包默认内置并暴露与独立 Engine 相同的协议。
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
  return db.prepare('SELECT * FROM tasks WHERE share_token = ?').get(token);
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
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
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
</head>
<body>
  <div class="header">
    <h1>${safeTitle}</h1>
    <span class="badge">只读分享</span>
  </div>
  <div class="layout">
    <div class="preview" id="preview"></div>
    <div class="toc" id="toc" style="display:none">
      <div class="toc-title">目录</div>
      <div id="toc-list"></div>
    </div>
  </div>
  <script>
    mermaid.initialize({startOnLoad:false,theme:'default'});
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
    mermaid.run({nodes:preview.querySelectorAll('.mermaid')});

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
  if (!task || !task.md_path) return res.status(404).send('链接无效或已失效');
  try {
    sendSharedMarkdown(res, task, req.params.token, fs.readFileSync(task.md_path, 'utf8'));
  } catch (e) {
    res.status(404).send('文件不存在');
  }
});

app.get('/share/:token/file', (req, res) => {
  const task = getSharedTask(req.params.token);
  if (!task || !task.md_path) return res.status(404).send('链接无效或已失效');
  const file = readSharedMarkdown(task, req.query.path);
  if (!file) return res.status(404).send('Markdown 文件不存在或无权访问');
  sendSharedMarkdown(res, task, req.params.token, file.content, file.relativePath);
});

app.get('/', (req, res) => {
  req.session.user = ensureSingleUser();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login.html', (req, res) => res.redirect('/'));

app.use(express.static(path.join(__dirname, 'public')));

// HTTP server + WebSocket server
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
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
      terminal.handleWs(ws, req, { login: authorization.principalId }, authorization.taskId);
    });
    return;
  }
  if (engineUrl.pathname.match(/^\/api\/remote-servers\/\d+\/terminal\/ws$/)) {
    const fakeRes = { getHeader: () => {}, setHeader: () => {}, end: () => {} };
    sessionMiddleware(req, fakeRes, () => {
      const user = (req.session && req.session.user) || ensureSingleUser();
      handleRemoteTerminalUpgrade(req, socket, head, wss, user).catch(() => {
        if (!socket.destroyed) socket.destroy();
      });
    });
    return;
  }
  if (!req.url.startsWith('/terminal/ws')) {
    socket.destroy();
    return;
  }
  // 复用 express session 中间件解析 session cookie
  const fakeRes = { getHeader: () => {}, setHeader: () => {}, end: () => {} };
  sessionMiddleware(req, fakeRes, () => {
    const user = (req.session && req.session.user) || ensureSingleUser();
    wss.handleUpgrade(req, socket, head, (ws) => {
      terminal.handleWs(ws, req, user);
    });
  });
});

server.listen(config.port, config.host, () => {
  console.log(`Server running at http://localhost:${config.port}`);
  console.log(`             LAN: http://${getLocalIP()}:${config.port}`);
  updates.start();
});
