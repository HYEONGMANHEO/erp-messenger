'use strict';
// 데이터베이스 초기화 모듈.
// Node.js 내장 SQLite(node:sqlite)를 사용하므로 별도 데이터베이스 설치가 필요 없다.
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

function open(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'messenger.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name          TEXT NOT NULL,
      department    TEXT NOT NULL DEFAULT '',
      position      TEXT NOT NULL DEFAULT '',
      role          TEXT NOT NULL DEFAULT 'user',   -- 'admin' 또는 'user'
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      type       TEXT NOT NULL,                     -- 'direct' 또는 'group'
      name       TEXT NOT NULL DEFAULT '',
      direct_key TEXT UNIQUE,                       -- 1대1 대화방 중복 방지 키
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS room_members (
      room_id      INTEGER NOT NULL REFERENCES rooms(id),
      user_id      INTEGER NOT NULL REFERENCES users(id),
      last_read_id INTEGER NOT NULL DEFAULT 0,
      joined_at    TEXT NOT NULL,
      PRIMARY KEY (room_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_members_user ON room_members(user_id);

    CREATE TABLE IF NOT EXISTS files (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id       INTEGER NOT NULL REFERENCES rooms(id),
      user_id       INTEGER NOT NULL REFERENCES users(id),
      original_name TEXT NOT NULL,
      stored_name   TEXT NOT NULL,
      size          INTEGER NOT NULL,
      mime          TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id    INTEGER NOT NULL REFERENCES rooms(id),
      user_id    INTEGER NOT NULL REFERENCES users(id),
      type       TEXT NOT NULL DEFAULT 'text',      -- 'text', 'file', 'system'
      content    TEXT NOT NULL DEFAULT '',
      file_id    INTEGER REFERENCES files(id),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, id);
  `);

  // 여러 쓰기 작업을 하나의 단위로 묶는 간단한 트랜잭션 도우미
  db.tx = (fn) => {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
  return db;
}

module.exports = { open };
