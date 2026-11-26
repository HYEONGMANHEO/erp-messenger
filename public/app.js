(() => {
  'use strict';

  // ───────────────────────── 상태 ─────────────────────────
  const state = {
    me: null,
    config: {},
    users: new Map(),        // 사용자 번호 → 사용자
    rooms: new Map(),        // 대화방 번호 → 대화방
    msgs: new Map(),         // 대화방 번호 → { list, hasMore, loaded }
    currentRoomId: null,
    tab: 'rooms',
    query: '',
    results: null,
  };
  let socket = null;
  const $app = document.getElementById('app');
  const $modalRoot = document.getElementById('modal-root');
  const $toast = document.getElementById('toast');

  // ───────────────────────── 도우미 ─────────────────────────
  // 화면 요소 생성. 문자열은 항상 텍스트로만 넣어 스크립트 삽입을 막는다.
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'class') el.className = value;
      else if (key === 'value') el.value = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  async function api(method, url, body) {
    const options = { method, headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' };
    if (body instanceof FormData) options.body = body;
    else if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && state.me) { leaveApp(); throw new Error('로그인이 만료되었습니다.'); }
    if (!res.ok) throw new Error(data.error || '요청을 처리하지 못했습니다.');
    return data;
  }

  let toastTimer = null;
  function toast(message) {
    $toast.textContent = message;
    $toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $toast.classList.remove('show'), 3500);
  }
  const guard = (fn) => async (...args) => { try { await fn(...args); } catch (err) { toast(err.message); } };

  const pad = (n) => String(n).padStart(2, '0');
  const timeOf = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const dayKey = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
  const dayLabel = (iso) => new Date(iso).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const shortTime = (iso) => (dayKey(iso) === dayKey(new Date().toISOString())
    ? timeOf(iso)
    : new Date(iso).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }));
  const fileSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

  const userName = (id) => state.users.get(id)?.name || '알 수 없음';
  function roomTitle(room) {
    if (room.type === 'group') return room.name;
    const other = room.members.find((m) => m.userId !== state.me.id);
    return other ? userName(other.userId) : '대화방';
  }
  const preview = (m) => (!m ? '' : m.type === 'file' ? `파일: ${m.content}` : m.content);
  const sortedRooms = () => [...state.rooms.values()].sort((a, b) =>
    (b.lastMessage?.createdAt || b.createdAt).localeCompare(a.lastMessage?.createdAt || a.createdAt));
  const totalUnread = () => [...state.rooms.values()].reduce((sum, r) => sum + r.unread, 0);
  const avatar = (text, extra = '') => h('span', { class: `avatar ${extra}` }, (text || '?').trim().charAt(0));

  // ───────────────────────── 모달 ─────────────────────────
  function openModal(title, body, actions = []) {
    const close = () => overlay.remove();
    const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) close(); } },
      h('div', { class: 'modal', role: 'dialog', 'aria-label': title },
        h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'icon-btn', onclick: close, 'aria-label': '닫기' }, '×')),
        h('div', { class: 'modal-body' }, body),
        actions.length ? h('div', { class: 'modal-foot' }, actions.map((a) =>
          h('button', { class: a.primary ? 'btn primary' : 'btn', onclick: guard(() => a.run(close)) }, a.label))) : null));
    $modalRoot.append(overlay);
    overlay.querySelector('input, textarea')?.focus();
    return close;
  }

  // 사용자 선택 목록 (그룹 만들기와 초대에서 공용)
  function userPicker(excludeIds) {
    const selected = new Set();
    const candidates = [...state.users.values()].filter((u) => u.active && !excludeIds.has(u.id));
    const list = h('div', { class: 'picker-list' });
    const draw = (keyword) => {
      const rows = candidates.filter((u) => `${u.name} ${u.department} ${u.position}`.includes(keyword)).map((u) =>
        h('label', { class: 'picker-row' },
          h('input', { type: 'checkbox', checked: selected.has(u.id), onchange: (e) => (e.target.checked ? selected.add(u.id) : selected.delete(u.id)) }),
          h('span', null, u.name), h('span', { class: 'muted' }, [u.department, u.position].filter(Boolean).join(' · '))));
      list.replaceChildren(...(rows.length ? rows : [h('p', { class: 'muted' }, '선택할 수 있는 사람이 없습니다.')]));
    };
    draw('');
    const node = h('div', null, h('input', { class: 'input', placeholder: '이름 또는 부서 검색', oninput: (e) => draw(e.target.value.trim()) }), list);
    return { node, selected };
  }

  // ───────────────────────── 로그인 화면 ─────────────────────────
  function renderAuth(mode = state.config.firstUser ? 'signup' : 'login') {
    document.title = '사내 메신저';
    const isSignup = mode === 'signup';
    const field = (name, label, type = 'text', extra = {}) =>
      h('label', { class: 'field' }, h('span', null, label), h('input', { class: 'input', name, type, ...extra }));
    const form = h('form', {
      class: 'auth-card',
      onsubmit: guard(async (e) => {
        e.preventDefault();
        const body = Object.fromEntries(new FormData(form));
        if (isSignup && body.password !== body.passwordConfirm) throw new Error('비밀번호가 서로 다릅니다.');
        const { user } = await api('POST', isSignup ? '/api/signup' : '/api/login', body);
        await enterApp(user);
      }),
    },
      h('h1', null, '사내 메신저'),
      h('p', { class: 'muted' }, isSignup
        ? (state.config.firstUser ? '첫 번째 가입자는 관리자 계정이 됩니다.' : '계정을 만들어 주세요.')
        : '아이디와 비밀번호를 입력해 주세요.'),
      field('username', '아이디', 'text', { autocomplete: 'username', required: true }),
      field('password', '비밀번호', 'password', { autocomplete: isSignup ? 'new-password' : 'current-password', required: true, minlength: isSignup ? 8 : null }),
      isSignup && [
        field('passwordConfirm', '비밀번호 확인', 'password', { autocomplete: 'new-password', required: true }),
        field('name', '이름', 'text', { required: true, maxlength: 30 }),
        field('department', '부서', 'text', { maxlength: 40 }),
        field('position', '직급', 'text', { maxlength: 40 }),
        state.config.signupCodeRequired && field('signupCode', '가입 코드', 'password', { required: true, autocomplete: 'off' }),
      ],
      h('button', { class: 'btn primary wide', type: 'submit' }, isSignup ? '가입하기' : '로그인'),
      h('button', { class: 'link', type: 'button', onclick: () => renderAuth(isSignup ? 'login' : 'signup') },
        isSignup ? '이미 계정이 있습니다' : '새 계정 만들기'));
    $app.className = 'auth';
    $app.replaceChildren(form);
    form.querySelector('input').focus();
  }

  // ───────────────────────── 메인 화면 ─────────────────────────
  let $sidebar; let $main;
  function renderShell() {
    $sidebar = h('aside', { class: 'sidebar' });
    $main = h('main', { class: 'main' });
    $app.className = 'shell';
    $app.replaceChildren($sidebar, $main);
    renderSidebar();
    renderMain();
  }

  function renderSidebar() {
    if (!$sidebar) return;
    const me = state.me;
    const unread = totalUnread();
    document.title = unread ? `(${unread}) 사내 메신저` : '사내 메신저';
    const hadFocus = document.activeElement?.id === 'search';

    const head = h('div', { class: 'side-head' },
      h('div', { class: 'me' }, avatar(me.name), h('div', null, h('strong', null, me.name),
        h('div', { class: 'muted small' }, [me.department, me.position].filter(Boolean).join(' · ') || me.username))),
      h('div', { class: 'side-actions' },
        h('button', { class: 'btn small', onclick: openGroupModal }, '새 그룹'),
        h('button', { class: 'btn small', onclick: openSettingsModal }, '설정'),
        me.role === 'admin' && h('button', { class: 'btn small', onclick: openAdminModal }, '관리'),
        h('button', { class: 'btn small', onclick: guard(logout) }, '로그아웃')));

    const search = h('input', { id: 'search', class: 'input', type: 'search', placeholder: '메시지 검색 (2자 이상)', value: state.query, oninput: onSearchInput });

    let content;
    if (state.query.trim().length >= 2) {
      const results = state.results || [];
      content = h('div', { class: 'list' },
        h('div', { class: 'list-label' }, state.results === null ? '검색 중' : `검색 결과 ${results.length}건`),
        results.map((m) => {
          const room = state.rooms.get(m.roomId);
          return h('button', { class: 'item', onclick: () => openRoom(m.roomId) },
            h('div', { class: 'item-body' },
              h('div', { class: 'item-top' }, h('strong', null, room ? roomTitle(room) : '대화방'), h('span', { class: 'muted small' }, shortTime(m.createdAt))),
              h('div', { class: 'item-sub wrap' }, `${userName(m.userId)}: ${preview(m)}`)));
        }));
    } else {
      const tabs = h('div', { class: 'tabs' },
        h('button', { class: state.tab === 'rooms' ? 'tab on' : 'tab', onclick: () => { state.tab = 'rooms'; renderSidebar(); } },
          '대화', unread ? h('span', { class: 'badge' }, unread > 99 ? '99+' : unread) : null),
        h('button', { class: state.tab === 'org' ? 'tab on' : 'tab', onclick: () => { state.tab = 'org'; renderSidebar(); } }, '조직도'));
      content = [tabs, state.tab === 'rooms' ? roomList() : orgList()];
    }
    $sidebar.replaceChildren(head, h('div', { class: 'side-search' }, search), ...[content].flat());
    if (hadFocus) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  }

  function roomList() {
    const rooms = sortedRooms();
    if (!rooms.length) return h('div', { class: 'list' }, h('p', { class: 'empty' }, '아직 대화가 없습니다. 조직도에서 동료를 선택해 대화를 시작해 보세요.'));
    return h('div', { class: 'list' }, rooms.map((room) => {
      const title = roomTitle(room);
      const other = room.type === 'direct' && room.members.find((m) => m.userId !== state.me.id);
      const isOnline = other && state.users.get(other.userId)?.online;
      return h('button', { class: room.id === state.currentRoomId ? 'item on' : 'item', onclick: () => openRoom(room.id) },
        h('span', { class: 'avatar-wrap' }, avatar(title, room.type === 'group' ? 'group' : ''), isOnline ? h('span', { class: 'dot on' }) : null),
        h('div', { class: 'item-body' },
          h('div', { class: 'item-top' },
            h('strong', null, title, room.type === 'group' ? h('span', { class: 'muted count' }, room.members.length) : null),
            h('span', { class: 'muted small' }, room.lastMessage ? shortTime(room.lastMessage.createdAt) : '')),
          h('div', { class: 'item-top' },
            h('span', { class: 'item-sub' }, preview(room.lastMessage)),
            room.unread ? h('span', { class: 'badge' }, room.unread > 99 ? '99+' : room.unread) : null)));
    }));
  }

  function orgList() {
    const groups = new Map();
    for (const user of state.users.values()) {
      if (!user.active) continue;
      const dept = user.department || '부서 미지정';
      if (!groups.has(dept)) groups.set(dept, []);
      groups.get(dept).push(user);
    }
    const depts = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'ko'));
    return h('div', { class: 'list' }, depts.map((dept) => [
      h('div', { class: 'list-label' }, `${dept} (${groups.get(dept).length})`),
      groups.get(dept).sort((a, b) => a.name.localeCompare(b.name, 'ko')).map((user) =>
        h('button', {
          class: 'item', disabled: user.id === state.me.id,
          onclick: guard(async () => { const { room } = await api('POST', '/api/rooms/direct', { userId: user.id }); state.rooms.set(room.id, room); openRoom(room.id); }),
        },
          h('span', { class: 'avatar-wrap' }, avatar(user.name), h('span', { class: user.online ? 'dot on' : 'dot' })),
          h('div', { class: 'item-body' },
            h('strong', null, user.name, user.id === state.me.id ? h('span', { class: 'muted count' }, '나') : null),
            h('div', { class: 'item-sub' }, [user.position, user.online ? '접속 중' : '부재'].filter(Boolean).join(' · ')))))]));
  }

  // ── 검색 ──
  let searchTimer = null;
  function onSearchInput(e) {
    state.query = e.target.value;
    state.results = null;
    clearTimeout(searchTimer);
    renderSidebar();
    const q = state.query.trim();
    if (q.length < 2) return;
    searchTimer = setTimeout(guard(async () => {
      const { results } = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
      if (state.query.trim() === q) { state.results = results; renderSidebar(); }
    }), 300);
  }

  // ───────────────────────── 대화창 ─────────────────────────
  let $messages = null; let $chatHead = null; let $input = null;

  function renderMain() {
    const room = state.rooms.get(state.currentRoomId);
    $app.classList.toggle('chat-open', !!room);
    if (!room) {
      $messages = $chatHead = $input = null;
      $main.replaceChildren(h('div', { class: 'placeholder' }, h('h2', null, '사내 메신저'), h('p', { class: 'muted' }, '왼쪽에서 대화방을 선택하거나 조직도에서 동료를 선택해 주세요.')));
      return;
    }
    $chatHead = h('header', { class: 'chat-head' });
    $messages = h('div', { class: 'messages' });
    $input = h('textarea', {
      class: 'composer-input', rows: '1', placeholder: '메시지 입력', title: 'Enter로 전송, Shift+Enter로 줄바꿈', maxlength: '4000',
      onkeydown: (e) => {
        // 한글 조합 중의 Enter는 전송으로 처리하지 않는다.
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); sendCurrent(); }
      },
      oninput: () => { $input.style.height = 'auto'; $input.style.height = `${Math.min($input.scrollHeight, 140)}px`; },
      onpaste: (e) => { const file = [...(e.clipboardData?.files || [])][0]; if (file) { e.preventDefault(); uploadFile(file); } },
    });
    const fileInput = h('input', { type: 'file', hidden: true, onchange: (e) => { if (e.target.files[0]) uploadFile(e.target.files[0]); e.target.value = ''; } });
    const composer = h('div', { class: 'composer' }, fileInput,
      h('button', { class: 'btn', title: `파일 첨부 (최대 ${state.config.maxFileMb}MB)`, onclick: () => fileInput.click() }, '파일'),
      $input, h('button', { class: 'btn primary', onclick: sendCurrent }, '전송'));
    $main.replaceChildren($chatHead, $messages, composer);
    $main.ondragover = (e) => e.preventDefault();
    $main.ondrop = (e) => { e.preventDefault(); const file = e.dataTransfer?.files?.[0]; if (file) uploadFile(file); };
    renderChatHead();
    renderMessages(true);
    $input.focus();
  }

  function renderChatHead() {
    const room = state.rooms.get(state.currentRoomId);
    if (!room || !$chatHead) return;
    const isGroup = room.type === 'group';
    $chatHead.replaceChildren(...[
      h('button', { class: 'icon-btn back', onclick: () => { state.currentRoomId = null; renderMain(); renderSidebar(); }, 'aria-label': '목록으로' }, '‹'),
      h('div', { class: 'chat-title' }, h('strong', null, roomTitle(room)),
        h('button', { class: 'link small', onclick: () => openMembersModal(room) }, `참여자 ${room.members.length}명`)),
      isGroup && h('button', { class: 'btn small', onclick: () => openInviteModal(room) }, '초대'),
      isGroup && h('button', { class: 'btn small', onclick: guard(async () => {
        if (!confirm('이 대화방에서 나가시겠습니까?')) return;
        await api('POST', `/api/rooms/${room.id}/leave`);
      }) }, '나가기')].filter(Boolean));
  }

  // 주소를 클릭 가능한 연결로 바꾼다. http와 https 주소만 허용한다.
  function linkify(text) {
    const parts = [];
    let last = 0;
    for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
      if (match.index > last) parts.push(text.slice(last, match.index));
      parts.push(h('a', { href: match[0], target: '_blank', rel: 'noopener noreferrer' }, match[0]));
      last = match.index + match[0].length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
  }

  function renderMessages(toBottom = false) {
    const room = state.rooms.get(state.currentRoomId);
    const store = state.msgs.get(state.currentRoomId);
    if (!room || !$messages) return;
    const nearBottom = $messages.scrollHeight - $messages.scrollTop - $messages.clientHeight < 80;
    const stick = toBottom || nearBottom;
    const scrollDown = () => { $messages.scrollTop = $messages.scrollHeight; };
    if (!store || !store.loaded) { $messages.replaceChildren(h('p', { class: 'empty' }, '불러오는 중')); return; }

    const nodes = [];
    if (store.hasMore) nodes.push(h('button', { class: 'link more', onclick: guard(loadOlder) }, '이전 메시지 더 보기'));
    let prev = null;
    for (const m of store.list) {
      if (!prev || dayKey(prev.createdAt) !== dayKey(m.createdAt)) nodes.push(h('div', { class: 'day' }, dayLabel(m.createdAt)));
      if (m.type === 'system') { nodes.push(h('div', { class: 'system' }, m.content)); prev = m; continue; }
      const mine = m.userId === state.me.id;
      const showName = !mine && (!prev || prev.userId !== m.userId || prev.type === 'system' || dayKey(prev.createdAt) !== dayKey(m.createdAt));
      const unread = room.members.filter((x) => x.userId !== m.userId && x.lastReadId < m.id).length;
      let bubble;
      if (m.type === 'file' && m.file) {
        const url = `/api/files/${m.file.id}`;
        bubble = h('div', { class: 'bubble file' },
          m.file.isImage ? h('a', { href: `${url}?inline=1`, target: '_blank', rel: 'noopener' },
            h('img', { src: `${url}?inline=1`, alt: m.file.name, loading: 'lazy', onload: () => { if (stick) scrollDown(); } })) : null,
          h('a', { href: url, download: m.file.name }, m.file.name), h('span', { class: 'muted small' }, fileSize(m.file.size)));
      } else {
        bubble = h('div', { class: 'bubble' }, linkify(m.content));
      }
      nodes.push(h('div', { class: mine ? 'msg mine' : 'msg' },
        showName ? h('div', { class: 'sender' }, userName(m.userId)) : null,
        h('div', { class: 'row' }, bubble,
          h('div', { class: 'meta' }, unread ? h('span', { class: 'unread' }, unread) : null, h('span', null, timeOf(m.createdAt))))));
      prev = m;
    }
    if (!store.list.length) nodes.push(h('p', { class: 'empty' }, '첫 메시지를 보내 보세요.'));
    $messages.replaceChildren(...nodes);
    if (stick) scrollDown();
  }

  async function loadMessages(roomId) {
    const { messages, hasMore } = await api('GET', `/api/rooms/${roomId}/messages`);
    state.msgs.set(roomId, { list: messages, hasMore, loaded: true });
  }

  async function loadOlder() {
    const roomId = state.currentRoomId;
    const store = state.msgs.get(roomId);
    if (!store?.list.length) return;
    const { messages, hasMore } = await api('GET', `/api/rooms/${roomId}/messages?before=${store.list[0].id}`);
    store.list = [...messages, ...store.list];
    store.hasMore = hasMore;
    if (roomId !== state.currentRoomId) return;
    const before = $messages.scrollHeight;
    renderMessages();
    $messages.scrollTop += $messages.scrollHeight - before; // 보던 위치 유지
  }

  const openRoom = guard(async (roomId) => {
    if (!state.rooms.has(roomId)) return;
    state.currentRoomId = roomId;
    state.tab = 'rooms';
    renderMain();
    renderSidebar();
    if (!state.msgs.get(roomId)?.loaded) await loadMessages(roomId);
    if (state.currentRoomId !== roomId) return;
    renderMessages(true);
    markCurrentRead();
  });

  function markCurrentRead() {
    const room = state.rooms.get(state.currentRoomId);
    const store = state.msgs.get(state.currentRoomId);
    if (!room || !store?.list.length || document.hidden || !document.hasFocus()) return;
    const lastId = store.list[store.list.length - 1].id;
    const mine = room.members.find((m) => m.userId === state.me.id);
    if (mine && mine.lastReadId >= lastId) return;
    socket.emit('room:read', { roomId: room.id, lastId });
  }

  function sendCurrent() {
    const roomId = state.currentRoomId;
    const content = $input.value.trim();
    if (!roomId || !content) return;
    $input.value = '';
    $input.style.height = 'auto';
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    socket.timeout(10000).emit('message:send', { roomId, content }, (err, res) => {
      if (err || !res?.ok) {
        toast(res?.error || '메시지를 보내지 못했습니다. 연결 상태를 확인해 주세요.');
        if (state.currentRoomId === roomId && !$input.value) $input.value = content;
      }
    });
    $input.focus();
  }

  const uploadFile = guard(async (file) => {
    const roomId = state.currentRoomId;
    if (!roomId) return;
    if (file.size > state.config.maxFileMb * 1048576) throw new Error(`파일은 ${state.config.maxFileMb}MB까지 올릴 수 있습니다.`);
    const body = new FormData();
    body.append('file', file);
    toast(`${file.name} 올리는 중`);
    await api('POST', `/api/rooms/${roomId}/files`, body);
    toast('파일을 올렸습니다.');
  });

  // ───────────────────────── 모달 화면들 ─────────────────────────
  function openGroupModal() {
    const name = h('input', { class: 'input', placeholder: '대화방 이름', maxlength: '50' });
    const picker = userPicker(new Set([state.me.id]));
    openModal('새 그룹 대화방', h('div', { class: 'stack' }, name, picker.node), [{
      label: '만들기', primary: true,
      run: async (close) => {
        const { room } = await api('POST', '/api/rooms/group', { name: name.value, memberIds: [...picker.selected] });
        state.rooms.set(room.id, room);
        close();
        openRoom(room.id);
      },
    }]);
  }

  function openInviteModal(room) {
    const picker = userPicker(new Set(room.members.map((m) => m.userId)));
    openModal('대화 상대 초대', picker.node, [{
      label: '초대하기', primary: true,
      run: async (close) => { await api('POST', `/api/rooms/${room.id}/invite`, { memberIds: [...picker.selected] }); close(); },
    }]);
  }

  function openMembersModal(room) {
    openModal('참여자', h('div', { class: 'picker-list' }, room.members.map((m) => {
      const user = state.users.get(m.userId);
      return h('div', { class: 'picker-row' }, h('span', { class: user?.online ? 'dot on inline' : 'dot inline' }), h('span', null, userName(m.userId)),
        h('span', { class: 'muted' }, [user?.department, user?.position].filter(Boolean).join(' · ')));
    })));
  }

  function openSettingsModal() {
    const me = state.me;
    const name = h('input', { class: 'input', value: me.name, maxlength: '30' });
    const department = h('input', { class: 'input', value: me.department, maxlength: '40' });
    const position = h('input', { class: 'input', value: me.position, maxlength: '40' });
    const current = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
    const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    const label = (text, node) => h('label', { class: 'field' }, h('span', null, text), node);
    const canNotify = 'Notification' in window;
    const body = h('div', { class: 'stack' },
      h('h3', null, '내 정보'), label('이름', name), label('부서', department), label('직급', position),
      h('button', { class: 'btn primary', onclick: guard(async () => {
        const { user } = await api('PATCH', '/api/me', { name: name.value, department: department.value, position: position.value });
        state.me = user; toast('내 정보를 저장했습니다.');
      }) }, '정보 저장'),
      h('h3', null, '비밀번호 변경'), label('현재 비밀번호', current), label('새 비밀번호 (8자 이상)', next),
      h('button', { class: 'btn', onclick: guard(async () => {
        await api('POST', '/api/me/password', { currentPassword: current.value, newPassword: next.value });
        current.value = next.value = ''; toast('비밀번호를 변경했습니다.');
      }) }, '비밀번호 변경'),
      h('h3', null, '알림'),
      h('button', { class: 'btn', disabled: !canNotify || Notification.permission === 'granted', onclick: guard(async () => {
        const result = await Notification.requestPermission();
        toast(result === 'granted' ? '알림을 켰습니다.' : '브라우저 설정에서 알림이 차단되어 있습니다.');
      }) }, !canNotify ? '이 브라우저는 알림을 지원하지 않습니다' : Notification.permission === 'granted' ? '알림 사용 중' : '새 메시지 알림 켜기'));
    openModal('설정', body);
  }

  function openAdminModal() {
    const table = h('div', { class: 'admin-list' });
    const draw = () => table.replaceChildren(...[...state.users.values()].sort((a, b) => a.id - b.id).map((user) => {
      const self = user.id === state.me.id;
      const update = (patch) => guard(async () => { await api('PATCH', `/api/admin/users/${user.id}`, patch); draw(); })();
      return h('div', { class: user.active ? 'admin-row' : 'admin-row off' },
        h('div', { class: 'admin-who' }, h('strong', null, user.name), h('span', { class: 'muted small' }, `${user.username} · ${user.department || '부서 미지정'}`)),
        h('select', { class: 'input slim', disabled: self, onchange: (e) => update({ role: e.target.value }) },
          h('option', { value: 'user', selected: user.role === 'user' }, '일반'), h('option', { value: 'admin', selected: user.role === 'admin' }, '관리자')),
        h('button', { class: 'btn small', disabled: self, onclick: () => {
          if (confirm(user.active ? `${user.name} 계정의 사용을 중지하시겠습니까?` : `${user.name} 계정을 다시 사용하도록 하시겠습니까?`)) update({ active: !user.active });
        } }, user.active ? '사용 중지' : '사용 재개'),
        h('button', { class: 'btn small', onclick: guard(async () => {
          const newPassword = prompt(`${user.name} 계정의 새 임시 비밀번호를 입력해 주세요. (8자 이상)`);
          if (!newPassword) return;
          await api('POST', `/api/admin/users/${user.id}/password`, { newPassword });
          toast('비밀번호를 초기화했습니다.');
        }) }, '비밀번호 초기화'));
    }));
    draw();
    adminRedraw = draw;
    openModal('사용자 관리', table);
  }
  let adminRedraw = null;

  // ───────────────────────── 실시간 연결 ─────────────────────────
  function notify(message) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!document.hidden && document.hasFocus()) return;
    const room = state.rooms.get(message.roomId);
    const n = new Notification(room ? roomTitle(room) : '새 메시지', { body: `${userName(message.userId)}: ${preview(message)}`, tag: `room-${message.roomId}` });
    n.onclick = () => { window.focus(); openRoom(message.roomId); n.close(); };
  }

  function connectSocket() {
    socket = io();
    let first = true;
    socket.on('connect', guard(async () => {
      if (first) { first = false; return; }
      await loadAll(); // 연결이 끊겼다가 복구되면 놓친 내용을 다시 불러온다.
      if (state.currentRoomId) { await loadMessages(state.currentRoomId); renderMessages(true); }
    }));
    socket.on('connect_error', (err) => { if (err.message === 'unauthorized') leaveApp(); });

    socket.on('message:new', (message) => {
      const room = state.rooms.get(message.roomId);
      if (!room) return;
      room.lastMessage = message;
      const store = state.msgs.get(message.roomId);
      if (store?.loaded && !store.list.some((m) => m.id === message.id)) store.list.push(message);
      const mine = message.userId === state.me.id;
      if (!mine && message.type !== 'system') { room.unread += 1; notify(message); }
      if (message.roomId === state.currentRoomId) { renderMessages(mine); markCurrentRead(); }
      renderSidebar();
    });

    socket.on('room:read', ({ roomId, userId, lastReadId }) => {
      const room = state.rooms.get(roomId);
      if (!room) return;
      const member = room.members.find((m) => m.userId === userId);
      if (member) member.lastReadId = Math.max(member.lastReadId, lastReadId);
      if (userId === state.me.id) {
        // 다른 기기에서 읽은 경우에도 안 읽은 수가 맞도록 다시 계산한다.
        const store = state.msgs.get(roomId);
        const lastId = room.lastMessage?.id || 0;
        room.unread = lastReadId >= lastId ? 0
          : store?.loaded ? store.list.filter((m) => m.id > lastReadId && m.userId !== userId && m.type !== 'system').length : room.unread;
        renderSidebar();
      }
      if (roomId === state.currentRoomId) renderMessages();
    });

    socket.on('room:upsert', (room) => {
      if (!room) return;
      state.rooms.set(room.id, room);
      renderSidebar();
      if (room.id === state.currentRoomId) { renderChatHead(); renderMessages(); }
    });

    socket.on('room:removed', ({ roomId }) => {
      state.rooms.delete(roomId);
      state.msgs.delete(roomId);
      if (state.currentRoomId === roomId) { state.currentRoomId = null; renderMain(); }
      renderSidebar();
    });

    socket.on('presence', ({ userId, online }) => {
      const user = state.users.get(userId);
      if (user) { user.online = online; renderSidebar(); }
    });

    socket.on('user:upsert', (user) => {
      state.users.set(user.id, { ...user, online: state.users.get(user.id)?.online ?? user.online });
      if (user.id === state.me.id) state.me = state.users.get(user.id);
      renderSidebar();
      renderChatHead();
      renderMessages();
      if (adminRedraw && $modalRoot.querySelector('.admin-list')) adminRedraw();
    });
  }

  window.addEventListener('focus', () => { if (state.me) markCurrentRead(); });
  document.addEventListener('visibilitychange', () => { if (state.me) markCurrentRead(); });

  // ───────────────────────── 시작과 종료 ─────────────────────────
  async function loadAll() {
    const [{ users }, { rooms }] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/rooms')]);
    state.users = new Map(users.map((u) => [u.id, u]));
    state.rooms = new Map(rooms.map((r) => [r.id, r]));
    if (state.currentRoomId && !state.rooms.has(state.currentRoomId)) state.currentRoomId = null;
    renderSidebar();
  }

  async function enterApp(user) {
    state.me = user;
    await loadAll();
    renderShell();
    connectSocket();
  }

  function leaveApp() {
    socket?.disconnect();
    socket = null;
    Object.assign(state, { me: null, users: new Map(), rooms: new Map(), msgs: new Map(), currentRoomId: null, query: '', results: null });
    $sidebar = $main = null;
    $modalRoot.replaceChildren();
    api('GET', '/api/config').then((config) => { state.config = config; renderAuth('login'); }).catch(() => renderAuth('login'));
  }

  async function logout() {
    await api('POST', '/api/logout');
    leaveApp();
  }

  (async () => {
    try {
      state.config = await api('GET', '/api/config');
      const res = await fetch('/api/me', { credentials: 'same-origin' });
      if (res.ok) await enterApp((await res.json()).user);
      else renderAuth();
    } catch (err) {
      $app.replaceChildren(h('p', { class: 'empty' }, '서버에 연결하지 못했습니다. 잠시 후 새로 고침해 주세요.'));
    }
  })();
})();
