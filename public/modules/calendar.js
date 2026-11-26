// 일정·캘린더 화면: 월간 달력에 개인, 부서, 전사 일정과 승인된 휴가를 함께 보여 준다.
(() => {
  'use strict';
  const { h, api, guard, toast, openModal, page, linkify, userName, userLabel, ymd, state } = App;
  const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
  const SCOPES = [['personal', '개인 (나만 보기)'], ['department', '부서 (같은 부서)'], ['company', '전사 (전 직원)']];
  const local = { year: null, month: null }; // month: 0~11
  let rootEl = null;
  const reload = () => { if (state.view === 'calendar' && rootEl) show(rootEl); };

  const timeText = (e) => {
    if (e.allDay) return e.startAt.slice(0, 10) === e.endAt.slice(0, 10) ? `${e.startAt.slice(0, 10)} 종일` : `${e.startAt.slice(0, 10)} ~ ${e.endAt.slice(0, 10)} 종일`;
    const sameDay = e.startAt.slice(0, 10) === e.endAt.slice(0, 10);
    return `${e.startAt.replace('T', ' ')} ~ ${sameDay ? e.endAt.slice(11) : e.endAt.replace('T', ' ')}`;
  };

  function openForm(date, existing) {
    const title = h('input', { class: 'input', maxlength: '100', placeholder: '일정 제목', value: existing?.title || '' });
    const scope = h('select', { class: 'input' }, SCOPES.map(([id, label]) => h('option', { value: id, selected: existing?.scope === id }, label)));
    const allDay = h('input', { type: 'checkbox', checked: !!existing?.allDay });
    const startDate = h('input', { class: 'input', type: 'date', value: existing ? existing.startAt.slice(0, 10) : date });
    const endDate = h('input', { class: 'input', type: 'date', value: existing ? existing.endAt.slice(0, 10) : date });
    const startTime = h('input', { class: 'input', type: 'time', value: existing && !existing.allDay ? existing.startAt.slice(11) : '09:00' });
    const endTime = h('input', { class: 'input', type: 'time', value: existing && !existing.allDay ? existing.endAt.slice(11) : '10:00' });
    const syncTime = () => { startTime.hidden = endTime.hidden = allDay.checked; };
    allDay.addEventListener('change', syncTime);
    startDate.addEventListener('change', () => { if (endDate.value < startDate.value) endDate.value = startDate.value; });
    syncTime();
    const location = h('input', { class: 'input', maxlength: '100', placeholder: '장소 (선택)', value: existing?.location || '' });
    const description = h('textarea', { class: 'input area', rows: '3', maxlength: '1000', placeholder: '설명 (선택)' });
    description.value = existing?.description || '';
    const body = h('div', { class: 'stack' }, title,
      h('label', { class: 'field' }, h('span', null, '공개 범위'), scope),
      h('label', { class: 'check' }, allDay, '종일 일정'),
      h('div', { class: 'two' }, h('label', { class: 'field' }, h('span', null, '시작'), startDate, startTime), h('label', { class: 'field' }, h('span', null, '종료'), endDate, endTime)),
      location, description);
    openModal(existing ? '일정 수정' : '일정 등록', body, [{
      label: existing ? '저장' : '등록', primary: true,
      run: async (close) => {
        const payload = {
          title: title.value, scope: scope.value, allDay: allDay.checked, location: location.value, description: description.value,
          startAt: allDay.checked ? startDate.value : `${startDate.value}T${startTime.value}`,
          endAt: allDay.checked ? endDate.value : `${endDate.value}T${endTime.value}`,
        };
        if (existing) await api('PATCH', `/api/events/${existing.id}`, payload); else await api('POST', '/api/events', payload);
        close(); toast(existing ? '일정을 수정했습니다.' : '일정을 등록했습니다.');
        reload();
      },
    }]);
  }

  function openEvent(e) {
    const canEdit = e.userId === state.me.id || (state.me.role === 'admin' && e.scope !== 'personal');
    const body = h('div', { class: 'stack' },
      h('div', { class: 'doc-meta' },
        h('div', null, h('span', { class: 'muted' }, '일시'), h('span', null, timeText(e))),
        h('div', null, h('span', { class: 'muted' }, '공개 범위'), h('span', null, e.scope === 'department' ? `부서 (${e.department})` : e.scopeLabel)),
        h('div', null, h('span', { class: 'muted' }, '등록자'), h('span', null, userLabel(e.userId))),
        e.location ? h('div', null, h('span', { class: 'muted' }, '장소'), h('span', null, e.location)) : null),
      e.description ? h('div', { class: 'post-content boxed' }, linkify(e.description)) : null);
    const actions = canEdit ? [
      { label: '삭제', run: async (close) => { if (!confirm('이 일정을 삭제하시겠습니까?')) return; await api('DELETE', `/api/events/${e.id}`); close(); toast('일정을 삭제했습니다.'); reload(); } },
      { label: '수정', primary: true, run: async (close) => { close(); openForm(null, e); } },
    ] : [];
    openModal(e.title, body, actions, { noFocus: true });
  }

  const show = guard(async (el) => {
    const first = new Date(local.year, local.month, 1);
    const gridStart = new Date(local.year, local.month, 1 - first.getDay());
    const lastDate = new Date(local.year, local.month + 1, 0);
    const weeks = Math.ceil((first.getDay() + lastDate.getDate()) / 7);
    const days = Array.from({ length: weeks * 7 }, (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
    const from = ymd(days[0]);
    const to = ymd(days[days.length - 1]);
    const [{ events }, { leaves }] = await Promise.all([api('GET', `/api/events?from=${from}&to=${to}`), api('GET', `/api/leaves/calendar?from=${from}&to=${to}`)]);
    if (state.view !== 'calendar') return;

    const today = ymd(new Date());
    const itemsOf = (date) => {
      const list = events.filter((e) => e.startAt.slice(0, 10) <= date && e.endAt.slice(0, 10) >= date)
        .sort((a, b) => (b.allDay - a.allDay) || a.startAt.localeCompare(b.startAt))
        .map((e) => ({ kind: e.scope, label: `${e.allDay || e.startAt.slice(0, 10) !== date ? '' : `${e.startAt.slice(11)} `}${e.title}`, open: () => openEvent(e) }));
      const off = leaves.filter((l) => l.startDate <= date && l.endDate >= date)
        .map((l) => ({ kind: 'leave', label: `${userName(l.userId)} ${l.typeLabel}`, open: null }));
      return [...list, ...off];
    };
    const chip = (item) => h(item.open ? 'button' : 'span', {
      class: `cal-item ${item.kind}`, title: item.label,
      onclick: item.open ? (ev) => { ev.stopPropagation(); item.open(); } : null,
    }, item.label);

    function openDay(date, items) {
      let close = () => {};
      const body = h('div', { class: 'stack' }, items.length ? items.map((item) =>
        h(item.open ? 'button' : 'div', { class: `cal-item big ${item.kind}`, onclick: item.open ? () => { close(); item.open(); } : null }, item.label))
        : h('p', { class: 'muted' }, '등록된 일정이 없습니다.'));
      close = openModal(`${date} (${WEEK[new Date(`${date}T00:00:00`).getDay()]})`, body,
        [{ label: '일정 등록', primary: true, run: async (c) => { c(); openForm(date); } }], { noFocus: true });
    }

    const grid = h('div', { class: 'cal-grid' },
      WEEK.map((w, i) => h('div', { class: `cal-week${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}` }, w)),
      days.map((d) => {
        const date = ymd(d);
        const items = itemsOf(date);
        const classes = ['cal-cell', d.getMonth() !== local.month ? 'other' : '', date === today ? 'today' : '', d.getDay() === 0 ? 'sun' : '', d.getDay() === 6 ? 'sat' : ''];
        return h('div', { class: classes.filter(Boolean).join(' '), role: 'button', tabindex: '0', onclick: () => openDay(date, items),
          onkeydown: (ev) => { if (ev.key === 'Enter') openDay(date, items); } },
          h('span', { class: 'cal-date' }, d.getDate()),
          items.slice(0, 3).map(chip),
          items.length > 3 ? h('span', { class: 'cal-more' }, `외 ${items.length - 3}건`) : null);
      }));

    const move = (diff) => { const d = new Date(local.year, local.month + diff, 1); local.year = d.getFullYear(); local.month = d.getMonth(); show(el); };
    el.replaceChildren(page('일정', [h('button', { class: 'btn primary', onclick: () => openForm(today) }, '일정 등록')],
      h('div', { class: 'month-nav' },
        h('button', { class: 'btn small', onclick: () => move(-1) }, '이전 달'),
        h('strong', null, `${local.year}년 ${local.month + 1}월`),
        h('button', { class: 'btn small', onclick: () => move(1) }, '다음 달'),
        h('button', { class: 'btn small', onclick: () => { const n = new Date(); local.year = n.getFullYear(); local.month = n.getMonth(); show(el); } }, '오늘')),
      h('div', { class: 'cal-legend' },
        h('span', { class: 'cal-item personal' }, '개인'), h('span', { class: 'cal-item department' }, '부서'),
        h('span', { class: 'cal-item company' }, '전사'), h('span', { class: 'cal-item leave' }, '휴가')),
      grid));
  });

  App.registerView({
    id: 'calendar', label: '일정', order: 60,
    render(el) {
      rootEl = el;
      if (local.year === null) { const n = new Date(); local.year = n.getFullYear(); local.month = n.getMonth(); }
      show(el);
    },
  });
})();
