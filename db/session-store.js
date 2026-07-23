const session = require('express-session');

class SqliteStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expired INTEGER NOT NULL
      )
    `);
    setInterval(() => {
      db.prepare('DELETE FROM sessions WHERE expired < ?').run(Date.now());
    }, 15 * 60 * 1000);
  }

  get(sid, callback) {
    try {
      const row = this.db.prepare('SELECT sess, expired FROM sessions WHERE sid = ?').get(sid);
      if (!row || row.expired < Date.now()) return callback(null, null);
      callback(null, JSON.parse(row.sess));
    } catch (e) {
      callback(e);
    }
  }

  set(sid, session, callback) {
    try {
      const ttl = session.cookie && session.cookie.maxAge
        ? session.cookie.maxAge
        : 7 * 24 * 60 * 60 * 1000;
      const expired = Date.now() + ttl;
      this.db.prepare(`
        INSERT INTO sessions (sid, sess, expired) VALUES (@sid, @sess, @expired)
        ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expired=excluded.expired
      `).run({ sid, sess: JSON.stringify(session), expired });
      callback(null);
    } catch (e) {
      callback(e);
    }
  }

  destroy(sid, callback) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      callback(null);
    } catch (e) {
      callback(e);
    }
  }
}

module.exports = SqliteStore;
