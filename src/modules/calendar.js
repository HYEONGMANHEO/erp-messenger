'use strict';
// 일정·캘린더 모듈.
// 공개 범위: personal(본인만), department(작성 당시 같은 부서), company(전 직원)
const SCOPES = { personal: '개인', department: '부서', company: '전사' };
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

module.exports = ({ app, db, auth, fail, toId, cleanText, now, isDate }) => {
  const row = (e) => ({
    id: e.id, title: e.title, description: e.description, location: e.location, startAt: e.start_at, endAt: e.end_at,
    allDay: !!e.all_day, scope: e.scope, scopeLabel: SCOPES[e.scope], department: e.department, userId: e.user_id,
  });
  const canView = (user, e) =>
    e.scope === 'company' || e.user_id === user.id || (e.scope === 'department' && e.department && e.department === user.department);
  const canEdit = (user, e) => e.user_id === user.id || (user.role === 'admin' && e.scope !== 'personal');
  const findEvent = (id) => db.prepare('SELECT * FROM events WHERE id = ?').get(id) || fail(404, '일정을 찾을 수 없습니다.');

  const validDateTime = (value) => typeof value === 'string' && DATETIME.test(value) && isDate(value.slice(0, 10))
    && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60;

  function readInput(body, user) {
    const title = cleanText(body.title, 100);
    if (!title) fail(400, '일정 제목을 입력해 주세요.');
    if (!SCOPES[body.scope]) fail(400, '공개 범위를 선택해 주세요.');
    if (body.scope === 'department' && !user.department) fail(400, '부서 정보가 없어 부서 일정을 만들 수 없습니다. 설정에서 부서를 입력해 주세요.');
    const allDay = body.allDay ? 1 : 0;
    let startAt = body.startAt;
    let endAt = body.endAt;
    if (allDay) { // 종일 일정은 날짜만 받아 하루의 시작과 끝으로 저장한다
      if (!isDate(String(startAt).slice(0, 10)) || !isDate(String(endAt).slice(0, 10))) fail(400, '일정 날짜를 올바르게 입력해 주세요.');
      startAt = `${String(startAt).slice(0, 10)}T00:00`;
      endAt = `${String(endAt).slice(0, 10)}T23:59`;
    }
    if (!validDateTime(startAt) || !validDateTime(endAt)) fail(400, '일정 시각을 올바르게 입력해 주세요.');
    if (endAt < startAt) fail(400, '종료 시각이 시작 시각보다 빠릅니다.');
    return {
      title, startAt, endAt, allDay, scope: body.scope,
      description: cleanText(body.description, 1000), location: cleanText(body.location, 100),
      department: body.scope === 'department' ? user.department : '',
    };
  }

  app.get('/api/events', auth, (req, res) => {
    if (!isDate(req.query.from) || !isDate(req.query.to)) fail(400, '조회 기간이 올바르지 않습니다.');
    const rows = db.prepare('SELECT * FROM events WHERE start_at <= ? AND end_at >= ? ORDER BY start_at, id')
      .all(`${req.query.to}T23:59`, `${req.query.from}T00:00`);
    res.json({ events: rows.filter((e) => canView(req.user, e)).map(row), scopes: SCOPES });
  });

  app.post('/api/events', auth, (req, res) => {
    const e = readInput(req.body, req.user);
    const id = Number(db.prepare(`
      INSERT INTO events (title, description, location, start_at, end_at, all_day, scope, department, user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.title, e.description, e.location, e.startAt, e.endAt, e.allDay, e.scope, e.department, req.user.id, now()).lastInsertRowid);
    res.json({ event: row(findEvent(id)) });
  });

  app.patch('/api/events/:id', auth, (req, res) => {
    const existing = findEvent(toId(req.params.id));
    if (!canView(req.user, existing)) fail(404, '일정을 찾을 수 없습니다.');
    if (!canEdit(req.user, existing)) fail(403, '작성자와 관리자만 수정할 수 있습니다.');
    const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(existing.user_id);
    const e = readInput(req.body, owner);
    db.prepare(`
      UPDATE events SET title = ?, description = ?, location = ?, start_at = ?, end_at = ?, all_day = ?, scope = ?, department = ? WHERE id = ?
    `).run(e.title, e.description, e.location, e.startAt, e.endAt, e.allDay, e.scope, e.department, existing.id);
    res.json({ event: row(findEvent(existing.id)) });
  });

  app.delete('/api/events/:id', auth, (req, res) => {
    const existing = findEvent(toId(req.params.id));
    if (!canView(req.user, existing)) fail(404, '일정을 찾을 수 없습니다.');
    if (!canEdit(req.user, existing)) fail(403, '작성자와 관리자만 삭제할 수 있습니다.');
    db.prepare('DELETE FROM events WHERE id = ?').run(existing.id);
    res.json({ ok: true });
  });
};
