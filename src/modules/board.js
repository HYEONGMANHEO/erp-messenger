'use strict';
// 공지사항·게시판 모듈.
// 공지사항은 관리자만 작성할 수 있고, 자유게시판은 누구나 작성할 수 있다.
const CATEGORIES = { notice: '공지사항', general: '자유게시판' };
const PAGE_SIZE = 20;

module.exports = ({ app, db, auth, fail, toId, cleanText, now, notify, allActiveUserIds }) => {
  const summary = (p) => ({
    id: p.id, category: p.category, title: p.title, userId: p.user_id, pinned: !!p.pinned,
    createdAt: p.created_at, updatedAt: p.updated_at, commentCount: p.comment_count ?? 0,
  });
  const findPost = (id) => db.prepare('SELECT * FROM posts WHERE id = ?').get(id) || fail(404, '게시글을 찾을 수 없습니다.');
  const canEdit = (user, row) => row.user_id === user.id || user.role === 'admin';

  function readInput(body, user, existing) {
    const category = existing ? existing.category : body.category;
    if (!CATEGORIES[category]) fail(400, '잘못된 게시판입니다.');
    if (category === 'notice' && user.role !== 'admin') fail(403, '공지사항은 관리자만 작성할 수 있습니다.');
    const title = cleanText(body.title, 100);
    const content = String(body.content ?? '').trim();
    if (!title) fail(400, '제목을 입력해 주세요.');
    if (!content) fail(400, '내용을 입력해 주세요.');
    if (content.length > 20000) fail(400, '내용은 20,000자까지 입력할 수 있습니다.');
    const pinned = user.role === 'admin' && body.pinned ? 1 : 0;
    return { category, title, content, pinned };
  }

  app.get('/api/posts', auth, (req, res) => {
    const category = CATEGORIES[req.query.category] ? req.query.category : 'notice';
    const page = Math.max(Number(req.query.page) || 1, 1);
    const total = db.prepare('SELECT COUNT(*) AS n FROM posts WHERE category = ?').get(category).n;
    const rows = db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count
      FROM posts p WHERE p.category = ?
      ORDER BY p.pinned DESC, p.id DESC LIMIT ? OFFSET ?
    `).all(category, PAGE_SIZE, (page - 1) * PAGE_SIZE);
    res.json({ posts: rows.map(summary), total, page, pageSize: PAGE_SIZE });
  });

  app.get('/api/posts/:id', auth, (req, res) => {
    const post = findPost(toId(req.params.id));
    const comments = db.prepare('SELECT * FROM comments WHERE post_id = ? ORDER BY id').all(post.id)
      .map((c) => ({ id: c.id, userId: c.user_id, content: c.content, createdAt: c.created_at }));
    res.json({ post: { ...summary(post), content: post.content, commentCount: comments.length }, comments });
  });

  app.post('/api/posts', auth, (req, res) => {
    const input = readInput(req.body, req.user);
    const t = now();
    const id = Number(db.prepare(`
      INSERT INTO posts (category, title, content, user_id, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.category, input.title, input.content, req.user.id, input.pinned, t, t).lastInsertRowid);
    if (input.category === 'notice') {
      notify(allActiveUserIds().filter((uid) => uid !== req.user.id),
        { type: 'notice', title: '새 공지사항', body: input.title, link: `board:${id}` });
    }
    res.json({ post: summary(findPost(id)) });
  });

  app.patch('/api/posts/:id', auth, (req, res) => {
    const post = findPost(toId(req.params.id));
    if (!canEdit(req.user, post)) fail(403, '작성자와 관리자만 수정할 수 있습니다.');
    const input = readInput(req.body, req.user, post);
    db.prepare('UPDATE posts SET title = ?, content = ?, pinned = ?, updated_at = ? WHERE id = ?')
      .run(input.title, input.content, input.pinned, now(), post.id);
    res.json({ post: summary(findPost(post.id)) });
  });

  app.delete('/api/posts/:id', auth, (req, res) => {
    const post = findPost(toId(req.params.id));
    if (!canEdit(req.user, post)) fail(403, '작성자와 관리자만 삭제할 수 있습니다.');
    db.tx(() => {
      db.prepare('DELETE FROM comments WHERE post_id = ?').run(post.id);
      db.prepare('DELETE FROM posts WHERE id = ?').run(post.id);
    });
    res.json({ ok: true });
  });

  app.post('/api/posts/:id/comments', auth, (req, res) => {
    const post = findPost(toId(req.params.id));
    const content = cleanText(req.body.content, 1000);
    if (!content) fail(400, '댓글 내용을 입력해 주세요.');
    const createdAt = now();
    const id = Number(db.prepare('INSERT INTO comments (post_id, user_id, content, created_at) VALUES (?, ?, ?, ?)')
      .run(post.id, req.user.id, content, createdAt).lastInsertRowid);
    if (post.user_id !== req.user.id) {
      notify([post.user_id], { type: 'comment', title: '내 글에 새 댓글', body: `${req.user.name}: ${content.slice(0, 60)}`, link: `board:${post.id}` });
    }
    res.json({ comment: { id, userId: req.user.id, content, createdAt } });
  });

  app.delete('/api/comments/:id', auth, (req, res) => {
    const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(toId(req.params.id)) || fail(404, '댓글을 찾을 수 없습니다.');
    if (!canEdit(req.user, comment)) fail(403, '작성자와 관리자만 삭제할 수 있습니다.');
    db.prepare('DELETE FROM comments WHERE id = ?').run(comment.id);
    res.json({ ok: true });
  });
};
