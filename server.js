#!/usr/bin/env node
// HowGo — 即时通讯 Web 应用（LaswI Studio (c) 2026）
// 零依赖 Node HTTP 服务：账号体系 + 私聊 + 服务端内容审核 + 管理员后台
// 设计要点：所有违规内容判定都在服务端完成，客户端拿不到绕过路径。
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const CRED_FILE = path.join(DATA_DIR, 'admin-credentials.txt');
const PORT = Number(process.env.PORT || 5210);
const HOST = process.env.HOST || '0.0.0.0';

// 管理员凭据：优先环境变量，否则首次启动随机生成并落盘
const ENV_ADMIN_PASSWORD = process.env.HOWGO_ADMIN_PASSWORD || '';
const ENV_ADMIN_KEY = process.env.HOWGO_ADMIN_KEY || '';

const SYSTEM_UID = 0; // 系统消息发送方

// ---------------------------------------------------------------------------
// 1. 数据层（JSON 文件 + 防抖落盘）
// ---------------------------------------------------------------------------

const DEFAULT_BLOCK = [
  '枪支弹药', '毒品交易', '冰毒', '海洛因', '代孕', '裸聊', '色情服务',
  '赌博平台', '博彩', '洗钱', '办假证', '假币', '恐怖袭击', '爆炸物', '迷药'
];
const DEFAULT_MASK = [
  '刷单', '返利', '日赚', '代开发票', '加微信', '加我微信', '私聊我',
  '薅羊毛', '推广引流', 'vx号', '稳定货源'
];

fs.mkdirSync(DATA_DIR, { recursive: true });

function freshDb() {
  return {
    version: 1,
    users: [],
    chats: [],
    messages: [],
    reports: [],
    audits: [],
    reads: {},          // reads[uid][chatId] = ISO 时间
    words: { block: [...DEFAULT_BLOCK], mask: [...DEFAULT_MASK] },
    seq: { userId: 10000, msgId: 1, chatId: 1, reportId: 1, auditId: 1 }
  };
}

// ---------------------------------------------------------------------------
// 1b. 云端存储（PostgREST 兼容，如 Supabase）：整份 db 存成一行 jsonb
//     - 配置 HOWGO_STORE_URL / HOWGO_STORE_KEY 即切换到云端，数据不随实例重建丢失
//     - 未配置时退化为本地 data/db.json（开发与自托管）
// ---------------------------------------------------------------------------
const STORE_URL = String(process.env.HOWGO_STORE_URL || '').replace(/\/+$/, '');
const STORE_KEY = String(process.env.HOWGO_STORE_KEY || '');
const CLOUD = Boolean(STORE_URL && STORE_KEY);
const DB_ROW = 'db';

let db = freshDb();
let dbLoaded = !CLOUD;
let loadPromise = null;

function storeHeaders() {
  return {
    apikey: STORE_KEY,
    Authorization: 'Bearer ' + STORE_KEY,
    'Content-Type': 'application/json'
  };
}

async function persistNow() {
  if (!CLOUD) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    return;
  }
  const res = await fetch(STORE_URL + '/rest/v1/howgo_kv', {
    method: 'POST',
    headers: Object.assign(storeHeaders(), {
      Prefer: 'resolution=merge-duplicates,return=minimal'
    }),
    body: JSON.stringify([{ key: DB_ROW, value: db, updated_at: new Date().toISOString() }])
  });
  if (!res.ok) throw new Error('写入云端失败 HTTP ' + res.status + ' ' + (await res.text()));
}

async function loadFromCloud() {
  const res = await fetch(STORE_URL + '/rest/v1/howgo_kv?key=eq.' + DB_ROW + '&select=value', {
    headers: storeHeaders()
  });
  if (!res.ok) throw new Error('读取云端失败 HTTP ' + res.status + ' ' + (await res.text()));
  const rows = await res.json();
  if (Array.isArray(rows) && rows.length && rows[0].value) {
    db = rows[0].value;
    if (!db.users) db = freshDb();
  } else {
    await persistNow(); // 首次部署：写入初始库
  }
}

// 请求入口统一 await 一次；失败时重试，绝不静默用空库覆盖云端
async function ensureLoaded() {
  if (dbLoaded) return;
  if (!loadPromise) {
    loadPromise = loadFromCloud()
      .then(() => { dbLoaded = true; initAdmin(); })
      .catch((e) => { loadPromise = null; throw e; });
  }
  await loadPromise;
}

if (!CLOUD) {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(freshDb(), null, 2), 'utf8');
  }
  db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

let saveTimer = null;
function persist() {
  if (CLOUD && !dbLoaded) {
    console.error('[howgo] 数据尚未从云端就绪，跳过本次写入以防覆盖');
    return;
  }
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistNow().catch((e) => console.error('[howgo] 写库失败：', e.message));
  }, CLOUD ? 300 : 150);
}

// ---------------------------------------------------------------------------
// 2. 通用工具
// ---------------------------------------------------------------------------

const nowIso = () => new Date().toISOString();

function uid(prefix) {
  return prefix + '_' + crypto.randomBytes(8).toString('hex');
}

function hashPassword(pwd, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(pwd, s, 64).toString('hex');
  return { salt: s, hash: h };
}

function verifyPassword(pwd, user) {
  try {
    const h = crypto.scryptSync(pwd, user.salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(user.hash, 'hex'));
  } catch {
    return false;
  }
}

// 清零宽字符、全角字母等规避手法后再比对
function normalize(text) {
  return String(text)
    .normalize('NFKC')
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .toLowerCase();
}

function maskWordInText(text, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, 'gi');
  return text.replace(re, '***');
}

function audit(actor, action, target, detail) {
  db.audits.push({
    id: db.seq.auditId++,
    at: nowIso(),
    actor,
    action,
    target: target || '',
    detail: detail || ''
  });
  persist();
}

// ---------------------------------------------------------------------------
// 3. 内容审核引擎（消息入库前唯一闸口）
// ---------------------------------------------------------------------------

const RATE_WINDOW_MS = 10 * 1000;
const RATE_LIMIT = 10;
const buckets = new Map();

function hitRateLimit(userId) {
  const t = Date.now();
  const arr = (buckets.get(userId) || []).filter((x) => t - x < RATE_WINDOW_MS);
  arr.push(t);
  buckets.set(userId, arr);
  return arr.length > RATE_LIMIT;
}

/**
 * 判定一条待发消息。
 * @returns {{action:'allow'|'mask'|'block', text:string, reason?:string, flags:string[]}}
 */
function moderate(rawText, user) {
  const text = String(rawText || '');
  const norm = normalize(text);
  const flags = [];

  // ① 一级：命中禁止词，整条拒发
  for (const w of db.words.block) {
    if (!w) continue;
    if (norm.includes(normalize(w))) {
      return { action: 'block', reason: '内容命中禁止词：' + w, text, flags: ['block:' + w] };
    }
  }

  // ② 一级：新账号 1 小时内禁止外链（防导流诈骗）
  const isFresh = Date.now() - new Date(user.createdAt).getTime() < 60 * 60 * 1000;
  if (isFresh && /(https?:\/\/|www\.)/i.test(text)) {
    return { action: 'block', reason: '注册未满 1 小时不能发送外部链接', text, flags: ['link:fresh-account'] };
  }

  // ③ 二级：引流/广告词打码
  let out = text;
  for (const w of db.words.mask) {
    if (!w) continue;
    if (norm.includes(normalize(w))) {
      out = maskWordInText(out, w);
      flags.push('mask:' + w);
    }
  }

  // ④ 二级：手机号、连续数字串打码
  if (/(?<!\d)1[3-9]\d{9}(?!\d)/.test(out)) {
    out = out.replace(/(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g, '$1****$2');
    flags.push('mask:phone');
  }
  if (/(加|➕|\+)\s*(微信|vx|v信|qq|扣扣|telegram|飞机)/i.test(norm)) {
    flags.push('mask:pull-traffic');
  }
  if (/(https?:\/\/|www\.)/i.test(text)) flags.push('link:external');

  return {
    action: flags.length ? 'mask' : 'allow',
    text: out,
    flags
  };
}

// ---------------------------------------------------------------------------
// 4. 会话与序列化
// ---------------------------------------------------------------------------

const sessions = new Map(); // token -> { uid, exp, role }
const SESSION_TTL = 7 * 24 * 3600 * 1000;

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    role: u.role,
    createdAt: u.createdAt,
    provider: u.provider || 'password',
    bannedUntil: u.bannedUntil || null,
    bannedReason: u.bannedReason || null
  };
}

function isBanned(u) {
  return !!(u.bannedUntil && new Date(u.bannedUntil).getTime() > Date.now());
}

function serializeMessage(m, viewer) {
  const base = {
    id: m.id,
    chatId: m.chatId,
    from: m.from,
    at: m.at,
    system: !!m.system,
    status: m.status // ok | masked | blocked | deleted
  };
  if (m.status === 'deleted') {
    return { ...base, text: '', removed: true, removedReason: m.removedReason || '违反社区规范' };
  }
  if (m.status === 'blocked') {
    // 被拦截的消息只对管理员可见
    if (viewer.role !== 'admin') return null;
    return { ...base, text: m.text, blockedReason: m.blockedReason || '' };
  }
  return { ...base, text: m.text, masked: m.status === 'masked', flags: m.flags || [] };
}

function chatOf(id) {
  return db.chats.find((c) => c.id === id);
}

function chatMembers(c) {
  return c.members.slice();
}

function unreadCount(uidNum, chat) {
  const last = db.reads[uidNum] && db.reads[uidNum][chat.id];
  const since = last ? new Date(last).getTime() : 0;
  return db.messages.filter(
    (m) => m.chatId === chat.id && m.from !== uidNum && m.status !== 'blocked' && new Date(m.at).getTime() > since
  ).length;
}

// ---------------------------------------------------------------------------
// 5. HTTP 基础设施
// ---------------------------------------------------------------------------

function json(res, code, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store'
  }, extraHeaders || {}));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}

function currentUser(req) {
  const token =
    parseCookies(req).hg_sid ||
    String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return db.users.find((u) => u.id === s.uid) || null;
}

function issueSession(res, user) {
  const token = crypto.randomBytes(24).toString('base64url');
  sessions.set(token, { uid: user.id, exp: Date.now() + SESSION_TTL, role: user.role });
  res.setHeader(
    'set-cookie',
    'hg_sid=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(SESSION_TTL / 1000)
  );
  return token;
}

// ---------------------------------------------------------------------------
// 6. 路由表
// ---------------------------------------------------------------------------

const routes = [];
function add(method, matcher, handler, opts) {
  routes.push({ method, matcher, handler, admin: !!(opts && opts.admin), public: !!(opts && opts.public) });
}

// ---- 账号 ----
// 注册已关闭：普通用户身份全部由 LaswI ID 签发，HowGo 不保存用户密码
add('POST', '/api/register', async (req, res) => {
  json(res, 403, { error: '注册已关闭：普通用户请使用 LaswI ID 登录（首次登录自动创建账号）' });
}, { public: true });


// 反代（Caddy / Nginx / 隧道）后 req.socket.remoteAddress 恒为 127.0.0.1，
// 限速必须取 x-forwarded-for 的第一跳，否则全站共用一个限速桶。
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return xf[0] || req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown';
}

const loginFails = new Map();
add('POST', '/api/login', async (req, res, body) => {
  const name = String(body.name || '').trim();
  const password = String(body.password || '');
  const adminKey = String(body.adminKey || '');
  const ip = clientIp(req);
  const fail = (loginFails.get(ip) || []).filter((t) => Date.now() - t < 60 * 1000);
  if (fail.length >= 8) return json(res, 429, { error: '尝试过于频繁，请 1 分钟后再试' });
  loginFails.set(ip, fail);

  const user = db.users.find((u) => u.name.toLowerCase() === name.toLowerCase());
  if (!user || !verifyPassword(password, user)) {
    fail.push(Date.now());
    loginFails.set(ip, fail);
    return json(res, 401, { error: '账号或密码错误' });
  }
  // 普通用户不允许密码登录：身份统一由 LaswI ID 签发，本地不存用户密码
  if (user.role !== 'admin') {
    audit(user.id, 'password-login-denied', String(user.id), '普通用户尝试密码登录');
    return json(res, 403, { error: '普通用户请使用 LaswI ID 登录' });
  }
  // 管理员登录：同一入口，额外一道管理密钥（第二个因素）
  if (user.role === 'admin') {
    if (adminKey !== ADMIN_KEY) {
      fail.push(Date.now());
      loginFails.set(ip, fail);
      audit(user.id, 'admin-login-denied', String(user.id), '管理密钥错误');
      return json(res, 401, { error: '管理密钥错误' });
    }
    audit(user.id, 'admin-login', String(user.id), '管理员登录成功');
  }
  issueSession(res, user);
  json(res, 200, { user: publicUser(user) });
}, { public: true });

add('POST', '/api/logout', async (req, res) => {
  const cookies = parseCookies(req);
  if (cookies.hg_sid) sessions.delete(cookies.hg_sid);
  res.setHeader('set-cookie', 'hg_sid=; Path=/; HttpOnly; Max-Age=0');
  json(res, 200, { ok: true });
});

add('GET', '/api/me', async (req, res, body, user) => {
  json(res, 200, { user: publicUser(user), banned: isBanned(user) });
});

// ---------------------------------------------------------------------------
// 5.1 LaswI ID 第三方登录（OAuth2 授权码模式，与 Gugu Browser 同源身份）
//     · 授权码交换全部在服务端完成，access_token 只留在服务端会话，前端拿不到
//     · 平台 CORS 未放行第三方源，服务端到服务端调用不受同源策略影响，正好绕过该限制
// ---------------------------------------------------------------------------

// 热土引擎（REngine）统一用户认证：LaswI ID 即热土账号
// 文档 https://rdd.rtstu.com ｜ 登录页 https://apilogin.rtstudio.top ｜ API https://appapi.rtstudio.top
// 流程：跳登录页（TE=true 授权码模式）→ 回调拿一次性 code → 服务端 /exchange 换用户 token
//       → 服务端 /get-user-by-token 取资料 → 本地建号 + 下发 HttpOnly Cookie
const RENGINE_LOGIN_BASE = (process.env.LASWI_LOGIN_BASE || 'https://apilogin.rtstudio.top').replace(/\/+$/, '');
const RENGINE_API_BASE = (process.env.LASWI_API_BASE || 'https://appapi.rtstudio.top').replace(/\/+$/, '');
const RENGINE_APP_TYPE = String(process.env.LASWI_APP_TYPE || 'name').trim().toLowerCase(); // name | token | loginkey
// 应用标识写死为 LaswI_ID：热土登录页始终以「LaswI_ID」的名义请求授权
const LASWI_APP_NAME = 'LaswI_ID';
const RENGINE_APP_ID = LASWI_APP_NAME; // 仅 name 模式使用；token 模式改用软件 Token 作为标识
const RENGINE_SOFTWARE_TOKEN = process.env.LASWI_SOFTWARE_TOKEN || '';
const LASWI_ENABLED =
  RENGINE_APP_TYPE === 'name' ||
  ((RENGINE_APP_TYPE === 'token' || RENGINE_APP_TYPE === 'loginkey') && !!RENGINE_SOFTWARE_TOKEN);

const LASWI_STATE_TTL = 10 * 60 * 1000;
const laswiStates = new Map(); // state -> 生成时间

function publicBase(req) {
  if (process.env.HOWGO_PUBLIC_URL) return process.env.HOWGO_PUBLIC_URL.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1:' + PORT)
    .split(',')[0]
    .trim();
  return proto + '://' + host;
}

function redirect(res, location) {
  const headers = { location, 'cache-control': 'no-store' };
  const cookie = res.getHeader('set-cookie');
  if (cookie) headers['set-cookie'] = cookie;
  res.writeHead(302, headers);
  res.end();
}

function rengineProfile(raw) {
  let p = raw;
  if (Array.isArray(p)) p = p[0] || {};
  return p && typeof p === 'object' ? p : {};
}

function rengineUserId(p) {
  return (p && (p.id ?? p.user_id ?? p.uid ?? p.userId ?? p.openid)) || '';
}

function laswiDisplayName(profile) {
  const raw = String(profile.nickname || profile.name || profile.username || '').trim();
  const base = raw.replace(/[^\u4e00-\u9fa5A-Za-z0-9_]/g, '').slice(0, 14);
  if (base.length >= 2) return base;
  return 'laswi' + String(rengineUserId(profile)).slice(-6);
}

// 健康检查：平台探活 / 隧道连通性验证
add('GET', '/api/health', async (req, res) => {
  json(res, 200, {
    ok: true,
    service: 'howgo',
    version: '1.1.0',
    users: db.users.length,
    laswi: LASWI_ENABLED,
    storage: CLOUD ? 'cloud' : 'file',
    uptime: Math.round(process.uptime())
  });
}, { public: true });

// 保活探针：同时唤醒实例并真实读一次云端库，避免免费层 / 免费库因低活跃被休眠或暂停
add('GET', '/api/ping', async (req, res) => {
  const t0 = Date.now();
  let store = CLOUD ? 'cloud' : 'file';
  if (CLOUD) {
    try {
      const r = await fetch(STORE_URL + '/rest/v1/howgo_kv?select=key&limit=1', { headers: storeHeaders() });
      store = r.ok ? 'cloud-ok' : 'cloud-' + r.status;
    } catch (e) {
      store = 'cloud-error';
    }
  }
  json(res, 200, { ok: true, store, users: db.users.length, ms: Date.now() - t0, t: new Date().toISOString() });
}, { public: true });

// 登录方式声明：普通用户仅 LaswI ID；密码入口只服务于管理员（管理员同样不能走 LaswI ID）
add('GET', '/api/auth/methods', async (req, res) => {
  json(res, 200, {
    laswi: LASWI_ENABLED,
    laswiLabel: 'LaswI ID',
    password: false,
    adminPassword: true
  });
}, { public: true });

add('GET', '/api/auth/laswi/start', async (req, res) => {
  const fail = (msg) => redirect(res, '/?login_error=' + encodeURIComponent(msg));
  if (!LASWI_ENABLED) return fail('LaswI ID 登录未配置');

  const state = crypto.randomBytes(16).toString('hex');
  laswiStates.set(state, Date.now());
  for (const [k, t] of laswiStates) {
    if (Date.now() - t > LASWI_STATE_TTL) laswiStates.delete(k);
  }

  // loginkey 模式：先用软件 Token 换 10 分钟有效的登录 Key，避免软件 Token 出现在 URL/日志里
  let appType = RENGINE_APP_TYPE;
  let appValue = appType === 'token' ? RENGINE_SOFTWARE_TOKEN : RENGINE_APP_ID;
  if (appType === 'loginkey') {
    try {
      const keyRes = await fetch(
        RENGINE_API_BASE + '/login-token?token=' + encodeURIComponent(RENGINE_SOFTWARE_TOKEN),
        { headers: { accept: 'application/json' } }
      );
      const payload = await keyRes.json().catch(() => ({}));
      const key = payload && payload.data && payload.data.login_key;
      if (!keyRes.ok || !payload.success || !key) throw new Error(payload.message || '获取登录 Key 失败');
      appValue = key;
    } catch (e) {
      console.error('[howgo] laswi-start', e.message);
      return fail('LaswI 授权失败：' + e.message);
    }
  }

  // Web 应用：port 传完整回调地址；TE=true 走授权码交换模式，用户 Token 不经过浏览器
  const u = new URL(RENGINE_LOGIN_BASE + '/');
  u.searchParams.set('port', publicBase(req) + '/api/auth/laswi/callback');
  u.searchParams.set('type', appType);
  u.searchParams.set('v', appValue);
  u.searchParams.set('state', state);
  u.searchParams.set('env', 'web');
  u.searchParams.set('TE', 'true');
  redirect(res, u.toString());
}, { public: true });

add('GET', '/api/auth/laswi/callback', async (req, res) => {
  const fail = (msg) => redirect(res, '/?login_error=' + encodeURIComponent(msg));
  if (!LASWI_ENABLED) return fail('LaswI ID 登录未配置');

  const state = req.searchParams.get('state') || '';
  const cbType = String(req.searchParams.get('type') || '').toLowerCase();
  const cbValue = req.searchParams.get('v') || '';
  if (!state || !laswiStates.has(state)) return fail('登录状态校验失败，请重新登录');
  laswiStates.delete(state);
  if (cbType === 'error') return fail('LaswI 授权失败：' + (cbValue || '用户取消或平台拒绝'));
  if (!cbValue) return fail('LaswI 未返回授权凭证');

  let accessToken = '';
  let profile = null;

  try {
    if (cbType === 'code') {
      const exRes = await fetch(RENGINE_API_BASE + '/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ code: cbValue })
      });
      const exPayload = await exRes.json().catch(() => ({}));
      if (!exRes.ok || !exPayload.success || !(exPayload.data && exPayload.data.token)) {
        throw new Error(exPayload.message || '授权码换取令牌失败');
      }
      accessToken = exPayload.data.token;
    } else if (cbType === 'success') {
      accessToken = cbValue;
    } else {
      throw new Error('未知的回调类型：' + (cbType || '空'));
    }

    const userRes = await fetch(RENGINE_API_BASE + '/get-user-by-token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ token: accessToken })
    });
    const userPayload = await userRes.json().catch(() => ({}));
    profile = rengineProfile(userPayload.data || userPayload.user || userPayload);
    if (!userRes.ok || userPayload.success === false || !rengineUserId(profile)) {
      throw new Error(userPayload.message || '读取热土用户资料失败');
    }
  } catch (e) {
    console.error('[howgo] laswi-login', e.message);
    return fail('LaswI 授权失败：' + e.message);
  }

  const laswiId = String(rengineUserId(profile));
  const bound = db.users.find((u) => u.laswiId === laswiId);

  // 管理员不得通过 LaswI ID 登录：管理员只走「密码 + 管理密钥」，第三方入口一律拒绝
  if (bound && bound.role === 'admin') {
    console.warn('[howgo] laswi-login-denied admin laswiId=' + laswiId);
    audit(bound.id, 'laswi-login-denied', 'laswi:' + laswiId, '管理员尝试 LaswI ID 登录，已拒绝');
    return fail('管理员账号不支持 LaswI ID 登录，请使用密码 + 管理密钥');
  }

  // 该 LaswI 身份若已绑定普通账号则直接复用，否则首次登录自动建号
  let user = bound || null;

  if (!user) {
    let name = laswiDisplayName(profile);
    while (db.users.some((u) => u.name.toLowerCase() === name.toLowerCase())) {
      name = name.slice(0, 12) + crypto.randomInt(10, 99);
    }
    user = {
      id: db.seq.userId++,
      name,
      salt: '',
      hash: '',
      role: 'user',
      provider: 'laswi-id',
      laswiId,
      avatar: String(profile.avatar || profile.avatar_url || ''),
      createdAt: nowIso(),
      bannedUntil: null,
      bannedReason: null
    };
    db.users.push(user);
    persist();
    audit(user.id, 'user-register', 'laswi:' + laswiId, '通过 LaswI ID 首次登录');
  }

  const sid = issueSession(res, user);
  const sess = sessions.get(sid);
  if (sess) sess.laswiToken = accessToken; // 仅服务端可见，不下发前端
  audit(user.id, 'laswi-login', 'laswi:' + laswiId, 'LaswI ID 登录成功');
  redirect(res, '/');
}, { public: true });

// ---- 联系人 / 会话 ----
add('GET', '/api/contacts', async (req, res, body, user) => {
  const list = db.users
    .filter((u) => u.role === 'user' && u.id !== user.id)
    .map((u) => ({
      id: u.id,
      name: u.name,
      banned: isBanned(u),
      online: false
    }));
  json(res, 200, { contacts: list });
});

add('POST', '/api/chats', async (req, res, body, user) => {
  const peerId = Number(body.peerId);
  if (!peerId) return json(res, 400, { error: '缺少 peerId' });
  const peer = db.users.find((u) => u.id === peerId);
  if (!peer) return json(res, 404, { error: '对方不存在' });
  let chat = db.chats.find(
    (c) => c.members.length === 2 && c.members.includes(user.id) && c.members.includes(peerId)
  );
  if (!chat) {
    chat = { id: String(db.seq.chatId++), members: [user.id, peerId], createdAt: nowIso() };
    db.chats.push(chat);
    persist();
  }
  json(res, 200, { chat: { id: chat.id, members: chat.members } });
});

add('GET', '/api/chats', async (req, res, body, user) => {
  const mine = db.chats.filter((c) => c.members.includes(user.id));
  const list = mine.map((c) => {
    const peerId = c.members.find((x) => x !== user.id);
    const peer = db.users.find((u) => u.id === peerId);
    const visible = db.messages.filter((m) => m.chatId === c.id && m.status !== 'blocked');
    const last = visible.length ? visible[visible.length - 1] : null;
    return {
      id: c.id,
      peer: peer ? { id: peer.id, name: peer.name, banned: isBanned(peer) } : { id: peerId, name: '已注销用户' },
      last: last
        ? {
            text: last.status === 'deleted' ? '[该消息已被移除]' : last.text,
            at: last.at,
            from: last.from
          }
        : null,
      unread: unreadCount(user.id, c)
    };
  });
  list.sort((a, b) => {
    const ta = a.last ? new Date(a.last.at).getTime() : 0;
    const tb = b.last ? new Date(b.last.at).getTime() : 0;
    return tb - ta;
  });
  json(res, 200, { chats: list });
});

add('GET', /^\/api\/chats\/([^/]+)\/messages$/, async (req, res, body, user, params) => {
  const chat = chatOf(params[0]);
  if (!chat || !chat.members.includes(user.id)) return json(res, 404, { error: '会话不存在' });
  const after = Number(req.searchParams.get('after') || 0);
  let rows = db.messages.filter((m) => m.chatId === chat.id);
  if (after) rows = rows.filter((m) => m.id > after);
  if (!after) rows = rows.slice(-120);
  const out = rows
    .map((m) => serializeMessage(m, user))
    .filter(Boolean);
  json(res, 200, { messages: out, chat: { id: chat.id, members: chat.members } });
});

add('POST', /^\/api\/chats\/([^/]+)\/read$/, async (req, res, body, user, params) => {
  const chat = chatOf(params[0]);
  if (!chat || !chat.members.includes(user.id)) return json(res, 404, { error: '会话不存在' });
  db.reads[user.id] = db.reads[user.id] || {};
  db.reads[user.id][chat.id] = nowIso();
  persist();
  json(res, 200, { ok: true });
});

// ---- 发消息（审核闸口）----
add('POST', /^\/api\/chats\/([^/]+)\/messages$/, async (req, res, body, user, params) => {
  const chat = chatOf(params[0]);
  if (!chat || !chat.members.includes(user.id)) return json(res, 404, { error: '会话不存在' });
  if (isBanned(user)) {
    return json(res, 403, {
      error: '你已被限制发言',
      bannedUntil: user.bannedUntil,
      reason: user.bannedReason
    });
  }
  const text = String(body.text || '').trim();
  if (!text) return json(res, 400, { error: '不能发送空消息' });
  if (text.length > 2000) return json(res, 400, { error: '单条消息不能超过 2000 字' });
  if (hitRateLimit(user.id)) return json(res, 429, { error: '发送过于频繁，请稍后再试' });

  // 短时重复内容（刷屏）
  const recentSame = db.messages.filter(
    (m) =>
      m.chatId === chat.id &&
      m.from === user.id &&
      m.text === text &&
      Date.now() - new Date(m.at).getTime() < 60 * 1000
  );
  if (recentSame.length >= 2) return json(res, 429, { error: '请勿重复发送相同内容' });

  const verdict = moderate(text, user);

  if (verdict.action === 'block') {
    // 拦截也留痕：写入库但仅管理员可见，便于取证与申诉
    const m = {
      id: db.seq.msgId++,
      chatId: chat.id,
      from: user.id,
      text,
      at: nowIso(),
      status: 'blocked',
      flags: verdict.flags,
      blockedReason: verdict.reason
    };
    db.messages.push(m);
    audit(user.id, 'message-blocked', 'msg:' + m.id, verdict.reason);
    persist();
    return json(res, 451, { error: verdict.reason, code: 'CONTENT_BLOCKED', flags: verdict.flags });
  }

  const m = {
    id: db.seq.msgId++,
    chatId: chat.id,
    from: user.id,
    text: verdict.text,
    at: nowIso(),
    status: verdict.action === 'mask' ? 'masked' : 'ok',
    flags: verdict.flags
  };
  db.messages.push(m);
  if (verdict.action === 'mask') audit(user.id, 'message-masked', 'msg:' + m.id, verdict.flags.join(','));
  db.reads[user.id] = db.reads[user.id] || {};
  db.reads[user.id][chat.id] = nowIso();
  persist();
  json(res, 201, { message: serializeMessage(m, user), masked: m.status === 'masked' });
});

// ---- 举报 ----
add('POST', /^\/api\/messages\/(\d+)\/report$/, async (req, res, body, user, params) => {
  const id = Number(params[0]);
  const msg = db.messages.find((m) => m.id === id);
  if (!msg) return json(res, 404, { error: '消息不存在' });
  const chat = chatOf(msg.chatId);
  if (!chat || !chat.members.includes(user.id)) return json(res, 403, { error: '无权举报该消息' });
  if (db.reports.some((r) => r.messageId === id && r.by === user.id && r.status === 'open')) {
    return json(res, 409, { error: '你已举报过这条消息，管理员正在处理' });
  }
  const report = {
    id: db.seq.reportId++,
    messageId: id,
    chatId: msg.chatId,
    by: user.id,
    reason: String(body.reason || '未填写').slice(0, 200),
    at: nowIso(),
    status: 'open'
  };
  db.reports.push(report);
  msg.reported = true;
  audit(user.id, 'report', 'msg:' + id, report.reason);
  persist();
  json(res, 201, { ok: true, reportId: report.id });
});

// ---- 管理员 ----
add('GET', '/api/admin/overview', async (req, res, body, user) => {
  const today = new Date().toISOString().slice(0, 10);
  json(res, 200, {
    users: db.users.filter((u) => u.role === 'user').length,
    bannedUsers: db.users.filter((u) => u.role === 'user' && isBanned(u)).length,
    messages: db.messages.length,
    blockedToday: db.messages.filter((m) => m.status === 'blocked' && m.at.startsWith(today)).length,
    maskedTotal: db.messages.filter((m) => m.status === 'masked').length,
    deletedTotal: db.messages.filter((m) => m.status === 'deleted').length,
    openReports: db.reports.filter((r) => r.status === 'open').length
  });
}, { admin: true });

add('GET', '/api/admin/messages', async (req, res, body, user) => {
  const status = req.searchParams.get('status') || '';
  const q = (req.searchParams.get('q') || '').toLowerCase();
  let rows = db.messages.slice().reverse();
  if (status) rows = rows.filter((m) => m.status === status);
  if (q) rows = rows.filter((m) => (m.text || '').toLowerCase().includes(q));
  rows = rows.slice(0, 200);
  json(res, 200, {
    messages: rows.map((m) => {
      const chat = chatOf(m.chatId) || { members: [] };
      const from = db.users.find((u) => u.id === m.from);
      const peerIds = chat.members.filter((x) => x !== m.from);
      const peer = db.users.find((u) => u.id === peerIds[0]);
      return {
        id: m.id,
        chatId: m.chatId,
        from: from ? { id: from.id, name: from.name } : { id: m.from, name: '系统' },
        to: peer ? { id: peer.id, name: peer.name } : null,
        text: m.text,
        at: m.at,
        status: m.status,
        flags: m.flags || [],
        blockedReason: m.blockedReason || '',
        removedReason: m.removedReason || '',
        reported: !!m.reported
      };
    })
  });
}, { admin: true });

add('POST', /^\/api\/admin\/messages\/(\d+)\/delete$/, async (req, res, body, user, params) => {
  const msg = db.messages.find((m) => m.id === Number(params[0]));
  if (!msg) return json(res, 404, { error: '消息不存在' });
  const reason = String(body.reason || '').trim() || '违反《HowGo 社区规范》';
  msg.status = 'deleted';
  msg.removedBy = user.id;
  msg.removedReason = reason;
  msg.removedAt = nowIso();
  // 系统提示落到会话里，双方可见
  db.messages.push({
    id: db.seq.msgId++,
    chatId: msg.chatId,
    from: SYSTEM_UID,
    system: true,
    text: '系统提示：一条消息因' + reason + '已被移除',
    at: nowIso(),
    status: 'ok'
  });
  audit(user.id, 'message-delete', 'msg:' + msg.id, reason);
  persist();
  json(res, 200, { ok: true });
}, { admin: true });

add('GET', '/api/admin/reports', async (req, res, body, user) => {
  const rows = db.reports
    .slice()
    .sort((a, b) => (a.status === b.status ? b.id - a.id : a.status === 'open' ? -1 : 1))
    .slice(0, 200)
    .map((r) => {
      const msg = db.messages.find((m) => m.id === r.messageId);
      const by = db.users.find((u) => u.id === r.by);
      const from = msg ? db.users.find((u) => u.id === msg.from) : null;
      return {
        id: r.id,
        at: r.at,
        status: r.status,
        reason: r.reason,
        reporter: by ? by.name : String(r.by),
        message: msg
          ? { id: msg.id, text: msg.text, at: msg.at, status: msg.status, from: from ? from.name : String(msg.from) }
          : null
      };
    });
  json(res, 200, { reports: rows });
}, { admin: true });

add('POST', /^\/api\/admin\/reports\/(\d+)\/resolve$/, async (req, res, body, user, params) => {
  const r = db.reports.find((x) => x.id === Number(params[0]));
  if (!r) return json(res, 404, { error: '举报不存在' });
  const action = String(body.action || 'keep');
  if (action === 'delete') {
    const msg = db.messages.find((m) => m.id === r.messageId);
    if (msg && msg.status !== 'deleted') {
      msg.status = 'deleted';
      msg.removedBy = user.id;
      msg.removedReason = '经举报核实违规';
      msg.removedAt = nowIso();
      db.messages.push({
        id: db.seq.msgId++,
        chatId: msg.chatId,
        from: SYSTEM_UID,
        system: true,
        text: '系统提示：一条消息经举报核实违规，已被移除',
        at: nowIso(),
        status: 'ok'
      });
    }
  }
  r.status = 'resolved';
  r.resolvedAt = nowIso();
  r.resolvedBy = user.id;
  r.resolution = action;
  audit(user.id, 'report-resolve', 'report:' + r.id, action);
  persist();
  json(res, 200, { ok: true });
}, { admin: true });

add('POST', /^\/api\/admin\/users\/(\d+)\/ban$/, async (req, res, body, user, params) => {
  const target = db.users.find((u) => u.id === Number(params[0]));
  if (!target) return json(res, 404, { error: '用户不存在' });
  if (target.role === 'admin') return json(res, 403, { error: '不能封禁管理员账号' });
  const minutes = Math.max(1, Math.min(60 * 24 * 30, Number(body.minutes || 60)));
  const reason = String(body.reason || '').trim() || '违反《HowGo 社区规范》';
  target.bannedUntil = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  target.bannedReason = reason;
  audit(user.id, 'user-ban', 'user:' + target.id, minutes + ' 分钟：' + reason);
  persist();
  json(res, 200, { ok: true, user: publicUser(target) });
}, { admin: true });

add('POST', /^\/api\/admin\/users\/(\d+)\/unban$/, async (req, res, body, user, params) => {
  const target = db.users.find((u) => u.id === Number(params[0]));
  if (!target) return json(res, 404, { error: '用户不存在' });
  target.bannedUntil = null;
  target.bannedReason = null;
  audit(user.id, 'user-unban', 'user:' + target.id, '解除限制');
  persist();
  json(res, 200, { ok: true });
}, { admin: true });

add('GET', '/api/admin/users', async (req, res, body, user) => {
  const rows = db.users
    .filter((u) => u.role !== 'admin')
    .map((u) => ({
      id: u.id,
      name: u.name,
      createdAt: u.createdAt,
      banned: isBanned(u),
      bannedUntil: u.bannedUntil || null,
      bannedReason: u.bannedReason || null,
      sent: db.messages.filter((m) => m.from === u.id).length,
      blocked: db.messages.filter((m) => m.from === u.id && m.status === 'blocked').length
    }))
    .sort((a, b) => b.blocked - a.blocked);
  json(res, 200, { users: rows });
}, { admin: true });

add('GET', '/api/admin/words', async (req, res, body, user) => {
  json(res, 200, { words: db.words });
}, { admin: true });

add('POST', '/api/admin/words', async (req, res, body, user) => {
  const kind = body.kind === 'block' ? 'block' : 'mask';
  const word = String(body.word || '').trim();
  if (!word) return json(res, 400, { error: '词条不能为空' });
  if (!db.words[kind].includes(word)) {
    db.words[kind].push(word);
    audit(user.id, 'word-add', kind, word);
    persist();
  }
  json(res, 200, { words: db.words });
}, { admin: true });

add('POST', '/api/admin/words/remove', async (req, res, body, user) => {
  const kind = body.kind === 'block' ? 'block' : 'mask';
  const word = String(body.word || '').trim();
  db.words[kind] = db.words[kind].filter((w) => w !== word);
  audit(user.id, 'word-remove', kind, word);
  persist();
  json(res, 200, { words: db.words });
}, { admin: true });

add('GET', '/api/admin/audits', async (req, res, body, user) => {
  const rows = db.audits.slice().reverse().slice(0, 200).map((a) => {
    const u = db.users.find((x) => x.id === a.actor);
    return { ...a, actorName: u ? u.name : String(a.actor) };
  });
  json(res, 200, { audits: rows });
}, { admin: true });

// ---------------------------------------------------------------------------
// 7. 静态资源 + 分发
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const safe = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('403');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      // 前端是单页应用：找不到的路径回 index.html
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          return res.end('404');
        }
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // 去掉尾部斜杠再匹配路由：热土登录页会把 port 规范成目录形式，
  // 回调可能变成 /api/auth/laswi/callback/?type=code…，否则会 404
  const pathname = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') || '/' : url.pathname;

  try {
    await ensureLoaded();
  } catch (e) {
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '数据服务暂时不可用，请稍后重试' }));
  }

  if (!pathname.startsWith('/api/')) return serveStatic(req, res);

  req.searchParams = url.searchParams;

  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      let params = null;
      if (typeof r.matcher === 'string') {
        if (r.matcher !== pathname) continue;
      } else {
        const m = pathname.match(r.matcher);
        if (!m) continue;
        params = m.slice(1);
      }
      const body = req.method === 'GET' ? {} : await readBody(req);
      const user = currentUser(req);
      if (!r.public && !user) return json(res, 401, { error: '请先登录' });
      if (r.admin && (!user || user.role !== 'admin')) return json(res, 403, { error: '需要管理员权限' });
      await r.handler(req, res, body, user, params || []);
      return;
    }
    json(res, 404, { error: '接口不存在' });
  } catch (e) {
    console.error('[howgo]', req.method, pathname, e);
    json(res, 500, { error: '服务器内部错误' });
  }
});

// ---------------------------------------------------------------------------
// 8. 启动：初始化管理员账号
// ---------------------------------------------------------------------------

let ADMIN_KEY = ENV_ADMIN_KEY;
let adminReady = false;

// 管理员初始化：云端模式下必须在数据加载完成后执行，否则每次冷启动都会重复建号
function initAdmin() {
  if (adminReady) return;
  adminReady = true;

  if (CLOUD && !ENV_ADMIN_PASSWORD) {
    console.warn('[howgo] 警告：云端模式未设置 HOWGO_ADMIN_PASSWORD，管理员密码为随机值且重启后不可复现，请在环境变量中固定。');
  }

  if (!db.users.some((u) => u.role === 'admin')) {
    const password = ENV_ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    if (!ADMIN_KEY) ADMIN_KEY = crypto.randomBytes(9).toString('base64url');
    const { salt, hash } = hashPassword(password);
    const admin = {
      id: db.seq.userId++,
      name: 'admin',
      salt,
      hash,
      role: 'admin',
      createdAt: nowIso(),
      bannedUntil: null,
      bannedReason: null
    };
    db.users.push(admin);
    persist();
    const cred =
      'HowGo 管理员凭据（首次启动生成，请妥善保管后删除本文件）\n' +
      '生成时间：' + nowIso() + '\n' +
      'HowGo 号：admin\n' +
      '密码：' + password + '\n' +
      '管理密钥：' + ADMIN_KEY + '\n' +
      '提示：登录时勾选「管理员登录」，账号密码之外还需填写管理密钥。\n' +
      '如需重置，删除 data/db.json 后重启服务。\n';
    fs.writeFileSync(CRED_FILE, cred, 'utf8');
    fs.writeFileSync(path.join(DATA_DIR, 'admin-key.txt'), ADMIN_KEY + '\n', 'utf8');
    console.log('\n===== HowGo 管理员账号已创建 =====');
    console.log('账号：admin');
    console.log('密码：' + password);
    console.log('管理密钥：' + ADMIN_KEY);
    console.log('凭据文件：' + CRED_FILE);
    console.log('=================================\n');
  } else if (!ADMIN_KEY) {
    // 管理密钥持久化：重启后保持一致，避免管理员被锁在门外
    const keyFile = path.join(DATA_DIR, 'admin-key.txt');
    if (fs.existsSync(keyFile)) {
      ADMIN_KEY = fs.readFileSync(keyFile, 'utf8').trim();
      console.log('[howgo] 已从 data/admin-key.txt 读取管理密钥');
    } else {
      ADMIN_KEY = crypto.randomBytes(9).toString('base64url');
      fs.writeFileSync(keyFile, ADMIN_KEY + '\n', 'utf8');
      console.log('[howgo] 已生成管理密钥并写入 data/admin-key.txt：' + ADMIN_KEY);
    }
  }
}

// 启动：先加载云端数据（若启用），再做管理员初始化，最后监听
(async () => {
  if (CLOUD) {
    try {
      await ensureLoaded();
      console.log('[howgo] 云端数据已加载，用户数：' + db.users.length);
    } catch (e) {
      console.error('[howgo] 启动时加载云端数据失败（首个请求会自动重试）：' + e.message);
    }
  }
  initAdmin();
})();

server.listen(PORT, HOST, () => {
  console.log('[howgo] 服务已启动： http://127.0.0.1:' + PORT);
  console.log('[howgo] 局域网： http://' + (require('node:os').networkInterfaces().en0
    ? Object.values(require('node:os').networkInterfaces().en0).find((x) => x.family === 'IPv4')?.address
    : '127.0.0.1') + ':' + PORT);
});
