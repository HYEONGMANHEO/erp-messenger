'use strict';
// 전자결재 모듈.
// 기안자가 결재선(1~5명)을 순서대로 지정하면, 앞 순서부터 차례로 승인 또는 반려한다.
// 휴가 신청도 같은 결재 문서로 처리되며, 결과는 hooks.approvalChanged 로 근태 모듈에 전달된다.
const TYPES = { general: '품의서', expense: '지출결의서', leave: '휴가신청서' };
const MAX_APPROVERS = 5;

module.exports = (ctx) => {
  const { app, db, auth, fail, toId, cleanText, now, notify, activeUsersByIds, hooks } = ctx;

  const findApproval = (id) => db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) || fail(404, '결재 문서를 찾을 수 없습니다.');
  const stepsOf = (id) => db.prepare('SELECT * FROM approval_steps WHERE approval_id = ? ORDER BY step_no').all(id);
  const canView = (user, approval, steps) =>
    user.role === 'admin' || approval.drafter_id === user.id || steps.some((s) => s.approver_id === user.id);

  function payload(a, withDetail = false) {
    const steps = stepsOf(a.id);
    const current = a.status === 'pending' ? steps.find((s) => s.step_no === a.current_step) : null;
    const base = {
      id: a.id, type: a.type, typeLabel: TYPES[a.type], title: a.title, amount: a.amount, drafterId: a.drafter_id,
      status: a.status, createdAt: a.created_at, completedAt: a.completed_at,
      currentApproverId: current ? current.approver_id : null, stepCount: steps.length, currentStep: a.current_step,
    };
    if (!withDetail) return base;
    return {
      ...base, content: a.content,
      steps: steps.map((s) => ({ stepNo: s.step_no, approverId: s.approver_id, status: s.status, comment: s.comment, actedAt: s.acted_at })),
    };
  }

  // 결재선 검증: 1~5명, 중복 없음, 본인 제외, 사용 중인 계정만 허용
  function readApprovers(ids, drafterId) {
    if (!Array.isArray(ids) || ids.length === 0) fail(400, '결재자를 한 명 이상 지정해 주세요.');
    if (ids.length > MAX_APPROVERS) fail(400, `결재자는 ${MAX_APPROVERS}명까지 지정할 수 있습니다.`);
    const numeric = ids.map(Number);
    if (new Set(numeric).size !== numeric.length) fail(400, '같은 결재자를 두 번 지정할 수 없습니다.');
    if (numeric.includes(drafterId)) fail(400, '본인을 결재자로 지정할 수 없습니다.');
    const users = activeUsersByIds(numeric);
    if (users.length !== numeric.length) fail(400, '결재자 정보가 올바르지 않습니다.');
    return numeric;
  }

  // 결재 문서 생성. 다른 모듈(휴가 신청)에서도 사용하므로 ctx 로 공개한다. 트랜잭션 안에서 호출해야 한다.
  ctx.createApproval = ({ type, title, content, amount = null, drafter, approverIds }) => {
    const approvers = readApprovers(approverIds, drafter.id);
    const id = Number(db.prepare(`
      INSERT INTO approvals (type, title, content, amount, drafter_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(type, title, content, amount, drafter.id, now()).lastInsertRowid);
    const insert = db.prepare('INSERT INTO approval_steps (approval_id, step_no, approver_id, status) VALUES (?, ?, ?, ?)');
    approvers.forEach((approverId, i) => insert.run(id, i + 1, approverId, i === 0 ? 'pending' : 'waiting'));
    return { id, firstApproverId: approvers[0] };
  };
  ctx.notifyApprovalRequested = (approvalId, approverId, drafterName, title) =>
    notify([approverId], { type: 'approval', title: '결재 요청', body: `${drafterName}: ${title}`, link: `approval:${approvalId}` });

  const runHooks = (approval) => hooks.approvalChanged.forEach((fn) => fn(approval));

  app.get('/api/approvals', auth, (req, res) => {
    const box = req.query.box;
    let rows;
    if (box === 'todo') {
      rows = db.prepare(`
        SELECT a.* FROM approvals a JOIN approval_steps s ON s.approval_id = a.id
        WHERE s.approver_id = ? AND s.status = 'pending' AND a.status = 'pending' ORDER BY a.id DESC LIMIT 100
      `).all(req.user.id);
    } else if (box === 'done') {
      rows = db.prepare(`
        SELECT a.* FROM approvals a JOIN approval_steps s ON s.approval_id = a.id
        WHERE s.approver_id = ? AND s.status IN ('approved', 'rejected') ORDER BY a.id DESC LIMIT 100
      `).all(req.user.id);
    } else if (box === 'all') {
      if (req.user.role !== 'admin') fail(403, '관리자만 사용할 수 있습니다.');
      rows = db.prepare('SELECT * FROM approvals ORDER BY id DESC LIMIT 200').all();
    } else {
      rows = db.prepare('SELECT * FROM approvals WHERE drafter_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id);
    }
    const todoCount = db.prepare(`
      SELECT COUNT(*) AS n FROM approvals a JOIN approval_steps s ON s.approval_id = a.id
      WHERE s.approver_id = ? AND s.status = 'pending' AND a.status = 'pending'
    `).get(req.user.id).n;
    res.json({ approvals: rows.map((a) => payload(a)), todoCount });
  });

  app.get('/api/approvals/:id', auth, (req, res) => {
    const approval = findApproval(toId(req.params.id));
    if (!canView(req.user, approval, stepsOf(approval.id))) fail(403, '열람 권한이 없는 문서입니다.');
    res.json({ approval: payload(approval, true) });
  });

  app.post('/api/approvals', auth, (req, res) => {
    const type = req.body.type;
    if (type !== 'general' && type !== 'expense') fail(400, '문서 종류를 선택해 주세요.');
    const title = cleanText(req.body.title, 100);
    const content = String(req.body.content ?? '').trim();
    if (!title) fail(400, '제목을 입력해 주세요.');
    if (!content) fail(400, '내용을 입력해 주세요.');
    if (content.length > 10000) fail(400, '내용은 10,000자까지 입력할 수 있습니다.');
    let amount = null;
    if (type === 'expense') {
      amount = Number(req.body.amount);
      if (!Number.isInteger(amount) || amount <= 0 || amount > 1e12) fail(400, '금액을 올바르게 입력해 주세요.');
    }
    const created = db.tx(() => ctx.createApproval({ type, title, content, amount, drafter: req.user, approverIds: req.body.approverIds }));
    ctx.notifyApprovalRequested(created.id, created.firstApproverId, req.user.name, title);
    res.json({ approval: payload(findApproval(created.id), true) });
  });

  app.post('/api/approvals/:id/act', auth, (req, res) => {
    const id = toId(req.params.id);
    const action = req.body.action;
    if (action !== 'approve' && action !== 'reject') fail(400, '잘못된 요청입니다.');
    const comment = cleanText(req.body.comment, 500);
    if (action === 'reject' && !comment) fail(400, '반려 사유를 입력해 주세요.');

    const result = db.tx(() => {
      const approval = findApproval(id);
      if (approval.status !== 'pending') fail(400, '이미 처리가 끝난 문서입니다.');
      const steps = stepsOf(id);
      const step = steps.find((s) => s.step_no === approval.current_step);
      if (!step || step.approver_id !== req.user.id || step.status !== 'pending') fail(403, '지금 결재할 차례가 아닙니다.');
      const t = now();
      db.prepare('UPDATE approval_steps SET status = ?, comment = ?, acted_at = ? WHERE approval_id = ? AND step_no = ?')
        .run(action === 'approve' ? 'approved' : 'rejected', comment, t, id, step.step_no);
      const next = steps.find((s) => s.step_no === step.step_no + 1);
      if (action === 'approve' && next) {
        db.prepare("UPDATE approval_steps SET status = 'pending' WHERE approval_id = ? AND step_no = ?").run(id, next.step_no);
        db.prepare('UPDATE approvals SET current_step = ? WHERE id = ?').run(next.step_no, id);
        return { nextApproverId: next.approver_id };
      }
      db.prepare('UPDATE approvals SET status = ?, completed_at = ? WHERE id = ?').run(action === 'approve' ? 'approved' : 'rejected', t, id);
      runHooks(findApproval(id));
      return { finished: true };
    });

    const approval = findApproval(id);
    const drafter = db.prepare('SELECT name FROM users WHERE id = ?').get(approval.drafter_id);
    if (result.nextApproverId) ctx.notifyApprovalRequested(id, result.nextApproverId, drafter.name, approval.title);
    if (result.finished) {
      notify([approval.drafter_id], {
        type: 'approval', link: `approval:${id}`, body: approval.title,
        title: approval.status === 'approved' ? '결재 승인 완료' : '결재 반려',
      });
    }
    res.json({ approval: payload(approval, true) });
  });

  app.post('/api/approvals/:id/withdraw', auth, (req, res) => {
    const id = toId(req.params.id);
    db.tx(() => {
      const approval = findApproval(id);
      if (approval.drafter_id !== req.user.id) fail(403, '기안자만 회수할 수 있습니다.');
      if (approval.status !== 'pending') fail(400, '진행 중인 문서만 회수할 수 있습니다.');
      db.prepare("UPDATE approvals SET status = 'withdrawn', completed_at = ? WHERE id = ?").run(now(), id);
      db.prepare("UPDATE approval_steps SET status = 'waiting' WHERE approval_id = ? AND status = 'pending'").run(id);
      runHooks(findApproval(id));
    });
    res.json({ approval: payload(findApproval(id), true) });
  });
};
