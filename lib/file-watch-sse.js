const fs = require('fs');

// Server-sent events that fire "changed" whenever the watched file is modified.
// Shared by the local /api/tasks routes and the Engine /v1 routes so both behave alike.
function serveFileWatch(req, res, filePath) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Keep reverse proxies (nginx) from buffering the stream.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let watcher;
  try {
    watcher = fs.watch(filePath, { persistent: false }, event => {
      if (event === 'change') res.write('data: changed\n\n');
    });
  } catch {
    res.write('data: error\n\n');
    return res.end();
  }

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(heartbeat); watcher.close(); });
}

module.exports = { serveFileWatch };
