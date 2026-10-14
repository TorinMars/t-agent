// 访问模式门禁：仅本机模式（local）和尚未选择模式（unset）时，只接受来自本机的直接访问，
// 其余地址（含经反向代理 / 隧道转发、Host 不是回环名的请求）一律 404，响应与路由不存在一致。
// 仅本机模式下，本机请求的会话被标记为可信，不再需要身份验证器。
const { isLocalInitialization } = require('../services/client-auth');
const { sendNotFound } = require('./login-gate');

function createAccessGate({ getMode }) {
  return function accessGate(req, res, next) {
    const mode = getMode();
    if (mode === 'remote') return next();
    if (!isLocalInitialization(req)) return sendNotFound(req, res);
    if (mode === 'local' && req.session && req.session.localTrusted !== true) req.session.localTrusted = true;
    next();
  };
}

// WebSocket 升级请求没有 Express 的响应对象，单独判断。
function upgradeAllowed(req, mode) {
  return mode === 'remote' || isLocalInitialization(req);
}

module.exports = { createAccessGate, upgradeAllowed };
