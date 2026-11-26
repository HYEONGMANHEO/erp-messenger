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

    // ───────────── ERP 모듈 ─────────────
    const d = client(); let D;
    const notifications = async (c0) => (await c0.call('GET', '/api/notifications')).data;
    const addDays = (date, n) => { const x = new Date(`${date}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
    let todayStr; let monday; let noticeId; let docId;

    await step('게시판: 공지는 관리자만 작성하고 전 직원에게 알림이 간다', async () => {
      D = (await d.call('POST', '/api/signup', { username: 'choi', password: 'password4', name: '최주임', department: '개발', signupCode: 'code-1234' })).data.user;
      assert.equal((await b.call('POST', '/api/posts', { category: 'notice', title: '공지', content: '내용' })).status, 403);
      sb.events.length = 0;
      const r = await a.call('POST', '/api/posts', { category: 'notice', title: '연말 일정 안내', content: '12월 31일은 휴무입니다.', pinned: true });
      assert.equal(r.status, 200); noticeId = r.data.post.id;
      await sleep(150);
      assert.ok(sb.events.some((e) => e.name === 'notify' && e.data.link === `board:${noticeId}`));
      const list = (await b.call('GET', '/api/posts?category=notice')).data;
      assert.equal(list.total, 1); assert.equal(list.posts[0].pinned, true);
    });
    await step('게시판: 댓글, 수정, 삭제 권한이 지켜진다', async () => {
      const cm = await b.call('POST', `/api/posts/${noticeId}/comments`, { content: '확인했습니다.' });
      assert.equal(cm.status, 200);
      assert.equal((await b.call('GET', `/api/posts/${noticeId}`)).data.comments.length, 1);
      assert.equal((await c.call('DELETE', `/api/comments/${cm.data.comment.id}`)).status, 403);
      assert.equal((await b.call('PATCH', `/api/posts/${noticeId}`, { title: '변조', content: '변조' })).status, 403);
      const mine = (await b.call('POST', '/api/posts', { category: 'general', title: '점심 추천', content: '국밥', pinned: true })).data.post;
      assert.equal(mine.pinned, false);
      assert.equal((await b.call('PATCH', `/api/posts/${mine.id}`, { title: '점심 추천 수정', content: '칼국수' })).data.post.title, '점심 추천 수정');
      assert.equal((await c.call('DELETE', `/api/posts/${mine.id}`)).status, 403);
      assert.equal((await a.call('DELETE', `/api/posts/${mine.id}`)).status, 200);
      assert.equal((await b.call('GET', `/api/posts/${mine.id}`)).status, 404);
    });

    await step('전자결재: 결재선 순서대로만 승인할 수 있다', async () => {
      const base = { type: 'expense', title: '노트북 구매', content: '개발용 장비', amount: 2500000 };
      assert.equal((await b.call('POST', '/api/approvals', { ...base, approverIds: [] })).status, 400);
      assert.equal((await b.call('POST', '/api/approvals', { ...base, approverIds: [B.id] })).status, 400);
      assert.equal((await b.call('POST', '/api/approvals', { ...base, approverIds: [C.id, C.id] })).status, 400);
      assert.equal((await b.call('POST', '/api/approvals', { ...base, amount: -5, approverIds: [C.id] })).status, 400);
      const r = await b.call('POST', '/api/approvals', { ...base, approverIds: [C.id, A.id] });
      assert.equal(r.status, 200); docId = r.data.approval.id;
      assert.equal(r.data.approval.currentApproverId, C.id);
      assert.equal((await a.call('POST', `/api/approvals/${docId}/act`, { action: 'approve' })).status, 403);
      assert.equal((await b.call('POST', `/api/approvals/${docId}/act`, { action: 'approve' })).status, 403);
      assert.equal((await d.call('GET', `/api/approvals/${docId}`)).status, 403);
      assert.equal((await c.call('GET', '/api/approvals?box=todo')).data.todoCount, 1);
      assert.equal((await a.call('GET', '/api/approvals?box=todo')).data.todoCount, 0);
      const first = await c.call('POST', `/api/approvals/${docId}/act`, { action: 'approve', comment: '확인' });
      assert.equal(first.data.approval.status, 'pending'); assert.equal(first.data.approval.currentApproverId, A.id);
      assert.equal((await c.call('POST', `/api/approvals/${docId}/act`, { action: 'approve' })).status, 403);
      const last = await a.call('POST', `/api/approvals/${docId}/act`, { action: 'approve' });
      assert.equal(last.data.approval.status, 'approved');
      assert.equal((await a.call('POST', `/api/approvals/${docId}/act`, { action: 'approve' })).status, 400);
      const note = (await notifications(b)).notifications.find((n) => n.link === `approval:${docId}`);
      assert.equal(note.title, '결재 승인 완료');
    });
    await step('전자결재: 반려에는 사유가 필요하고 회수한 문서는 결재할 수 없다', async () => {
      const mk = async () => (await b.call('POST', '/api/approvals', { type: 'general', title: '외부 교육 참가', content: '교육 신청', approverIds: [C.id] })).data.approval.id;
      const id1 = await mk();
      assert.equal((await c.call('POST', `/api/approvals/${id1}/act`, { action: 'reject' })).status, 400);
      assert.equal((await c.call('POST', `/api/approvals/${id1}/act`, { action: 'reject', comment: '예산 부족' })).data.approval.status, 'rejected');
      const id2 = await mk();
      assert.equal((await c.call('POST', `/api/approvals/${id2}/withdraw`)).status, 403);
      assert.equal((await b.call('POST', `/api/approvals/${id2}/withdraw`)).data.approval.status, 'withdrawn');
      assert.equal((await c.call('POST', `/api/approvals/${id2}/act`, { action: 'approve' })).status, 400);
      assert.equal((await b.call('GET', '/api/approvals?box=all')).status, 403);
      assert.ok((await a.call('GET', '/api/approvals?box=all')).data.approvals.length >= 3);
    });

    await step('근태: 출근과 퇴근이 기록되고 중복 출근은 거부된다', async () => {
      assert.equal((await c.call('POST', '/api/attendance/check-out')).status, 400);
      const cin = await b.call('POST', '/api/attendance/check-in');
      assert.equal(cin.status, 200); todayStr = cin.data.date;
      assert.match(todayStr, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal((await b.call('POST', '/api/attendance/check-in')).status, 400);
      const out = await b.call('POST', '/api/attendance/check-out');
      assert.ok(out.data.record.checkOut);
      assert.equal((await b.call('GET', '/api/attendance')).data.records.length, 1);
      assert.equal((await b.call('GET', '/api/admin/attendance')).status, 403);
      const all = (await a.call('GET', '/api/admin/attendance')).data.records;
      assert.ok(all.find((r) => r.userId === B.id).checkIn);
      assert.equal(all.find((r) => r.userId === C.id).checkIn, null);
    });

    await step('휴가: 신청은 결재로 올라가고 승인되면 연차가 차감된다', async () => {
      monday = addDays(todayStr, ((8 - new Date(`${todayStr}T00:00:00Z`).getUTCDay()) % 7) || 7);
      const year = monday.slice(0, 4);
      const before = (await b.call('GET', `/api/leaves?year=${year}`)).data.balance;
      assert.equal(before.total, 15); assert.equal(before.remaining, 15);
      const weekend = await b.call('POST', '/api/leaves', { type: 'annual', startDate: addDays(monday, 5), endDate: addDays(monday, 6), approverIds: [A.id] });
      assert.equal(weekend.status, 400);
      const req = await b.call('POST', '/api/leaves', { type: 'annual', startDate: monday, endDate: addDays(monday, 2), reason: '가족 여행', approverIds: [A.id] });
      assert.equal(req.status, 200); assert.equal(req.data.leave.days, 3); assert.equal(req.data.leave.status, 'pending');
      const mid = (await b.call('GET', `/api/leaves?year=${year}`)).data.balance;
      assert.equal(mid.pending, 3); assert.equal(mid.remaining, 12);
      const dup = await b.call('POST', '/api/leaves', { type: 'half_am', startDate: addDays(monday, 1), approverIds: [A.id] });
      assert.equal(dup.status, 400);
      assert.equal((await a.call('GET', `/api/leaves/calendar?from=${monday}&to=${addDays(monday, 6)}`)).data.leaves.length, 0);
      await a.call('POST', `/api/approvals/${req.data.leave.approvalId}/act`, { action: 'approve' });
      const after = (await b.call('GET', `/api/leaves?year=${year}`)).data;
      assert.equal(after.leaves[0].status, 'approved'); assert.equal(after.balance.used, 3); assert.equal(after.balance.pending, 0);
      assert.equal((await d.call('GET', `/api/leaves/calendar?from=${monday}&to=${addDays(monday, 6)}`)).data.leaves[0].userId, B.id);
    });
    await step('휴가: 반차, 잔여 부족, 반려와 회수가 올바르게 처리된다', async () => {
      const year = monday.slice(0, 4);
      const half = await b.call('POST', '/api/leaves', { type: 'half_pm', startDate: addDays(monday, 4), endDate: addDays(monday, 30), approverIds: [A.id] });
      assert.equal(half.data.leave.days, 0.5); assert.equal(half.data.leave.endDate, addDays(monday, 4));
      await a.call('POST', `/api/approvals/${half.data.leave.approvalId}/act`, { action: 'reject', comment: '일정 조정 필요' });
      const afterReject = (await b.call('GET', `/api/leaves?year=${year}`)).data;
      assert.equal(afterReject.leaves.find((l) => l.id === half.data.leave.id).status, 'rejected');
      assert.equal(afterReject.balance.remaining, 12);
      assert.equal((await b.call('PATCH', `/api/admin/users/${B.id}/leave`, { annualLeaveDays: 30 })).status, 403);
      assert.equal((await a.call('PATCH', `/api/admin/users/${B.id}/leave`, { annualLeaveDays: 3.3 })).status, 400);
      assert.equal((await a.call('PATCH', `/api/admin/users/${B.id}/leave`, { annualLeaveDays: 3.5 })).data.balance.remaining, 0.5);
      const over = await b.call('POST', '/api/leaves', { type: 'annual', startDate: addDays(monday, 7), endDate: addDays(monday, 7), approverIds: [A.id] });
      assert.equal(over.status, 400);
      const sick = await b.call('POST', '/api/leaves', { type: 'sick', startDate: addDays(monday, 7), endDate: addDays(monday, 8), approverIds: [A.id] });
      assert.equal(sick.status, 200);
      await b.call('POST', `/api/approvals/${sick.data.leave.approvalId}/withdraw`);
      assert.equal((await b.call('GET', `/api/leaves?year=${year}`)).data.leaves.find((l) => l.id === sick.data.leave.id).status, 'withdrawn');
      assert.equal((await a.call('GET', `/api/admin/leaves?year=${year}`)).data.balances.find((x) => x.userId === B.id).used, 3);
    });

    await step('일정: 공개 범위에 따라 보이는 사람이 달라진다', async () => {
      const range = `/api/events?from=${monday}&to=${addDays(monday, 6)}`;
      const mk = (cl, body) => cl.call('POST', '/api/events', { title: '회의', startAt: `${monday}T10:00`, endAt: `${monday}T11:00`, ...body });
      assert.equal((await mk(b, { scope: 'personal', startAt: `${monday}T12:00`, endAt: `${monday}T11:00` })).status, 400);
      assert.equal((await mk(b, { scope: 'secret' })).status, 400);
      assert.equal((await mk(c, { scope: 'department' })).status, 400); // 부서 정보가 없는 사용자
      const personal = (await mk(b, { scope: 'personal', title: '개인 약속' })).data.event;
      const dept = (await mk(b, { scope: 'department', title: '개발팀 주간회의' })).data.event;
      const company = (await mk(b, { scope: 'company', title: '전사 워크숍', allDay: true, startAt: monday, endAt: addDays(monday, 1) })).data.event;
      assert.equal(company.startAt, `${monday}T00:00`); assert.equal(company.endAt, `${addDays(monday, 1)}T23:59`);
      const titles = async (cl) => (await cl.call('GET', range)).data.events.map((e) => e.title).sort();
      assert.deepEqual(await titles(b), ['개발팀 주간회의', '개인 약속', '전사 워크숍'].sort());
      assert.deepEqual(await titles(d), ['개발팀 주간회의', '전사 워크숍'].sort()); // 같은 부서
      assert.deepEqual(await titles(c), ['전사 워크숍']);
      assert.deepEqual(await titles(a), ['전사 워크숍']); // 관리자도 남의 개인 일정은 볼 수 없다
      assert.equal((await c.call('DELETE', `/api/events/${company.id}`)).status, 403);
      assert.equal((await a.call('DELETE', `/api/events/${personal.id}`)).status, 404);
      const edited = await a.call('PATCH', `/api/events/${company.id}`, { title: '전사 워크숍 (변경)', scope: 'company', startAt: `${monday}T09:00`, endAt: `${monday}T18:00` });
      assert.equal(edited.data.event.title, '전사 워크숍 (변경)');
      assert.equal((await b.call('DELETE', `/api/events/${dept.id}`)).status, 200);
      assert.equal((await b.call('GET', '/api/events?from=abc&to=def')).status, 400);
    });

    await step('알림: 내 알림만 조회되고 읽음 처리된다', async () => {
      const mine = await notifications(b);
      assert.ok(mine.unread > 0);
      assert.ok(mine.notifications.every((n) => typeof n.title === 'string'));
      await b.call('POST', '/api/notifications/read');
      assert.equal((await notifications(b)).unread, 0);
      assert.ok((await notifications(c)).unread > 0);
    });
    await step('이전 버전 데이터베이스가 자동으로 변환된다', async () => {
      const { DatabaseSync } = require('node:sqlite');
      const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'messenger-old-'));
      const old = new DatabaseSync(path.join(oldDir, 'messenger.db'));
      old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
        name TEXT NOT NULL, department TEXT NOT NULL DEFAULT '', position TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'user',
        active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
        INSERT INTO users (username, password_hash, name, created_at) VALUES ('old', 'x', '기존 직원', '2026-01-01');`);
      old.close();
      const upgraded = require('../src/db').open(oldDir);
      const row = upgraded.prepare('SELECT name, annual_leave_days FROM users').get();
      assert.equal(row.name, '기존 직원'); assert.equal(row.annual_leave_days, 15);
      upgraded.close();
      require('../src/db').open(oldDir).close(); // 두 번 열어도 문제가 없어야 한다
      fs.rmSync(oldDir, { recursive: true, force: true });
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
