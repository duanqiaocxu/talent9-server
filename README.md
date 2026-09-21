# 人才盘点九宫格 · 授权 + 支付服务端

把"九宫格可视化"变成可卖钱的付费产品：**服务端签发授权（Ed25519 非对称签名）+ 微信支付 / Stripe 支付下单与回调**。

> 安全核心：授权私钥只在服务器。客户端只内置**公钥**，只能「验签」不能「伪造」。
> 旧的「前端 checksum 激活码」（如 `PRO9-OK9G-4444`）已被彻底移除——它能被 F12 改 localStorage 绕过，不能用于真实付费。

## 目录
```
talent9-server/
├─ server.js          # 零依赖 Node 服务（http/crypto/https 内置）
├─ gen_keys.js        # 生成 Ed25519 密钥对（已跑过，keys/ 已存在）
├─ keys/
│  ├─ private.pem     # ⚠️ 服务端保密，绝不外发
│  └─ public.pem      # 公钥（其 SPKI base64 已嵌入客户端 HTML 的 SERVER_PUBLIC_KEY）
├─ licenses.json      # 签发记录（演示用；生产请换数据库）
├─ admin.html         # 极简发码后台页（GET /admin）
├─ .env.example       # 配置模板
└─ README.md
```

## 快速跑通（DEMO，无需任何密钥）
```bash
cd talent9-server
node server.js
# 浏览器打开 http://localhost:8787
# 点右上角「激活正式版」→「在线购买」→「▶ 演示解锁（无真实支付）」
# 即走通：下单 → 服务端签发授权 → 客户端公钥验签 → 解锁
```
DEMO 签发的授权带 `demo:true`，7 天过期，用于验证全链路；不收真实钱。

## 价格档位（两档，已就绪）
| 档位 | 价格 | 权限 | 授权有效期 |
|---|---|---|---|
| 试用版 | ¥0 | ≤15 人、单批次、带水印导出 | 无限 |
| 入门版 | ¥199/年 | 去水印导出、最多 100 人、单批次 | 365 天 |
| 专业版 | ¥999/年 | 不限人数 · 多批次 · 无水印 · Excel 报告 · 继任地图 · 席位管理 | 365 天 |

- 购买页两档卡片可选；`selectedPlan` 决定下单金额（Stripe/微信按 plan 选 `19900`/`99900` 分）与服务端签发的 `plan` 字段。
- 入门版定位"降低首单门槛"；专业版与 CXueai 学院培训/认证捆绑销售（专业版徽章显示"含培训/认证"）。
- 授权到期前 15 天，客户端自动显示续费提醒横幅（`renderRenew`，基于本地 token `exp` 计算，无需联网）。
- 服务端 `/api/license/verify` 同时返回 `daysLeft` 与 `renewSoon` 供前端/后台展示。

## 上线（真实收费）
1. `cp .env.example .env`，填入 Stripe / 微信 真实密钥（见文件内注释与官方文档）。
2. 重启 `node server.js` → 自动进入生产模式，DEMO 按钮可保留作测试。
3. 把客户端 HTML 通过本服务同源托管（`GET /`），用户访问 `http://你的域名/` 即可。
4. **本地双击打开 HTML 也能用**，但 `crypto.subtle` 在 `file://` 下可能不可用 → 此时回退为「服务端在线验签」，需保持服务可达。建议用户走同源 http 访问以获得离线验签能力。

## 方式二：静态收款码 + 人工核对发码（无需商户号，已接入）
客户端「在线购买」页已内嵌**微信静态收款码**（base64 内联，单文件可移植）。用户扫码付款 → 填联系方式 → 点「我已付款 · 申请激活」，服务端登记并等待人工核对：

```bash
# 管理端：查看付款登记（DEMO 模式无需 token；生产设置 ADMIN_TOKEN 后用请求头 x-admin-token）
curl http://localhost:8787/api/manual-pay-requests
# 核对微信到账后，审批签发正式授权码（一年期、demo:false）：
curl -X POST http://localhost:8787/api/manual-pay-approve -H "Content-Type: application/json" -d "{\"id\":\"Mxxxx\"}"
# 返回的 token 即授权码，发给用户 → 客户端「输入授权码」页粘贴激活
```
- 接口：`POST /api/manual-pay-request`（用户登记）、`GET /api/manual-pay-requests`（管理端查看）、`POST /api/manual-pay-approve`（审批发码，幂等）。
- 管理端鉴权：`.env` 设 `ADMIN_TOKEN=你的口令`；未设置时仅 DEMO 模式放行（本地测试用）。
- 注意：静态码无法自动确认到账，发码依赖人工核对；量大后升级为商户号 Native 自动发码（方式一）。

### 极简发码后台（可视化操作，不用敲命令）
已提供 `admin.html`，由服务端同源托管：**浏览器打开 `http://127.0.0.1:8787/admin`** 即可。
- 顶部显示 DEMO / 生产模式；生产环境在右上角填 `.env` 的 `ADMIN_TOKEN` 并保存（存 localStorage）。
- 卡片列出每条付款登记：编号、状态（待发码/已发码）、方案、联系方式、备注、时间。
- 待发码卡片 → 点「✅ 审批发码」→ 服务端签发正式授权码（按方案 199/999），卡片下方出现令牌框，可「复制」或「📧 发邮件」（若用户留了邮箱）。
- 已发码卡片直接展示令牌并可复制；重复审批返回同一令牌（幂等）。
- 支持「自动刷新(15s)」开关，微信看到账后无需手动刷新。

### 付款后「激活码自动到用户手里」（领取号闭环，已落地）
用户走方式二（微信静态收款码）付款登记后，**无需你手动复制发微信**：
1. 用户在 App 填联系方式并提交 → 服务端返回**领取号**，App 显示领取号并每 8 秒自动查询。
2. 你在后台看到登记、微信核对到账后点「✅ 审批发码」→ 服务端当场签发正式授权码并与领取号绑定。
3. 用户 App 自动查询到已签发的码 → **自动填充并激活正式版**（页面提示"已自动激活"）。
4. 后台也保留「复制 / 发邮件」按钮，供你按需手动发送。
- 接口：`POST /api/manual-pay-request`（返回 `claimCode`）、`GET /api/claim-status?claim=...`（用户端轮询/手动查询）、`POST /api/manual-pay-approve`（审批签发，幂等）。
- 边界：个人静态收款码无法让服务端自动感知"已付款"，因此"核对到账"那一步仍需你点一下；但**批准后发码 100% 自动到用户端**。要彻底无人值守（扫码即自动激活），请开微信支付商户号，把 `.env` 的 WECHAT_* 填好，server.js 的 Native 支付 + 回调自动签发已就绪，无需改代码。

```bash
node server.js
# 打开 http://127.0.0.1:8787/admin
```

### 后台页提示「未连接服务端」怎么办（已加固）
后台页已改为直连 `http://127.0.0.1:8787`（不再用 `localhost`，避免 Windows 把 localhost 解析到 IPv6 `::1` 而服务端只监听 IPv4 导致空响应）。若仍连不上，按此排查：
1. **服务端是否在运行**：双击 `启动服务端.bat`，保持那个 cmd 窗口开着（关了服务就停）。
2. **自检接口**：浏览器直接打开 `http://127.0.0.1:8787/api/config`，应看到一行 JSON（如 `{"demo":true,...}`）。看到 JSON = 服务正常，刷新后台页即可；看不到 = 服务没起来或被端口占用。
3. **端口占用**：若 8787 被占，改 `server.js` 顶部 `PORT` 或设环境变量 `PORT=新端口` 重启，并把后台页 `api()` 里的 8787 一并改掉。
4. **node 找不到**：bat 会先找 PATH 里的 `node`，没有则回退到受管路径 `C:\Users\jsqiang\.workbuddy\binaries\node\versions\22.22.2-3\node.exe`；若都不在，会提示安装 Node.js。

## 支付接入要点（务必核实官方最新文档）
- **Stripe**：`STRIPE_SECRET_KEY`（test: `sk_test_...`）、Webhook 用 `stripe listen --forward-to localhost:8787/api/webhook/stripe` 本地联调，上线配 `STRIPE_WEBHOOK_SECRET`。费率约 2.9%+$0.3/笔（以 stripe.com/pricing 为准）。
- **微信支付 V3**：需商户号、APIv3 密钥、商户 RSA 私钥、平台证书。Native 下单返回 `code_url` 由客户端展示二维码。回调用平台证书 RSA 验签 + APIv3 密钥 AES-GCM 解密。费率约 0.6%（以 pay.weixin.qq.com 为准）。
- **合规**：员工绩效/潜力属敏感个人信息，受《个人信息保护法》约束——告知-同意、最小必要、加密存储、可审计；企业大客户建议私有化部署。

## 接入办公 App（钉钉 / 飞书 / 企业微信）

九宫格是 HR 内部工具，最自然的入口是**员工已经在用的办公 IM**。三种主流方案里，**钉钉 H5 微应用**最适合大多数中国企业（尤其 SME/培训客户）；飞书适合偏互联网/新经济的客户；企业微信适合已经在用企微做客户经营的客户。

### 方案 A：钉钉 H5 微应用（推荐，零改造）
把九宫格当成一个"企业内部 H5 应用"嵌进钉钉工作台，员工点图标即在钉钉内打开，**不用单独注册账号**。服务端已内置钉钉免登脚手架（env 填齐即生效，未填则完全不影响现有功能）。

**步骤（约 30 分钟）**
1. 准备一个**公网 HTTPS 域名**（钉钉 H5 微应用强制 HTTPS，且需在钉钉后台配置「可信域名」并完成域名归属校验）。本地 `localhost` 只用于开发联调。
2. 把 `server.js` 部署到该域名（云主机 / 容器均可，零依赖，Node 一键起）；`CLIENT_HTML` 指向客户端 HTML，服务同源托管 `GET /`。
3. 钉钉开发者后台（open-dev.dingtalk.com）→ 创建「**企业内部应用**」→ 应用类型选 **H5 微应用**。
4. 应用配置：
   - 「**应用首页地址**」= `https://你的域名/`
   - 「**可用范围**」= 授权给 HR / 盘点负责人所在部门
   - 「**开发管理**」填「服务器出口 IP」「应用首页」与「PC 端首页」（同地址）
5. 在「**权限管理**」开通：*通讯录只读*（拉员工名单）、*免登*（获取员工身份）等所需权限。
6. 发布应用 → 钉钉工作台出现图标 → 员工点击即在钉钉内打开九宫格。

**免登（让 App 知道"当前是谁"，可选但强烈建议）**
- 前端引入钉钉 JSAPI：`https://g.alicdn.com/dingtalk/open-develop/1.9.0/dingtalk.js`
- `dd.ready` 后调用 `dd.runtime.permission.requestAuthCode({ corpId })` 拿到临时 `code`
- `POST /api/dingtalk/login { authCode }` → 服务端用 `appKey/secret` 换 `access_token`，再调 `topapi/v2/user/getuserinfo` 换回 `userid/姓名`
- `/api/dingtalk/jsapi-config?url=当前页URL` 返回 `dd.config` 所需的 `corpId/agentId/timeStamp/nonceStr/signature`（服务端用 `jsapi_ticket` 做 SHA1 签名，已内置）
- 拿到身份后可做：① 把授权绑定到「企业」而非个人（按 corpId 批量发放）；② 操作留痕（谁改了谁的盘点）。

**数据自动接入（真正的差异化，进阶）**
- 调钉钉通讯录 API（`topapi/v2/user/list` / `department/list`）把员工名单自动拉进九宫格「人员」，免手工录入。
- 绩效分钉钉本身不存，需对接你的绩效系统（北森/Moka/用友）或让用户上传；这部分是"连接 HR 系统"的工作，可后续做。

### 方案 B：飞书（Lark）H5 应用
飞书开放平台创建「**企业自建应用**」→ 配置「应用主页」为你的 HTTPS 地址 → 开通「获取用户 userid / 姓名」权限 → 工作台可见。免登走飞书 OAuth 2.0 网页授权：前端拿到 `code` 后 `POST /api/feishu/login` 由服务端用 `app_id+app_secret+code` 换 `user_access_token`，再取 `open_id / 姓名`。**飞书版免登脚手架已接进 server.js（见下方「已落地」）。**

### 方案 C：企业微信 H5 应用
企业微信管理后台创建「**应用**」→「主页」填你的 HTTPS 地址 → 用「网页授权及 JS-SDK」的 `snsapi_base` 静默拿 `userid`（无需钉钉那种临时 code 换 token 的二次调用，更省事）→ 通讯录用「通讯录同步」 secret 拉名单。适合客户已在企微体系内。

### 当前已落地的脚手架（server.js，env 开关，钉钉 + 飞书）
**钉钉**
- 配置：`.env` 填 `DINGTALK_APPKEY / DINGTALK_APPSECRET / DINGTALK_CORPID / DINGTALK_AGENTID`，重启后 `/api/config` 的 `providers.dingtalk` 变 `true`。
- 端点：`GET /api/dingtalk/jsapi-config?url=` 返回 `dd.config` 签名；`POST /api/dingtalk/login` 用 `authCode` 换员工身份。

**飞书**
- 配置：`.env` 填 `FEISHU_APP_ID / FEISHU_APP_SECRET`，重启后 `/api/config` 的 `providers.feishu` 变 `true`。
- 端点：`GET /api/feishu/config` 返回 `{ enabled, appId }` 供前端判断是否启用免登；`POST /api/feishu/login` 用 `authCode` 换 `open_id / name`。
- 前端集成：飞书工作台内用 JSAPI `tt.requestAuthCode({ appID })` 拿 `code`（或网页授权跳转 `open.feishu.cn/open-apis/authen/v1/authorize`），再把 `code` POST 给 `/api/feishu/login` 即可免登。

**通用**
- 未填对应密钥时，钉钉/飞书端点均返回 `400 未配置凭证`，**不影响支付/发码/现有流程**。
- ⚠️ 签名与免登逻辑按各自开放平台文档实现，**需在拿到真实凭证后实网验证一次**（本沙箱无钉钉/飞书凭证，仅做了无密钥降级验证）。

## 授权令牌结构（Ed25519 签名的最小 JWT）
`base64url(header).base64url(payload).base64url(signature)`
- header: `{"alg":"EdDSA","typ":"LIC"}`
- payload: `{"sub":订单ID,"plan":"pro","email":"","iat":签发时间,"exp":过期时间,"demo":bool}`
- 签名：服务端私钥对 `header.payload` 做 Ed25519 签名

伪造需要服务器私钥；客户端仅凭公钥可验签、不可签发。这是它比"前端 checksum"安全的原因。

## 已知边界 / 后续
- `licenses.json` 为演示持久化，生产请用数据库（PostgreSQL/Redis）。
- 微信回调签名校验已按规范实现，但需在配齐证书后实网验证一次。
- 可加：批量发码后台、企业多席位、私有化内网部署、等保。

## 上传到 GitHub 与部署（生产化）

### 安全红线（必读）
- `keys/private.pem`（Ed25519 私钥）、`.env`、`licenses.json`（含已签发令牌与邮箱）已被 `.gitignore` 排除，**绝不入库**。
- 部署时私钥经平台 Secret 注入（`LICENSE_PRIVATE_KEY_PEM`），服务端由该私钥派生公钥，与客户端嵌入公钥天然一致；**切勿把私钥提交进仓库**。
- 即使是公开仓库也必须守住上述红线；私有仓库同样建议用 Secret 注入，而非提交密钥文件。

### 部署所需环境变量（在平台后台 / Secret 填写）
| 变量 | 必填 | 说明 |
|---|---|---|
| `LICENSE_PRIVATE_KEY_PEM` | ✅ | 本地 `keys/private.pem` 全文（含 `-----BEGIN/END-----` 整段） |
| `ADMIN_TOKEN` | ✅ | 管理后台口令；不设则后台接口仅 DEMO 放行 |
| `PUBLIC_BASE_URL` | ✅ | 公网地址，如 `https://talent9-grid.onrender.com`（Stripe 回跳 / 微信回调用） |
| `PORT` | 自动 | 平台注入，默认 8787 |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | 选填 | 填齐即开通 Stripe 真实收款 |
| `WECHAT_*` | 选填 | 微信支付 V3 参数，填齐即开通微信真实收款 |
| `DINGTALK_*` / `FEISHU_*` | 选填 | 办公 App 免登，填齐即启用 |

### 三种部署方式
- **Render（推荐，最省心）**：仓库根已含 `render.yaml`。Render 控制台「New → Blueprint」连 GitHub 仓库，按提示填上述 Secret 即可；免费层约 15 分钟无流量会休眠。
- **容器 / Railway**：已含 `Dockerfile` 与 `Procfile`，`docker build -t talent9 . && docker run -p 8787:8787 -e LICENSE_PRIVATE_KEY_PEM="$(cat keys/private.pem)" talent9`。
- **自有云主机 + HTTPS**：把服务端跑在有域名的服务器，`PUBLIC_BASE_URL` 填域名，前面用 Nginx/Caddy 反代并配 HTTPS；监听 `0.0.0.0`（已默认）。

### 完整步骤
见仓库内 **《上传与部署指南.md》**（含本机 `git` 命令、GitHub 建库、Render 填 Secret、上线验证与安全复核清单）。

