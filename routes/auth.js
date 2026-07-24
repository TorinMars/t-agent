const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const db = require('../db');

const router = express.Router();

// POST /auth/login
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  try {
    const hash = crypto.scryptSync(password, user.salt, 64).toString('hex');
    if (hash !== user.hash) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
  } catch (e) {
    return res.status(500).json({ error: '服务器错误' });
  }
  req.session.user = { login: username, avatar_url: '', name: username, work_dir: user.work_dir };
  res.json({ success: true });
});

// PUT /auth/settings — 更新工作路径
router.put('/settings', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
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
    res.redirect('/login.html');
  });
});

// GET /auth/me
router.get('/me', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  res.json(req.session.user);
});

module.exports = router;
