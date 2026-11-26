'use strict';
// 근태·휴가 모듈.
// 출퇴근 기록과 휴가 신청을 다룬다. 휴가 신청은 전자결재 문서로 올라가며, 최종 승인되면 휴가로 확정된다.
const LEAVE_TYPES = { annual: '연차', half_am: '오전 반차', half_pm: '오후 반차', sick: '병가', etc: '기타 휴가' };
const DEDUCTING = new Set(['annual', 'half_am', 'half_pm']); // 연차에서 차감되는 종류
const MAX_RANGE_DAYS = 60;

module.exports = (ctx) => {
  const { app, db, auth, adminOnly, fail, toId, cleanText, now, today, isDate, hooks } = ctx;

  // ── 출퇴근 ──
  const attendanceRow = (r) => (r ? { workDate: r.work_date, checkIn: r.check_in, checkOut: r.check_out } : null);
  const todayRecord = (userId) => db.prepare('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?').get(userId, today());

  app.get('/api/attendance/today', auth, (req, res) => {
    res.json({ date: today(), record: attendanceRow(todayRecord(req.user.id)) });
  });

  app.post('/api/attendance/check-in', auth, (req, res) => {
    if (todayRecord(req.user.id)) fail(400, '오늘은 이미 출근 처리되었습니다.');
    db.prepare('INSERT INTO attendance (user_id, work_date, check_in) VALUES (?, ?, ?)').run(req.user.id, today(), now());
    res.json({ date: today(), record: attendanceRow(todayRecord(req.user.id)) });
  });

  app.post('/api/attendance/check-out', auth, (req, res) => {
    const record = todayRecord(req.user.id) || fail(400, '출근 기록이 없습니다. 먼저 출근 처리를 해 주세요.');
    db.prepare('UPDATE attendance SET check_out = ? WHERE id = ?').run(now(), record.id); // 다시 누르면 퇴근 시각을 갱신한다
    res.json({ date: today(), record: attendanceRow(todayRecord(req.user.id)) });
  });

  app.get('/api/attendance', auth, (req, res) => {
    const month = /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : today().slice(0, 7);
    const rows = db.prepare('SELECT * FROM attendance WHERE user_id = ? AND work_date LIKE ? ORDER BY work_date DESC')
      .all(req.user.id, `${month}-%`);
    res.json({ month, records: rows.map(attendanceRow) });
  });

  app.get('/api/admin/attendance', auth, adminOnly, (req, res) => {
    const date = isDate(req.query.date) ? req.query.date : today();
    const rows = db.prepare(`
      SELECT u.id AS user_id, a.check_in, a.check_out FROM users u
      LEFT JOIN attendance a ON a.user_id = u.id AND a.work_date = ?
      WHERE u.active = 1 ORDER BY u.department, u.name
    `).all(date);
    const onLeave = db.prepare(`
      SELECT user_id, type FROM leave_requests WHERE status = 'approved' AND start_date <= ? AND end_date >= ?
    `).all(date, date);
    const leaveByUser = new Map(onLeave.map((l) => [l.user_id, LEAVE_TYPES[l.type]]));
    res.json({
      date,
      records: rows.map((r) => ({ userId: r.user_id, checkIn: r.check_in, checkOut: r.check_out, leave: leaveByUser.get(r.user_id) || null })),
    });
  });

  // ── 휴가 ──
  const leaveRow = (l) => ({
    id: l.id, userId: l.user_id, type: l.type, typeLabel: LEAVE_TYPES[l.type], startDate: l.start_date, endDate: l.end_date,
    days: l.days, reason: l.reason, status: l.status, approvalId: l.approval_id, createdAt: l.created_at,
  });

  // 시작일부터 종료일까지 주말을 제외한 일수 (공휴일은 반영하지 않는다)
  function countWeekdays(start, end) {
    let count = 0;
    for (let d = new Date(`${start}T00:00:00Z`); d <= new Date(`${end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      const day = d.getUTCDay();
      if (day !== 0 && day !== 6) count += 1;
    }
    return count;
  }

  function balanceOf(userId, year) {
    const total = db.prepare('SELECT annual_leave_days AS n FROM users WHERE id = ?').get(userId).n;
    const sum = (status) => db.prepare(`
      SELECT COALESCE(SUM(days), 0) AS n FROM leave_requests
      WHERE user_id = ? AND status = ? AND type IN ('annual', 'half_am', 'half_pm') AND start_date LIKE ?
    `).get(userId, status, `${year}-%`).n;
    const used = sum('approved');
    const pending = sum('pending');
    return { year, total, used, pending, remaining: total - used - pending };
  }

  app.get('/api/leaves', auth, (req, res) => {
    const year = /^\d{4}$/.test(req.query.year) ? req.query.year : today().slice(0, 4);
    const rows = db.prepare('SELECT * FROM leave_requests WHERE user_id = ? AND start_date LIKE ? ORDER BY start_date DESC, id DESC')
      .all(req.user.id, `${year}-%`);
    res.json({ leaves: rows.map(leaveRow), balance: balanceOf(req.user.id, year), types: LEAVE_TYPES });
  });

  // 달력 표시용: 기간에 걸친 승인된 휴가 (전 직원)
  app.get('/api/leaves/calendar', auth, (req, res) => {
    if (!isDate(req.query.from) || !isDate(req.query.to)) fail(400, '조회 기간이 올바르지 않습니다.');
    const rows = db.prepare(`
      SELECT * FROM leave_requests WHERE status = 'approved' AND start_date <= ? AND end_date >= ? ORDER BY start_date
    `).all(req.query.to, req.query.from);
    res.json({ leaves: rows.map((l) => ({ id: l.id, userId: l.user_id, typeLabel: LEAVE_TYPES[l.type], startDate: l.start_date, endDate: l.end_date })) });
  });

  app.post('/api/leaves', auth, (req, res) => {
    const { type } = req.body;
    if (!LEAVE_TYPES[type]) fail(400, '휴가 종류를 선택해 주세요.');
    const startDate = req.body.startDate;
    const endDate = type.startsWith('half_') ? startDate : req.body.endDate;
    if (!isDate(startDate) || !isDate(endDate)) fail(400, '휴가 기간을 올바르게 입력해 주세요.');
    if (endDate < startDate) fail(400, '종료일이 시작일보다 빠릅니다.');
    if ((Date.parse(endDate) - Date.parse(startDate)) / 86400000 >= MAX_RANGE_DAYS) fail(400, `한 번에 ${MAX_RANGE_DAYS}일까지 신청할 수 있습니다.`);
    const weekdays = countWeekdays(startDate, endDate);
    if (weekdays === 0) fail(400, '선택한 기간에 근무일이 없습니다.');
    const days = type.startsWith('half_') ? 0.5 : weekdays;
    const reason = cleanText(req.body.reason, 500);

    const result = db.tx(() => {
      const overlap = db.prepare(`
        SELECT 1 FROM leave_requests WHERE user_id = ? AND status IN ('pending', 'approved') AND start_date <= ? AND end_date >= ?
      `).get(req.user.id, endDate, startDate);
      if (overlap) fail(400, '같은 기간에 이미 신청했거나 승인된 휴가가 있습니다.');
      if (DEDUCTING.has(type)) {
        const balance = balanceOf(req.user.id, startDate.slice(0, 4));
        if (balance.remaining < days) fail(400, `잔여 연차가 부족합니다. (잔여 ${balance.remaining}일, 신청 ${days}일)`);
      }
      const period = startDate === endDate ? startDate : `${startDate} ~ ${endDate}`;
      const title = `${LEAVE_TYPES[type]} 신청 (${period}, ${days}일)`;
      const approval = ctx.createApproval({
        type: 'leave', title, content: reason || '사유 미기재', drafter: req.user, approverIds: req.body.approverIds,
      });
      const id = Number(db.prepare(`
        INSERT INTO leave_requests (user_id, type, start_date, end_date, days, reason, approval_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.user.id, type, startDate, endDate, days, reason, approval.id, now()).lastInsertRowid);
      return { id, approval, title };
    });
    ctx.notifyApprovalRequested(result.approval.id, result.approval.firstApproverId, req.user.name, result.title);
    res.json({ leave: leaveRow(db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(result.id)) });
  });

  // 결재 결과(승인, 반려, 회수)를 휴가 신청 상태에 반영한다.
  hooks.approvalChanged.push((approval) => {
    if (approval.type !== 'leave') return;
    db.prepare('UPDATE leave_requests SET status = ? WHERE approval_id = ?').run(approval.status, approval.id);
  });

  // ── 관리자: 연차 현황과 부여 일수 ──
  app.get('/api/admin/leaves', auth, adminOnly, (req, res) => {
    const year = /^\d{4}$/.test(req.query.year) ? req.query.year : today().slice(0, 4);
    const users = db.prepare('SELECT id FROM users WHERE active = 1 ORDER BY department, name').all();
    res.json({ year, balances: users.map((u) => ({ userId: u.id, ...balanceOf(u.id, year) })) });
  });

  app.patch('/api/admin/users/:id/leave', auth, adminOnly, (req, res) => {
    const id = toId(req.params.id);
    const days = Number(req.body.annualLeaveDays);
    if (!Number.isFinite(days) || days < 0 || days > 100 || (days * 2) % 1 !== 0) fail(400, '연차 일수는 0에서 100 사이의 0.5 단위로 입력해 주세요.');
    const info = db.prepare('UPDATE users SET annual_leave_days = ? WHERE id = ?').run(days, id);
    if (!info.changes) fail(404, '사용자를 찾을 수 없습니다.');
    res.json({ balance: balanceOf(id, today().slice(0, 4)) });
  });
};
