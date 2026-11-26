// 홈 화면: 오늘 할 일을 한눈에 보여 준다 (출퇴근, 결재 대기, 공지, 다가오는 일정, 연차).
(() => {
  'use strict';
  const { h, api, guard, toast, page, ymd, timeOf, userName, state } = App;

  App.registerView({
    id: 'home', label: '홈', order: 10,
    async render(el) {
      const grid = h('div', { class: 'cards' }, h('p', { class: 'empty' }, '불러오는 중'));
      const today = new Date();
      el.append(page(`${state.me.name}님, 안녕하세요`, [], h('p', { class: 'muted page-sub' }, App.dayLabel(today.toISOString())), grid));

      const load = guard(async () => {
        const weekLater = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7);
        const [att, todo, notices, events, leaves] = await Promise.all([
          api('GET', '/api/attendance/today'),
          api('GET', '/api/approvals?box=todo'),
          api('GET', '/api/posts?category=notice'),
          api('GET', `/api/events?from=${ymd(today)}&to=${ymd(weekLater)}`),
          api('GET', '/api/leaves'),
        ]);
        if (state.view !== 'home') return;
        state.approvalTodo = todo.todoCount;
        App.renderRail();

        const card = (title, onMore, ...body) => h('section', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', null, title), onMore ? h('button', { class: 'link small', onclick: onMore }, '더 보기') : null), body);
        const rows = (items, empty) => (items.length ? h('div', { class: 'card-list' }, items) : h('p', { class: 'muted' }, empty));

        const record = att.record;
        const punch = (path, done) => guard(async () => { await api('POST', path); toast(done); load(); });
        const attendanceCard = card('오늘 근무', () => App.go('attendance'),
          h('div', { class: 'stat-row' },
            h('div', { class: 'stat' }, h('span', { class: 'muted small' }, '출근'), h('strong', null, record ? timeOf(record.checkIn) : '-')),
            h('div', { class: 'stat' }, h('span', { class: 'muted small' }, '퇴근'), h('strong', null, record?.checkOut ? timeOf(record.checkOut) : '-'))),
          h('div', { class: 'btn-row' },
            h('button', { class: 'btn primary', disabled: !!record, onclick: punch('/api/attendance/check-in', '출근 처리되었습니다.') }, '출근'),
            h('button', { class: 'btn', disabled: !record, onclick: punch('/api/attendance/check-out', '퇴근 처리되었습니다.') }, record?.checkOut ? '퇴근 시각 갱신' : '퇴근')));

        const todoCard = card(`결재 대기 ${todo.todoCount}건`, () => App.go('approval'), rows(todo.approvals.slice(0, 5).map((a) =>
          h('button', { class: 'row-btn', onclick: () => App.openApproval(a.id) },
            h('span', { class: 'ellipsis' }, a.title), h('span', { class: 'muted small' }, userName(a.drafterId)))), '결재할 문서가 없습니다.'));

        const noticeCard = card('공지사항', () => App.go('board'), rows(notices.posts.slice(0, 5).map((p) =>
          h('button', { class: 'row-btn', onclick: () => App.go('board', { postId: p.id }) },
            h('span', { class: 'ellipsis' }, p.pinned ? '[고정] ' : '', p.title), h('span', { class: 'muted small' }, p.createdAt.slice(0, 10)))), '등록된 공지가 없습니다.'));

        const eventCard = card('다가오는 일정 (7일)', () => App.go('calendar'), rows(events.events.slice(0, 6).map((e) =>
          h('button', { class: 'row-btn', onclick: () => App.go('calendar') },
            h('span', { class: 'ellipsis' }, e.title),
            h('span', { class: 'muted small' }, `${e.startAt.slice(5, 10)}${e.allDay ? '' : ` ${e.startAt.slice(11)}`}`))), '예정된 일정이 없습니다.'));

        const b = leaves.balance;
        const leaveCard = card(`${b.year}년 연차`, () => App.go('attendance', { tab: 'leave' }),
          h('div', { class: 'stat-row' },
            h('div', { class: 'stat' }, h('span', { class: 'muted small' }, '잔여'), h('strong', null, `${b.remaining}일`)),
            h('div', { class: 'stat' }, h('span', { class: 'muted small' }, '사용'), h('strong', null, `${b.used}일`)),
            h('div', { class: 'stat' }, h('span', { class: 'muted small' }, '부여'), h('strong', null, `${b.total}일`))));

        grid.replaceChildren(attendanceCard, todoCard, noticeCard, eventCard, leaveCard);
      });
      load();
    },
  });
})();
