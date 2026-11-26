// 전자결재 화면
(() => {
  'use strict';
  const { h, api, guard, toast, openModal, page, tabs, statusChip, approverPicker, linkify, userName, userLabel, dateTime, state } = App;
  const local = { box: 'todo' };
  const won = (n) => `${Number(n).toLocaleString('ko-KR')}원`;

  // 결재 처리 뒤에는 지금 보고 있는 화면(결재, 근태, 홈 등)을 다시 그려 최신 상태를 반영한다.
  const refresh = () => { App.refreshCounts().catch(() => {}); App.go(state.view); };

  // 결재 문서 상세. 홈, 알림, 휴가 목록에서도 열 수 있도록 공개한다.
  App.openApproval = guard(async (id) => {
    const { approval: a } = await api('GET', `/api/approvals/${id}`);
    const myTurn = a.status === 'pending' && a.currentApproverId === state.me.id;
    const comment = h('textarea', { class: 'input area', rows: '2', maxlength: '500', placeholder: '의견 (반려 시 필수)' });
    const body = h('div', { class: 'stack' },
      h('div', { class: 'doc-meta' },
        h('div', null, h('span', { class: 'muted' }, '종류'), h('span', null, a.typeLabel)),
        h('div', null, h('span', { class: 'muted' }, '기안자'), h('span', null, userLabel(a.drafterId))),
        h('div', null, h('span', { class: 'muted' }, '기안일'), h('span', null, dateTime(a.createdAt))),
        h('div', null, h('span', { class: 'muted' }, '상태'), statusChip(a.status)),
        a.amount !== null ? h('div', null, h('span', { class: 'muted' }, '금액'), h('strong', null, won(a.amount))) : null),
      h('div', { class: 'post-content boxed' }, linkify(a.content)),
      h('h3', null, '결재선'),
      h('ol', { class: 'steps' }, a.steps.map((s) => h('li', { class: `step ${s.status}` },
        h('div', { class: 'item-top' }, h('span', null, `${s.stepNo}차 `, h('strong', null, userLabel(s.approverId))), statusChip(s.status)),
        s.actedAt ? h('div', { class: 'muted small' }, dateTime(s.actedAt)) : null,
        s.comment ? h('div', { class: 'step-comment' }, s.comment) : null))),
      myTurn ? comment : null);

    const actions = [];
    const act = (action, done) => async (close) => {
      await api('POST', `/api/approvals/${id}/act`, { action, comment: comment.value });
      close(); toast(done); refresh();
    };
    if (myTurn) {
      actions.push({ label: '반려', run: act('reject', '반려했습니다.') });
      actions.push({ label: '승인', primary: true, run: act('approve', '승인했습니다.') });
    }
    if (a.status === 'pending' && a.drafterId === state.me.id) {
      actions.push({
        label: '회수', run: async (close) => {
          if (!confirm('이 문서를 회수하시겠습니까?')) return;
          await api('POST', `/api/approvals/${id}/withdraw`);
          close(); toast('회수했습니다.'); refresh();
        },
      });
    }
    openModal(a.title, body, actions, { wide: true, noFocus: true });
  });

  function openDraft() {
    const type = h('select', { class: 'input' }, h('option', { value: 'general' }, '품의서'), h('option', { value: 'expense' }, '지출결의서'));
    const title = h('input', { class: 'input', maxlength: '100', placeholder: '제목' });
    const amount = h('input', { class: 'input', type: 'number', min: '1', step: '1', placeholder: '금액 (원)' });
    const amountField = h('label', { class: 'field', hidden: true }, h('span', null, '금액'), amount);
    type.addEventListener('change', () => { amountField.hidden = type.value !== 'expense'; });
    const content = h('textarea', { class: 'input area', rows: '8', maxlength: '10000', placeholder: '내용' });
    const picker = approverPicker();
    const body = h('div', { class: 'stack' }, h('label', { class: 'field' }, h('span', null, '문서 종류'), type), title, amountField, content, picker.node);
    openModal('기안하기', body, [{
      label: '결재 요청', primary: true,
      run: async (close) => {
        await api('POST', '/api/approvals', {
          type: type.value, title: title.value, content: content.value,
          amount: type.value === 'expense' ? Number(amount.value) : undefined, approverIds: picker.ids(),
        });
        close(); toast('결재를 요청했습니다.');
        local.box = 'mine';
        refresh();
      },
    }], { wide: true });
  }

  const showList = guard(async (el) => {
    const { approvals, todoCount } = await api('GET', `/api/approvals?box=${local.box}`);
    if (state.view !== 'approval') return;
    state.approvalTodo = todoCount;
    App.renderRail();
    const boxes = [['todo', '결재할 문서', todoCount], ['mine', '내가 올린 문서'], ['done', '결재한 문서']];
    if (state.me.role === 'admin') boxes.push(['all', '전체 문서']);
    const table = approvals.length ? h('div', { class: 'table' },
      h('div', { class: 'tr th approval-row' }, h('span', null, '제목'), h('span', null, '종류'), h('span', null, '기안자'), h('span', null, '현재 결재자'), h('span', null, '상태')),
      approvals.map((a) => h('button', { class: 'tr approval-row', onclick: () => App.openApproval(a.id) },
        h('span', { class: 'ellipsis' }, a.title, a.amount !== null ? h('span', { class: 'muted small' }, ` ${won(a.amount)}`) : null),
        h('span', { class: 'muted' }, a.typeLabel), h('span', { class: 'muted' }, userName(a.drafterId)),
        h('span', { class: 'muted' }, a.currentApproverId ? `${userName(a.currentApproverId)} (${a.currentStep}/${a.stepCount})` : '-'),
        h('span', null, statusChip(a.status)))))
      : h('p', { class: 'empty' }, '해당하는 문서가 없습니다.');
    el.replaceChildren(page('전자결재', [h('button', { class: 'btn primary', onclick: openDraft }, '기안하기')],
      tabs(boxes, local.box, (id) => { local.box = id; showList(el); }), table));
  });

  App.registerView({
    id: 'approval', label: '결재', order: 40, badge: () => state.approvalTodo,
    render(el) { showList(el); },
  });
})();
