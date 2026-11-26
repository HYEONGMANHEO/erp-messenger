// 근태·휴가 화면
(() => {
  'use strict';
  const { h, api, guard, toast, openModal, page, tabs, statusChip, approverPicker, userName, userLabel, ymd, timeOf, state } = App;
  const local = { tab: 'work', month: null, adminDate: null };
  const pad = (n) => String(n).padStart(2, '0');
  const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
  const withDay = (date) => `${date} (${WEEK[new Date(`${date}T00:00:00`).getDay()]})`;

  function duration(record) {
    if (!record?.checkOut) return '-';
    const minutes = Math.max(Math.round((new Date(record.checkOut) - new Date(record.checkIn)) / 60000), 0);
    return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
  }
  const shiftMonth = (month, diff) => { const [y, m] = month.split('-').map(Number); const d = new Date(y, m - 1 + diff, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };

  // ── 출퇴근 ──
  const showWork = guard(async (el, body) => {
    const [today, list] = await Promise.all([api('GET', '/api/attendance/today'), api('GET', `/api/attendance?month=${local.month}`)]);
    if (state.view !== 'attendance' || local.tab !== 'work') return;
    const record = today.record;
    const punch = (path, done) => guard(async () => { await api('POST', path); toast(done); showWork(el, body); });
    body.replaceChildren(
      h('section', { class: 'panel' },
        h('h3', null, `오늘 ${withDay(today.date)}`),
        h('div', { class: 'stat-row' },
          h('div', { class: 'stat' }, h('span', { class: 'muted small' }, '출근'), h('strong', null, record ? timeOf(record.checkIn) : '-')),
          h('div', { class: 'stat' }, h('span', { class: 'muted small' }, '퇴근'), h('strong', null, record?.checkOut ? timeOf(record.checkOut) : '-')),
          h('div', { class: 'stat' }, h('span', { class: 'muted small' }, '근무 시간'), h('strong', null, duration(record)))),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn primary', disabled: !!record, onclick: punch('/api/attendance/check-in', '출근 처리되었습니다.') }, '출근'),
          h('button', { class: 'btn', disabled: !record, onclick: punch('/api/attendance/check-out', '퇴근 처리되었습니다.') }, record?.checkOut ? '퇴근 시각 갱신' : '퇴근'))),
      h('section', { class: 'panel' },
        h('div', { class: 'month-nav' },
          h('button', { class: 'btn small', onclick: () => { local.month = shiftMonth(local.month, -1); showWork(el, body); } }, '이전 달'),
          h('strong', null, `${local.month.replace('-', '년 ')}월 근무 기록`),
          h('button', { class: 'btn small', onclick: () => { local.month = shiftMonth(local.month, 1); showWork(el, body); } }, '다음 달')),
        list.records.length ? h('div', { class: 'table' },
          h('div', { class: 'tr th work-row' }, h('span', null, '날짜'), h('span', null, '출근'), h('span', null, '퇴근'), h('span', null, '근무 시간')),
          list.records.map((r) => h('div', { class: 'tr work-row' }, h('span', null, withDay(r.workDate)), h('span', null, timeOf(r.checkIn)),
            h('span', null, r.checkOut ? timeOf(r.checkOut) : '-'), h('span', { class: 'muted' }, duration(r)))))
          : h('p', { class: 'empty' }, '근무 기록이 없습니다.')));
  });

  // ── 휴가 ──
  function openLeaveForm(el, body, types) {
    const type = h('select', { class: 'input' }, Object.entries(types).map(([id, label]) => h('option', { value: id }, label)));
    const today = ymd(new Date());
    const start = h('input', { class: 'input', type: 'date', value: today });
    const end = h('input', { class: 'input', type: 'date', value: today });
    const endField = h('label', { class: 'field' }, h('span', null, '종료일'), end);
    type.addEventListener('change', () => { endField.hidden = type.value.startsWith('half_'); });
    start.addEventListener('change', () => { if (end.value < start.value) end.value = start.value; });
    const reason = h('textarea', { class: 'input area', rows: '3', maxlength: '500', placeholder: '사유' });
    const picker = approverPicker();
    openModal('휴가 신청', h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', null, '휴가 종류'), type),
      h('div', { class: 'two' }, h('label', { class: 'field' }, h('span', null, '시작일'), start), endField),
      reason, picker.node,
      h('p', { class: 'muted small' }, '주말은 일수에서 제외되며, 공휴일은 자동으로 제외되지 않습니다.')), [{
      label: '신청', primary: true,
      run: async (close) => {
        await api('POST', '/api/leaves', { type: type.value, startDate: start.value, endDate: end.value, reason: reason.value, approverIds: picker.ids() });
        close(); toast('휴가를 신청했습니다. 결재가 끝나면 확정됩니다.');
        showLeave(el, body);
      },
    }], { wide: true });
  }

  const showLeave = guard(async (el, body) => {
    const { leaves, balance, types } = await api('GET', '/api/leaves');
    if (state.view !== 'attendance' || local.tab !== 'leave') return;
    body.replaceChildren(
      h('section', { class: 'panel' },
        h('div', { class: 'card-head' }, h('h3', null, `${balance.year}년 연차 현황`),
          h('button', { class: 'btn primary', onclick: () => openLeaveForm(el, body, types) }, '휴가 신청')),
        h('div', { class: 'stat-row' },
          h('div', { class: 'stat' }, h('span', { class: 'muted small' }, '잔여'), h('strong', null, `${balance.remaining}일`)),
          h('div', { class: 'stat' }, h('span', { class: 'muted small' }, '사용'), h('strong', null, `${balance.used}일`)),
          h('div', { class: 'stat' }, h('span', { class: 'muted small' }, '결재 중'), h('strong', null, `${balance.pending}일`)),
          h('div', { class: 'stat' }, h('span', { class: 'muted small' }, '부여'), h('strong', null, `${balance.total}일`)))),
      h('section', { class: 'panel' },
        h('h3', null, '신청 내역'),
        leaves.length ? h('div', { class: 'table' },
          h('div', { class: 'tr th leave-row' }, h('span', null, '종류'), h('span', null, '기간'), h('span', null, '일수'), h('span', null, '상태')),
          leaves.map((l) => h('button', { class: 'tr leave-row', onclick: () => App.openApproval(l.approvalId) },
            h('span', null, l.typeLabel), h('span', null, l.startDate === l.endDate ? l.startDate : `${l.startDate} ~ ${l.endDate}`),
            h('span', { class: 'muted' }, `${l.days}일`), h('span', null, statusChip(l.status)))))
          : h('p', { class: 'empty' }, '올해 신청한 휴가가 없습니다.')));
  });

  // ── 관리자: 전체 현황 ──
  const showAdmin = guard(async (el, body) => {
    const [att, leave] = await Promise.all([api('GET', `/api/admin/attendance?date=${local.adminDate}`), api('GET', '/api/admin/leaves')]);
    if (state.view !== 'attendance' || local.tab !== 'admin') return;
    const date = h('input', { class: 'input slim', type: 'date', value: att.date, onchange: (e) => { if (e.target.value) { local.adminDate = e.target.value; showAdmin(el, body); } } });
    const present = att.records.filter((r) => r.checkIn).length;
    body.replaceChildren(
      h('section', { class: 'panel' },
        h('div', { class: 'card-head' }, h('h3', null, `출근 현황 (${present} / ${att.records.length}명)`), date),
        h('div', { class: 'table' },
          h('div', { class: 'tr th work-row' }, h('span', null, '이름'), h('span', null, '출근'), h('span', null, '퇴근'), h('span', null, '비고')),
          att.records.map((r) => h('div', { class: 'tr work-row' }, h('span', null, userLabel(r.userId)),
            h('span', null, r.checkIn ? timeOf(r.checkIn) : '-'), h('span', null, r.checkOut ? timeOf(r.checkOut) : '-'),
            h('span', { class: 'muted' }, r.leave || (r.checkIn ? '' : '미출근')))))),
      h('section', { class: 'panel' },
        h('h3', null, `${leave.year}년 연차 현황`),
        h('div', { class: 'table' },
          h('div', { class: 'tr th balance-row' }, h('span', null, '이름'), h('span', null, '부여'), h('span', null, '사용'), h('span', null, '잔여'), h('span', null, '')),
          leave.balances.map((b) => h('div', { class: 'tr balance-row' }, h('span', null, userLabel(b.userId)),
            h('span', null, `${b.total}일`), h('span', null, `${b.used}일`), h('span', null, `${b.remaining}일`),
            h('button', {
              class: 'btn small',
              onclick: guard(async () => {
                const value = prompt(`${userName(b.userId)}님의 연차 부여 일수를 입력해 주세요. (0.5 단위)`, String(b.total));
                if (value === null) return;
                await api('PATCH', `/api/admin/users/${b.userId}/leave`, { annualLeaveDays: Number(value) });
                toast('연차 부여 일수를 변경했습니다.');
                showAdmin(el, body);
              }),
            }, '부여 일수 변경'))))));
  });

  function show(el) {
    const today = ymd(new Date());
    local.month = local.month || today.slice(0, 7);
    local.adminDate = local.adminDate || today;
    const items = [['work', '출퇴근'], ['leave', '휴가']];
    if (state.me.role === 'admin') items.push(['admin', '전체 현황']);
    if (!items.some(([id]) => id === local.tab)) local.tab = 'work';
    const body = h('div', { class: 'stack' }, h('p', { class: 'empty' }, '불러오는 중'));
    el.replaceChildren(page('근태·휴가', [], tabs(items, local.tab, (id) => { local.tab = id; show(el); }), body));
    ({ work: showWork, leave: showLeave, admin: showAdmin })[local.tab](el, body);
  }

  App.registerView({
    id: 'attendance', label: '근태', order: 50,
    render(el, params) { if (params.tab) local.tab = params.tab; show(el); },
  });
})();
