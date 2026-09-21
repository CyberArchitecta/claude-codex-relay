import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { retryBusy } from './database.mjs';

export const now = () => new Date().toISOString();
export const activeStates = new Set(['queued', 'running']);
export function textValue(value, name, max = 20_000, required = true) {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max) {
    throw new Error(`${name} must be ${required ? '1' : '0'}-${max} characters.`);
  }
  return value.trim();
}

export class Store {
  constructor(directory) {
    this.directory = path.resolve(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, 'relay.sqlite3'));
    retryBusy(() => this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, project TEXT NOT NULL,
        original_prompt TEXT NOT NULL, context TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), agent TEXT NOT NULL,
        prompt TEXT NOT NULL, permission TEXT NOT NULL, model TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL, session_id TEXT, summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, exit_code INTEGER, instruction TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id),
        kind TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id,id);
      CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id,created_at);`));
    retryBusy(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (!this.db.prepare('PRAGMA table_info(runs)').all().some(column => column.name === 'instruction')) {
          this.db.exec("ALTER TABLE runs ADD COLUMN instruction TEXT NOT NULL DEFAULT ''");
        }
        if (!this.db.prepare('PRAGMA table_info(tasks)').all().some(c => c.name === 'kind')) this.db.exec("ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'");
        if (!this.db.prepare('PRAGMA table_info(runs)').all().some(c => c.name === 'usage_json')) this.db.exec("ALTER TABLE runs ADD COLUMN usage_json TEXT");
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    });
  }
  createTask({ title, project = '', prompt = '', context = '', kind = 'task' }) {
    if (!['task', 'chat'].includes(kind)) throw new Error('Invalid task kind.');
    const task = { id: randomUUID(), title: textValue(title, 'Title', 160), project,
      original_prompt: textValue(prompt, 'Request', 20_000, kind !== 'chat'), context: textValue(context, 'Context', 20_000, false),
      created_at: now(), updated_at: now(), kind };
    this.db.prepare('INSERT INTO tasks (id,title,project,original_prompt,context,created_at,updated_at,kind) VALUES (?,?,?,?,?,?,?,?)').run(...Object.values(task));
    return task;
  }
  task(id) {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    if (!task) throw new Error('Task not found.');
    return task;
  }
  tasks() {
    return this.db.prepare(`SELECT t.*, (SELECT state FROM runs WHERE task_id=t.id ORDER BY rowid DESC LIMIT 1) AS state,
      (SELECT agent FROM runs WHERE task_id=t.id ORDER BY rowid DESC LIMIT 1) AS agent
      FROM tasks t ORDER BY updated_at DESC`).all();
  }
  setContext(id, context, expectedContext) {
    this.task(id);
    const value = textValue(context, 'Context', 20_000, false);
    if (expectedContext !== undefined) textValue(expectedContext, 'Previous context', 20_000, false);
    const result = expectedContext === undefined
      ? this.db.prepare('UPDATE tasks SET context=?,updated_at=? WHERE id=?').run(value, now(), id)
      : this.db.prepare('UPDATE tasks SET context=?,updated_at=? WHERE id=? AND context=?').run(value, now(), id, expectedContext);
    if (!result.changes) {
      const error = new Error('Shared context changed elsewhere. Review the latest context before saving.');
      error.status = 409; throw error;
    }
    return this.task(id);
  }
  appendContext(id, note) {
    return retryBusy(() => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const task = this.task(id);
        const updated = this.setContext(id, `${task.context}\n\n${textValue(note, 'Note', 6000)}`.trim(), task.context);
        this.db.exec('COMMIT'); return updated;
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    });
  }
  chatDirectory(id) {
    const task = this.task(id);
    if (task.project) return task.project;
    const directory = path.join(this.directory, 'chat-workspaces', task.id);
    mkdirSync(directory, { recursive: true, mode: 0o700 }); return directory;
  }
  runs(taskId) {
    const rows = taskId ? this.db.prepare('SELECT * FROM runs WHERE task_id=? ORDER BY rowid').all(taskId)
      : this.db.prepare('SELECT * FROM runs ORDER BY rowid').all();
    return rows.map(row => ({ ...row, usage: row.usage_json ? JSON.parse(row.usage_json) : null }));
  }
  run(id) {
    const run = this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);
    if (!run) throw new Error('Run not found.');
    return { ...run, usage: run.usage_json ? JSON.parse(run.usage_json) : null };
  }
  createRun({ task_id, agent, prompt, permission, model = '', session_id = null, instruction = '' }) {
    this.task(task_id);
    const run = { id: randomUUID(), task_id, agent, prompt, permission, model,
      state: 'queued', session_id, summary: '', created_at: now(), started_at: null, ended_at: null, exit_code: null, instruction };
    this.db.prepare(`INSERT INTO runs (${Object.keys(run).join(',')}) VALUES (${Object.keys(run).map(() => '?').join(',')})`).run(...Object.values(run));
    this.db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(now(), task_id);
    return run;
  }
  patchRun(id, patch) {
    const allowed = new Set(['state', 'session_id', 'summary', 'started_at', 'ended_at', 'exit_code', 'usage_json']);
    for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new Error('Invalid run field.');
    const run = this.run(id);
    this.db.prepare(`UPDATE runs SET ${Object.keys(patch).map(k => `${k}=?`).join(',')} WHERE id=?`)
      .run(...Object.values(patch), id);
    this.db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(now(), run.task_id);
    return this.run(id);
  }
  event(id, kind, text) {
    this.db.prepare('INSERT INTO events(run_id,kind,text,created_at) VALUES (?,?,?,?)')
      .run(id, kind, String(text).slice(0, 32_000), now());
  }
  events(id, after = 0) {
    return this.db.prepare('SELECT * FROM events WHERE run_id=? AND id>? ORDER BY id LIMIT 1000').all(id, after);
  }
  recentEvents(id, limit = 80) {
    return this.db.prepare('SELECT * FROM events WHERE run_id=? ORDER BY id DESC LIMIT ?').all(id, limit).reverse();
  }
  recover() {
    this.db.prepare(`UPDATE runs SET state='interrupted',ended_at=?,summary=? WHERE state IN ('queued','running')`)
      .run(now(), 'Relay restarted. Review the workspace before continuing; no run was automatically restarted.');
  }
  close() { this.db.close(); }
}
