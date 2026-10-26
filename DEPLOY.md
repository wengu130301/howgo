---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 036678f504ff50ab1d8d56fc51fc50d4_47a3f7fed13911f196c5525400248c00
    ReservedCode1: V3db3iRQCE6t/NoJwErn606/ikkv25RkbVNr5LoTdRscGfX5sZ2IoIbPZPsAp2W9nRMaKzU2yZRdIab2WVkJ/ZlmnRdmP33LnLpZbu1J3kDRRvYfuPwMltMNPii4APVU2eFlCyLuwIdEz7Xe207aHK7Bo3BwvsP2E9mt9yq3ewMF9jPswrAx+zv2jh0=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 036678f504ff50ab1d8d56fc51fc50d4_47a3f7fed13911f196c5525400248c00
    ReservedCode2: V3db3iRQCE6t/NoJwErn606/ikkv25RkbVNr5LoTdRscGfX5sZ2IoIbPZPsAp2W9nRMaKzU2yZRdIab2WVkJ/ZlmnRdmP33LnLpZbu1J3kDRRvYfuPwMltMNPii4APVU2eFlCyLuwIdEz7Xe207aHK7Bo3BwvsP2E9mt9yq3ewMF9jPswrAx+zv2jh0=
---

# HowGo 公网部署手册（howgo.laswi.com.cn）

> 目标：`https://howgo.laswi.com.cn` 完整可用 —— 页面、LaswI ID 登录、聊天、管理台全部走通。

---

## 一、先说结论：当前域名指向的东西跑不了后端

动手前实测到的现状（2026-10-26）：

| 项目 | 实测结果 |
|---|---|
| `howgo.laswi.com.cn` 解析 | CNAME → `wengu130301.github.io`（GitHub Pages） |
| 站点响应 | `HTTP 200`，`server: GitHub.com`，证书正常 |
| 线上内容 | 另一版 HowGo 前端（`/js/main.js`、`/js/common.js`、`/js/moments.js`），最后更新 2026-09-07 |
| 线上 API | 前端调同域 `/api/*`，Pages 上 `/api/auth/methods` 实测 `404` |
| `laswi.com.cn` NS | `brady.dnspod.net` / `duncan.dnspod.net`（DNSPod） |
| 本机工具 | 无 `cloudflared` / `nginx` / `caddy` / `pm2`；无 Cloudflare、Vercel、GitHub Token 凭据 |

**GitHub Pages 只托管静态文件，无法运行 `server.js`**（Node 常驻 + 文件持久化 + HttpOnly 会话 + 服务端换 token）。
所以「把 HowGo 部署到 `howgo.laswi.com.cn`」的前提是：**有一台能跑 Node 的机器，并把该子域解析指过去**（不再是 GitHub Pages）。

---

## 二、三条可行路径（按落地难度排序）

| 路径 | 需要什么 | 自定义域怎么绑 | 是否适合本项目 |
|---|---|---|---|
| **A. VPS + Docker Compose** | 一台公网 VPS（1C1G 够）+ SSH | DNSPod 加 A 记录指向 VPS IP | ✅ 推荐，工件已备好，最省事 |
| **B. 托管平台**（Render / Railway / Fly） | 平台账号 | 平台面板加自定义域 → DNSPod 加 CNAME | ✅ 可行，但**免费层文件系统不持久**，`data/` 需换外部存储 |
| **C. 本机 + 隧道**（Cloudflare Tunnel / frp） | CF 托管该域，或一台公网跳板 | Cloudflare 要求 NS 迁到 CF；frp 要求有公网服务器 | ⚠️ 家庭宽带无固定 IP、80/443 多被封，不推荐 |

> Vercel / Netlify 走的是 Serverless，`server.js` 的 `fs` 持久化与常驻会话都要重写，改动量大，不建议为这个项目选它。

---

## 三、路径 A 完整步骤（推荐）

### 1. 准备 VPS

- 系统：Ubuntu 22.04 / Debian 12，1 核 1G 起
- 安全组放行：`22`、`80`、`443`
- 装 Docker：

```bash
curl -fsSL https://get.docker.com | sh
```

### 2. 上传代码

```bash
# 本地执行（项目根目录 output/howgo）
tar czf howgo.tgz --exclude data --exclude .DS_Store server.js package.json public Dockerfile docker-compose.yml Caddyfile deploy
scp howgo.tgz root@<VPS_IP>:/opt/

# 服务器执行
mkdir -p /opt/howgo && cd /opt/howgo && tar xzf /opt/howgo.tgz
```

### 3. 写 `.env`（不要提交到仓库）

```bash
cd /opt/howgo
cat > .env <<'ENV'
HOWGO_ADMIN_KEY=<自己生成：openssl rand -base64 24>
LASWI_CLIENT_ID=<LaswI 平台申请>
LASWI_CLIENT_SECRET=<LaswI 平台申请>
LASWI_AUTH_BASE=https://rtuser.rtstudio.top
ENV
chmod 600 .env
```

> `HOWGO_PUBLIC_URL` 已在 `docker-compose.yml` 固定为 `https://howgo.laswi.com.cn`，用于拼接 OAuth 回调地址。

### 4. 改 DNS（DNSPod）

| 主机记录 | 类型 | 记录值 | TTL |
|---|---|---|---|
| `howgo` | A | `<VPS_IP>` | 600 |

**必须删掉原来那条指向 `wengu130301.github.io` 的 CNAME**，否则会和 A 记录冲突。
改完验证：

```bash
dig +short howgo.laswi.com.cn      # 应返回 VPS IP
# macOS 有阴性缓存时用公共 DNS 复核
dig @223.5.5.5 +short howgo.laswi.com.cn
```

### 5. 启动

```bash
cd /opt/howgo
docker compose up -d --build
docker compose logs -f howgo      # 首次启动会打印管理员账号/密码/密钥
```

Caddy 会自动向 Let's Encrypt 申请证书（DNS 生效后 30 秒内）。

### 6. LaswI 平台登记回调地址

在 LaswI ID 平台把该应用的回调白名单加上：

```
https://howgo.laswi.com.cn/api/auth/laswi/callback
```

漏了这一步，登录会在授权页报 `redirect_uri` 不匹配。

### 7. 上线自检

```bash
curl -s https://howgo.laswi.com.cn/api/health
# {"ok":true,"service":"howgo","version":"1.1.0","users":1,"laswi":true,"uptime":...}
```

浏览器验收清单：

- [ ] 打开首页默认停在「LaswI ID 登录」面板位
- [ ] 点登录能跳到 LaswI 授权页并成功回跳，建号成功
- [ ] 管理员入口用「账号 + 密码 + 管理密钥」能进管理台
- [ ] 管理员用 LaswI ID 登录会被拦并提示「管理员账号不支持 LaswI ID 登录」
- [ ] 手机 4G 网络访问正常（不走局域网）

### 8. 上线后必做

```bash
# 1) 凭据文件读完即删（密码与密钥已在控制台输出过）
docker compose exec howgo sh -c 'rm -f /app/data/admin-credentials.txt'

# 2) 备份数据卷（用户、消息、词库、审计全在 data/db.json）
docker run --rm -v howgo_howgo-data:/d -v /opt/backup:/b alpine tar czf /b/howgo-data-$(date +%F).tgz -C /d .
```

---

## 四、路径 B（Render / Railway）注意点

1. 直接用仓库里的 `Dockerfile`，平台会自动识别。
2. 环境变量同上（`PORT` 由平台注入，无需手填）。
3. **挂载持久盘到 `/app/data`**，否则每次重启用户和消息全丢 —— Railway 的 Volume、Render 的 Disk 都支持。
4. 平台面板「Custom Domain」填 `howgo.laswi.com.cn`，按提示在 DNSPod 加 CNAME（值形如 `xxx.onrender.com`），并删除原有指向 GitHub Pages 的 CNAME。
5. 回调地址同样要在 LaswI 平台登记。

---

## 五、路径 C（本机临时对外）为什么不可行

- Cloudflare Tunnel 的自定义域要求 `laswi.com.cn` 的 NS 迁到 Cloudflare —— 会影响该域下所有现有站点（含 `gubrowser.laswi.com.cn`），风险大，需你确认。
- `trycloudflare` 临时隧道只给随机 `*.trycloudflare.com` 域名，不满足自定义域。
- frp / ngrok 固定域名需要付费或有公网跳板；家庭宽带 80/443 通常被运营商封禁。

---

## 六、日常运维

| 操作 | 命令 |
|---|---|
| 看日志 | `docker compose logs -f howgo` |
| 重启 | `docker compose restart howgo` |
| 更新代码 | 重新上传 `server.js`/`public` → `docker compose up -d --build` |
| 证书续期 | Caddy 自动，无需干预 |
| 数据备份 | 见「上线后必做」第 2 条 |
| 换管理密钥 | 改 `.env` 的 `HOWGO_ADMIN_KEY` → `docker compose up -d` |

---

## 七、Railway 专线（已选定方案）

本机无 Docker 也能走：Railway 在云端构建 `Dockerfile`，本地只需 CLI 上传源码。

### 1. 拿 Token

Railway 控制台 → **Account Settings → Tokens → Create Token**，复制 `rw_` 开头的串。

### 2. 安装并登录

```bash
npm i -g @railway/cli
railway login --token <TOKEN>
```

### 3. 建项目并上传

```bash
cd output/howgo
railway init --name howgo            # 新建空项目
railway up --service howgo           # 按 Dockerfile 构建并部署
```

### 4. 挂持久卷（关键，否则重启丢用户和消息）

```bash
railway volume add --service howgo --mount-path /app/data
```

### 5. 注入环境变量

```bash
railway variables --service howgo \
  --set "HOWGO_PUBLIC_URL=https://howgo.laswi.com.cn" \
  --set "HOWGO_ADMIN_KEY=$(openssl rand -base64 24)" \
  --set "LASWI_CLIENT_ID=<LaswI 平台申请>" \
  --set "LASWI_CLIENT_SECRET=<LaswI 平台申请>" \
  --set "LASWI_AUTH_BASE=https://rtuser.rtstudio.top"
```

> 不要设 `PORT`，Railway 自己注入，`server.js` 会读 `process.env.PORT`。

### 6. 生成临时域名并验证

```bash
railway domain --service howgo       # 拿到 xxx.up.railway.app
curl -s https://xxx.up.railway.app/api/health
```

`/api/health` 返回 `{"ok":true,...}` 说明容器、卷、健康检查都通了，再绑自定义域。

### 7. 绑自定义域

```bash
railway domain howgo.laswi.com.cn --service howgo
```

RAILWAY 会给出 CNAME 目标值（形如 `xxxx.up.railway.app`）。到 DNSPod：

| 主机记录 | 类型 | 记录值 |
|---|---|---|
| `howgo` | CNAME | RAILWAY 面板给出的目标值 |

**先删掉原来指向 `wengu130301.github.io` 的那条 CNAME**。解析生效后 Railway 自动签发 Let's Encrypt 证书。

### 8. 注意事项

- 免费/试用额度有月度上限，服务闲置会被休眠；正式用建议升到付费计划（具体额度以平台当前套餐页为准）。
- 卷挂载后**不能**随意改挂载路径，否则等于换了一块空盘。
- `data/` 内是 `db.json`（用户、会话、消息、词库、审计），备份靠 `railway run` 或定期导出：

```bash
railway run --service howgo tar czf - -C /app data > howgo-data-$(date +%F).tgz
```

---

## 八、需要你提供的东西（当前唯一阻塞）

1. **Railway Token**：`rw_` 开头，用于 `railway login --token`。
2. **LaswI 应用凭据**：`LASWI_CLIENT_ID` / `LASWI_CLIENT_SECRET`（LaswI ID 平台建应用后取得）。没有也能先上线，但首页 LaswI 登录按钮会置灰。
3. **DNSPod 改记录**：把 `howgo` 的 CNAME 换成 Railway 给的目标值 —— 你可以自己在控制台点，或给我 DNSPod API Token。

> 注意：改 DNS 会覆盖现在 `howgo.laswi.com.cn` 上的那版 GitHub Pages 站点（2026-09-07 部署的另一套 HowGo 前端）。如果要保留它，请先告诉我，我会在切换前把线上文件抓一份存档。
*（内容由AI生成，仅供参考）*
