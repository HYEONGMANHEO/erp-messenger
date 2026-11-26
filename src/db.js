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

    -- 알림
    CREATE TABLE IF NOT EXISTS notifications (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      type       TEXT NOT NULL,
      title      TEXT NOT NULL,
      body       TEXT NOT NULL DEFAULT '',
      link       TEXT NOT NULL DEFAULT '',          -- 예: 'approval:12', 'board:5'
      is_read    INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id);

    -- 게시판
    CREATE TABLE IF NOT EXISTS posts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      category   TEXT NOT NULL,                     -- 'notice' 또는 'general'
      title      TEXT NOT NULL,
      content    TEXT NOT NULL,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      pinned     INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_posts_category ON posts(category, id);
    CREATE TABLE IF NOT EXISTS comments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id    INTEGER NOT NULL REFERENCES posts(id),
      user_id    INTEGER NOT NULL REFERENCES users(id),
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, id);

    -- 전자결재
    CREATE TABLE IF NOT EXISTS approvals (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      type         TEXT NOT NULL,                   -- 'general', 'expense', 'leave'
      title        TEXT NOT NULL,
      content      TEXT NOT NULL DEFAULT '',
      amount       INTEGER,
      drafter_id   INTEGER NOT NULL REFERENCES users(id),
      status       TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'approved', 'rejected', 'withdrawn'
      current_step INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_drafter ON approvals(drafter_id, id);
    CREATE TABLE IF NOT EXISTS approval_steps (
      approval_id INTEGER NOT NULL REFERENCES approvals(id),
      step_no     INTEGER NOT NULL,
      approver_id INTEGER NOT NULL REFERENCES users(id),
      status      TEXT NOT NULL DEFAULT 'waiting',  -- 'waiting', 'pending', 'approved', 'rejected'
      comment     TEXT NOT NULL DEFAULT '',
      acted_at    TEXT,
      PRIMARY KEY (approval_id, step_no)
    );
    CREATE INDEX IF NOT EXISTS idx_steps_approver ON approval_steps(approver_id, status);

    -- 근태와 휴가
    CREATE TABLE IF NOT EXISTS attendance (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id   INTEGER NOT NULL REFERENCES users(id),
      work_date TEXT NOT NULL,                      -- 'YYYY-MM-DD'
      check_in  TEXT NOT NULL,
      check_out TEXT,
      UNIQUE (user_id, work_date)
    );
    CREATE TABLE IF NOT EXISTS leave_requests (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      type        TEXT NOT NULL,                    -- 'annual', 'half_am', 'half_pm', 'sick', 'etc'
      start_date  TEXT NOT NULL,
      end_date    TEXT NOT NULL,
      days        REAL NOT NULL,
      reason      TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'pending',
      approval_id INTEGER REFERENCES approvals(id),
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_leaves_user ON leave_requests(user_id, start_date);

    -- 일정
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      location    TEXT NOT NULL DEFAULT '',
      start_at    TEXT NOT NULL,                    -- 'YYYY-MM-DDTHH:mm'
      end_at      TEXT NOT NULL,
      all_day     INTEGER NOT NULL DEFAULT 0,
      scope       TEXT NOT NULL,                    -- 'personal', 'department', 'company'
      department  TEXT NOT NULL DEFAULT '',
      user_id     INTEGER NOT NULL REFERENCES users(id),
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_range ON events(start_at, end_at);
  `);

  // 이전 버전에서 만든 데이터베이스에 새 항목을 추가한다 (기존 데이터는 그대로 유지).
  const userColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userColumns.includes('annual_leave_days')) {
    db.exec('ALTER TABLE users ADD COLUMN annual_leave_days REAL NOT NULL DEFAULT 15');
  }

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
