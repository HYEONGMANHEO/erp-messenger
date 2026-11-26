'use strict';
// 주요 기능 점검 스크립트: 임시 폴더에 서버를 띄우고 가입, 대화, 파일, 검색, 권한을 차례로 확인한다.
// 실행: npm test
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');

const PORT = 39000 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client() {
  let cookie = '';
  const call = async (method, url, body, headers = { 'X-Requested-With': 'fetch' }) => {
    const options = { method, headers: { ...headers, cookie } };
    if (body instanceof FormData) options.body = body;
    else if (body) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
    const res = await fetch(BASE + url, options);
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : await res.text() };
  };
  return { call, cookie: () => cookie };
}
const connect = (c) => new Promise((resolve, reject) => {
  const socket = io(BASE, { extraHeaders: { cookie: c.cookie() }, transports: ['websocket'] });
  socket.events = [];
  socket.onAny((name, data) => socket.events.push({ name, data }));
  socket.on('connect', () => resolve(socket));
  socket.on('connect_error', reject);
});
const emit = (socket, name, data) => new Promise((resolve) => socket.emit(name, data, resolve));

let passed = 0;
async function step(name, fn) { await fn(); passed += 1; console.log(`  통과  ${name}`); }

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, SIGNUP_CODE: 'code-1234', MAX_FILE_MB: '1', NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    await new Promise((resolve, reject) => {
      server.stdout.on('data', (d) => { if (String(d).includes('실행되었습니다')) resolve(); });
      server.on('exit', () => reject(new Error('서버가 시작되지 않았습니다.')));
    });

    const a = client(); const b = client(); const c = client(); const guest = client();
    let A; let B; let C; let direct; let group; let sa; let sb; let fileId;

    await step('첫 가입자는 가입 코드 없이 관리자가 된다', async () => {
      const r = await a.call('POST', '/api/signup', { username: 'admin', password: 'password1', name: '김관리', department: '경영지원' });
      assert.equal(r.status, 200); assert.equal(r.data.user.role, 'admin'); A = r.data.user;
    });
    await step('이후 가입자는 가입 코드가 필요하다', async () => {
      const bad = await b.call('POST', '/api/signup', { username: 'lee', password: 'password2', name: '이사원' });
      assert.equal(bad.status, 403);
      const ok = await b.call('POST', '/api/signup', { username: 'lee', password: 'password2', name: '이사원', department: '개발', signupCode: 'code-1234' });
      assert.equal(ok.data.user.role, 'user'); B = ok.data.user;
      C = (await c.call('POST', '/api/signup', { username: 'park', password: 'password3', name: '박대리', signupCode: 'code-1234' })).data.user;
    });
    await step('중복 아이디와 짧은 비밀번호는 거부된다', async () => {
      assert.equal((await guest.call('POST', '/api/signup', { username: 'lee', password: 'password9', name: '중복', signupCode: 'code-1234' })).status, 409);
      assert.equal((await guest.call('POST', '/api/signup', { username: 'kim2', password: 'short', name: '짧음', signupCode: 'code-1234' })).status, 400);
    });
    await step('로그인하지 않으면 사용할 수 없다', async () => {
      assert.equal((await guest.call('GET', '/api/rooms')).status, 401);
      await assert.rejects(connect(guest));
    });
    await step('전용 헤더가 없는 변경 요청은 거부된다', async () => {
      assert.equal((await a.call('POST', '/api/rooms/direct', { userId: B.id }, {})).status, 403);
    });
    await step('잘못된 비밀번호로는 로그인할 수 없다', async () => {
      assert.equal((await guest.call('POST', '/api/login', { username: 'lee', password: 'wrong-password' })).status, 401);
    });

    await step('1대1 대화방은 한 번만 만들어진다', async () => {
      sa = await connect(a); sb = await connect(b);
      direct = (await a.call('POST', '/api/rooms/direct', { userId: B.id })).data.room;
      const again = (await b.call('POST', '/api/rooms/direct', { userId: A.id })).data.room;
      assert.equal(direct.id, again.id);
    });
    await step('메시지가 실시간으로 전달되고 저장된다', async () => {
      const res = await emit(sa, 'message:send', { roomId: direct.id, content: '안녕하세요, 회의 자료 공유드립니다 <b>테스트</b>' });
      assert.equal(res.ok, true);
      await sleep(150);
      const got = sb.events.find((e) => e.name === 'message:new');
      assert.equal(got.data.content, '안녕하세요, 회의 자료 공유드립니다 <b>테스트</b>');
      const list = (await b.call('GET', `/api/rooms/${direct.id}/messages`)).data.messages;
      assert.equal(list.length, 1);
    });
    await step('안 읽은 수와 읽음 처리가 동작한다', async () => {
      const before = (await b.call('GET', '/api/rooms')).data.rooms.find((r) => r.id === direct.id);
      assert.equal(before.unread, 1);
      await emit(sb, 'room:read', { roomId: direct.id, lastId: before.lastMessage.id });
      await sleep(150);
      const after = (await b.call('GET', '/api/rooms')).data.rooms.find((r) => r.id === direct.id);
      assert.equal(after.unread, 0);
      assert.ok(sa.events.some((e) => e.name === 'room:read' && e.data.userId === B.id));
    });
    await step('빈 메시지와 너무 긴 메시지는 거부된다', async () => {
      assert.equal((await emit(sa, 'message:send', { roomId: direct.id, content: '   ' })).ok, false);
      assert.equal((await emit(sa, 'message:send', { roomId: direct.id, content: 'x'.repeat(4001) })).ok, false);
    });
    await step('참여하지 않은 대화방은 읽거나 쓸 수 없다', async () => {
      assert.equal((await c.call('GET', `/api/rooms/${direct.id}/messages`)).status, 403);
      assert.equal((await c.call('POST', `/api/rooms/${direct.id}/messages`, { content: '침입' })).status, 403);
      const sc = await connect(c);
      assert.equal((await emit(sc, 'message:send', { roomId: direct.id, content: '침입' })).ok, false);
      sc.close();
    });

    await step('그룹 대화방 생성, 초대, 나가기가 동작한다', async () => {
      group = (await a.call('POST', '/api/rooms/group', { name: '프로젝트 방', memberIds: [B.id] })).data.room;
      assert.equal(group.members.length, 2);
      assert.equal((await c.call('POST', `/api/rooms/${group.id}/invite`, { memberIds: [C.id] })).status, 403);
      const invited = (await b.call('POST', `/api/rooms/${group.id}/invite`, { memberIds: [C.id] })).data.room;
      assert.equal(invited.members.length, 3);
      assert.equal((await c.call('POST', `/api/rooms/${group.id}/messages`, { content: '합류했습니다' })).status, 200);
      assert.equal((await c.call('POST', `/api/rooms/${group.id}/leave`)).status, 200);
      assert.equal((await c.call('GET', `/api/rooms/${group.id}/messages`)).status, 403);
      assert.equal((await a.call('POST', `/api/rooms/${direct.id}/leave`)).status, 400);
    });

    await step('한글 이름 파일을 올리고 참여자만 내려받을 수 있다', async () => {
      const form = new FormData();
      form.append('file', new Blob(['분기 보고서 내용']), '3분기 보고서.txt');
      const up = await a.call('POST', `/api/rooms/${direct.id}/files`, form);
      assert.equal(up.status, 200);
      assert.equal(up.data.message.file.name, '3분기 보고서.txt');
      fileId = up.data.message.file.id;
      const down = await b.call('GET', `/api/files/${fileId}`);
      assert.equal(down.data, '분기 보고서 내용');
      assert.match(down.headers.get('content-disposition'), /^attachment/);
      assert.equal((await c.call('GET', `/api/files/${fileId}`)).status, 403);
    });
    await step('용량 제한을 넘는 파일과 참여하지 않은 방의 업로드는 거부된다', async () => {
      const big = new FormData();
      big.append('file', new Blob([Buffer.alloc(1024 * 1024 + 10)]), 'big.bin');
      assert.equal((await a.call('POST', `/api/rooms/${direct.id}/files`, big)).status, 400);
      const form = new FormData();
      form.append('file', new Blob(['x']), 'x.txt');
      assert.equal((await c.call('POST', `/api/rooms/${direct.id}/files`, form)).status, 403);
      assert.equal(fs.readdirSync(path.join(dataDir, 'uploads')).length, 1);
    });
    await step('웹 문서 파일은 화면에 바로 표시되지 않고 내려받기로만 제공된다', async () => {
      const form = new FormData();
      form.append('file', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'page.html');
      const id = (await a.call('POST', `/api/rooms/${direct.id}/files`, form)).data.message.file.id;
      const res = await a.call('GET', `/api/files/${id}?inline=1`);
      assert.match(res.headers.get('content-disposition'), /^attachment/);
      assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    });

    await step('검색은 본인이 참여한 대화방의 메시지만 찾는다', async () => {
      assert.equal((await b.call('GET', `/api/search?q=${encodeURIComponent('회의 자료')}`)).data.results.length, 1);
      assert.equal((await c.call('GET', `/api/search?q=${encodeURIComponent('회의 자료')}`)).data.results.length, 0);
      assert.equal((await b.call('GET', '/api/search?q=%25%25')).data.results.length, 0);
    });
    await step('이전 메시지를 나누어 불러올 수 있다', async () => {
      for (let i = 0; i < 60; i += 1) await a.call('POST', `/api/rooms/${group.id}/messages`, { content: `메시지 ${i}` });
      const first = (await a.call('GET', `/api/rooms/${group.id}/messages`)).data;
      assert.equal(first.messages.length, 50); assert.equal(first.hasMore, true);
      const older = (await a.call('GET', `/api/rooms/${group.id}/messages?before=${first.messages[0].id}`)).data;
      assert.equal(older.hasMore, false);
      assert.ok(older.messages.at(-1).id < first.messages[0].id);
    });

    await step('일반 사용자는 관리 기능을 사용할 수 없다', async () => {
      assert.equal((await b.call('PATCH', `/api/admin/users/${C.id}`, { active: false })).status, 403);
      assert.equal((await a.call('PATCH', `/api/admin/users/${A.id}`, { role: 'user' })).status, 400);
    });
    await step('계정을 중지하면 즉시 접속이 끊기고 로그인할 수 없다', async () => {
      assert.equal((await a.call('PATCH', `/api/admin/users/${B.id}`, { active: false })).status, 200);
      await sleep(200);
      assert.equal(sb.connected, false);
      assert.equal((await b.call('GET', '/api/rooms')).status, 401);
      assert.equal((await b.call('POST', '/api/login', { username: 'lee', password: 'password2' })).status, 403);
    });
    await step('비밀번호 변경과 로그아웃이 동작한다', async () => {
      assert.equal((await c.call('POST', '/api/me/password', { currentPassword: 'wrong-one', newPassword: 'newpassword3' })).status, 400);
      assert.equal((await c.call('POST', '/api/me/password', { currentPassword: 'password3', newPassword: 'newpassword3' })).status, 200);
      assert.equal((await c.call('POST', '/api/logout')).status, 200);
      assert.equal((await c.call('GET', '/api/me')).status, 401);
      assert.equal((await c.call('POST', '/api/login', { username: 'park', password: 'newpassword3' })).status, 200);
    });
    await step('비밀번호는 원문으로 저장되지 않는다', async () => {
      const raw = fs.readFileSync(path.join(dataDir, 'messenger.db')).toString('latin1')
        + (fs.existsSync(path.join(dataDir, 'messenger.db-wal')) ? fs.readFileSync(path.join(dataDir, 'messenger.db-wal')).toString('latin1') : '');
      assert.ok(!raw.includes('password1') && !raw.includes('newpassword3'));
    });

    sa.close();
    console.log(`\n전체 ${passed}개 항목 통과`);
  } finally {
    server.kill();
    await sleep(200);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error('\n실패:', err); process.exit(1); });
