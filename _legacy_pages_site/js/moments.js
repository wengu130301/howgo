/* HowGo 朋友圈模块 */
'use strict';

window.Moments = (function () {
  let feeds = [];
  let offset = 0;
  let total = 0;
  let mode = 'all';
  const PAGE = 10;

  async function activate() {
    const side = $('#sidePanel');
    side.innerHTML = `
      <div class="side-head"><h2>朋友圈</h2></div>
      <div class="side-list" style="padding:12px">
        <div class="item" id="momMyCard" style="border-radius:10px;background:#f5faf7">
          <span id="momMeAvatar"></span>
          <div class="item-main"><div class="item-name">${esc(State.me.nickname)}</div>
          <div class="item-preview">查看我的朋友圈</div></div>
        </div>
        <div class="item" id="momPublishBtn" style="border-radius:10px">
          <span class="avatar-mini" style="background:var(--green);font-size:20px">+</span>
          <div class="item-main"><div class="item-name">发布动态</div>
          <div class="item-preview">分享新鲜事给好友</div></div>
        </div>
      </div>`;
    $('#momMeAvatar').innerHTML = avatarHTML(State.me);
    $('#momMyCard').onclick = () => window.Moments.showMine();
    $('#momPublishBtn').onclick = () => window.Moments.openPublish();

    const main = $('#mainPanel');
    main.innerHTML = `
      <div class="topbar"><h3>${mode === 'mine' ? '我的朋友圈' : '朋友圈'}</h3>
        ${mode === 'mine' ? '<button class="btn-ghost" id="backAllBtn">全部动态</button>' : ''}
      </div>
      <div class="mom-feeds" id="feedsEl"></div>
      <div style="text-align:center;padding-bottom:20px">
        <button class="btn-ghost" id="loadMoreBtn">加载更多</button>
      </div>`;

    await refresh();
    $('#loadMoreBtn').onclick = loadMore;
    const backBtn = $('#backAllBtn');
    if (backBtn) backBtn.onclick = () => { mode = 'all'; activate(); };
  }

  async function refresh() {
    offset = 0;
    await fetchFeeds();
    render();
  }

  async function loadMore() {
    offset += PAGE;
    await fetchFeeds();
    render();
  }

  async function fetchFeeds() {
    const mine = mode === 'mine' ? '&mine=1' : '';
    const d = await httpGet(`/api/moments?offset=${offset}&limit=${PAGE}${mine}`);
    // 服务端按 offset 返回片段，这里简单全量刷新顶层
    if (offset === 0) feeds = d.items;
    else {
      const seen = new Set(feeds.map((f) => f.id));
      for (const f of d.items) if (!seen.has(f.id)) feeds.push(f);
    }
    total = d.total;
  }

  function render() {
    const el = $('#feedsEl');
    if (!el) return;
    if (!feeds.length) {
      el.innerHTML = `<div class="main-empty"><div class="big">📷</div><div>朋友圈还没有动态</div></div>`;
      return;
    }
    el.innerHTML = feeds.map(feedHTML).join('');
    bindFeedEvents();
  }

  function feedHTML(v) {
    const imgs = v.images.length
      ? `<div class="feed-imgs s${v.images.length}">${v.images.map((s) => `<img src="${esc(s)}" alt=""/>`).join('')}</div>`
      : '';
    const likes = v.likes.length
      ? `<div class="feed-likes">❤️ ${v.likes.map((l) => `<span class="lk" data-user="${l.userId}">${esc(l.nickname)}</span>`).join('，')}</div>`
      : '';
    const comments = v.comments.length
      ? `<div class="feed-comments">${v.comments.map((c) => `<div class="cm" data-comment="${c.id}"><span class="cm-name">${esc(c.nickname)}：</span>${esc(c.content)}</div>`).join('')}</div>`
      : '';
    const canDelete = v.author.id === State.me.id;
    return `
    <div class="feed" data-feed="${v.id}">
      <div class="feed-head">
        ${avatarHTML(v.author, 'avatar-mini avatar-sm')}
        <div style="flex:1;min-width:0">
          <div class="feed-name">${esc(v.author.nickname)}</div>
          <div class="feed-time">${fmtDate(v.createdAt)}</div>
        </div>
        ${canDelete ? '<button class="btn-plain danger" data-del="1">删除</button>' : ''}
      </div>
      ${v.content ? `<div class="feed-content">${esc(v.content)}</div>` : ''}
      ${imgs}
      <div class="feed-foot">
        <span data-like="1" style="cursor:pointer">${v.likedByMe ? '❤️ 已赞' : '🤍 点赞'}</span>
        <span data-comment="1" style="cursor:pointer">💬 评论</span>
      </div>
      ${likes}
      ${comments}
      <div class="feed-input hidden">
        <input placeholder="评论一下..." />
        <button>发送</button>
      </div>
    </div>`;
  }

  function bindFeedEvents() {
    const el = $('#feedsEl');
    if (!el) return;
    el.onclick = async (e) => {
      const feedEl = e.target.closest('.feed');
      if (!feedEl) return;
      const id = feedEl.dataset.feed;
      if (e.target.closest('[data-del]')) {
        const yes = await confirmModal('删除这条朋友圈？');
        if (!yes) return;
        await httpDelete(`/api/moments/${id}`);
        toast('已删除');
        await refresh();
        return;
      }
      if (e.target.closest('[data-like]')) {
        await httpPost(`/api/moments/${id}/like`);
        await refresh();
        return;
      }
      if (e.target.closest('[data-comment]')) {
        const box = feedEl.querySelector('.feed-input');
        box.classList.toggle('hidden');
        if (!box.classList.contains('hidden')) box.querySelector('input').focus();
        return;
      }
      const img = e.target.closest('img');
      if (img && feedEl.contains(img)) zoomImage(img.src);
    };
    el.onkeydown = async (e) => {
      if (e.key !== 'Enter') return;
      const input = e.target;
      if (!input || input.tagName !== 'INPUT') return;
      const feedEl = input.closest('.feed');
      if (!feedEl || feedEl.querySelector('.feed-input').classList.contains('hidden')) return;
      const text = input.value.trim();
      if (!text) return;
      await httpPost(`/api/moments/${feedEl.dataset.feed}/comments`, { content: text });
      await refresh();
    };
  }

  // 发布后重新绑定事件
  async function afterRender() { bindFeedEvents(); }

  async function openPublish() {
    const images = [];
    openModal({
      title: '发布动态',
      width: 480,
      body: `
        <div class="form-row"><textarea id="pubContent" placeholder="这一刻的想法..."></textarea></div>
        <div id="pubImgs" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px"></div>
        <button class="btn-ghost" id="pubAddImg" style="margin-top:8px">＋ 添加图片</button>
        <div style="color:#999;font-size:12px;margin-top:6px">图片将自动压缩，最多 9 张</div>`,
      foot: `<button class="btn-primary" style="border:none" id="pubSubmit">发布</button>`,
      onMount: ({ close }) => {
        const box = $('#pubImgs');
        function renderImgs() {
          box.innerHTML = images
            .map((src, i) => `<div style="position:relative"><img src="${src}" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px"/>
              <button data-i="${i}" style="position:absolute;top:-6px;right:-6px;width:22px;height:22px;border-radius:50%;border:none;background:#fa5151;color:#fff">×</button></div>`)
            .join('');
          $$('[data-i]', box).forEach((b) => {
            b.onclick = () => { images.splice(+b.dataset.i, 1); renderImgs(); };
          });
        }
        $('#pubAddImg').onclick = () => {
          pickImage(1000, (err, dataURL) => {
            if (err) return toast(err);
            if (images.length >= 9) return toast('最多 9 张图片');
            images.push(dataURL);
            renderImgs();
          });
        };
        $('#pubSubmit').onclick = async () => {
          const content = $('#pubContent').value.trim();
          if (!content && !images.length) return toast('写点什么或选张图吧');
          await httpPost('/api/moments', { content, images });
          close();
          toast('发布成功');
          await refresh();
        };
      },
    });
  }

  async function showMine() {
    mode = 'mine';
    await activate();
  }

  return {
    activate,
    refresh,
    afterRender,
    openPublish,
    showMine,
    get feedCount() { return feeds.length; },
  };
})();
