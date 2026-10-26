/* HowGo 主入口：导航 / 聊天 / 通讯录 / WS 事件 */
'use strict';

(function () {
  /* ================= 启动 ================= */
  async function boot() {
    try {
      const d = await httpGet('/api/me');
      State.me = d.user;
      State.me.isAdmin = d.isAdmin;
    } catch (_) {
      return;
    }
    $('#app').classList.remove('hidden');
    $('#railAvatar').innerHTML = avatarHTML(State.me, 'avatar-mini');
    if (new URLSearchParams(location.search).get('welcome')) toast('欢迎加入 HowGo！');

    if (State.me.isAdmin) $('#adminTabBtn').classList.remove('hidden');

    // 左侧导航
    $$('.rail-btn[data-tab]').forEach((btn) => {
      btn.onclick = () => switchTab(btn.dataset.tab);
    });
    $('#btnMyProfile').onclick = showMyProfileModal;

    // WS 事件分发
    State.wsHandlers = {
      msg: onWsMsg,
      conv_new: onWsConvNew,
      conv_update: onWsConvUpdate,
      friend_request: onWsFriendRequest,
      friend_update: onWsFriendUpdate,
      moment_update: () => { if (State.currentTab === 'moments') Moments.refresh(); },
      user_banned: () => {
        toast('账号已被封禁');
        setTimeout(() => { location.href = '/login.html'; }, 800);
      },
    };
    connectWs();

    await refreshChatsData();
    switchTab('chats');
    // 定时刷新会话未读状态（兜底）
    setInterval(() => { if (State.currentTab === 'chats') refreshChatsData(true); }, 60000);
  }

  /* ================= Tab ================= */
  async function switchTab(tab) {
    if (tab === 'admin' && !State.me.isAdmin) return;
    State.currentTab = tab;
    $$('.rail-btn[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'chats') {
      await refreshChatsData();
      renderChatsSide();
      renderChatsMain();
    } else if (tab === 'contacts') {
      await renderContactsSide();
      renderContactsDefaultMain();
    } else if (tab === 'moments') {
      await Moments.activate();
    } else if (tab === 'admin') {
      await Admin.activate();
    }
  }

  /* ================= 会话数据 ================= */
  async function refreshChatsData(silent) {
    try {
      State.convs = await httpGet('/api/conversations');
    } catch (e) {
      if (!silent) toast(e.message);
    }
  }

  function unreadTotal() {
    return State.convs.reduce((s, c) => s + (c.unread || 0), 0);
  }

  function updateChatBadge() {
    const n = unreadTotal();
    const badge = $('#chatBadge');
    badge.textContent = n > 99 ? '99+' : n;
    badge.classList.toggle('hidden', n === 0);
  }

  function upsertConvView(conv) {
    const idx = State.convs.findIndex((c) => c.id === conv.id);
    const isOpen = State.openConvId === conv.id;
    if (isOpen && conv.type === 'dm') {
      // 打开会话时未读由本地维护（置 0）
      const cur = State.convs[idx];
      if (cur) conv.unread = 0;
    }
    if (idx >= 0) State.convs[idx] = conv;
    else State.convs.unshift(conv);
    // 按 lastMessage / createdAt 排序
    State.convs.sort((a, b) => (b.lastMessage ? b.lastMessage.createdAt : b.createdAt).localeCompare(a.lastMessage ? a.lastMessage.createdAt : a.createdAt));
  }

  /* ================= 聊天列表（侧栏） ================= */
  function renderChatsSide() {
    const side = $('#sidePanel');
    if (side.dataset.mode === 'chats') {
      // 保持输入框等不重建：仅刷新列表容器
    } else {
      side.dataset.mode = 'chats';
    }
    side.innerHTML = `
      <div class="side-head"><h2>HowGo 聊天</h2></div>
      <div class="side-list" id="chatListEl"></div>`;
    const el = $('#chatListEl');
    if (!State.convs.length) {
      el.innerHTML = `<div style="text-align:center;color:#bbb;padding:30px 10px">还没有会话<br/>去通讯录添加好友聊聊吧</div>`;
      updateChatBadge();
      return;
    }
    el.innerHTML = State.convs.map((c) => {
      const last = c.lastMessage ? previewText(c.lastMessage) : '暂无消息';
      const t = c.lastMessage ? fmtTime(c.lastMessage.createdAt) : '';
      return `
      <div class="item ${c.id === State.openConvId ? 'active' : ''}" data-conv="${c.id}">
        <span class="ava">${avatarHTML({ avatar: c.avatar, nickname: c.name, color: c.type === 'group' ? '#1683e8' : undefined }, 'avatar-mini')}</span>
        <div class="item-main">
          <div class="item-title">
            <span class="item-name">${esc(c.name)}${c.type === 'group' ? ` <span style="color:#aaa;font-size:12px">(${c.memberCount})</span>` : ''}</span>
            <span class="item-time">${t}</span>
          </div>
          <div class="item-sub">
            <span class="item-preview">${esc(last)}</span>
            ${c.unread ? `<span class="item-count">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');
    $$('#chatListEl .item').forEach((it) => {
      it.onclick = () => openConv(it.dataset.conv);
    });
    updateChatBadge();
  }

  /* ================= 聊天主区 ================= */
  function renderChatsMain() {
    const main = $('#mainPanel');
    if (State.openConvId) {
      const conv = State.convs.find((c) => c.id === State.openConvId);
      if (conv && conv.isMember) {
        renderChatMain(conv);
        return;
      }
      State.openConvId = null;
    }
    main.innerHTML = `
      <div class="main-empty"><div class="big">💬</div><div>选择一个会话开始聊天</div></div>`;
  }

  async function openConv(convId) {
    State.openConvId = convId;
    renderChatsSide();
    renderChatsMain();
  }

  async function renderChatMain(conv) {
    const main = $('#mainPanel');
    const sub = conv.type === 'group' ? `${conv.memberCount} 位成员` : (conv.lastMessage ? '私聊' : '');
    main.innerHTML = `
      <div class="topbar">
        <h3>${esc(conv.name)}</h3>
        <span class="sub">${esc(sub)}</span>
        <div class="topbar-actions">
          <button class="btn-ghost" id="convMoreBtn" style="padding:4px 12px">···</button>
        </div>
      </div>
      <div class="chat-scroll" id="chatScroll"><div id="chatMsgs"></div></div>
      <div class="chat-input">
        <div class="chat-toolbar">
          <button id="emojiBtn" title="表情">${btnSvg('emoji')}</button>
          <button id="imgBtn" title="图片">${btnSvg('image')}</button>
          <button id="inviteBtn" title="邀请" style="${conv.type === 'group' ? '' : 'display:none'}">${btnSvg('add')}</button>
        </div>
        <div class="chat-input-row">
          <textarea id="chatInput" placeholder="输入消息..."></textarea>
          <button class="chat-send" id="sendBtn">发送</button>
        </div>
      </div>`;

    const emojiPanel = document.createElement('div');
    emojiPanel.className = 'emoji-panel hidden';
    emojiPanel.innerHTML = EMOJIS.map((e) => `<span data-emoji="${e}">${e}</span>`).join('');
    main.appendChild(emojiPanel);

    // 加载消息
    const data = await httpGet(`/api/conversations/${conv.id}/messages`);
    State.convs = State.convs.map((c) => (c.id === conv.id ? data.conversation : c));
    const scroll = $('#chatScroll');
    const wrap = $('#chatMsgs');
    let prevT = null;
    for (const m of data.messages) {
      const dt = new Date(m.createdAt);
      if (!prevT || dt.getTime() - prevT.getTime() > 5 * 60000) {
        wrap.appendChild(dateLine(m.createdAt));
      }
      prevT = dt;
      wrap.appendChild(msgEl(m));
    }
    scroll.scrollTop = scroll.scrollHeight;
    await httpPost(`/api/conversations/${conv.id}/read`);
    markConvReadLocal(conv.id);

    // 事件
    $('#sendBtn').onclick = sendCurrentMessage;
    $('#chatInput').onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendCurrentMessage(); }
    };
    $('#emojiBtn').onclick = () => emojiPanel.classList.toggle('hidden');
    emojiPanel.onclick = (e) => {
      const t = e.target.closest('[data-emoji]');
      if (!t) return;
      const ta = $('#chatInput');
      ta.value += t.dataset.emoji;
      ta.focus();
    };
    document.addEventListener('click', function hideEmoji(e2) {
      if (!e2.target.closest('#emojiBtn') && !e2.target.closest('.emoji-panel')) {
        emojiPanel.classList.add('hidden');
      }
    });
    $('#imgBtn').onclick = () => {
      pickImage(900, async (err, dataURL) => {
        if (err) return toast(err);
        try {
          const v = await httpPost('/api/messages', { convId: conv.id, type: 'image', content: dataURL });
          appendSentMsg(v);
        } catch (e) { toast(e.message); }
      });
    };
    const moreBtn = $('#convMoreBtn');
    moreBtn.onclick = () => showConvMenu(conv, emojiPanel);
    const inviteBtn = $('#inviteBtn');
    if (inviteBtn) inviteBtn.onclick = () => showGroupInfo(conv);
    $('#chatInput').focus();
  }

  function dateLine(iso) {
    const d = document.createElement('div');
    d.className = 'chat-date';
    const now = new Date();
    const t = new Date(iso);
    if (t.toDateString() === now.toDateString()) d.textContent = '今天 ' + fmtTime(iso);
    else if (new Date(now.getTime() - 86400000).toDateString() === t.toDateString()) d.textContent = '昨天 ' + fmtTime(iso);
    else d.textContent = fmtTime(iso, true);
    return d;
  }

  function msgEl(m) {
    const row = document.createElement('div');
    const isMe = m.senderId === State.me.id;
    row.className = 'msg-row' + (isMe ? ' me' : '');
    if (m.type === 'system') {
      row.className = 'msg-row';
      const b = document.createElement('div');
      b.className = 'bubble system';
      b.textContent = m.content;
      row.appendChild(b);
      return row;
    }
    const sender = { avatar: m.senderAvatar, nickname: m.senderName, color: m.senderColor };
    row.innerHTML = `${avatarHTML(sender, 'avatar-mini')}`;
    const body = document.createElement('div');
    body.className = 'msg-body';
    const isGroupConv = State.convs.find((c) => c.id === m.convId && c.type === 'group');
    if (isGroupConv && !isMe) {
      const nm = document.createElement('div');
      nm.className = 'msg-name';
      nm.textContent = m.senderName;
      body.appendChild(nm);
    }
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (m.type === 'image') {
      const img = document.createElement('img');
      img.className = 'msg-img';
      img.src = m.content;
      img.onclick = () => zoomImage(m.content);
      bubble.appendChild(img);
    } else {
      bubble.textContent = m.content;
    }
    body.appendChild(bubble);
    row.appendChild(body);
    return row;
  }

  function scrollToBottom() {
    const s = $('#chatScroll');
    if (s) s.scrollTop = s.scrollHeight;
  }

  function appendSentMsg(view) {
    const wrap = $('#chatMsgs');
    if (!wrap) return;
    wrap.appendChild(msgEl(view));
    scrollToBottom();
  }

  async function sendCurrentMessage() {
    const ta = $('#chatInput');
    const text = (ta.value || '').trim();
    if (!text || !State.openConvId) return;
    const btn = $('#sendBtn');
    btn.disabled = true;
    try {
      const v = await httpPost('/api/messages', { convId: State.openConvId, type: 'text', content: text });
      ta.value = '';
      appendSentMsg(v);
      const conv = State.convs.find((c) => c.id === State.openConvId);
      if (conv) { conv.lastMessage = v; upsertConvView(conv); renderChatsSide(); }
    } catch (e) {
      toast(e.message);
    } finally {
      btn.disabled = false;
      ta.focus();
    }
  }

  function markConvReadLocal(convId) {
    const c = State.convs.find((x) => x.id === convId);
    if (c && c.unread) { c.unread = 0; renderChatsSide(); }
  }

  /* ---------- 会话菜单（群信息 / 好友资料） ---------- */
  function showConvMenu(conv, emojiPanel) {
    if (conv.type === 'group') return showGroupInfo(conv);
    const peer = conv.members && conv.members.find((m) => m.id !== State.me.id);
    return contactProfile(peer);
  }

  async function showGroupInfo(conv) {
    const latest = State.convs.find((c) => c.id === conv.id) || conv;
    const members = latest.members || [];
    const canInvite = latest.ownerId === State.me.id;
    openModal({
      title: '群聊信息',
      width: 460,
      body: `
        <div style="margin-bottom:10px"><b>${esc(latest.name)}</b> <span style="color:#888;font-size:13px">${members.length} 位成员</span></div>
        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px" id="gmGrid">
          ${members.map((m) => `<div style="text-align:center">
            ${avatarHTML(m, 'avatar-mini')}
            <div style="font-size:11px;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(m.nickname)}</div>
            ${m.id === latest.ownerId ? '<div style="font-size:10px;color:#e6a23c">群主</div>' : (m.id === State.me.id ? '<div style="font-size:10px;color:#1683e8">我</div>' : '')}
          </div>`).join('')}
        </div>`,
      foot: `${canInvite ? `<button class="btn-primary" style="border:none" id="inviteBtn2">邀请好友</button>` : ''}
        <button class="btn-action danger" id="leaveBtn2">退出群聊</button>`,
      onMount: ({ close }) => {
        const ib = $('#inviteBtn2');
        if (ib) ib.onclick = () => { close(); inviteToGroup(latest); };
        const lb = $('#leaveBtn2');
        lb.onclick = async () => {
          if (!(await confirmModal('退出该群聊？', { okText: '退出' }))) return;
          await httpPost(`/api/conversations/${latest.id}/leave`);
          close();
          State.openConvId = null;
          await refreshChatsData();
          switchTab('chats');
          toast('已退出群聊');
        };
      },
    });
  }

  /* ================= 通讯录 ================= */
  async function renderContactsSide() {
    const side = $('#sidePanel');
    const friends = await httpGet('/api/friends');
    State.contacts = friends;
    const reqs = await httpGet('/api/friends/requests');
    const incoming = reqs.incoming.length;
    const badge = $('#friendBadge');
    badge.textContent = incoming;
    badge.classList.toggle('hidden', !incoming);

    side.innerHTML = `
      <div class="side-head"><h2>通讯录</h2><button class="btn-plain" id="contactSearchBtn" title="添加好友">${btnSvg('add')}</button></div>
      <div class="side-list">
        <div class="item" data-act="requests">
          ${avatarHTML({ nickname: '新的朋友', color: '#ff9f0a' }, 'avatar-mini')}
          <div class="item-main"><div class="item-name">新的朋友</div></div>
          ${incoming ? `<span class="item-count">${incoming > 99 ? '99+' : incoming}</span>` : ''}
        </div>
        <div class="item" data-act="newgroup">
          ${avatarHTML({ nickname: '发起群聊', color: '#10aeff' }, 'avatar-mini')}
          <div class="item-main"><div class="item-name">发起群聊</div></div>
        </div>
      </div>
      <div style="padding:8px 14px;color:#aaa;font-size:12px">好友（${friends.length}）</div>
      <div class="side-list" id="friendListEl" style="flex:1;overflow-y:auto"></div>`;

    const listEl = $('#friendListEl');
    if (!friends.length) listEl.innerHTML = '<div style="text-align:center;color:#bbb;padding:24px 10px">还没有好友<br/>点右上角 + 添加</div>';
    else {
      const grouped = {};
      for (const f of friends) {
        const ch = f.nickname ? f.nickname.slice(0, 1).toUpperCase() : '#';
        (grouped[ch] = grouped[ch] || []).push(f);
      }
      listEl.innerHTML = Object.keys(grouped).sort().map((k) => `
        <div style="padding:8px 14px 2px;color:#aaa;font-size:12px;font-weight:600">${esc(k)}</div>
        ${grouped[k].map((f) => `<div class="item" data-peer="${f.id}">
          ${avatarHTML(f, 'avatar-mini')}
          <div class="item-main"><div class="item-name">${esc(f.nickname)}</div></div>
        </div>`).join('')}`).join('');
    }

    $('#contactSearchBtn').onclick = openSearchModal;
    $$('#friendListEl .item[data-peer]').forEach((it) => {
      it.onclick = () => {
        const peer = friends.find((f) => f.id === it.dataset.peer);
        contactProfile(peer);
      };
    });
    $$('#sidePanel .item[data-act]').forEach((it) => {
      it.onclick = () => {
        if (it.dataset.act === 'requests') renderRequestsMain();
        if (it.dataset.act === 'newgroup') openGroupBuilder();
      };
    });
  }

  function renderContactsDefaultMain() {
    const main = $('#mainPanel');
    main.innerHTML = `<div class="main-empty"><div class="big">👥</div><div>选择联系人查看资料或开始聊天</div></div>`;
  }

  function contactProfile(peer) {
    if (!peer) return;
    const main = $('#mainPanel');
    main.innerHTML = `
      <div class="topbar"><button class="btn-plain" id="profileBackBtn" style="font-size:20px">‹</button><h3>${esc(peer.nickname)}</h3></div>
      <div class="profile-card">
        ${avatarHTML(peer, 'avatar-lg')}
        <div class="name">${esc(peer.nickname)}${peer.role === 'admin' ? ' <span class="tag admin">管理员</span>' : ''}</div>
        ${peer.bio ? `<div class="bio">${esc(peer.bio)}</div>` : ''}
        <div class="meta">热土账号：${esc(peer.hotuEmail || peer.id)} · 加入于 ${fmtDate(peer.createdAt)}</div>
        <div class="profile-actions">
          <button class="btn-action green" id="msgPeerBtn">发消息</button>
          <button class="btn-action danger" id="delPeerBtn">删除好友</button>
        </div>
      </div>`;
    $('#profileBackBtn').onclick = () => { switchTab('contacts'); renderContactsSide(); renderContactsDefaultMain(); };
    $('#msgPeerBtn').onclick = async () => {
      try {
        const conv = await httpPost('/api/conversations/dm', { userId: peer.id });
        await refreshChatsData();
        switchTab('chats');
        await openConv(conv.id);
      } catch (e) { toast(e.message); }
    };
    $('#delPeerBtn').onclick = async () => {
      if (!(await confirmModal(`删除好友「${peer.nickname}」？删除后无法继续私聊。`, { okText: '删除' }))) return;
      await httpDelete(`/api/friends/${peer.id}`);
      toast('已删除');
      await renderContactsSide();
      renderContactsDefaultMain();
    };
  }

  async function renderRequestsMain() {
    const d = await httpGet('/api/friends/requests');
    const main = $('#mainPanel');
    const incRow = (r) => `
      <div class="item" data-req="${r.id}">
        ${avatarHTML(r.user, 'avatar-mini')}
        <div class="item-main">
          <div class="item-name">${esc(r.user.nickname)}</div>
          <div class="item-preview">${esc(r.message || '请求添加你为好友')} · ${fmtTime(r.createdAt)}</div>
        </div>
        <button class="btn-action green" data-accept="${r.id}" style="padding:5px 14px">接受</button>
        <button class="btn-action gray" data-reject="${r.id}" style="padding:5px 14px">拒绝</button>
      </div>`;
    main.innerHTML = `
      <div class="topbar"><h3>新的朋友</h3></div>
      <div style="padding:10px 16px;flex:1;overflow-y:auto">
        <div style="color:#666;font-size:13px;margin:6px 0">收到（${d.incoming.length}）</div>
        ${d.incoming.map(incRow).join('') || '<div style="color:#bbb;padding:6px 4px">暂无待处理的申请</div>'}
        <div style="color:#666;font-size:13px;margin:14px 0 6px">已发送（${d.outgoing.length}）</div>
        ${d.outgoing.map((r) => `
          <div class="item" style="cursor:default">
            ${avatarHTML(r.user, 'avatar-mini')}
            <div class="item-main"><div class="item-name">${esc(r.user.nickname)}</div><div class="item-preview">等待对方通过</div></div>
          </div>`).join('') || '<div style="color:#bbb;padding:6px 4px">暂无已发送的申请</div>'}
      </div>`;
    $('#mainPanel').onclick = async (e) => {
      const a = e.target.closest('[data-accept]');
      const r = e.target.closest('[data-reject]');
      try {
        if (a) { await httpPost(`/api/friends/requests/${a.dataset.accept}/respond`, { accept: true }); toast('已添加好友'); }
        if (r) { await httpPost(`/api/friends/requests/${r.dataset.reject}/respond`, { accept: false }); toast('已拒绝'); }
        if (a || r) { await renderRequestsMain(); await renderContactsSide(); }
      } catch (err) { toast(err.message); }
    };
  }

  /* ---------- 搜索 / 加好友 ---------- */
  function openSearchModal() {
    openModal({
      title: '添加好友',
      width: 440,
      body: `
        <div class="form-row"><input id="searchKw" placeholder="输入昵称 / 热土 UID / 邮箱" /></div>
        <div id="searchResult" style="min-height:40px;color:#aaa;font-size:13px"></div>`,
      onMount: () => {
        let timer = null;
        const doSearch = async () => {
          const kw = $('#searchKw').value.trim();
          const box = $('#searchResult');
          if (!kw) { box.innerHTML = ''; return; }
          box.innerHTML = '<div style="color:#aaa;padding:6px">搜索中...</div>';
          try {
            const list = await httpGet('/api/users/search?q=' + encodeURIComponent(kw));
            if (!list.length) { box.innerHTML = '<div style="color:#aaa;padding:6px">没有找到相关用户</div>'; return; }
            box.innerHTML = list.map((u) => {
              let action = '';
              if (u.relation === 'friend') action = '<span class="tag user">已是好友</span>';
              else if (u.relation === 'outgoing') action = '<span class="tag admin">等待验证</span>';
              else if (u.relation === 'incoming') action = `<button class="btn-action green" data-accept="${u.requestId}" style="padding:4px 12px">接受</button>`;
              else action = `<button class="btn-action orange" data-add="${u.id}" style="padding:4px 12px">添加好友</button>`;
              return `<div class="search-result-item">
                ${avatarHTML(u, 'avatar-mini avatar-sm')}
                <div class="info"><div class="n">${esc(u.nickname)}</div><div class="s">${esc(u.hotuEmail || '热土用户')}</div></div>${action}
              </div>`;
            }).join('');
            $$('#searchResult [data-add]').forEach((b) => {
              b.onclick = () => addFriendFlow(u => ({ toUserId: u.id }), { id: b.dataset.add });
            });
            $$('#searchResult [data-accept]').forEach((b) => {
              b.onclick = async () => {
                try {
                  await httpPost(`/api/friends/requests/${b.dataset.accept}/respond`, { accept: true });
                  toast('已添加好友'); doSearch();
                } catch (e) { toast(e.message); }
              };
            });
          } catch (e) { box.innerHTML = `<div style="color:red;padding:6px">${esc(e.message)}</div>`; }
        };
        $('#searchKw').addEventListener('input', () => {
          clearTimeout(timer);
          timer = setTimeout(doSearch, 350);
        });
        $('#searchKw').focus();
      },
    });
  }

  function addFriendFlow(getTarget, item) {
    openModal({
      title: '好友申请',
      width: 420,
      body: `<div class="form-row"><label>验证信息（可选）</label><textarea id="reqMsg" placeholder="我是..."></textarea></div>`,
      foot: `<button class="btn-primary" style="border:none" id="reqSend">发送申请</button>`,
      onMount: ({ close }) => {
        $('#reqSend').onclick = async () => {
          try {
            const target = getTarget(item);
            const d = await httpPost('/api/friends/requests', { toUserId: target.id, message: $('#reqMsg').value });
            close();
            if (d.autoAccepted) toast('对方也添加了你，已成为好友');
            else toast('好友申请已发送');
          } catch (e) { toast(e.message); }
        };
      },
    });
  }

  /* ---------- 群聊 ---------- */
  function openGroupBuilder() {
    const friends = State.contacts.filter((f) => f.status !== 'banned');
    const chosen = new Set();
    const render = () => {
      const rows = friends.map((f) => `
        <div class="search-result-item" data-id="${f.id}" style="cursor:pointer">
          ${avatarHTML(f, 'avatar-mini avatar-sm')}
          <div class="info"><div class="n">${esc(f.nickname)}</div></div>
          <input type="checkbox" data-cb="${f.id}" ${chosen.has(f.id) ? 'checked' : ''} style="width:18px;height:18px"/>
        </div>`).join('');
      $('#gbList').innerHTML = rows || '<div style="color:#aaa;padding:6px">还没有好友可选</div>';
      $$('#gbList [data-cb]').forEach((cb) => {
        cb.onchange = () => {
          if (cb.checked) chosen.add(cb.dataset.cb); else chosen.delete(cb.dataset.cb);
          $('#gbCount').textContent = chosen.size ? `已选 ${chosen.size} 人` : '请选择好友';
        };
      });
    };
    openModal({
      title: '发起群聊',
      width: 440,
      body: `
        <div class="form-row"><input id="gbName" placeholder="群聊名称（必填）" maxlength="20" /></div>
        <div style="color:#666;font-size:13px;margin-bottom:6px">选择好友 <span id="gbCount">请选择好友</span></div>
        <div id="gbList" style="max-height:300px;overflow-y:auto"></div>`,
      foot: `<button class="btn-primary" style="border:none" id="gbCreate">创建</button>`,
      onMount: ({ close }) => {
        render();
        $('#gbCreate').onclick = async () => {
          const name = $('#gbName').value.trim();
          if (!name) return toast('请填写群聊名称');
          try {
            const conv = await httpPost('/api/conversations/group', { name, memberIds: [...chosen] });
            close();
            await refreshChatsData();
            switchTab('chats');
            await openConv(conv.id);
            toast('群聊创建成功');
          } catch (e) { toast(e.message); }
        };
      },
    });
  }

  async function inviteToGroup(conv) {
    const members = new Set(conv.members.map((m) => m.id));
    const candidates = State.contacts.filter((f) => !members.has(f.id));
    if (!candidates.length) return toast('没有可邀请的好友');
    const chosen = new Set();
    openModal({
      title: `邀请加入「${conv.name}」`,
      width: 420,
      body: `<div id="invList" style="max-height:340px;overflow-y:auto"></div>`,
      foot: `<button class="btn-primary" style="border:none" id="invSend">邀请</button>`,
      onMount: ({ close }) => {
        const list = $('#invList');
        const render = () => {
          list.innerHTML = candidates.map((f) => `
            <div class="search-result-item">
              ${avatarHTML(f, 'avatar-mini avatar-sm')}
              <div class="info"><div class="n">${esc(f.nickname)}</div></div>
              <input type="checkbox" data-cb="${f.id}" ${chosen.has(f.id) ? 'checked' : ''} style="width:18px;height:18px"/>
            </div>`).join('') || '<div style="color:#aaa">所有好友都在群里了</div>';
          $$('#invList [data-cb]').forEach((cb) => {
            cb.onchange = () => { if (cb.checked) chosen.add(cb.dataset.cb); else chosen.delete(cb.dataset.cb); };
          });
        };
        render();
        $('#invSend').onclick = async () => {
          if (!chosen.size) return toast('请选择要邀请的好友');
          try {
            await httpPost(`/api/conversations/${conv.id}/members`, { memberIds: [...chosen] });
            close();
            await refreshChatsData();
            renderChatsSide();
            if (State.openConvId === conv.id) await renderChatMain(State.convs.find((c) => c.id === conv.id));
            toast('邀请已发送');
          } catch (e) { toast(e.message); }
        };
      },
    });
  }

  /* ---------- 我的资料 ---------- */
  function showMyProfileModal() {
    openModal({
      title: '我的资料',
      width: 440,
      body: `
        <div style="display:flex;gap:16px;align-items:center;margin-bottom:14px">
          <span id="myAvatarBox" style="cursor:pointer" title="点击修改头像">${avatarHTML(State.me, 'avatar-lg')}</span>
          <div style="flex:1">
            <div class="form-row" style="margin-bottom:6px"><input id="myNick" value="${esc(State.me.nickname)}" maxlength="20" /></div>
            <div class="form-row" style="margin-bottom:0"><input id="myBio" placeholder="个性签名" value="${esc(State.me.bio || '')}" maxlength="60" /></div>
          </div>
        </div>
        <div style="color:#999;font-size:12px;line-height:1.7">热土账号：${esc(State.me.hotuEmail || State.me.id)}<br/>角色：${State.me.isAdmin ? '管理员' : '普通用户'} · 注册于 ${fmtDate(State.me.createdAt)}</div>`,
      foot: `<button class="btn-primary" style="border:none" id="saveMeBtn">保存</button>
        <button class="btn-action danger" id="logoutBtn" style="border:none">退出登录</button>`,
      onMount: ({ close }) => {
        $('#myAvatarBox').onclick = () => {
          pickImage(220, async (err, dataURL) => {
            if (err) return toast(err);
            const u = await httpPatch('/api/me', { avatar: dataURL });
            State.me = { ...State.me, ...u.user, isAdmin: State.me.isAdmin };
            $('#myAvatarBox').innerHTML = avatarHTML(u.user, 'avatar-lg');
            $('#railAvatar').innerHTML = avatarHTML(u.user, 'avatar-mini');
            toast('头像已更新');
          });
        };
        $('#saveMeBtn').onclick = async () => {
          const patch = { nickname: $('#myNick').value.trim(), bio: $('#myBio').value.trim() };
          if (!patch.nickname) return toast('昵称不能为空');
          try {
            const u = await httpPatch('/api/me', patch);
            State.me = { ...State.me, ...u.user, isAdmin: State.me.isAdmin };
            $('#railAvatar').innerHTML = avatarHTML(u.user, 'avatar-mini');
            toast('已保存');
            close();
          } catch (e) { toast(e.message); }
        };
        $('#logoutBtn').onclick = async () => {
          await httpPost('/api/logout');
          location.href = '/login.html';
        };
      },
    });
  }

  /* ================= WS Handlers ================= */
  async function onWsMsg(msg) {
    if (msg.senderId === State.me.id) {
      // 其它设备发送的消息：仅在打开该会话时展示
      if (State.currentTab === 'chats' && State.openConvId === msg.convId && $('#chatMsgs')) {
        appendSentMsg(msg);
        await httpPost(`/api/conversations/${msg.convId}/read`);
      } else {
        const conv = State.convs.find((c) => c.id === msg.convId);
        if (conv) {
          conv.lastMessage = msg;
          conv.unread = (conv.unread || 0) + (msg.senderId !== State.me.id ? 1 : 0);
          upsertConvView(conv);
          renderChatsSide();
        }
      }
      return;
    }
    const isOpen = State.currentTab === 'chats' && State.openConvId === msg.convId && $('#chatMsgs');
    if (isOpen) {
      const wrap = $('#chatMsgs');
      const lastEl = wrap.lastElementChild;
      const isDate = lastEl && lastEl.classList.contains('chat-date');
      const anchor = isDate ? null : lastEl;
      const prevT = anchor ? new Date((State.convs.find((c) => c.id === msg.convId) || {}).lastMessage ? msg.createdAt : Date.now()) : null;
      const dt = new Date(msg.createdAt);
      const lastT = lastEl && lastEl.dataset.t ? new Date(lastEl.dataset.t) : null;
      if (!lastT || dt.getTime() - lastT.getTime() > 5 * 60000) {
        const dl = dateLine(msg.createdAt);
        dl.dataset.t = msg.createdAt;
        wrap.appendChild(dl);
      }
      wrap.appendChild(msgEl(msg));
      // 记录最近一条时间便于分隔判断
      const lastMsgEl = wrap.lastElementChild;
      lastMsgEl.dataset.t = msg.createdAt;
      scrollToBottom();
      await httpPost(`/api/conversations/${msg.convId}/read`);
      markConvReadLocal(msg.convId);
    } else {
      const conv = State.convs.find((c) => c.id === msg.convId);
      if (conv) {
        conv.lastMessage = msg;
        conv.unread = (conv.unread || 0) + 1;
        upsertConvView(conv);
        if (State.currentTab === 'chats') renderChatsSide();
      }
    }
  }

  async function onWsConvNew(conv) {
    upsertConvView(conv);
    if (State.currentTab === 'chats') renderChatsSide();
  }

  async function onWsConvUpdate(conv) {
    upsertConvView(conv);
    if (State.currentTab === 'chats') {
      renderChatsSide();
      // 群聊信息在打开时刷新
      if (State.openConvId === conv.id && conv.type === 'group') {
        const top = $('#mainPanel .topbar h3');
        if (top) {
          top.textContent = conv.name;
          const sib = top.parentElement.querySelector('.sub');
          if (sib) sib.textContent = `${conv.memberCount} 位成员`;
        }
      }
    }
    // 会话被删除/退群后已不是成员
    if (State.openConvId === conv.id && !conv.isMember) {
      State.openConvId = null;
      if (State.currentTab === 'chats') renderChatsMain();
    }
  }

  function onWsFriendRequest(data) {
    const badge = $('#friendBadge');
    const n = (parseInt(badge.textContent, 10) || 0) + 1;
    badge.textContent = n;
    badge.classList.remove('hidden');
    toast(`${data.user.nickname} 请求添加你为好友`);
    if (State.currentTab === 'contacts') renderContactsSide();
  }

  async function onWsFriendUpdate(data) {
    // data: { friend, status }
    if (State.currentTab === 'contacts') {
      await renderContactsSide();
    } else {
      // 若好友关系变化，需刷新好友列表缓存
      State.contacts = await httpGet('/api/friends').catch(() => State.contacts);
    }
  }

  /* ================= 兜底渲染错误 ================= */
  window.addEventListener('error', (e) => {
    console.error(e.error || e.message);
  });

  boot();
})();
