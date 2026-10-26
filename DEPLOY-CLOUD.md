---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 036678f504ff50ab1d8d56fc51fc50d4_bff0808bd13e11f196c5525400248c00
    ReservedCode1: EQ14YIYR7WYBEO7jV7U/2OWdwAzHhZW0eGS/hDZLBhSKsYEYVAQ9aNM9I9aPeRCRbFv2RIrsN655EOUzrY+Xov3bYvtbgxCItF9gEV9FYi7ApEnIudBwkV5FyMLZIXevRdceJoEnql3dY/E3KfUkjKQCBQDDOHAyRwmFtkw2cY2A/HUebjIX1Ib7I10=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 036678f504ff50ab1d8d56fc51fc50d4_bff0808bd13e11f196c5525400248c00
    ReservedCode2: EQ14YIYR7WYBEO7jV7U/2OWdwAzHhZW0eGS/hDZLBhSKsYEYVAQ9aNM9I9aPeRCRbFv2RIrsN655EOUzrY+Xov3bYvtbgxCItF9gEV9FYi7ApEnIudBwkV5FyMLZIXevRdceJoEnql3dY/E3KfUkjKQCBQDDOHAyRwmFtkw2cY2A/HUebjIX1Ib7I10=
---

# HowGo 公网部署方案（不依赖本机 Mac）

目标：`https://howgo.laswi.com.cn` 长期在线，运行位置在云上，关掉 Mac 也不影响。
约束与解法对照：

| 约束 | 解法 |
|---|---|
| 不能用 Mac 常开 | 用 Render / Koyeb 免费 Web 服务跑容器 |
| 接受休眠 | Render 免费实例 15 分钟无流量会休眠，首个请求约 30–60 秒唤醒（已可接受） |
| 数据不能丢 | 免费实例没有持久磁盘，所以数据层已改成**云端 PostgREST 存储**（Supabase 免费库），实例重建 / 休眠唤醒都不丢 |
| 不花钱 | Render free（单实例 750 h/月）+ Supabase free（500 MB）+ GitHub Actions 定时保活，全部零费用 |

已在本仓库落地的改动：

- `server.js`：新增云端存储层（`HOWGO_STORE_URL` / `HOWGO_STORE_KEY`），未配置时自动退化为本地 `data/db.json`
- `server.js`：新增 `GET /api/ping` 保活探针（会真实读一次云端库，返回 `{"store":"cloud-ok"}`）
- `server.js`：云端加载失败时返回 503 且**拒绝写入**，绝不会用空库覆盖线上数据
- `supabase/schema.sql`：建表脚本
- `render.yaml`：已接入两个存储环境变量
- `.github/workflows/keepalive.yml`：每天北京时间 11:17 自动唤醒站点 + 保活数据库

---

## 一、准备云端数据库（5 分钟，一次性）

1. 打开 https://supabase.com → 用 GitHub 登录 → `New project`
   - 区域选 `Southeast Asia (Singapore)`（离大陆最近）
   - 记下数据库密码（本方案用不到，但别丢）
2. 进入项目 → 左侧 `SQL Editor` → 粘贴 `supabase/schema.sql` 全部内容 → `Run`
3. 左侧 `Project Settings` → `API`，抄两个值：
   - `Project URL`，形如 `https://abcdefgh.supabase.co`
   - `service_role` 那个 `secret` key（**不要用 anon key**）

> 注意：Supabase 免费项目连续 7 天几乎无数据库活动会被自动暂停（数据保留，可一键 Resume）。上面的保活工作流每天读一次库，正常不会触发暂停；万一暂停，仪表盘点 `Resume project` 即可，数据原样还在。

---

## 二、代码推到 GitHub（需要一个仓库）

Render / Koyeb 都从 Git 仓库构建。当前项目目录已是可部署状态（含 `Dockerfile`、`render.yaml`）。

```bash
cd howgo
git init -b main
git add -A
git commit -m "HowGo: 云端存储 + 免费层部署配置"
# 在 GitHub 新建空仓库 howgo（Private 即可），然后：
git remote add origin https://github.com/<你的账号>/howgo.git
git push -u origin main
```

注意：`data/db.json` 里有现有账号数据，**不要**推到公开仓库；若想保留线上历史数据，可在部署完成后用管理台重新建号，或私库推送。

---

## 三、Render 部署（主选，免费）

1. https://render.com → GitHub 登录 → 授权访问该仓库
2. `New` → `Blueprint` → 选 `howgo` 仓库 → Render 自动识别 `render.yaml`
3. 填三个环境变量：
   - `HOWGO_STORE_URL` = 上一步的 Project URL
   - `HOWGO_STORE_KEY` = service_role key
   - `LASWI_CLIENT_ID` / `LASWI_CLIENT_SECRET` = LaswI ID 应用凭据（没有可先留空，站点其余功能照常）
4. `Apply` → 等构建（约 3–5 分钟）→ 得到 `https://howgo-xxxx.onrender.com`
5. 验证：浏览器打开 `https://howgo-xxxx.onrender.com/api/ping`，应返回 `"store":"cloud-ok"`

> 免费实例 15 分钟无访问会休眠，首次访问需要等 30–60 秒；有保活工作流每天唤醒一次。
> 想彻底不休眠就得付费（Starter 7 美元/月），这与「不花钱」冲突，按你的要求已放弃。

## 四、自定义域名 howgo.laswi.com.cn

1. Render 服务页 → `Settings` → `Custom Domains` → 添加 `howgo.laswi.com.cn`
2. Render 给出一条目标值（形如 `howgo-xxxx.onrender.com`）
3. 登录 DNSPod（`laswi.com.cn` 的 NS 是 `brady.dnspod.net` / `duncan.dnspod.net`）
4. 把 `howgo` 这条记录从 **CNAME → wengu130301.github.io** 改成 **CNAME → howgo-xxxx.onrender.com**
   - 原记录先记下来（回滚用）；TTL 设 600
5. 等 Render 完成证书签发（通常 5–15 分钟，最长 1 小时）
6. 验证（本机有 DNS 缓存，必须绕过）：
   ```bash
   dig @8.8.8.8 howgo.laswi.com.cn CNAME +short
   curl -s https://howgo.laswi.com.cn/api/ping
   ```

---

## 五、备用平台：Koyeb（Render 不给免费实例时用）

Koyeb 免费额度：1 个 Web 服务，512 MB / 0.1 vCPU，**仅 Frankfurt 或 Washington D.C. 区域**（大陆访问比新加坡略慢）。

1. https://app.koyeb.com → GitHub 登录 → `Create Service` → `GitHub` → 选仓库
2. Builder 选 `Dockerfile`，Instance 选 `Free`，Region 选 `Washington, D.C.` 或 `Frankfurt`
3. 环境变量同上（`HOWGO_STORE_URL` / `HOWGO_STORE_KEY` / 端口用默认 8000 或设 `PORT=8000`）
4. 部署后拿到 `https://xxx.koyeb.app`，再按第四节绑 `howgo.laswi.com.cn`

---

## 六、验收清单

| 检查项 | 期望 |
|---|---|
| `GET /api/health` | `{"ok":true,...,"storage":"cloud"}` |
| `GET /api/ping` | `{"ok":true,"store":"cloud-ok",...}` |
| 首页 `GET /` | 200，能正常渲染 |
| 管理员登录 | `POST /api/login` 带 `adminKey` 才通过；普通用户走 LaswI ID |
| 休眠唤醒 | 静置 20 分钟后访问，首次慢（30–60 s），之后正常 |
| 数据持久 | Render 后台 `Manual Deploy` 或重启实例，用户与消息仍在 |
| 数据库保活 | GitHub Actions `keepalive` 每天绿勾 |

---

## 七、本地回落与自建服务器

不配 `HOWGO_STORE_URL` 时，服务仍用 `data/db.json`，本地跑法不变：

```bash
PORT=5210 node server.js
```

有 VPS 时仍可用 `docker compose up -d`（见 `docker-compose.yml` / `Caddyfile`），数据卷挂 `/app/data`。
*（内容由AI生成，仅供参考）*
