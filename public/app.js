/* HowGo 前端主逻辑 — LaswI Studio (c) 2026 */
'use strict';

const $ = (sel) => document.querySelector(sel);

const state = {
  me: null,
  banned: false,
  chats: [],
  contacts: [],
  activeChatId: null,
  activePeer: null,
  panel: 'chats',
  adminTab: 'overview',
  lastMsgId: 0,
  authMode: 'laswi',
  laswiEnabled: false,
  pollTimer: null
};

/* ---------------- 基础工具 ---------------- */

function el(tag, opts, ...children) {
  const node = document.createElement(tag);
  opts = opts || {};
  if (opts.class) node.className = opts.class;
  if (opts.text != null) node.textContent = String(opts.text);
  if (opts.attrs) for (const k in opts.attrs) node.setAttribute(k, opts.attrs[k]);
  if (opts.on) for (const k in opts.on) node.addEventListener(k, opts.on[k]);
  children.flat().forEach((c) => {
    if (c == null || c === false) return;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

let toastTimer = null;
function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return hh + ':' + mm;
  const yesterday = new Date(now.getTime() - 86400000);
  if (d.toDateString() === yesterday.toDateString()) return '昨天 ' + hh + ':' + mm;
  return d.getMonth() + 1 + '月' + d.getDate() + '日 ' + hh + ':' + mm;
}

function initial(name) {
  return (name || '?').slice(0, 1).toUpperCase();
}

async function api(path, opts) {
  opts = opts || {};
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin'
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = { error: '响应解析失败（HTTP ' + res.status + '）' };
  }
  if (!res.ok) {
    const err = new Error(data.error || 'HTTP ' + res.status);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* ---------------- 登录（普通用户走 LaswI ID，管理员走本地密码 + 密钥） ---------------- */

function setAuthMode(mode) {
  state.authMode = mode; // 'laswi' | 'admin'
  $('#laswi-panel').classList.toggle('hidden', mode !== 'laswi');
  $('#auth-form').classList.toggle('hidden', mode !== 'admin');
  $('#auth-error').textContent = '';
  $('#laswi-hint').textContent = '';
}

function bindAuth() {
  $('#to-admin-mode').addEventListener('click', (e) => {
    e.preventDefault();
    setAuthMode('admin');
    $('#auth-name').focus();
  });

  $('#to-user-mode').addEventListener('click', (e) => {
    e.preventDefault();
    setAuthMode('laswi');
  });

  $('#laswi-login-btn').addEventListener('click', () => {
    if (!state.laswiEnabled) {
      $('#laswi-hint').textContent = 'LaswI ID 登录暂不可用，请联系管理员检查热土引擎（REngine）相关配置。';
      return;
    }
    window.location.href = '/api/auth/laswi/start';
  });

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#auth-name').value.trim();
    const password = $('#auth-password').value;
    const adminKey = $('#auth-adminkey').value;
    const errBox = $('#auth-error');
    errBox.textContent = '';
    const btn = $('#auth-submit');
    btn.disabled = true;

    try {
      const r = await api('/api/login', { method: 'POST', body: { name, password, adminKey } });
      state.me = r.user;
      await enterApp();
    } catch (err) {
      errBox.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

/* ---------------- 进入应用 ---------------- */

async function enterApp() {
  $('#auth-view').classList.add('hidden');
  $('#main-view').classList.remove('hidden');

  $('#me-name').textContent = state.me.name;
  $('#me-id').textContent = 'HowGo 号 ' + state.me.id;
  $('#me-avatar').textContent = initial(state.me.name);

  const isAdmin = state.me.role === 'admin';
  document.querySelectorAll('.admin-only').forEach((n) => n.classList.toggle('hidden', !isAdmin));
  if (isAdmin) setPanel('admin');

  const me = await api('/api/me').catch(() => null);
  state.banned = !!(me && me.banned);

  await Promise.all([loadChats(), loadContacts()]);
  startPolling();
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    if (!state.me) return;
    try {
      await loadChats(true);
      if (state.activeChatId) await loadMessages(true);
      if (state.panel === 'admin') window.HowGoAdmin.refresh();
    } catch {
      /* 轮询失败静默，下一轮重试 */
    }
  }, 2500);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

/* ---------------- 侧栏 ---------------- */

function setPanel(panel) {
  state.panel = panel;
  document.querySelectorAll('.side-tab').forEach((b) => b.classList.toggle('active', b.dataset.panel === panel));
  $('#list-chats').classList.toggle('hidden', panel !== 'chats');
  $('#list-contacts').classList.toggle('hidden', panel !== 'contacts');
  $('#panel-admin').classList.toggle('hidden', panel !== 'admin');
  $('#chat-pane').classList.toggle('hidden', panel === 'admin');
  $('#admin-pane').classList.toggle('hidden', panel !== 'admin');
  $('#main-view').classList.toggle('chat-open', panel !== 'admin' && !!state.activeChatId);
  if (panel === 'admin') window.HowGoAdmin.render($('#admin-body'), state.adminTab);
}

function bindSidebar() {
  document.querySelectorAll('.side-tab').forEach((b) => {
    b.addEventListener('click', () => setPanel(b.dataset.panel));
  });

  $('#logout-btn').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => null);
    stopPolling();
    state.me = null;
    state.activeChatId = null;
    location.reload();
  });
}

async function loadChats(silent) {
  const r = await api('/api/chats');
  state.chats = r.chats;
  renderChats();
  if (!silent && !state.activeChatId && state.chats.length && state.me.role !== 'admin') {
    openChat(state.chats[0].id, state.chats[0].peer);
  }
}

function renderChats() {
  const box = $('#list-chats');
  clear(box);
  if (!state.chats.length) {
    box.appendChild(el('div', { class: 'empty-small', text: '还没有会话，去「联系人」发起聊天' }));
    return;
  }
  state.chats.forEach((c) => {
    const preview = c.last
      ? (c.last.from === state.me.id ? '我：' : '') +
        (c.last.text.length > 24 ? c.last.text.slice(0, 24) + '…' : c.last.text)
      : '开始聊天';
    const item = el(
      'div',
      {
        class: 'item' + (c.id === state.activeChatId ? ' active' : ''),
        on: { click: () => openChat(c.id, c.peer) }
      },
      el('div', { class: 'avatar', text: initial(c.peer.name) }),
      el(
        'div',
        { class: 'item-main' },
        el(
          'div',
          { class: 'item-title' },
          el('strong', { text: c.peer.name + (c.peer.banned ? '（已限制）' : '') }),
          el('time', { text: c.last ? fmtTime(c.last.at) : '' })
        ),
        el('div', { class: 'item-sub', text: preview })
      ),
      c.unread ? el('div', { class: 'badge-dot', text: c.unread > 99 ? '99+' : c.unread }) : null
    );
    box.appendChild(item);
  });
}

async function loadContacts() {
  const r = await api('/api/contacts');
  state.contacts = r.contacts;
  const box = $('#list-contacts');
  clear(box);
  if (!r.contacts.length) {
    box.appendChild(el('div', { class: 'empty-small', text: '暂无其他用户，可在另一个浏览器窗口注册账号测试' }));
    return;
  }
  r.contacts.forEach((u) => {
    box.appendChild(
      el(
        'div',
        {
          class: 'item',
          on: {
            click: async () => {
              try {
                const cr = await api('/api/chats', { method: 'POST', body: { peerId: u.id } });
                await loadChats(true);
                openChat(cr.chat.id, u);
                setPanel('chats');
              } catch (e) {
                toast(e.message, true);
              }
            }
          }
        },
        el('div', { class: 'avatar', text: initial(u.name) }),
        el(
          'div',
          { class: 'item-main' },
          el('div', { class: 'item-title' }, el('strong', { text: u.name })),
          el('div', { class: 'item-sub', text: 'HowGo 号 ' + u.id })
        )
      )
    );
  });
}

/* ---------------- 聊天 ---------------- */

async function openChat(chatId, peer) {
  state.activeChatId = chatId;
  state.activePeer = peer || null;
  state.lastMsgId = 0;

  $('#chat-empty').classList.add('hidden');
  $('#chat-box').classList.remove('hidden');
  $('#chat-peer').textContent = peer ? peer.name : '会话';
  $('#chat-peer-id').textContent = peer ? 'HowGo 号 ' + peer.id : '';
  $('#chat-ban-tag').hidden = !(peer && peer.banned);
  $('#messages').replaceChildren();

  renderChats();
  setPanel(state.panel === 'admin' ? 'chats' : state.panel);
  $('#main-view').classList.add('chat-open');

  await loadMessages(false).catch((e) => {
    if (e.status === 404 && state.me && state.me.role === 'admin') {
      toast('管理员请在「管理台 → 消息审查」中查看会话内容', true);
    } else {
      toast(e.message, true);
    }
  });
  await api('/api/chats/' + chatId + '/read', { method: 'POST' }).catch(() => null);
  await loadChats(true);
  $('#msg-input').focus();
}

async function loadMessages(append) {
  if (!state.activeChatId) return;
  const q = append ? '?after=' + state.lastMsgId : '';
  const r = await api('/api/chats/' + state.activeChatId + '/messages' + q);
  const box = $('#messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;

  r.messages.forEach((m) => {
    if (m.id > state.lastMsgId) state.lastMsgId = m.id;
    box.appendChild(renderMessage(m));
  });

  if (!append && !r.messages.length) {
    box.appendChild(el('div', { class: 'sys-line', text: '开始你们的对话吧' }));
  }

  if (append && r.messages.length) {
    await api('/api/chats/' + state.activeChatId + '/read', { method: 'POST' }).catch(() => null);
  }
  if (atBottom || !append) box.scrollTop = box.scrollHeight;
}

function renderMessage(m) {
  if (m.system) return el('div', { class: 'sys-line', text: m.text });

  const mine = m.from === state.me.id;
  const peerName = mine ? state.me.name : (state.activePeer ? state.activePeer.name : '对方');

  const bubble = el('div', { class: 'bubble' });
  if (m.removed) {
    bubble.classList.add('removed');
    bubble.textContent = '该消息因' + (m.removedReason || '违反社区规范') + '已被移除';
  } else if (m.status === 'blocked') {
    bubble.classList.add('blocked');
    bubble.textContent = m.text;
    bubble.appendChild(
      el('span', { class: 'mask-flag', text: '（该消息已被审核拦截，仅管理员可见）' })
    );
  } else {
    bubble.textContent = m.text;
    if (m.masked) {
      bubble.appendChild(el('span', { class: 'mask-flag', text: '（含引流或联系方式，已自动打码）' }));
    }
  }

  const meta = el('div', { class: 'msg-meta' }, el('span', { text: fmtTime(m.at) }));
  if (!mine && !m.removed) {
    meta.appendChild(
      el('button', {
        class: 'report-btn',
        text: '举报',
        on: { click: () => reportMessage(m.id) }
      })
    );
  }

  return el(
    'div',
    { class: 'msg' + (mine ? ' me' : '') },
    el('div', { class: 'avatar', text: initial(peerName) }),
    el('div', { class: 'msg-body' }, bubble, meta)
  );
}

async function reportMessage(id) {
  const reason = prompt('请简要说明举报理由（如：诈骗、广告、色情、辱骂）');
  if (reason === null) return;
  try {
    await api('/api/messages/' + id + '/report', { method: 'POST', body: { reason: reason || '未填写' } });
    toast('举报已提交，管理员会尽快核实');
  } catch (e) {
    toast(e.message, true);
  }
}

function bindComposer() {
  const input = $('#msg-input');

  const autoGrow = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(120, input.scrollHeight) + 'px';
  };
  input.addEventListener('input', autoGrow);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });

  $('#send-btn').addEventListener('click', sendMessage);

  // 移动端返回：从聊天退回列表
  document.addEventListener('click', (e) => {
    if (window.innerWidth <= 760 && e.target.matches('.chat-head, .chat-head::before')) {
      /* 占位，真实回退由下方 listener 处理 */
    }
  });
  const head = $('.chat-head');
  head.addEventListener('click', (e) => {
    if (window.innerWidth <= 760 && e.clientX - head.getBoundingClientRect().left < 48) {
      state.activeChatId = null;
      $('#main-view').classList.remove('chat-open');
      setPanel('chats');
    }
  });
}

async function sendMessage() {
  const input = $('#msg-input');
  const text = input.value.trim();
  if (!text || !state.activeChatId) return;

  input.value = '';
  input.style.height = 'auto';

  try {
    const r = await api('/api/chats/' + state.activeChatId + '/messages', {
      method: 'POST',
      body: { text }
    });
    const box = $('#messages');
    box.appendChild(renderMessage(r.message));
    state.lastMsgId = Math.max(state.lastMsgId, r.message.id);
    box.scrollTop = box.scrollHeight;
    if (r.masked) toast('消息含引流/联系方式，已自动打码后发送');
  } catch (e) {
    // 被拦截：把原文还给输入框，避免用户重打
    input.value = text;
    if (e.status === 451) {
      toast('发送被拦截：' + e.message, true);
    } else if (e.status === 403) {
      state.banned = true;
      toast(e.message, true);
      updateBanBanner();
    } else {
      toast(e.message, true);
    }
  }
}

function updateBanBanner() {
  const banner = $('#ban-banner');
  if (state.banned) {
    banner.classList.remove('hidden');
    banner.textContent = '你已被限制发言，暂时无法发送消息';
    $('#send-btn').disabled = true;
  } else {
    banner.classList.add('hidden');
    $('#send-btn').disabled = false;
  }
}

/* ---------------- 启动 ---------------- */

async function boot() {
  bindAuth();
  bindSidebar();
  bindComposer();
  setAuthMode('laswi');

  // 普通用户统一走 LaswI ID：后端未配置凭据时给出明确提示，不做假登录
  api('/api/auth/methods')
    .then((m) => {
      state.laswiEnabled = !!(m && m.laswi);
      const btn = $('#laswi-login-btn');
      btn.textContent = '使用 ' + ((m && m.laswiLabel) || 'LaswI ID') + ' 登录';
      if (!state.laswiEnabled) {
        btn.disabled = true;
        if (!$('#laswi-hint').textContent) {
          $('#laswi-hint').textContent =
            'LaswI ID 登录暂未配置，普通用户暂时无法登录；管理员可从下方链接进入。';
        }
      }
    })
    .catch(() => null);

  const params = new URLSearchParams(location.search);
  const loginError = params.get('login_error');
  if (loginError) {
    history.replaceState(null, '', location.pathname);
    if (/管理员/.test(loginError)) {
      // 管理员被 LaswI 入口拦下：直接带到管理员表单并说明原因
      setAuthMode('admin');
      $('#auth-error').textContent = loginError;
    } else {
      $('#laswi-hint').textContent = loginError;
    }
  }

  try {
    const r = await api('/api/me');
    state.me = r.user;
    state.banned = r.banned;
    await enterApp();
  } catch {
    $('#auth-view').classList.remove('hidden');
  }
}

document.addEventListener('DOMContentLoaded', boot);

/* 供管理台模块复用 */
window.HowGo = { api, el, clear, toast, fmtTime, initial, state, loadChats, updateBanBanner };
