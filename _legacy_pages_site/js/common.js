/* HowGo 前端公共层：工具、API、WS、模态框、全局状态 */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const EMOJIS = ['😀','😁','😂','🤣','😊','😇','🙂','😉','😍','🥰','😘','😜','🤪','😎','🤩','🥳','😭','😅','😳','🤔','🤗','😐','😴','🤤','😱','😤','😡','🤯','😷','🤒','🥺','😬','🙄','💪','👍','👏','🙏','🤝','👋','✌️','🤞','❤️','🧡','💛','💚','💙','💜','🖤','💔','🔥','✨','🎉','🎂','🌈','☀️','🌙','⭐','⚡','🍀','🎵','💯','🐶','🐱','🐼','🍎','🚀','🌹'];

const State = {
  me: null,
  convs: [],
  contacts: [],
  currentTab: 'chats',
  openConvId: null,
  ws: null,
  wsReady: false,
  wsHandlers: {},
  openConvBeforeReconnect: null,
};

/* ---------- HTTP ---------- */
async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opt);
  let data;
  try { data = await resp.json(); } catch (_) { data = { success: false, message: '服务异常' }; }
  if (resp.status === 401) {
    location.href = '/login.html';
    throw new Error('未登录');
  }
  return data;
}

async function httpGet(url) {
  const d = await api('GET', url);
  if (!d.success) throw new Error(d.message);
  return d.data;
}
async function httpPost(url, body) {
  const d = await api('POST', url, body);
  if (!d.success) throw new Error(d.message);
  return d.data;
}
async function httpPatch(url, body) {
  const d = await api('PATCH', url, body);
  if (!d.success) throw new Error(d.message);
  return d.data;
}
async function httpDelete(url) {
  const d = await api('DELETE', url);
  if (!d.success) throw new Error(d.message);
  return d.data;
}

/* ---------- 头像 / 时间 ---------- */
function avatarHTML(user, cls = 'avatar-mini') {
  const c = cls || 'avatar-mini';
  if (user && user.avatar) {
    return `<span class="${c}"><img src="${esc(user.avatar)}" alt="" /></span>`;
  }
  let color = (user && user.color) || '#1683e8';
  if (String(color).toLowerCase() === '#07c160') color = '#1683e8'; // laswi 主题下将遗留微信绿归一为蓝
  const ch = user && user.nickname ? esc(user.nickname.slice(0, 1)) : '?';
  return `<span class="${c}" style="background:${color}">${ch}</span>`;
}

function fmtTime(iso, withYear = false) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now.getTime() - 86400000).toDateString() === d.toDateString();
  if (sameDay) return hm;
  if (yesterday) return `昨天 ${hm}`;
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (withYear || d.getFullYear() !== now.getFullYear()) return `${d.getFullYear()}-${md}`;
  return `${md} ${hm}`;
}

function fmtDate(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function previewText(msg) {
  if (msg.type === 'image') return '[图片]';
  if (msg.type === 'system') return msg.content;
  return msg.content;
}

/* ---------- Toast ---------- */
function toast(msg, ms = 1800) {
  const root = $('#toastRoot');
  const el = document.createElement('div');
  el.className = 'toast-item';
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => { el.remove(); }, ms);
}

/* ---------- 模态框 ---------- */
function openModal({ title = '', body = '', foot = '', width, onMount, imgMode = false }) {
  $('#modalRoot').innerHTML = `
    <div class="modal-mask">
      <div class="modal-card" style="${width ? `width:${width}px` : ''} ${imgMode ? 'background:transparent;box-shadow:none;max-width:92vw;' : ''}">
        ${imgMode ? '' : `<div class="modal-head"><h4>${esc(title)}</h4><button class="modal-close" data-close="1">×</button></div>`}
        <div class="modal-body ${imgMode ? '' : ''}" style="${imgMode ? 'padding:0;display:flex;align-items:center;justify-content:center;' : ''}">${body}</div>
        ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
      </div>
    </div>`;
  const mask = $('#modalRoot .modal-mask');
  function close() { $('#modalRoot').innerHTML = ''; }
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('[data-close]')) close();
  });
  document.addEventListener('keydown', function escClose(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escClose); }
  });
  if (onMount) onMount({ close, el: $('.modal-body') });
  return { close, el: $('.modal-body') };
}

function confirmModal(msg, opts = {}) {
  return new Promise((resolve) => {
    openModal({
      title: opts.title || '请确认',
      body: `<p>${esc(msg)}</p>`,
      foot: `<button class="btn-ghost" data-no="1">取消</button><button class="btn-primary" style="border:none" data-yes="1">${esc(opts.okText || '确定')}</button>`,
      onMount: ({ close }) => {
        $('#modalRoot').querySelector('[data-no]').onclick = () => { close(); resolve(false); };
        $('#modalRoot').querySelector('[data-yes]').onclick = () => { close(); resolve(true); };
      },
    });
  });
}

/* ---------- 图片压缩 ---------- */
function fileToDataURL(file, maxSide = 900, quality = 0.82) {
  return new Promise((resolve, reject) => {
    if (!/^image\//.test(file.type)) return reject(new Error('请选择图片文件'));
    const reader = new FileReader();
    reader.onload = () => {
      const src = reader.result;
      if (file.type === 'image/gif') return resolve(src);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('图片解析失败'));
      img.src = src;
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function pickImage(maxSide = 900, cb) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    try {
      const dataURL = await fileToDataURL(f, maxSide);
      cb(null, dataURL);
    } catch (e) {
      cb(e.message || '图片处理失败');
    }
  };
  input.click();
}

/* ---------- WebSocket ---------- */
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  State.ws = new WebSocket(`${proto}://${location.host}/ws`);
  State.ws.onopen = () => { State.wsReady = true; };
  State.ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.type === 'ready') return;
    const h = State.wsHandlers[msg.type];
    if (h) h(msg.data);
  };
  State.ws.onclose = () => {
    State.wsReady = false;
    if (State.me) {
      setTimeout(connectWs, 2500);
    }
  };
  // 心跳保活（服务端 ping 自动回 pong）
  setInterval(() => {
    if (State.ws && State.ws.readyState === 1) {
      State.ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, 25000);
}

/* ---------- 图片放大预览 ---------- */
function zoomImage(src) {
  openModal({ body: `<img src="${esc(src)}" alt="" />`, imgMode: true });
}

function btnSvg(name) {
  const icons = {
    add: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 16l4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    emoji: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="10" r="1" fill="currentColor"/><circle cx="15" cy="10" r="1" fill="currentColor"/><path d="M8.5 14.2c.9 1.2 2.2 1.8 3.5 1.8s2.6-.6 3.5-1.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    image: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="9" cy="10" r="1.6" fill="currentColor"/><path d="M4.5 17.5l5-4.6 3.2 2.9 3-2.7 3.8 4.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="M14.5 5.5L8 12l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    group: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8.5" r="3" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="16.5" cy="9.5" r="2.3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3.5 18.5c.7-2.8 2.8-4.3 5.5-4.3s4.8 1.5 5.5 4.3M15 14.3c2.6.2 4.4 1.5 5 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/></svg>',
  };
  return icons[name] || '';
}
