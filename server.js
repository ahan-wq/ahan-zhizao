/* ============================================================
  阿憨植造 · 实景景观设计器 —— 用户系统后端
  ------------------------------------------------------------
  运行：node server.js
  访问：浏览器打开 http://localhost:8080
  局域网（手机/平板）：http://本机IP:8080

  接口一览：
    POST /api/register      {username, password}   注册 → {ok, token, username}
    POST /api/login         {username, password}   登录 → {ok, token, username}
    POST /api/login/wechat  {code}                 微信一键登录（预留，部署后开放）
    GET  /api/me                                   校验登录态 → {ok, username}
    GET  /api/plan                                 获取当前用户云端方案 → {ok, plan}
    PUT  /api/plan         {方案数据}               保存当前用户云端方案 → {ok}

  数据存储（本地文件，无需数据库）：
    data/users.json   用户（密码 scrypt 加盐哈希）
    data/tokens.json  登录令牌
    data/plans/       每个用户一个方案文件

  微信部署指引（后续上架微信时）：
    1. 部署到有公网 IP 的服务器，绑定已备案域名并启用 HTTPS
    2. 设置环境变量 WECHAT_APPID / WECHAT_SECRET
    3. 启用下方 apiWechatLogin 中注释的 code2session 对接代码
    4. 微信小程序内用 web-view 加载你的网页（配置业务域名），
       或用 wx.login() 获取 code 后调用本接口完成微信登录
============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const WECHAT_APPID = process.env.WECHAT_APPID || '';
const WECHAT_SECRET = process.env.WECHAT_SECRET || '';

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');      // 前端普通用户（member）
const ADMINS_FILE = path.join(DATA_DIR, 'admins.json');    // 管理后台管理员（admin，独立账号体系）
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
const PLANS_DIR = path.join(DATA_DIR, 'plans');
const CATS_FILE = path.join(DATA_DIR, 'categories.json');
const MATS_FILE = path.join(DATA_DIR, 'materials.json');
const MATS_DIR = path.join(DATA_DIR, 'materials');
const THUMBS_DIR = path.join(DATA_DIR, 'thumbs');
const CONFIG_FILE = path.join(ROOT, 'config.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PLANS_DIR, { recursive: true });
fs.mkdirSync(MATS_DIR, { recursive: true });
fs.mkdirSync(THUMBS_DIR, { recursive: true });

/* ---------- 管理员账号（独立体系，data/admins.json） ----------
   前端用户（users.json）与管理员（admins.json）完全独立：
   - 前端注册/登录只走 users.json（member）
   - 管理员只存在于 admins.json（admin），可登录前端，也可登录管理后台
   - 普通前端用户无法登录管理后台
   初始化时若 admins.json 为空，自动创建默认管理员 admin / 123456 */
function loadAdmins() { return readJSON(ADMINS_FILE, {}); }
function ensureAdmins() {
  const admins = loadAdmins();
  if (!Object.keys(admins).length) {
    const salt = crypto.randomBytes(16).toString('hex');
    admins['admin'] = { username: 'admin', salt: salt, hash: hashPassword('123456', salt), createdAt: Date.now() };
    writeJSON(ADMINS_FILE, admins);
    console.log('已创建默认管理员：admin / 123456（可登录前端与管理后台）');
  }
}
ensureAdmins();

/* ---------- 配置：管理员账号（可写多个） ----------
   config.json 示例：
   { "adminUsers": ["admin"] }
   名单中的用户名注册时自动获得管理员角色，可进入素材管理后台 */
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { return { adminUsers: ['admin'] }; }
}

/* ================= AI 渲染（写实效果图）接口骨架 =================
   用法（三选一，填好 config.json 的 aiRender 即可）：
   1) 通义万相（阿里云 DashScope，国内直连推荐）
      { "enabled": true, "platform": "tongyi", "apiKey": "sk-xxxxxxxx",
        "model": "wan2.2-t2i-img2img" }   ← 模型名以官方文档为准
      局部编辑（mask 局部重绘）需要编辑模型：
        "editModel": "wanx2.1-imageedit"  ← 以官方文档为准，配置后涂抹区域才会生效
      本实现已含"提交任务 + 轮询结果"，端点默认 DashScope 官方地址。
   2) fal.ai（海外聚合，需可支付外币的账号）
      { "enabled": true, "platform": "fal", "apiKey": "你的FAL_KEY",
        "endpoint": "https://queue.fal.run/fal-ai/flux/dev/image-to-image",
        "editEndpoint": "https://queue.fal.run/fal-ai/flux/dev/image-to-image" }
      带 mask 时自动用 editEndpoint（局部重绘模型），且 body 追加 mask_url。
   3) 其他平台：在 callAIRender 里按平台分支自行扩展。
   注意：图片会发送到第三方 AI 平台，涉及客户场地隐私，正式商用需在
   前端做授权提示并在用户协议中说明。 */
function callAIRender(imageDataURL, prompt, cfg, maskDataURL, n) {
  if (cfg.platform === 'tongyi') return aiRenderTongyi(imageDataURL, prompt, cfg, maskDataURL, n);
  if (cfg.platform === 'fal') return aiRenderFal(imageDataURL, prompt, cfg, maskDataURL, n);
  return Promise.reject(new Error('未支持的 platform："' + cfg.platform + '"（可在 server.js 的 callAIRender 中扩展）'));
}

/* 通义万相：异步任务提交 + 轮询 */
function aiRenderTongyi(imageDataURL, prompt, cfg, maskDataURL, n) {
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey };
  let endpoint = cfg.endpoint || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
  let model = cfg.model || 'wan2.2-t2i-img2img';
  const content = [{ image: imageDataURL, text: prompt }];
  if (maskDataURL) {
    // 局部重绘：需要平台支持蒙版的编辑模型（如 wanx2.1-imageedit），
    // 不同模型的蒙版字段名/接口可能不同，请按官方文档调整此处
    if (!cfg.editModel) return Promise.reject(new Error('当前平台未配置局部编辑模型：请在 config.json 的 aiRender 中填 editModel（如 "wanx2.1-imageedit"）'));
    model = cfg.editModel;
    endpoint = cfg.editEndpoint || endpoint;
    content.push({ mask: maskDataURL, text: '' });
  }
  const body = { model: model, input: { messages: [{ role: 'user', content: content }] } };
  if (n && n > 1) body.parameters = Object.assign(body.parameters || {}, { n: n });
  return fetch(endpoint, { method: 'POST', headers: headers, body: JSON.stringify(body) })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      const taskId = data.output && data.output.task_id;
      if (!taskId) {
        const msg = (data.message && data.message.content) ? data.message.content : JSON.stringify(data).slice(0, 300);
        throw new Error('任务提交失败：' + msg);
      }
      const pollUrl = cfg.taskPollEndpoint || 'https://dashscope.aliyuncs.com/api/v1/tasks/' + taskId;
      return pollTongyi(pollUrl, headers, cfg.maxPolls || 30, cfg.pollIntervalMs || 3000, 0);
    });
}
function pollTongyi(pollUrl, headers, maxPolls, interval, n) {
  return fetch(pollUrl, { headers: headers })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      const out = data.output || {};
      if (out.task_status === 'SUCCEEDED') {
        const results = out.results || [];
        if (!results.length) throw new Error('渲染完成但未返回图片');
        return results.map(function (r) { return r.url; });
      }
      if (out.task_status === 'FAILED' || out.task_status === 'CANCELED') {
        throw new Error('渲染失败：' + (out.message || out.task_status));
      }
      if (n >= maxPolls) throw new Error('渲染超时，请稍后再试');
      return new Promise(function (resolve, reject) {
        setTimeout(function () { pollTongyi(pollUrl, headers, maxPolls, interval, n + 1).then(resolve, reject); }, interval);
      });
    });
}

/* fal.ai：同步返回（部分模型异步则按官方文档改为提交 + 轮询） */
function aiRenderFal(imageDataURL, prompt, cfg, maskDataURL, n) {
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Key ' + cfg.apiKey };
  const endpoint = maskDataURL ? (cfg.editEndpoint || cfg.endpoint) : cfg.endpoint;
  const body = { image_url: imageDataURL, prompt: prompt, image_size: cfg.size || 'landscape_4_3' };
  if (maskDataURL) body.mask_url = maskDataURL;
  if (n && n > 1) body.num_images = n;
  return fetch(endpoint, { method: 'POST', headers: headers, body: JSON.stringify(body) })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      const urls = [];
      if (data.images && data.images.length) { data.images.forEach(function (im) { urls.push(im.url || im); }); }
      else if (data.image && data.image.url) urls.push(data.image.url);
      else if (typeof data.image === 'string') urls.push(data.image);
      if (!urls.length) throw new Error('fal 渲染失败：' + JSON.stringify(data).slice(0, 300));
      return urls;
    });
}

/* 把第三方返回的图片 URL 拉回并转成 base64（避免前端跨域/防盗链） */
function urlToDataURL(url) {
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error('图片下载失败：HTTP ' + r.status);
    return r.arrayBuffer();
  }).then(function (buf) {
    return 'data:image/png;base64,' + Buffer.from(buf).toString('base64');
  });
}
function apiAIRender(imageDataURL, prompt, maskDataURL, n) {
  const cfg = loadConfig().aiRender || {};
  if (!cfg.enabled || !cfg.apiKey) {
    return Promise.resolve({ status: 400, body: { ok: false, message: 'AI 渲染服务尚未配置：请在 config.json 的 aiRender 中填入平台 API Key 并设置 enabled=true（详见 README）' } });
  }
  return callAIRender(imageDataURL, prompt, cfg, maskDataURL, n)
    .then(function (urls) {
      return Promise.all(urls.map(urlToDataURL)).then(function (images) {
        return { status: 200, body: { ok: true, images: images } };
      });
    })
    .catch(function (e) {
      return { status: 500, body: { ok: false, message: e.message || 'AI 渲染失败' } };
    });
}

/* ---------- 存储辅助 ---------- */
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/* ---------- 用户与令牌 ---------- */
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}
function issueToken(username, scope) {
  const tokens = readJSON(TOKENS_FILE, {});
  const token = crypto.randomBytes(24).toString('hex');
  tokens[token] = { username: username, scope: scope || 'user', createdAt: Date.now() };
  writeJSON(TOKENS_FILE, tokens);
  return token;
}
function userByToken(req) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  const tokens = readJSON(TOKENS_FILE, {});
  const rec = tokens[token];
  return rec ? { username: rec.username, scope: rec.scope || 'user' } : null;
}

/* ---------- 接口实现 ---------- */
function apiRegister(username, password) {
  if (!username || !password) return { status: 400, body: { message: '用户名和密码不能为空' } };
  username = String(username).trim();
  if (username.length < 2 || username.length > 20) return { status: 400, body: { message: '用户名需为 2-20 个字符' } };
  if (!/^[\w\u4e00-\u9fa5]+$/.test(username)) return { status: 400, body: { message: '用户名只能包含中文、字母、数字、下划线' } };
  if (String(password).length < 6) return { status: 400, body: { message: '密码至少 6 位' } };
  if (username === 'admin') return { status: 409, body: { message: '该用户名已被注册' } };  // 保留给管理员账号
  const users = readJSON(USERS_FILE, {});
  if (users[username]) return { status: 409, body: { message: '该用户名已被注册' } };
  const salt = crypto.randomBytes(16).toString('hex');
  users[username] = { username: username, salt: salt, hash: hashPassword(password, salt), createdAt: Date.now() };
  writeJSON(USERS_FILE, users);
  return { status: 200, body: { ok: true, token: issueToken(username, 'user'), username: username, role: 'member' } };
}

function apiLogin(username, password) {
  if (!username || !password) return { status: 400, body: { message: '用户名和密码不能为空' } };
  username = String(username).trim();
  // 前端用户
  const users = readJSON(USERS_FILE, {});
  const u = users[username];
  if (u) {
    if (u.hash !== hashPassword(password, u.salt)) return { status: 401, body: { message: '密码错误' } };
    return { status: 200, body: { ok: true, token: issueToken(username, 'user'), username: username, role: 'member' } };
  }
  // 管理员（独立账号体系，可登录前端；登录管理后台同样走此接口）
  const admins = loadAdmins();
  const a = admins[username];
  if (a) {
    if (a.hash !== hashPassword(password, a.salt)) return { status: 401, body: { message: '密码错误' } };
    return { status: 200, body: { ok: true, token: issueToken(username, 'admin'), username: username, role: 'admin' } };
  }
  return { status: 404, body: { message: '用户不存在，请先注册' } };
}

/* 微信一键登录 —— 预留实现
   小程序端：wx.login() 得到 code，POST {code} 到本接口。
   正式部署步骤：
   1. 服务器设置环境变量 WECHAT_APPID / WECHAT_SECRET
   2. 启用下方注释的 code2session 对接代码
   3. 用 openid 查/建用户（users 表增加 openid 字段）并签发 token
   网页端（公众号网页授权）用 OAuth2 的 code 换 openid，逻辑一致 */
function apiWechatLogin(body) {
  if (!WECHAT_APPID || !WECHAT_SECRET) {
    return { status: 501, body: { ok: false, message: '微信登录尚未配置，部署后开放（需设置 WECHAT_APPID / WECHAT_SECRET）' } };
  }
  const code = body && body.code;
  if (!code) return { status: 400, body: { message: '缺少 code 参数' } };
  /* 启用此段代码后即可完成微信登录对接：
  const url = 'https://api.weixin.qq.com/sns/jscode2session' +
    '?appid=' + WECHAT_APPID +
    '&secret=' + WECHAT_SECRET +
    '&js_code=' + encodeURIComponent(code) +
    '&grant_type=authorization_code';
  return fetch(url).then(function (r) { return r.json(); }).then(function (data) {
    if (data.openid) {
      const users = readJSON(USERS_FILE, {});
      let username = Object.keys(users).find(function (k) { return users[k].openid === data.openid; });
      if (!username) {
        username = 'wx_' + data.openid.slice(0, 10);
        users[username] = { username: username, salt: '', hash: '', openid: data.openid, createdAt: Date.now() };
        writeJSON(USERS_FILE, users);
      }
      return { status: 200, body: { ok: true, token: issueToken(username), username: username } };
    }
    return { status: 401, body: { message: '微信登录失败：' + (data.errmsg || 'code 无效') } };
  });
  */
  return { status: 501, body: { ok: false, message: '微信接口对接代码已预留，部署后启用' } };
}

function apiGetPlan(username) {
  const f = path.join(PLANS_DIR, username + '.json');
  try {
    return { status: 200, body: { ok: true, plan: JSON.parse(fs.readFileSync(f, 'utf8')) } };
  } catch (e) {
    return { status: 200, body: { ok: true, plan: null } };
  }
}

function apiSavePlan(username, plan) {
  if (!plan || typeof plan !== 'object') return { status: 400, body: { message: '方案数据格式错误' } };
  fs.writeFileSync(path.join(PLANS_DIR, username + '.json'), JSON.stringify(plan));
  return { status: 200, body: { ok: true } };
}

/* ---------- 素材库：两级分类 + 预设素材 ---------- */
function readCats() { return readJSON(CATS_FILE, []); }
function writeCats(cats) { writeJSON(CATS_FILE, cats); }
function readMats() { return readJSON(MATS_FILE, []); }
function writeMats(mats) { writeJSON(MATS_FILE, mats); }

function isAdmin(req) {
  const who = userByToken(req);
  return !!(who && who.scope === 'admin');
}

function apiUploadMaterials(files) {
  if (!Array.isArray(files) || !files.length) return { status: 400, body: { message: '没有收到图片' } };
  const mats = readMats();
  const added = [];
  for (const f of files) {
    if (!f || !f.data || !f.name) continue;
    // 强制缩略图：所有上传（含替换）必须附带缩略图，杜绝无缩略图素材
    if (!f.thumb) return { status: 400, body: { message: '素材缺少缩略图，无法上传：' + f.name + '（请重新上传）' } };
    const m = f.data.match(/^data:image\/[^;]+;base64,(.+)$/);
    if (!m) continue;
    let id;
    let replaceTarget = null;
    // 替换模式：files[i].replaceId 指向已有素材 id，覆盖其原图与缩略图、保留元数据
    if (f.replaceId) {
      replaceTarget = mats.find(function (x) { return x.id === f.replaceId; });
      if (!replaceTarget) return { status: 404, body: { message: '要替换的素材不存在：' + f.replaceId } };
      id = replaceTarget.id;
    } else {
      id = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }
    try {
      fs.writeFileSync(path.join(MATS_DIR, id + '.png'), Buffer.from(m[1], 'base64'));
    } catch (e) { continue; }
    // 同步生成缩略图（前端上传时附带 thumb 字段；缺失则跳过，客户端会自动回退到原图）
    if (f.thumb) {
      const tm = String(f.thumb).match(/^data:image\/[^;]+;base64,(.+)$/);
      if (tm) {
        try { fs.writeFileSync(path.join(THUMBS_DIR, id + '.png'), Buffer.from(tm[1], 'base64')); } catch (e) {}
      }
    }
    if (replaceTarget) {
      // 替换：保留 id/name/cat/sub/flag，更新宽高
      replaceTarget.w = Math.round(f.w) || replaceTarget.w || 0;
      replaceTarget.h = Math.round(f.h) || replaceTarget.h || 0;
      added.push({ id: id, name: replaceTarget.name, replaced: true });
    } else {
      const mat = {
        id: id,
        name: String(f.name).slice(0, 40),
        cat: f.cat || '', sub: f.sub || '',   // 可选：上传时直接归类
        file: id + '.png',
        w: Math.round(f.w) || 0,
        h: Math.round(f.h) || 0
      };
      mats.push(mat);
      added.push(mat);
    }
  }
  if (!added.length) return { status: 400, body: { message: '图片解析失败' } };
  writeMats(mats);
  return { status: 200, body: { ok: true, added: added } };
}

/* 素材质检标记：ids 批量设置/清除标记
   flag: 'bad' 残次图 | 'redo' 待重做 | '' 清除标记
   note: 可选备注（如重做原因） */
function apiFlagMaterials(ids, flag, note) {
  if (!Array.isArray(ids) || !ids.length) return { status: 400, body: { message: '请先选择素材' } };
  if (flag !== 'bad' && flag !== 'redo' && flag !== '') return { status: 400, body: { message: '标记值无效' } };
  const mats = readMats();
  mats.forEach(function (m) {
    if (ids.indexOf(m.id) !== -1) {
      if (flag) {
        m.flag = flag;
        if (note !== undefined) m.flagNote = String(note).slice(0, 100);
      } else {
        delete m.flag;
        delete m.flagNote;
      }
    }
  });
  writeMats(mats);
  return { status: 200, body: { ok: true } };
}

/* 客户反馈：普通登录用户可对素材提交反馈（存到素材 fbk 数组，管理员后台可见） */
function apiFeedbackMaterial(id, type, note, username) {
  if (!id) return { status: 400, body: { message: '缺少素材ID' } };
  const mats = readMats();
  const m = mats.find(function (x) { return x.id === id; });
  if (!m) return { status: 404, body: { message: '素材不存在' } };
  m.fbk = m.fbk || [];
  m.fbk.push({ u: username, t: Date.now(), type: String(type || '其他').slice(0, 10), note: String(note || '').slice(0, 200) });
  writeMats(mats);
  return { status: 200, body: { ok: true } };
}

function apiCategorizeMaterials(ids, cat, sub) {
  if (!Array.isArray(ids) || !ids.length) return { status: 400, body: { message: '请先选择素材' } };
  const mats = readMats();
  mats.forEach(function (m) {
    if (ids.indexOf(m.id) !== -1) { m.cat = cat || ''; m.sub = sub || ''; }
  });
  writeMats(mats);
  return { status: 200, body: { ok: true } };
}

function apiUpdateMaterial(id, name) {
  const mats = readMats();
  const m = mats.find(function (x) { return x.id === id; });
  if (!m) return { status: 404, body: { message: '素材不存在' } };
  if (name !== undefined) m.name = String(name).slice(0, 40) || m.name;
  writeMats(mats);
  return { status: 200, body: { ok: true } };
}

function apiDeleteMaterials(ids) {
  if (!Array.isArray(ids) || !ids.length) return { status: 400, body: { message: '请先选择素材' } };
  const mats = readMats().filter(function (m) { return ids.indexOf(m.id) === -1; });
  ids.forEach(function (id) {
    try { fs.unlinkSync(path.join(MATS_DIR, id + '.png')); } catch (e) { /* 文件不存在则忽略 */ }
    try { fs.unlinkSync(path.join(THUMBS_DIR, id + '.png')); } catch (e) { /* 缩略图不存在则忽略 */ }
  });
  writeMats(mats);
  return { status: 200, body: { ok: true } };
}

function apiSaveCategories(cats) {
  if (!Array.isArray(cats)) return { status: 400, body: { message: '分类数据格式错误' } };
  writeCats(cats);
  return { status: 200, body: { ok: true } };
}

/* ---------- 用户管理（仅管理员，管理对象=前端普通用户 users.json） ---------- */
function apiListUsers() {
  const users = readJSON(USERS_FILE, {});
  const list = Object.keys(users).map(function (k) {
    return { username: k, role: 'member', createdAt: users[k].createdAt || 0 };
  });
  return { status: 200, body: { ok: true, users: list } };
}

function apiDeleteUser(username, operator) {
  const users = readJSON(USERS_FILE, {});
  if (!users[username]) return { status: 404, body: { message: '用户不存在' } };
  if (username === operator) return { status: 400, body: { message: '不能删除当前登录账号' } };
  delete users[username];
  writeJSON(USERS_FILE, users);
  // 清理该用户的方案与登录令牌
  try { fs.unlinkSync(path.join(PLANS_DIR, username + '.json')); } catch (e) { /* 无方案则忽略 */ }
  const tokens = readJSON(TOKENS_FILE, {});
  Object.keys(tokens).forEach(function (t) { if (tokens[t].username === username) delete tokens[t]; });
  writeJSON(TOKENS_FILE, tokens);
  return { status: 200, body: { ok: true } };
}

/* ---------- HTTP 服务 ---------- */
function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > (limit || 25 * 1024 * 1024)) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

function serveStatic(res, pathname, query) {
  // 素材目录鉴权（防直接下载原图/缩略图）：必须携带有效 token
  if (pathname.indexOf('/data/materials/') === 0 || pathname.indexOf('/data/thumbs/') === 0) {
    const tk = (query && query.get('token')) || '';
    const tokens = readJSON(TOKENS_FILE, {});
    if (!tk || !tokens[tk]) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden: login required');
      return;
    }
  }
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.replace(/^\//, ''));
  const filePath = path.resolve(ROOT, rel);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    // 强制不缓存：HTML/JS/CSS 每次拉取最新（否则手机浏览器会缓存旧页面导致迭代不生效）
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(payload);
}

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  function handle() {
    // 用户接口
    if (p === '/api/register' && req.method === 'POST') {
      return readBody(req, 64 * 1024).then(function (b) {
        const r = apiRegister(b.username, b.password);
        send(res, r.status, r.body);
      });
    }
    if (p === '/api/login' && req.method === 'POST') {
      return readBody(req, 64 * 1024).then(function (b) {
        const r = apiLogin(b.username, b.password);
        send(res, r.status, r.body);
      });
    }
    if (p === '/api/login/wechat' && req.method === 'POST') {
      return readBody(req, 64 * 1024).then(function (b) {
        const r = apiWechatLogin(b);
        send(res, r.status, r.body);
      });
    }
    if (p === '/api/me' && req.method === 'GET') {
      const who = userByToken(req);
      if (!who) return send(res, 401, { message: '未登录或登录已过期' });
      const role = who.scope === 'admin' ? 'admin' : 'member';
      return send(res, 200, { ok: true, username: who.username, role: role });
    }
    // 素材库
    if (p === '/api/materials' && req.method === 'GET') {
      if (!userByToken(req)) return send(res, 401, { message: '未登录或登录已过期' });
      return send(res, 200, { ok: true, cats: readCats(), mats: readMats() });
    }
    if (p === '/api/materials/upload' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { message: '仅管理员可上传素材' });
      return readBody(req, 32 * 1024 * 1024).then(function (b) {
        const r = apiUploadMaterials(b.files);
        send(res, r.status, r.body);
      });
    }
    if (p === '/api/materials/categorize' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { message: '仅管理员可操作素材' });
      return readBody(req).then(function (b) {
        const r = apiCategorizeMaterials(b.ids, b.cat, b.sub);
        send(res, r.status, r.body);
      });
    }
    if (p === '/api/materials/update' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { message: '仅管理员可操作素材' });
      return readBody(req).then(function (b) {
        const r = apiUpdateMaterial(b.id, b.name);
        send(res, r.status, r.body);
      });
    }
    if (p === '/api/materials/delete' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { message: '仅管理员可操作素材' });
      return readBody(req).then(function (b) {
        const r = apiDeleteMaterials(b.ids);
        send(res, r.status, r.body);
      });
    }
    if (p === '/api/materials/flag' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { message: '仅管理员可标记素材' });
      return readBody(req).then(function (b) {
        const r = apiFlagMaterials(b.ids, b.flag, b.note);
        send(res, r.status, r.body);
      });
    }
    if (p === '/api/materials/feedback' && req.method === 'POST') {
      const who = userByToken(req);
      if (!who) return send(res, 401, { message: '请先登录' });
      return readBody(req).then(function (b) {
        const r = apiFeedbackMaterial(b.id, b.type, b.note, who.username);
        send(res, r.status, r.body);
      });
    }
    if (p === '/api/categories/save' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { message: '仅管理员可操作分类' });
      return readBody(req).then(function (b) {
        const r = apiSaveCategories(b.cats);
        send(res, r.status, r.body);
      });
    }
    // 用户管理
    if (p === '/api/users' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 403, { message: '仅管理员可查看用户' });
      const r = apiListUsers();
      return send(res, r.status, r.body);
    }
    if (p === '/api/users/delete' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { message: '仅管理员可删除用户' });
      return readBody(req).then(function (b) {
        const who = userByToken(req);
        const r = apiDeleteUser(b.username, who ? who.username : '');
        send(res, r.status, r.body);
      });
    }
    // AI 渲染（写实效果图）：登录用户可用，按张调用第三方 AI 出图；支持 mask 局部重绘、n 多图
    if (p === '/api/ai-render' && req.method === 'POST') {
      if (!userByToken(req)) return send(res, 401, { message: '请先登录' });
      return readBody(req).then(function (b) {
        if (!b.image || typeof b.image !== 'string') return send(res, 400, { message: '缺少图片数据' });
        if (!b.prompt || typeof b.prompt !== 'string') return send(res, 400, { message: '缺少渲染描述' });
        if (b.prompt.length > 500) return send(res, 400, { message: '描述请控制在 500 字以内' });
        const n = Math.min(parseInt(b.n, 10) || 1, 4);
        return apiAIRender(b.image, b.prompt, b.mask, n).then(function (r) {
          send(res, r.status, r.body);
        });
      });
    }
    if (p === '/api/plan' && req.method === 'GET') {
      const who = userByToken(req);
      if (!who) return send(res, 401, { message: '未登录或登录已过期' });
      const r = apiGetPlan(who.username);
      return send(res, r.status, r.body);
    }
    if (p === '/api/plan' && req.method === 'PUT') {
      const who = userByToken(req);
      if (!who) return send(res, 401, { message: '未登录或登录已过期' });
      return readBody(req).then(function (b) {
        const r = apiSavePlan(who.username, b);
        send(res, r.status, r.body);
      });
    }
    // 静态资源
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(res, p, url.searchParams);
    send(res, 405, { message: 'Method Not Allowed' });
  }

  Promise.resolve(handle()).catch(function (err) {
    if (err.message === 'bad json') return send(res, 400, { message: '请求体不是合法 JSON' });
    if (err.message === 'body too large') return send(res, 413, { message: '数据过大' });
    console.error(err);
    send(res, 500, { message: '服务器内部错误' });
  });
});

server.listen(PORT, function () {
  console.log('阿憨植造服务已启动：http://localhost:' + PORT);
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach(function (k) {
    nets[k].forEach(function (n) {
      if (n.family === 'IPv4' && !n.internal) console.log('局域网访问（手机/平板）：http://' + n.address + ':' + PORT);
    });
  });
});
