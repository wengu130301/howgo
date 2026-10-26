/* HowGo 管理后台模块 */
'use strict';

window.Admin = (function () {
  const NAV = [
    { v: 'overview', label: '数据概览', icon: '📊' },
    { v: 'users', label: '用户管理', icon: '👥' },
    { v: 'convs', label: '会话管理', icon: '💬' },
    { v: 'moments', label: '动态管理', icon: '📷' },
    { v: 'logs', label: '操作日志', icon: '📜' },
  ];

  let current = 'overview';

  async function activate() {
    const side = $('#sidePanel');
    side.innerHTML = `
      <div class="side-head"><h2>管理后台</h2></div>
      <div class="side-list">${NAV.map((n) => `
        <div class="item" data-view="${n.v}" style="${n.v === current ? 'background:#e9f7ef' : ''}">
          <span style="font-size:17px">${n.icon}</span>
          <div class="item-main"><div class="item-name">${n.label}</div></div>
        </div>`).join('')}
      </div>`;
    $$('[data-view]', side).forEach((it) => {
      it.onclick = async () => { current = it.dataset.view; await activate(); };
    });
    await loadView(current);
  }

  async function loadView(v) {
    const main = $('#mainPanel');
    try {
      if (v === 'overview') return await renderOverview(main);
      if (v === 'users') return await renderUsers(main);
      if (v === 'convs') return await renderConvs(main);
      if (v === 'moments') return await renderMoments(main);
      if (v === 'logs') return await renderLogs(main);
    } catch (e) {
      main.innerHTML = `<div class="main-empty"><div>${esc(e.message)}</div></div>`;
    }
  }

  async function renderOverview(main) {
    const s = await httpGet('/api/admin/stats');
    main.innerHTML = `
      <div class="topbar"><h3>数据概览</h3></div>
      <div class="admin-grid">
        <div class="stat-card"><div class="lbl">注册用户</div><div class="num">${s.userCount}</div></div>
        <div class="stat-card"><div class="lbl">24h 活跃</div><div class="num">${s.activeToday}</div></div>
        <div class="stat-card"><div class="lbl">好友关系</div><div class="num">${s.friendCount}</div></div>
        <div class="stat-card"><div class="lbl">私聊会话</div><div class="num">${s.dmCount}</div></div>
        <div class="stat-card"><div class="lbl">群聊会话</div><div class="num">${s.groupCount}</div></div>
        <div class="stat-card"><div class="lbl">消息总数</div><div class="num">${s.messageCount}</div></div>
        <div class="stat-card"><div class="lbl">朋友圈动态</div><div class="num">${s.momentCount}</div></div>
      </div>`;
  }

  async function renderUsers(main) {
    const users = await httpGet('/api/admin/users');
    const rows = users.map((u) => `
      <tr>
        <td><div class="cell-user">${avatarHTML(u, 'avatar-mini avatar-sm')} <b>${esc(u.nickname)}</b> ${u.role === 'admin' ? '<span class="tag admin">管理员</span>' : '<span class="tag user">用户</span>'} ${u.status === 'banned' ? '<span class="tag banned">已封禁</span>' : ''}</div></td>
        <td style="font-size:12px;color:#888">${esc(u.hotuUid)}</td>
        <td>${esc(u.hotuEmail || '-')}</td>
        <td style="color:#888;font-size:12px">${fmtDate(u.createdAt)}</td>
        <td>${u.status === 'banned'
          ? `<button class="btn-action gray" data-unban="${u.id}" style="padding:4px 12px">解封</button>`
          : `<button class="btn-action danger" data-ban="${u.id}" style="padding:4px 12px">封禁</button>`}</td>
      </tr>`).join('');
    main.innerHTML = `
      <div class="topbar"><h3>用户管理（${users.length}）</h3></div>
      <div class="table-wrap"><table class="hg-table">
        <thead><tr><th>用户</th><th>热土 UID</th><th>邮箱</th><th>注册时间</th><th>操作</th></tr></thead>
        <tbody id="userTbody">${rows || `<tr><td colspan="5" style="color:#aaa;text-align:center">暂无用户</td></tr>`}</tbody>
      </table></div>`;
    $('#userTbody').onclick = async (e) => {
      const banBtn = e.target.closest('[data-ban]');
      const unbanBtn = e.target.closest('[data-unban]');
      if (banBtn) {
        if (!(await confirmModal('确认封禁该用户？封禁后其会话立即失效。', { okText: '封禁' }))) return;
        await httpPost(`/api/admin/users/${banBtn.dataset.ban}/ban`);
        toast('已封禁');
      }
      if (unbanBtn) {
        await httpPost(`/api/admin/users/${unbanBtn.dataset.unban}/unban`);
        toast('已解封');
      }
      await renderUsers(main);
    };
  }

  async function renderConvs(main) {
    const convs = await httpGet('/api/admin/conversations');
    const rows = convs.map((c) => `
      <tr>
        <td style="font-size:12px;color:#888">${c.id.slice(0, 8)}</td>
        <td>${c.type === 'group' ? '<span class="tag user">群聊</span>' : '<span class="tag admin">私聊</span>'}</td>
        <td>${esc(c.name)}</td>
        <td style="font-size:12px">${esc(c.members.map((m) => m.nickname + (m.status === 'banned' ? '(封)' : '')).join('、').slice(0, 60))}</td>
        <td>${c.members.length}</td>
        <td>${c.msgCount}</td>
        <td style="color:#888;font-size:12px">${fmtDate(c.createdAt)}</td>
        <td><button class="btn-action danger" data-del="${c.id}" style="padding:4px 12px">删除会话</button></td>
      </tr>`).join('');
    main.innerHTML = `
      <div class="topbar"><h3>会话管理（${convs.length}）</h3></div>
      <div class="table-wrap"><table class="hg-table">
        <thead><tr><th>ID</th><th>类型</th><th>名称</th><th>成员</th><th>人数</th><th>消息数</th><th>创建时间</th><th>操作</th></tr></thead>
        <tbody id="convTbody">${rows || `<tr><td colspan="8" style="color:#aaa;text-align:center">暂无会话</td></tr>`}</tbody>
      </table></div>`;
    $('#convTbody').onclick = async (e) => {
      const b = e.target.closest('[data-del]');
      if (!b) return;
      if (!(await confirmModal('删除会话将清空其全部消息且不可恢复，确认删除？', { okText: '删除' }))) return;
      await httpDelete(`/api/admin/conversations/${b.dataset.del}`);
      toast('会话已删除');
      await renderConvs(main);
    };
  }

  async function renderMoments(main) {
    const list = await httpGet('/api/admin/moments');
    const body = list.length
      ? list.map((m) => `
        <div class="feed" style="background:#fff;border-radius:12px;padding:12px 16px;margin:10px 0">
          <div style="display:flex;align-items:center;gap:10px">
            ${avatarHTML(m.author, 'avatar-mini avatar-sm')}
            <div style="flex:1"><b>${esc(m.author.nickname)}</b><div style="color:#aaa;font-size:12px">${fmtDate(m.createdAt)} · 赞 ${m.likes.length} · 评 ${m.comments.length}</div></div>
            <button class="btn-action danger" data-del="${m.id}" style="padding:4px 12px">删除</button>
          </div>
          ${m.content ? `<div style="margin:8px 0;white-space:pre-wrap">${esc(m.content)}</div>` : ''}
          ${m.images.length ? `<div style="display:flex;gap:6px;flex-wrap:wrap">${m.images.slice(0, 4).map((s) => `<img src="${esc(s)}" style="width:64px;height:64px;object-fit:cover;border-radius:6px"/>`).join('')}${m.images.length > 4 ? `<span style="align-self:center;color:#aaa">+${m.images.length - 4}</span>` : ''}</div>` : ''}
        </div>`).join('')
      : '<div class="main-empty"><div>暂无动态</div></div>';
    main.innerHTML = `<div class="topbar"><h3>动态管理（${list.length}）</h3></div><div style="padding:6px 16px;overflow-y:auto;flex:1">${body}</div>`;
    $('#mainPanel').onclick = async (e) => {
      const b = e.target.closest('[data-del]');
      if (!b) return;
      if (!(await confirmModal('确认删除该动态？', { okText: '删除' }))) return;
      await httpDelete(`/api/admin/moments/${b.dataset.del}`);
      toast('已删除');
      await renderMoments(main);
    };
  }

  async function renderLogs(main) {
    const logs = await httpGet('/api/admin/logs');
    const rows = logs.map((l) => `
      <tr>
        <td style="color:#888;font-size:12px">${fmtDate(l.createdAt)}</td>
        <td>${esc(l.action)}</td>
        <td style="color:#888;font-size:12px">${esc(JSON.stringify(l.detail || {}).slice(0, 140))}</td>
      </tr>`).join('');
    main.innerHTML = `
      <div class="topbar"><h3>操作日志</h3></div>
      <div class="table-wrap"><table class="hg-table">
        <thead><tr><th>时间</th><th>动作</th><th>详情</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="3" style="color:#aaa;text-align:center">暂无日志</td></tr>`}</tbody>
      </table></div>`;
  }

  return { activate };
})();
