/*
 * 人才盘点九宫格 · 授权 + 支付服务端（零依赖，Node 内置模块）
 * ---------------------------------------------------------------
 * 安全模型：Ed25519 非对称授权。私钥只在服务器，客户端只能「验签」不能「伪造」。
 * 支付：Stripe Checkout（国际/信用卡）与 微信支付 V3（Native 扫码）。
 * 无密钥时自动进入 DEMO 模式：可完整跑通「下单→支付成功→签发授权→解锁」流程，但不收真实钱。
 *
 * 启动： node server.js            (默认端口 8787)
 * 上线： 复制 .env.example 为 .env，填入真实密钥后重启。
 */
'use strict';
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const url = require('url');
const querystring = require('querystring');

const PORT = process.env.PORT || 8787;
const CLIENT_HTML = process.env.CLIENT_HTML || 'C:\\Users\\jsqiang\\Desktop\\人才盘点九宫格App.html';

// ---------- 配置（来自环境变量，生产必须填入） ----------
const CFG = {
  stripeSecret: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  stripePricePro: process.env.STRIPE_PRICE_PRO || '99900',     // 单位：分（专业版 ¥999）
  stripePriceStarter: process.env.STRIPE_PRICE_STARTER || '19900', // 单位：分（入门版 ¥199）
  wechatMchId: process.env.WECHAT_MCH_ID || '',
  wechatAppId: process.env.WECHAT_APP_ID || '',
  wechatApiV3Key: process.env.WECHAT_API_V3_KEY || '',         // 32 字节，解密回调
  wechatSerial: process.env.WECHAT_SERIAL || '',               // 商户 API 证书序列号
  wechatPrivateKeyPath: process.env.WECHAT_PRIVATE_KEY_PATH || '', // 商户 RSA 私钥 PEM
  wechatPlatformCertPath: process.env.WECHAT_PLATFORM_CERT_PATH || '', // 微信平台公钥证书 PEM
  wechatAmountPro: process.env.WECHAT_AMOUNT_PRO || '99900',   // 单位：分（¥999.00）
  adminToken: process.env.ADMIN_TOKEN || '',                   // 管理端接口口令（生产必填）
  dingtalkAppKey: process.env.DINGTALK_APPKEY || '',          // 钉钉企业内部应用 AppKey
  dingtalkAppSecret: process.env.DINGTALK_APPSECRET || '',    // 钉钉企业内部应用 AppSecret
  dingtalkCorpId: process.env.DINGTALK_CORPID || '',          // 钉钉 CorpId（免登/通讯录用）
  dingtalkAgentId: process.env.DINGTALK_AGENTID || '',        // 钉钉 AgentId（dd.config 用）
  feishuAppId: process.env.FEISHU_APP_ID || '',               // 飞书企业自建应用 App ID
  feishuAppSecret: process.env.FEISHU_APP_SECRET || '',       // 飞书企业自建应用 App Secret
  demoMode: !(process.env.STRIPE_SECRET_KEY || process.env.WECHAT_MCH_ID || process.env.DINGTALK_APPKEY || process.env.FEISHU_APP_ID),
};

// ---------- 授权密钥（Ed25519） ----------
const keysDir = path.join(__dirname, 'keys');
const privateKey = crypto.createPrivateKey(fs.readFileSync(path.join(keysDir, 'private.pem')));
const publicKey = crypto.createPublicKey(fs.readFileSync(path.join(keysDir, 'public.pem')));
const PUBLIC_KEY_SPKI_B64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

// ---------- 持久化（演示用 JSON；生产请换数据库） ----------
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'licenses.json');
let DB = { licenses: {}, orders: {}, revoked: {}, pending: {} };
try { DB = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')); } catch (_) {}
DB.pending = DB.pending || {};
function persist() { fs.writeFileSync(DB_FILE, JSON.stringify(DB, null, 2)); }
function requireAdmin(req) {
  if (CFG.adminToken) return (req.headers['x-admin-token'] || '') === CFG.adminToken;
  return CFG.demoMode; // 未设置 ADMIN_TOKEN 时仅 DEMO 模式放行（便于本地测试）
}

// ---------- 钉钉接入（免登 + JSAPI 配置 + 通讯录，可选；env 未配置则不启用） ----------
const DT = {
  appKey: process.env.DINGTALK_APPKEY || '',
  appSecret: process.env.DINGTALK_APPSECRET || '',
  corpId: process.env.DINGTALK_CORPID || '',
  agentId: process.env.DINGTALK_AGENTID || '',
};
function dtEnabled() { return !!(DT.appKey && DT.appSecret && DT.corpId); }
let _dtToken = { v: '', exp: 0 };
let _dtTicket = { v: '', exp: 0 };
function dtHttpGet(apiPath, q) {
  return new Promise((resolve, reject) => {
    const qs = querystring.stringify(q || {});
    https.get('https://oapi.dingtalk.com' + apiPath + (qs ? '?' + qs : ''), r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
async function dtToken() {
  if (_dtToken.exp > Date.now()) return _dtToken.v;
  const j = await dtHttpGet('/gettoken', { appkey: DT.appKey, appsecret: DT.appSecret });
  if (!j.access_token) throw new Error('钉钉 gettoken 失败: ' + JSON.stringify(j));
  _dtToken = { v: j.access_token, exp: Date.now() + (j.expires_in - 300) * 1000 };
  return j.access_token;
}
async function dtJsapiTicket() {
  if (_dtTicket.exp > Date.now()) return _dtTicket.v;
  const tk = await dtToken();
  const j = await dtHttpGet('/get_jsapi_ticket', { access_token: tk });
  if (!j.ticket) throw new Error('钉钉 get_jsapi_ticket 失败: ' + JSON.stringify(j));
  _dtTicket = { v: j.ticket, exp: Date.now() + (j.expires_in - 300) * 1000 };
  return j.ticket;
}
async function dtJsapiConfig(pageUrl) {
  const ticket = await dtJsapiTicket();
  const noncestr = crypto.randomBytes(8).toString('hex');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const raw = `jsapi_ticket=${ticket}&noncestr=${noncestr}&timestamp=${timestamp}&url=${pageUrl}`;
  const signature = crypto.createHash('sha1').update(raw).digest('hex');
  return { corpId: DT.corpId, agentId: DT.agentId, timeStamp: timestamp, nonceStr: noncestr, signature };
}
async function dtGetUserInfo(authCode) {
  const tk = await dtToken();
  return await new Promise((resolve, reject) => {
    const body = JSON.stringify({ code: authCode });
    const req2 = https.request({ hostname: 'oapi.dingtalk.com', path: '/topapi/v2/user/getuserinfo?access_token=' + tk, method: 'POST', headers: { 'Content-Type': 'application/json' } }, r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req2.on('error', reject); req2.write(body); req2.end();
  });
}

// ---------- 飞书接入（企业自建应用 · 网页授权/OAuth 与工作台 H5 免登，可选；env 未配置则不启用） ----------
const FS = {
  appId: process.env.FEISHU_APP_ID || '',
  appSecret: process.env.FEISHU_APP_SECRET || '',
};
function fsEnabled() { return !!(FS.appId && FS.appSecret); }
// 用前端回传的授权 code 换 user_access_token（飞书 OAuth 2.0 网页授权）
function fsExchangeToken(code) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ grant_type: 'authorization_code', code, app_id: FS.appId, app_secret: FS.appSecret });
    const r = https.request({ hostname: 'open.feishu.cn', path: '/open-apis/authen/v2/oauth/token', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    r.on('error', reject); r.write(body); r.end();
  });
}
// 用 user_access_token 取当前用户信息（open_id / 姓名）；飞书 authen/v1/user_info 只需授权 scope，无需通讯录权限
function fsGetUserInfo(accessToken) {
  return new Promise((resolve, reject) => {
    const r = https.request({ hostname: 'open.feishu.cn', path: '/open-apis/authen/v1/user_info', method: 'GET', headers: { Authorization: 'Bearer ' + accessToken } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    r.on('error', reject); r.end();
  });
}

// ---------- 授权令牌：Ed25519 签名的最小 JWT ----------
function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function signToken(payload) {
  const h = b64u(Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'LIC' })));
  const p = b64u(Buffer.from(JSON.stringify(payload)));
  const sig = crypto.sign(null, Buffer.from(h + '.' + p), privateKey);
  return `${h}.${p}.${b64u(sig)}`;
}
function verifyTokenLocal(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const data = Buffer.from(parts[0] + '.' + parts[1]);
  const sig = Buffer.from(parts[2], 'base64url');
  if (!crypto.verify(null, data, publicKey, sig)) return null;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString()); } catch { return null; }
}
function issueLicense({ email, plan, demo }) {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const exp = demo ? now + 7 * 86400 : now + 365 * 86400; // 演示 7 天，正式 1 年
  const payload = { sub: id, plan, email: email || '', iat: now, exp, demo: !!demo };
  const token = signToken(payload);
  DB.licenses[id] = { token, plan, email: email || '', exp, demo: !!demo, issuedAt: now };
  persist();
  return token;
}

// ---------- 工具 ----------
function send(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }, extraHeaders || {}));
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = ''; req.on('data', c => d += c); req.on('end', () => {
      try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); }
    });
  });
}
function newOrder(ref, email, plan) { DB.orders[ref] = { ref, email, plan, status: 'pending', createdAt: Date.now() }; persist(); }

// ---------- Stripe 下单（raw HTTPS，无 SDK） ----------
function stripeCreateSession(ref, email, plan, amount, name) {
  const body = querystring.stringify({
    mode: 'payment',
    'client_reference_id': ref,
    success_url: `${PUBLIC_BASE}/api/license/claim?ref=${ref}`,
    cancel_url: `${PUBLIC_BASE}/`,
    customer_email: email || '',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'cny',
    'line_items[0][price_data][unit_amount]': String(amount),
    'line_items[0][price_data][product_data][name]': '人才盘点九宫格工作台·' + (name || '正式版'),
  });
  const opt = {
    method: 'POST', hostname: 'api.stripe.com', path: '/v1/checkout/sessions',
    headers: { Authorization: 'Bearer ' + CFG.stripeSecret, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  };
  return new Promise((resolve, reject) => {
    const r = https.request(opt, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    r.on('error', reject); r.write(body); r.end();
  });
}

// ---------- 微信支付 V3 下单（raw HTTPS + RSA-SHA256 签名） ----------
function wechatSign(method, pathname, bodyStr) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(8).toString('hex');
  const msg = `${method}\n${pathname}\n${ts}\n${nonce}\n${bodyStr}\n`;
  const key = crypto.createPrivateKey(fs.readFileSync(CFG.wechatPrivateKeyPath));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(msg), key).toString('base64');
  return { auth: `WECHATPAY2-SHA256-RSA2048 mchid="${CFG.wechatMchId}",nonce_str="${nonce}",signature="${sig}",timestamp="${ts}",serial_no="${CFG.wechatSerial}"`, bodyStr };
}
function wechatCreateOrder(ref, plan, amount) {
  const body = JSON.stringify({
    mchid: CFG.wechatMchId, appid: CFG.wechatAppId,
    description: '人才盘点九宫格工作台·正式版', out_trade_no: ref,
    notify_url: `http://localhost:${PORT}/api/webhook/wechat`,
    amount: { total: Number(amount), currency: 'CNY' },
  });
  const s = wechatSign('POST', '/v3/pay/transactions/native', body);
  const opt = {
    method: 'POST', hostname: 'api.mch.weixin.qq.com', path: '/v3/pay/transactions/native',
    headers: { Authorization: s.auth, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s.bodyStr) },
  };
  return new Promise((resolve, reject) => {
    const r = https.request(opt, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    r.on('error', reject); r.write(s.bodyStr); r.end();
  });
}
function wechatDecryptResource(resource) {
  const key = Buffer.from(CFG.wechatApiV3Key, 'utf-8');
  const nonce = Buffer.from(resource.nonce, 'utf-8');
  const ad = Buffer.from(resource.associated_data || '', 'utf-8');
  const ct = Buffer.from(resource.ciphertext, 'base64');
  const authTag = ct.subarray(ct.length - 16);
  const data = ct.subarray(0, ct.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(authTag); decipher.setAAD(ad);
  return JSON.parse(decipher.update(data, null, 'utf-8') + decipher.final('utf-8'));
}

// ================= 路由 =================
const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const p = u.pathname;
  try {
    // ---------- 钉钉 JSAPI 配置（前端 dd.config 用；未配置钉钉凭证时返回 400） ----------
    if (p === '/api/dingtalk/jsapi-config' && req.method === 'GET') {
      if (!dtEnabled()) return send(res, 400, { error: '未配置钉钉凭证（DINGTALK_APPKEY/SECRET/CORPID）' });
      try { const cfg = await dtJsapiConfig(decodeURIComponent(u.query.url || '')); return send(res, 200, cfg); }
      catch (e) { return send(res, 502, { error: '钉钉 JSAPI 配置失败: ' + (e.message || e) }); }
    }
    // ---------- 钉钉免登：用前端 authCode 换取当前员工身份 ----------
    if (p === '/api/dingtalk/login' && req.method === 'POST') {
      if (!dtEnabled()) return send(res, 400, { error: '未配置钉钉凭证' });
      try {
        const b = await readBody(req);
        const j = await dtGetUserInfo(b.authCode);
        if (j.errcode) return send(res, 200, { ok: false, errcode: j.errcode, errmsg: j.errmsg });
        return send(res, 200, { ok: true, userid: j.result && j.result.userid, name: j.result && j.result.name });
      } catch (e) { return send(res, 502, { error: '钉钉免登失败: ' + (e.message || e) }); }
    }


    // ---------- 飞书配置（前端判断是否启用飞书免登 / 拼授权链接） ----------
    if (p === '/api/feishu/config' && req.method === 'GET') {
      return send(res, 200, { enabled: fsEnabled(), appId: FS.appId });
    }
    // ---------- 飞书免登：用前端 authCode 换取当前用户身份 ----------
    if (p === '/api/feishu/login' && req.method === 'POST') {
      if (!fsEnabled()) return send(res, 400, { error: '未配置飞书凭证（FEISHU_APP_ID/SECRET）' });
      try {
        const b = await readBody(req);
        const t = await fsExchangeToken(b.authCode);
        if (!t || t.code) return send(res, 200, { ok: false, code: t && t.code, msg: t && t.msg });
        const info = await fsGetUserInfo(t.data.access_token);
        if (!info || info.code) return send(res, 200, { ok: false, code: info && info.code, msg: info && info.msg });
        return send(res, 200, { ok: true, open_id: info.data && info.data.open_id, name: info.data && info.data.name });
      } catch (e) { return send(res, 502, { error: '飞书免登失败: ' + (e.message || e) }); }
    }

    // ---- 静态托管 App ----
    if (p === '/' || p === '/index.html') {
      try { const html = fs.readFileSync(CLIENT_HTML); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); }
      catch (e) { send(res, 500, { error: '找不到客户端 HTML，请设置 CLIENT_HTML 环境变量' }); }
      return;
    }
    if (p === '/api/public-key') { send(res, 200, { spki: PUBLIC_KEY_SPKI_B64 }); return; }
    // ---- 管理后台页 ----
    if (p === '/admin' || p === '/admin.html') {
      try { const html = fs.readFileSync(path.join(__dirname, 'admin.html')); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); }
      catch (e) { send(res, 500, { error: '找不到 admin.html' }); }
      return;
    }
    if (p === '/api/config') {
      send(res, 200, { demo: CFG.demoMode, providers: { stripe: !!CFG.stripeSecret, wechat: !!CFG.wechatMchId, dingtalk: dtEnabled(), feishu: fsEnabled() } });
      return;
    }

    // ---- 验签授权令牌（在线权威校验；同时支持客户端本地验签） ----
    if (p === '/api/license/verify' && req.method === 'POST') {
      const b = await readBody(req);
      const pl = verifyTokenLocal(b.token);
      if (!pl) return send(res, 200, { valid: false, reason: '签名无效或格式错误' });
      if (pl.exp * 1000 < Date.now()) return send(res, 200, { valid: false, reason: '已过期' });
      if (DB.revoked[pl.sub]) return send(res, 200, { valid: false, reason: '已吊销' });
      const daysLeft = Math.ceil((pl.exp * 1000 - Date.now()) / 86400000);
      return send(res, 200, { valid: true, plan: pl.plan, exp: pl.exp, demo: !!pl.demo, email: pl.email, daysLeft, renewSoon: daysLeft <= 15 });
    }

    // ---- 输入授权码解锁（用户已付费，拿到服务端签发的令牌） ----
    if (p === '/api/license/redeem' && req.method === 'POST') {
      const b = await readBody(req);
      const pl = verifyTokenLocal(b.token);
      if (!pl || pl.exp * 1000 < Date.now() || DB.revoked[pl.sub]) return send(res, 400, { ok: false, error: '授权码无效或已失效' });
      return send(res, 200, { ok: true, plan: pl.plan, exp: pl.exp, demo: !!pl.demo });
    }

    // ---- 支付后领取授权（Stripe/微信 回调签发后，客户端凭 ref 领取） ----
    if (p === '/api/license/claim' && req.method === 'GET') {
      const o = DB.orders[u.query.ref];
      if (!o) return send(res, 404, { error: '订单不存在' });
      if (o.status !== 'paid') return send(res, 202, { status: o.status });
      const lic = Object.values(DB.licenses).find(l => l.orderRef === u.query.ref);
      return send(res, 200, { token: lic ? lic.token : null });
    }

    // ---- DEMO 下单：无需密钥，直接签发演示授权（演示「支付成功→解锁」全链路） ----
    if (p === '/api/checkout/demo' && req.method === 'POST') {
      const b = await readBody(req);
      const token = issueLicense({ email: b.email, plan: b.plan || 'pro', demo: true });
      return send(res, 200, { demo: true, token });
    }

    // ---- Stripe 下单 ----
    if (p === '/api/checkout/stripe' && req.method === 'POST') {
      if (!CFG.stripeSecret) return send(res, 400, { error: '未配置 STRIPE_SECRET_KEY（当前为 DEMO 模式，请用 /api/checkout/demo）' });
      const b = await readBody(req);
      const ref = crypto.randomUUID();
      newOrder(ref, b.email, b.plan || 'pro');
      const sess = await stripeCreateSession(ref, b.email, b.plan || 'pro', CFG.stripePricePro);
      if (sess.url) { DB.orders[ref].checkoutUrl = sess.url; persist(); return send(res, 200, { url: sess.url, ref }); }
      return send(res, 502, { error: 'Stripe 下单失败', detail: sess });
    }

    // ---- 微信下单（Native 扫码） ----
    if (p === '/api/checkout/wechat' && req.method === 'POST') {
      if (!CFG.wechatMchId || !CFG.wechatPrivateKeyPath) return send(res, 400, { error: '未配置微信支付参数（当前为 DEMO 模式）' });
      const b = await readBody(req);
      const plan = b.plan === 'starter' ? 'starter' : 'pro';
      const amount = plan === 'starter' ? CFG.wechatAmountStarter : CFG.wechatAmountPro;
      const ref = crypto.randomUUID();
      newOrder(ref, b.email, plan);
      const r = await wechatCreateOrder(ref, plan, amount, plan === 'starter' ? '入门版' : '正式版');
      if (r.code_url) { DB.orders[ref].codeUrl = r.code_url; persist(); return send(res, 200, { code_url: r.code_url, ref }); }
      return send(res, 502, { error: '微信下单失败', detail: r });
    }

    // ---- Stripe Webhook ----
    if (p === '/api/webhook/stripe' && req.method === 'POST') {
      const sig = req.headers['stripe-signature'] || '';
      let raw = '';
      req.on('data', c => raw += c);
      await new Promise(r => req.on('end', r));
      // 校验签名
      const parts = sig.match(/t=(\d+),v1=(.+)/);
      if (CFG.stripeWebhookSecret && parts) {
        const expected = crypto.createHmac('sha256', CFG.stripeWebhookSecret).update(parts[1] + '.' + raw).digest('hex');
        if (expected !== parts[2]) return send(res, 400, { error: '签名校验失败' });
      }
      const evt = JSON.parse(raw || '{}');
      if (evt.type === 'checkout.session.completed') {
        const ref = evt.data.object.client_reference_id;
        if (DB.orders[ref]) {
          DB.orders[ref].status = 'paid';
          const token = issueLicense({ email: DB.orders[ref].email, plan: DB.orders[ref].plan, demo: false });
          DB.licenses[Object.keys(DB.licenses).pop()].orderRef = ref; // 关联
          persist();
        }
      }
      return send(res, 200, { received: true });
    }

    // ---- 微信支付 Webhook ----
    if (p === '/api/webhook/wechat' && req.method === 'POST') {
      let raw = ''; req.on('data', c => raw += c); await new Promise(r => req.on('end', r));
      // 生产应校验 Wechatpay-Signature（用平台证书 RSA 验签），此处校验存在性
      const evt = JSON.parse(raw || '{}');
      if (evt.resource) {
        try {
          const decrypted = wechatDecryptResource(evt.resource);
          const ref = decrypted.out_trade_no;
          if (DB.orders[ref]) {
            DB.orders[ref].status = 'paid';
            const token = issueLicense({ email: DB.orders[ref].email, plan: DB.orders[ref].plan, demo: false });
            DB.licenses[Object.keys(DB.licenses).pop()].orderRef = ref;
            persist();
          }
        } catch (e) { return send(res, 500, { code: 'FAIL', message: '解密失败' }); }
      }
      return send(res, 200, { code: 'SUCCESS', message: '成功' });
    }

    // ---- 静态收款码：付款登记（人工核对后由管理员签发授权） ----
    if (p === '/api/manual-pay-request' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.contact) return send(res, 400, { ok: false, error: '缺少联系方式' });
      const id = 'M' + Date.now().toString(36).toUpperCase();
      const claimCode = crypto.randomBytes(4).toString('hex').toUpperCase();
      DB.pending[id] = {
        id, plan: b.plan || 'pro',
        contact: String(b.contact).slice(0, 200),
        note: String(b.note || '').slice(0, 500),
        claimCode, status: 'pending', createdAt: new Date().toISOString(),
      };
      persist();
      return send(res, 200, { ok: true, id, claimCode });
    }
    // 用户端：凭领取号查询激活码（审批通过后自动返回，用户无需人工收发）
    if (p === '/api/claim-status' && req.method === 'GET') {
      const rec = Object.values(DB.pending).find(r => r.claimCode === u.query.claim);
      if (!rec) return send(res, 404, { found: false });
      if (rec.status === 'approved' && rec.token) {
        return send(res, 200, { found: true, approved: true, token: rec.token, plan: rec.plan });
      }
      return send(res, 200, { found: true, approved: false, status: rec.status });
    }
    // 管理端：查看付款登记（请求头 x-admin-token；DEMO 未设 ADMIN_TOKEN 时放行便于测试）
    if (p === '/api/manual-pay-requests' && req.method === 'GET') {
      if (!requireAdmin(req)) return send(res, 403, { error: '需要 x-admin-token 请求头' });
      const list = Object.values(DB.pending).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return send(res, 200, { requests: list });
    }
    // 管理端：核对收款后签发正式授权码
    if (p === '/api/manual-pay-approve' && req.method === 'POST') {
      if (!requireAdmin(req)) return send(res, 403, { error: '需要 x-admin-token 请求头' });
      const b = await readBody(req);
      const r = DB.pending[b.id];
      if (!r) return send(res, 404, { error: '登记不存在' });
      if (r.status === 'approved') return send(res, 200, { ok: true, token: r.token, already: true, claimCode: r.claimCode });
      const token = issueLicense({ email: r.contact, plan: r.plan, demo: false });
      r.status = 'approved'; r.token = token; r.approvedAt = new Date().toISOString();
      persist();
      return send(res, 200, { ok: true, token, claimCode: r.claimCode });
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String(e && e.message || e) });
  }
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    fs.writeFileSync(path.join(__dirname, 'ready.txt'), `ready on 127.0.0.1:${PORT} demo=${CFG.demoMode}\n`, 'utf-8');
    console.log(`[talent9] 服务已启动: http://localhost:${PORT}`);
    console.log(`[talent9] 模式: ${CFG.demoMode ? 'DEMO（无需密钥，演示流程）' : '生产（已配置支付密钥）'}`);
    console.log(`[talent9] 提供方: Stripe=${!!CFG.stripeSecret} 微信=${!!CFG.wechatMchId}`);
  });
}
process.on('uncaughtException', e => { try { fs.writeFileSync(path.join(__dirname, 'crash.txt'), 'UNCAUGHT: ' + (e && e.stack || e) + '\n', 'utf-8'); } catch (_) {} });
module.exports = { server, PORT };
