const express = require('express');
const fs = require('fs');
const db = require('../db');
const { ensureSingleUser } = require('../services/single-user');

const router = express.Router();

function attachUser(req) {
  const user = ensureSingleUser();
  req.session.user = user;
  return user;
}

// 兼容旧页面和旧客户端：不再校验用户名或密码。
router.post('/login', (req, res) => {
  res.json({ success: true, user: attachUser(req) });
});

// PUT /auth/settings — 更新工作路径
router.put('/settings', (req, res) => {
  attachUser(req);
  const { work_dir } = req.body;
  const username = req.session.user.login;

  let finalWorkDir = work_dir ? work_dir.trim() : null;
  if (finalWorkDir) {
    try {
      fs.mkdirSync(finalWorkDir, { recursive: true });
    } catch (e) {
      return res.status(400).json({ error: `工作目录创建失败: ${e.message}` });
    }
  }

  db.prepare('UPDATE users SET work_dir = ? WHERE username = ?').run(finalWorkDir, username);
  req.session.user.work_dir = finalWorkDir;
  res.json({ success: true, work_dir: finalWorkDir });
});

// POST /auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// GET /auth/me
router.get('/me', (req, res) => {
  res.json(attachUser(req));
});

module.exports = router;
