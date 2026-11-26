// 공지사항·게시판 화면
(() => {
  'use strict';
  const { h, api, guard, toast, openModal, page, tabs, linkify, userName, dateTime, state } = App;
  const CATEGORIES = [['notice', '공지사항'], ['general', '자유게시판']];
  const local = { category: 'notice', page: 1 };

  function openEditor(el, existing) {
    const isNotice = (existing?.category || local.category) === 'notice';
    const title = h('input', { class: 'input', maxlength: '100', placeholder: '제목', value: existing?.title || '' });
    const content = h('textarea', { class: 'input area', rows: '12', placeholder: '내용', maxlength: '20000' });
    content.value = existing?.content || '';
    const pinned = h('input', { type: 'checkbox', checked: !!existing?.pinned });
    const body = h('div', { class: 'stack' }, title, content,
      state.me.role === 'admin' ? h('label', { class: 'check' }, pinned, '목록 맨 위에 고정') : null);
    openModal(existing ? '글 수정' : `${isNotice ? '공지사항' : '자유게시판'} 글쓰기`, body, [{
      label: existing ? '저장' : '등록', primary: true,
      run: async (close) => {
        const payload = { category: local.category, title: title.value, content: content.value, pinned: pinned.checked };
        const { post } = existing ? await api('PATCH', `/api/posts/${existing.id}`, payload) : await api('POST', '/api/posts', payload);
        close();
        toast(existing ? '수정했습니다.' : '등록했습니다.');
        if (existing) showPost(el, post.id); else { local.page = 1; showList(el); }
      },
    }], { wide: true });
  }

  const showList = guard(async (el) => {
    const { posts, total, pageSize } = await api('GET', `/api/posts?category=${local.category}&page=${local.page}`);
    if (state.view !== 'board') return;
    const canWrite = local.category === 'general' || state.me.role === 'admin';
    const lastPage = Math.max(Math.ceil(total / pageSize), 1);
    const table = posts.length ? h('div', { class: 'table' },
      h('div', { class: 'tr th board-row' }, h('span', null, '제목'), h('span', null, '작성자'), h('span', null, '작성일')),
      posts.map((p) => h('button', { class: 'tr board-row', onclick: () => showPost(el, p.id) },
        h('span', { class: 'ellipsis' }, p.pinned ? h('span', { class: 'chip wait' }, '고정') : null, ' ', p.title,
          p.commentCount ? h('span', { class: 'muted small' }, ` [${p.commentCount}]`) : null),
        h('span', { class: 'muted' }, userName(p.userId)), h('span', { class: 'muted' }, p.createdAt.slice(0, 10)))))
      : h('p', { class: 'empty' }, '등록된 글이 없습니다.');
    const pager = lastPage > 1 ? h('div', { class: 'pager' },
      h('button', { class: 'btn small', disabled: local.page <= 1, onclick: () => { local.page -= 1; showList(el); } }, '이전'),
      h('span', { class: 'muted' }, `${local.page} / ${lastPage}`),
      h('button', { class: 'btn small', disabled: local.page >= lastPage, onclick: () => { local.page += 1; showList(el); } }, '다음')) : null;
    el.replaceChildren(page('게시판', canWrite ? [h('button', { class: 'btn primary', onclick: () => openEditor(el) }, '글쓰기')] : [],
      tabs(CATEGORIES, local.category, (id) => { local.category = id; local.page = 1; showList(el); }), table, pager));
  });

  const showPost = guard(async (el, postId) => {
    let data;
    try { data = await api('GET', `/api/posts/${postId}`); } catch (err) { toast(err.message); return showList(el); }
    if (state.view !== 'board') return;
    const { post, comments } = data;
    local.category = post.category;
    const mine = (userId) => userId === state.me.id || state.me.role === 'admin';
    const input = h('textarea', { class: 'input area', rows: '2', maxlength: '1000', placeholder: '댓글 입력' });
    const article = h('article', { class: 'panel' },
      h('h2', { class: 'post-title' }, post.title),
      h('div', { class: 'muted small' }, `${userName(post.userId)} · ${dateTime(post.createdAt)}${post.updatedAt !== post.createdAt ? ' (수정됨)' : ''}`),
      h('div', { class: 'post-content' }, linkify(post.content)));
    const commentList = h('section', { class: 'panel' },
      h('h3', null, `댓글 ${comments.length}`),
      comments.map((c) => h('div', { class: 'comment' },
        h('div', { class: 'item-top' }, h('strong', null, userName(c.userId)),
          h('span', { class: 'muted small' }, dateTime(c.createdAt), mine(c.userId) ? [' · ', h('button', {
            class: 'link small',
            onclick: guard(async () => { if (confirm('댓글을 삭제하시겠습니까?')) { await api('DELETE', `/api/comments/${c.id}`); showPost(el, postId); } }),
          }, '삭제')] : null)),
        h('div', { class: 'comment-body' }, linkify(c.content)))),
      h('div', { class: 'comment-form' }, input, h('button', {
        class: 'btn primary',
        onclick: guard(async () => { await api('POST', `/api/posts/${postId}/comments`, { content: input.value }); showPost(el, postId); }),
      }, '등록')));
    const actions = [h('button', { class: 'btn', onclick: () => showList(el) }, '목록')];
    if (mine(post.userId)) {
      actions.push(h('button', { class: 'btn', onclick: () => openEditor(el, post) }, '수정'));
      actions.push(h('button', {
        class: 'btn',
        onclick: guard(async () => { if (confirm('이 글을 삭제하시겠습니까?')) { await api('DELETE', `/api/posts/${postId}`); toast('삭제했습니다.'); showList(el); } }),
      }, '삭제'));
    }
    el.replaceChildren(page(post.category === 'notice' ? '공지사항' : '자유게시판', actions, article, commentList));
  });

  App.registerView({
    id: 'board', label: '게시판', order: 30,
    render(el, params) { if (params.postId) showPost(el, params.postId); else showList(el); },
  });
})();
