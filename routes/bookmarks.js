const express = require('express');
const db = require('../db');
const requireAuth = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

router.get('/', (req, res) => {
  const bookmarks = db.prepare('SELECT * FROM bookmarks ORDER BY group_name ASC, sort_order ASC, created_at ASC').all();
  res.json(bookmarks);
});

router.post('/', (req, res) => {
  const { title, url, icon, group_name, sort_order } = req.body;
  if (!title || !url) {
    return res.status(400).json({ error: 'title and url are required' });
  }

  const stmt = db.prepare(`
    INSERT INTO bookmarks (title, url, icon, group_name, sort_order)
    VALUES (@title, @url, @icon, @group_name, @sort_order)
  `);
  const info = stmt.run({
    title,
    url,
    icon: icon || null,
    group_name: group_name || '默认',
    sort_order: sort_order || 0,
  });

  const bookmark = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(bookmark);
});

router.put('/reorder', (req, res) => {
  const { orders } = req.body;
  if (!Array.isArray(orders)) {
    return res.status(400).json({ error: 'orders must be an array' });
  }

  const update = db.prepare('UPDATE bookmarks SET sort_order = @sort_order WHERE id = @id');
  const updateMany = db.transaction((items) => {
    for (const item of items) {
      update.run({ id: item.id, sort_order: item.sort_order });
    }
  });
  updateMany(orders);
  res.json({ success: true });
});

router.put('/:id', (req, res) => {
  const { id } = req.params;
  const bookmark = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id);
  if (!bookmark) return res.status(404).json({ error: 'Bookmark not found' });

  const { title, url, icon, group_name, sort_order } = req.body;

  db.prepare(`
    UPDATE bookmarks SET
      title      = COALESCE(@title, title),
      url        = COALESCE(@url, url),
      icon       = CASE WHEN @icon_set = 1 THEN @icon ELSE icon END,
      group_name = COALESCE(@group_name, group_name),
      sort_order = COALESCE(@sort_order, sort_order)
    WHERE id = @id
  `).run({
    id,
    title: title !== undefined ? title : null,
    url: url !== undefined ? url : null,
    icon: icon !== undefined ? icon : null,
    icon_set: icon !== undefined ? 1 : 0,
    group_name: group_name !== undefined ? group_name : null,
    sort_order: sort_order !== undefined ? sort_order : null,
  });

  const updated = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id);
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  const { id } = req.params;
  const bookmark = db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(id);
  if (!bookmark) return res.status(404).json({ error: 'Bookmark not found' });

  db.prepare('DELETE FROM bookmarks WHERE id = ?').run(id);
  res.json({ success: true });
});

module.exports = router;
