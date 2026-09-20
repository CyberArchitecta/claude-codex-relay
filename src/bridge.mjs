import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { now, textValue } from './store.mjs';
import { retryBusy } from './database.mjs';

function channelValue(value = 'general') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(value)) throw new Error('Invalid channel. Use 1-100 letters, numbers, dots, underscores, colons, or hyphens.');
  return value;
}
function limitValue(value = 25) {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error('Limit must be an integer from 1 to 100.');
  return value;
}
export class Bridge {
  constructor(directory, agent) {
    if (!['claude', 'codex'].includes(agent)) throw new Error('--agent must be claude or codex.');
    this.agent = agent; this.peer = agent === 'claude' ? 'codex' : 'claude';
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = path.join(directory, 'messages.sqlite3');
    this.db = new DatabaseSync(this.path);
    retryBusy(() => this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL,
        sender TEXT NOT NULL CHECK(sender IN ('codex','claude')),
        recipient TEXT NOT NULL CHECK(recipient IN ('codex','claude')),
        body TEXT NOT NULL, reply_to INTEGER REFERENCES messages(id), created_at TEXT NOT NULL, read_at TEXT);
      CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages(recipient,read_at,channel,id);`));
  }
  send({ message, channel = 'general', reply_to = null }) {
    const body = textValue(message, 'Message'); channel = channelValue(channel);
    if (reply_to !== null) {
      if (!Number.isSafeInteger(reply_to) || reply_to < 1) throw new Error('reply_to must be a positive integer.');
      const parent = this.db.prepare('SELECT * FROM messages WHERE id=?').get(reply_to);
      if (!parent || parent.channel !== channel || parent.recipient !== this.agent) throw new Error('Reply must reference a message addressed to you in the same channel.');
    }
    const created_at = now();
    const result = this.db.prepare('INSERT INTO messages(channel,sender,recipient,body,reply_to,created_at) VALUES (?,?,?,?,?,?)')
      .run(channel, this.agent, this.peer, body, reply_to, created_at);
    return { id: Number(result.lastInsertRowid), channel, sender: this.agent, recipient: this.peer, created_at };
  }
  inbox({ channel, limit = 25, unread_only = true, mark_read = true } = {}) {
    const selected = channel == null ? null : channelValue(channel); limitValue(limit);
    if (typeof unread_only !== 'boolean' || typeof mark_read !== 'boolean') throw new Error('Inbox flags must be booleans.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.db.prepare(`SELECT * FROM messages WHERE recipient=? AND (? IS NULL OR channel=?)
        ${unread_only ? 'AND read_at IS NULL' : ''} ORDER BY id ${unread_only ? 'ASC' : 'DESC'} LIMIT ?`).all(this.agent, selected, selected, limit);
      if (!unread_only) rows.reverse();
      if (mark_read) for (const row of rows) if (!row.read_at) {
        row.read_at = now(); this.db.prepare('UPDATE messages SET read_at=? WHERE id=?').run(row.read_at, row.id);
      }
      this.db.exec('COMMIT'); return { agent: this.agent, messages: rows };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  history({ channel, limit = 25 } = {}) {
    const selected = channel == null ? null : channelValue(channel); limitValue(limit);
    return { agent: this.agent, messages: this.db.prepare('SELECT * FROM messages WHERE (? IS NULL OR channel=?) ORDER BY id DESC LIMIT ?').all(selected, selected, limit).reverse() };
  }
  status() {
    const counts = this.db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN recipient=? AND read_at IS NULL THEN 1 ELSE 0 END) AS unread FROM messages').get(this.agent);
    return { agent: this.agent, peer: this.peer, database: this.path, total_messages: counts.total, unread_messages: counts.unread || 0 };
  }
  close() { this.db.close(); }
}
