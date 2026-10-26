---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 036678f504ff50ab1d8d56fc51fc50d4_32656ea7d13211f196c5525400248c00
    ReservedCode1: 5c5b9cM71xeUx2o+GT12VrK1334jYiAfPbDEh0/5pasm9mn8zGGloOBA9ZjipPcbQaX7gbGz8Dt4DPaBcyh9zfCQAJluAIeknxjtTD6ywlFsFxLdVQ1VXqdDLk4coDmfF6v2d1+0Fo3bu6X63YtKZv4VtwHKM0eIPqCqDn5Cnmwov2Yefahwo9ovGjM=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 036678f504ff50ab1d8d56fc51fc50d4_32656ea7d13211f196c5525400248c00
    ReservedCode2: 5c5b9cM71xeUx2o+GT12VrK1334jYiAfPbDEh0/5pasm9mn8zGGloOBA9ZjipPcbQaX7gbGz8Dt4DPaBcyh9zfCQAJluAIeknxjtTD6ywlFsFxLdVQ1VXqdDLk4coDmfF6v2d1+0Fo3bu6X63YtKZv4VtwHKM0eIPqCqDn5Cnmwov2Yefahwo9ovGjM=
---

# HowGo —— 类微信 / QQ 的即时通讯网页

零依赖 Node.js 单文件后端 + 原生前端（无构建步骤）。**登录体系与 Gugu Browser 的 LaswI ID 一致**，内置管理员双因素登录与一整套违规内容防传播闸口。

---

## 一、快速启动

```bash
cd howgo
node server.js                 # 默认 http://127.0.0.1:5299
PORT=8080 node server.js       # 换端口
```

首次启动会自动：

1. 生成管理员账号 `admin`（随机密码）与**管理密钥**；
2. 把凭据写到 `data/admin-credentials.txt`，管理密钥另存 `data/admin-key.txt`（重启后自动复用，不会失效）；
3. 写入 `data/db.json` 数据文件。

> 生产环境务必用 `HOWGO_ADMIN_KEY` 环境变量固定管理密钥，并删除 `data/admin-credentials.txt`。

---

## 二、普通用户登录：只允许 LaswI ID（与 Gugu Browser 同构）

账号策略：**普通用户唯一登录方式是 LaswI ID**，`/api/register` 已关闭、普通账号密码登录一律 `403`，HowGo 不保存用户密码；管理员账号不能走此入口。

三层信任边界，和 Gugu Browser 原生侧的桥接设计一一对应：

| 层 | Gugu Browser（Tauri） | HowGo（Web） |
|---|---|---|
| 协议与常量 | `laswi-id.ts` 协议常量 | `server.js` 中 `LASWI_*` 常量 |
| 令牌持有 | Rust/SQLite，前端不可见 | 服务端内存会话 `sessions[].laswiToken`，前端响应中无 token 字段 |
| 前端视图 | `stores/identity.ts`（仅 id/昵称/头像） | `state.me`（仅 id/name/role/provider） |

OAuth2 授权码模式，**换取令牌全程在服务端完成**：

```
GET /api/auth/laswi/start     生成 state → 302 跳转 LaswI 授权页
        ↓ 用户在 LaswI 完成授权
GET /api/auth/laswi/callback?code&state
        1) 校验 state（10 分钟有效，一次性）
        2) 服务端 POST 换 access_token      ← 前端看不到
        3) 服务端 GET 用户资料               ← 只取 id/昵称/头像
        4) 按 laswiId 查找或创建本地账号
        5) 下发 HttpOnly Cookie 会话 → 302 回 /
```

关键设计点（与 Gugu Browser 一致的经验）：

- **令牌不入前端**：`access_token` 只存在 `sessions` 的内存副本里，任何 `/api/me` 响应都不含 token；Cookie 为 `HttpOnly; SameSite=Lax`。
- **绕过平台 CORS 限制**：LaswI 平台未对第三方源放行 `Access-Control-Allow-Origin`，浏览器直连必被拦；本实现的授权码交换是**服务端到服务端**调用，天然不受同源策略约束，无需额外 Worker 代理。
- **不编造凭据**：未配置 `LASWI_CLIENT_ID` / `LASWI_CLIENT_SECRET` 时，`/api/auth/methods` 返回 `laswi:false`，前端按钮置灰并显式提示「LaswI ID 登录暂未配置」，绝不出现假登录。
- **管理员排除**：回调里若 `laswiId` 已绑定 `role=admin` 的账号，直接 302 回 `/?login_error=管理员账号不支持 LaswI ID 登录…`，不下发会话，并写审计 `laswi-login-denied`。

### 配置

```bash
export LASWI_CLIENT_ID=xxx
export LASWI_CLIENT_SECRET=xxx
export LASWI_AUTH_BASE=https://rtuser.rtstudio.top   # 默认值
export LASWI_AUTHORIZE_PATH=/auth/authorize          # 按平台实际端点覆盖
export LASWI_TOKEN_PATH=/auth/token
export LASWI_USER_PATH=/auth/get-user
export LASWI_SCOPE="openid profile"
export HOWGO_PUBLIC_URL=https://howgo.example.com    # 反代后必须显式指定，否则回调地址会错
```

> 端点路径按 LaswI 平台实际文档填写；本实现只依赖「授权码换 token + Bearer 取资料」这一标准契约，不硬编码任何未验证的接口。

---

## 三、管理员登录（双因素）

管理员**只能**通过「管理员登录」入口，用本地账号密码 + 管理密钥登录，**不支持 LaswI ID 第三方登录**：

- 账号密码错误 → `401 账号或密码错误`（计入 IP 限速）
- 密钥为空或错误 → `401 管理密钥错误`，并写审计 `admin-login-denied`
- 通过 → 写审计 `admin-login`，会话角色 `admin`

其他约束：

- 管理员**无法改密码**：没有改密接口，`admin` 账号也不会被注册接口覆盖
- 登录失败限速：同 IP 每分钟 8 次
- 管理接口全部二次校验 `role === 'admin'`，普通用户访问返回 `403`（已实测）

---

## 四、违规内容防传播（五道闸口）

发送链路是「先审后发」，不是「先发后删」。

| # | 闸口 | 机制 | 效果 |
|---|---|---|---|
| 1 | **写入前拦截** | 命中禁止词库（14 词：枪支弹药、毒品交易、冰毒、海洛因、代孕、裸聊、色情服务、赌博平台、博彩、洗钱、办假证、假币、恐怖袭击、爆炸物、迷药） | 整条 `451` 拒发，**不进会话**，仅管理员在审查台可见 |
| 2 | **写入前打码** | 命中引流词库（刷单、返利、日赚、代开发票、加微信、加我微信、私聊我、薅羊毛、推广引流、vx号、稳定货源）+ 手机号正则 | 关键词与手机号就地替换 `***` / `138****5678` 后送达，并标记 `mask:*` |
| 3 | **新号风控** | 注册未满 1 小时禁止发外链 | 防批量养号导流诈骗 |
| 4 | **发送限速** | 单用户 10 秒 10 条 | 防刷屏 / 爆破式群发 |
| 5 | **事后处置** | 举报 → 管理员判定删除；直接删消息；封禁（禁言到指定时间，封禁期发消息 `403`）；词库热更新；全量审计日志 | 删后消息对双方都显示「已移除」，原文不残留 |

补充：归一化后再匹配（`normalize()` 处理全半角、大小写、零宽字符等变形），避免「赌*博平*台」类绕过。

---

## 五、管理台（6 个页签）

| 页签 | 能力 |
|---|---|
| 概览 | 注册用户 / 封禁数 / 消息总数 / 今日拦截 / 累计打码 / 已删除 / 待处理举报 + 最近操作 |
| 消息审查 | 按状态（全部/正常/已打码/已拦截/已删除）与关键词检索，可强制删除 |
| 举报处理 | 举报队列，判定删除或驳回 |
| 用户管理 | 查用户、限时封禁 / 解封 |
| 敏感词库 | 拦截词、打码词增删（即时生效，无需重启） |
| 审计日志 | 最近 200 条操作留痕（登录、注册、打码、删除、封禁、词库变更） |

---

## 六、API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/register` | 已关闭，固定 `403`（普通用户由 LaswI ID 首次登录自动建号） |
| POST | `/api/login` | 仅管理员：需额外 `adminKey`；普通用户返回 `403` |
| POST | `/api/logout` | 退出 |
| GET | `/api/me` | 当前用户（无 token 字段） |
| GET | `/api/auth/methods` | 登录方式声明（`laswi` / `password:false` / `adminPassword:true`） |
| GET | `/api/auth/laswi/start` | 发起 LaswI 授权 |
| GET | `/api/auth/laswi/callback` | 授权回调（服务端换 token → 建本地会话） |
| GET | `/api/contacts` | 联系人列表 |
| POST | `/api/chats` | 建/取单聊 |
| GET | `/api/chats` | 会话列表（含未读数） |
| GET | `/api/chats/:id/messages` | 拉消息 |
| POST | `/api/chats/:id/messages` | 发消息（经审核闸口） |
| POST | `/api/chats/:id/read` | 标记已读 |
| POST | `/api/messages/:id/report` | 举报 |
| GET | `/api/admin/overview` | 概览 |
| GET | `/api/admin/messages` | 消息审查（可按 status 过滤） |
| POST | `/api/admin/messages/:id/delete` | 删除消息 |
| GET | `/api/admin/reports` | 举报队列 |
| POST | `/api/admin/reports/:id/resolve` | 处理举报（delete / dismiss） |
| GET | `/api/admin/users` | 用户列表 |
| POST | `/api/admin/users/:id/ban` \| `/unban` | 封禁 / 解封 |
| GET/POST | `/api/admin/words`、`/api/admin/words/remove` | 词库查询 / 增 / 删 |
| GET | `/api/admin/audits` | 审计日志 |

---

## 七、目录结构

```
howgo/
├── server.js              后端单文件（路由 / 会话 / 审核闸口 / 管理接口 / LaswI ID）
├── public/
│   ├── index.html         登录注册 + 主界面 + 管理台骨架
│   ├── style.css          微信绿主题，含移动端适配
│   ├── app.js             登录、轮询、会话、发消息、举报
│   └── admin.js           管理台 6 页签
└── data/                  运行时生成（db.json / admin-credentials.txt / admin-key.txt）
```

---

## 八、已知限制 / 上线前必做

- 消息靠 2 秒轮询，不是 WebSocket；在线规模上去后应改 WS 或 SSE
- 会话与词库在内存 + JSON 文件，多实例部署需换 Redis / SQLite
- 只有单聊，无群聊、无文件/图片传输、无离线推送
- 生产必须：HTTPS + 反向代理（并设 `HOWGO_PUBLIC_URL`）、删除凭据明文文件、`HOWGO_ADMIN_KEY` 走密钥管理
- 内容审核是本地词库 + 正则，属「基础防线」；正式产品应再接入平台级内容安全服务（文本 + 图片），本实现已预留审核结果字段 `status/flags/masked`
*（内容由AI生成，仅供参考）*
