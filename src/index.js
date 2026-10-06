import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import { WebSocketServer } from 'ws';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3001);
const wsPath = process.env.WS_PATH || '/onebot/v11/ws';
const accessToken = process.env.ONEBOT_ACCESS_TOKEN || '';
const projectDir = path.resolve(process.env.PROJECT_DIR || process.cwd());
const allowedUsers = new Set((process.env.ALLOWED_USER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean));
const allowedGroups = new Set((process.env.ALLOWED_GROUP_IDS || '').split(',').map((id) => id.trim()).filter(Boolean));
const botId = process.env.BOT_QQ_ID || '';
const maxPromptChars = Number(process.env.MAX_PROMPT_CHARS || 6000);
const configuredDedupWindow = Number(process.env.MESSAGE_DEDUP_WINDOW_MS);
const messageDedupWindowMs = Number.isFinite(configuredDedupWindow) && configuredDedupWindow > 0
  ? configuredDedupWindow : 45 * 1000;
const configuredBatchWindow = Number(process.env.MESSAGE_BATCH_WINDOW_MS);
const messageBatchWindowMs = Number.isFinite(configuredBatchWindow) && configuredBatchWindow > 0
  ? configuredBatchWindow : 4 * 1000;
const configuredImageBatchWindow = Number(process.env.MESSAGE_IMAGE_BATCH_WINDOW_MS);
const messageImageBatchWindowMs = Number.isFinite(configuredImageBatchWindow) && configuredImageBatchWindow > 0
  ? configuredImageBatchWindow : 12 * 1000;
const codexModel = process.env.CODEX_MODEL?.trim() || '';
const codexReasoningEffort = process.env.CODEX_REASONING_EFFORT?.trim() || '';
const codexCommand = process.env.CODEX_BIN?.trim() || 'codex';
const chatBackend = (process.env.CHAT_BACKEND?.trim().toLowerCase() || 'codex');
if (!['codex', 'dsh', 'official'].includes(chatBackend)) {
  throw new Error(`Unsupported CHAT_BACKEND: ${chatBackend}. Use codex, dsh, or official.`);
}
const dshCommand = process.env.CHAT_DSH_BIN?.trim() || 'dsh';
const dshProfile = process.env.CHAT_DSH_PROFILE?.trim() || 'headless';
const dshHome = process.env.CHAT_DSH_HOME?.trim() || '';
const dshPatch = process.env.CHAT_DSH_PATCH?.trim() || '';
const deepseekApiKey = process.env.DEEPSEEK_API_KEY?.trim() || '';
const deepseekBaseUrl = (process.env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com').replace(/\/$/, '');
const deepseekModel = process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-chat';
const deepseekReasoningEffort = process.env.DEEPSEEK_REASONING_EFFORT?.trim() || '';
const configuredDeepseekMaxTokens = Number(process.env.DEEPSEEK_MAX_TOKENS);
const deepseekMaxTokens = Number.isFinite(configuredDeepseekMaxTokens) && configuredDeepseekMaxTokens > 0
  ? configuredDeepseekMaxTokens : 4096;
const configuredCodexTimeout = Number(process.env.CODEX_TIMEOUT_MS);
const codexTimeoutMs = Number.isFinite(configuredCodexTimeout) && configuredCodexTimeout > 0
  ? configuredCodexTimeout : 10 * 60 * 1000;
const defaultPersona = process.env.DEFAULT_PERSONA
  || '你是一个友好、理性、可靠的 QQ 助手。请简洁清楚地回答问题，保持事实准确。';
const dataDir = path.resolve('data');
const sessionsFile = path.join(dataDir, 'sessions.json');
const officialSessionsFile = path.join(dataDir, 'official_sessions.json');
const localStickersDir = path.join(dataDir, 'stickers');
const localStickersFile = path.join(dataDir, 'stickers.json');
const recentPrompts = new Map();
const pendingMessageBatches = new Map();
const holidayGreetingsSent = new Map();
const lastWelcomeByGroup = new Map();
const favoriteStickerCache = new WeakMap();
const welcomeGreetings = [
  '欢迎加入！请先阅读群公告，祝你交流愉快。',
  '欢迎新朋友，期待和你一起交流。',
];
const holidayGreetings = new Map([
  ['01-01', ['元旦快乐，祝大家新的一年平安顺利！']],
  ['02-14', ['情人节快乐，愿大家收获温暖与关心。']],
  ['03-08', ['妇女节快乐，祝每一位女性自在、自信。']],
  ['05-01', ['劳动节快乐，辛苦了，好好休息！']],
  ['06-01', ['儿童节快乐，愿大家保持好奇心。']],
  ['09-10', ['教师节快乐，感谢每一位老师的付出。']],
  ['10-01', ['国庆快乐，祝大家假期愉快！']],
  ['12-25', ['圣诞快乐，愿大家度过温暖的一天。']],
]);

if (allowedUsers.size === 0 && allowedGroups.size === 0) {
  throw new Error('Set ALLOWED_USER_IDS or ALLOWED_GROUP_IDS in .env before starting.');
}
if (chatBackend === 'official' && !deepseekApiKey) {
  throw new Error('Set DEEPSEEK_API_KEY when CHAT_BACKEND=official.');
}
await mkdir(dataDir, { recursive: true });
await mkdir(localStickersDir, { recursive: true });
let localStickers = [];
try {
  localStickers = JSON.parse(await readFile(localStickersFile, 'utf8'));
  if (!Array.isArray(localStickers)) localStickers = [];
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
async function saveLocalStickers() {
  await writeFile(localStickersFile, JSON.stringify(localStickers, null, 2), { mode: 0o600 });
}
let sessions = {};
try {
  sessions = JSON.parse(await readFile(sessionsFile, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
let officialHistories = {};
try {
  officialHistories = JSON.parse(await readFile(officialSessionsFile, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

async function saveSessions() {
  await writeFile(sessionsFile, JSON.stringify(sessions, null, 2), { mode: 0o600 });
}

async function saveOfficialHistories() {
  await writeFile(officialSessionsFile, JSON.stringify(officialHistories, null, 2), { mode: 0o600 });
}

function backendName() {
  if (chatBackend === 'dsh') return 'dsh';
  if (chatBackend === 'official') return 'DeepSeek 官方 API';
  return 'Codex';
}

let oneBotSocket = null;

function localStickerEntries() {
  return localStickers.map((sticker) => ({
    id: sticker.id,
    name: sticker.name,
    file: path.resolve(sticker.file),
    local: true,
  }));
}

function officialVersionLabel() {
  return `当前使用的模型：DeepSeek 官方 API / ${deepseekModel}${deepseekReasoningEffort ? `，推理强度：${deepseekReasoningEffort}` : ''}`;
}

const editableEnvKeys = [
  'HOST', 'PORT', 'WS_PATH', 'ONEBOT_ACCESS_TOKEN', 'ALLOWED_USER_IDS', 'ALLOWED_GROUP_IDS', 'BOT_QQ_ID',
  'CHAT_BACKEND', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'DEEPSEEK_REASONING_EFFORT',
  'DEEPSEEK_MAX_TOKENS', 'CHAT_DSH_BIN', 'CHAT_DSH_PROFILE', 'CHAT_DSH_HOME', 'CHAT_DSH_PATCH', 'PROJECT_DIR',
  'MAX_PROMPT_CHARS', 'MESSAGE_DEDUP_WINDOW_MS', 'MESSAGE_BATCH_WINDOW_MS', 'MESSAGE_IMAGE_BATCH_WINDOW_MS',
  'CODEX_MODEL', 'CODEX_REASONING_EFFORT', 'CODEX_BIN', 'CODEX_TIMEOUT_MS', 'DEFAULT_PERSONA',
];

function envValueForApi(key) {
  const value = process.env[key] || '';
  if (key === 'ONEBOT_ACCESS_TOKEN' || key === 'DEEPSEEK_API_KEY') {
    return { configured: Boolean(value), value: '' };
  }
  return { configured: Boolean(value), value };
}

function publicConfig() {
  return Object.fromEntries(editableEnvKeys.map((key) => [key, envValueForApi(key)]));
}

function envEncode(value) {
  const text = String(value ?? '').replace(/[\r\n]/g, ' ').trim();
  if (!text) return '';
  if (/^[A-Za-z0-9_./:@%+,=-]+$/.test(text)) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function saveWebConfig(payload) {
  const current = {};
  try {
    const source = await readFile(path.resolve('.env'), 'utf8');
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (match) current[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const key of editableEnvKeys) {
    if (key === 'ONEBOT_ACCESS_TOKEN' || key === 'DEEPSEEK_API_KEY') {
      if (typeof payload[key] === 'string' && payload[key].trim()) current[key] = payload[key].trim();
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(payload, key)) current[key] = String(payload[key] ?? '').trim();
  }
  if (!['codex', 'dsh', 'official'].includes(String(current.CHAT_BACKEND || 'codex').toLowerCase())) {
    throw new Error('CHAT_BACKEND 必须是 codex、dsh 或 official。');
  }
  if (!String(current.ALLOWED_USER_IDS || '').trim() && !String(current.ALLOWED_GROUP_IDS || '').trim()) {
    throw new Error('至少填写一个允许使用机器人的 QQ 用户或群号。');
  }
  const output = [
    '# Generated by the local QQ chat bridge settings page.',
    '# Keep this file private. It contains local access settings and may contain API keys.',
    ...editableEnvKeys.map((key) => `${key}=${envEncode(current[key] || '')}`),
    '',
  ].join('\n');
  await writeFile(path.resolve('.env'), output, { mode: 0o600 });
}

function jsonResponse(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

async function handleHttpRequest(req, res) {
  try {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (requestUrl.pathname === '/api/stickers' && req.method === 'GET') {
      const qqStickers = oneBotSocket ? await getFavoriteStickers(oneBotSocket, true) : [];
      jsonResponse(res, 200, {
        onebotConnected: Boolean(oneBotSocket),
        canReadQq: Boolean(oneBotSocket),
        canAddToQq: false,
        limitation: 'OneBot v11/NapCat 没有通用的加入 QQ 收藏表情 API。电脑上传的图片会保存到本地 agent 表情库。',
        qq: qqStickers,
        local: localStickers.map((sticker) => ({ ...sticker, preview: `/sticker-files/${path.basename(sticker.file)}` })),
      });
      return;
    }
    if (requestUrl.pathname === '/api/stickers/upload' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 25 * 1024 * 1024) throw new Error('图片请求过大，不能超过 20 MB。');
      }
      const payload = JSON.parse(body);
      const match = String(payload.data || '').match(/^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,([A-Za-z0-9+/=]+)$/i);
      if (!match) throw new Error('只支持 PNG、JPG、GIF 或 WebP 图片。');
      const name = String(payload.name || '未命名表情').trim().slice(0, 80) || '未命名表情';
      const extension = match[1].includes('png') ? 'png' : match[1].includes('gif') ? 'gif' : match[1].includes('webp') ? 'webp' : 'jpg';
      const id = `local-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const file = path.join(localStickersDir, `${id}.${extension}`);
      const buffer = Buffer.from(match[2], 'base64');
      if (buffer.length > 15 * 1024 * 1024) throw new Error('图片过大，单张不能超过 15 MB。');
      await writeFile(file, buffer, { mode: 0o600 });
      const entry = { id, name, file: path.relative(process.cwd(), file), createdAt: new Date().toISOString() };
      localStickers.push(entry);
      await saveLocalStickers();
      jsonResponse(res, 200, { ok: true, sticker: entry });
      return;
    }
    if (requestUrl.pathname.startsWith('/sticker-files/') && req.method === 'GET') {
      const name = requestUrl.pathname.slice('/sticker-files/'.length);
      if (!/^[A-Za-z0-9_.-]+$/.test(name)) { res.writeHead(404); res.end('Not found'); return; }
      const file = path.join(localStickersDir, name);
      const content = await readFile(file);
      const type = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp' }[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(content); return;
    }
    if (requestUrl.pathname === '/api/config' && req.method === 'GET') {
      jsonResponse(res, 200, { config: publicConfig(), running: { backend: chatBackend, port, wsPath } });
      return;
    }
    if (requestUrl.pathname === '/api/models' && req.method === 'GET') {
      const models = await getAvailableModels();
      jsonResponse(res, 200, { backend: chatBackend, models });
      return;
    }
    if (requestUrl.pathname === '/api/config' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024 * 1024) throw new Error('配置请求过大。');
      }
      await saveWebConfig(JSON.parse(body));
      jsonResponse(res, 200, { ok: true, message: '配置已保存。点击重启后生效。' });
      return;
    }
    if (requestUrl.pathname === '/api/restart' && req.method === 'POST') {
      jsonResponse(res, 200, { ok: true, message: '桥接服务正在重启。' });
      setTimeout(() => {
        const child = spawn(process.execPath, process.argv.slice(1), {
          cwd: process.cwd(), env: process.env, detached: true, stdio: 'ignore',
        });
        child.unref();
        process.exit(0);
      }, 250);
      return;
    }
    if (requestUrl.pathname === '/api/health' && req.method === 'GET') {
      jsonResponse(res, 200, { ok: true, backend: chatBackend, websocket: `ws://${host}:${port}${wsPath}` });
      return;
    }
    if (req.method !== 'GET' || requestUrl.pathname === '/onebot/v11/ws') {
      res.writeHead(404); res.end('Not found'); return;
    }
    const relative = requestUrl.pathname === '/' ? 'index.html' : requestUrl.pathname.slice(1);
    if (!/^[-a-zA-Z0-9_./]+$/.test(relative) || relative.includes('..')) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const file = path.resolve('web', relative);
    if (!file.startsWith(`${path.resolve('web')}${path.sep}`)) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const content = await readFile(file);
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(content);
  } catch (error) {
    jsonResponse(res, 400, { ok: false, error: error.message || '请求失败。' });
  }
}

const httpServer = createServer(handleHttpRequest);
const wss = new WebSocketServer({
  server: httpServer,
  path: wsPath,
  verifyClient: ({ req }, done) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const suppliedToken = req.headers.authorization?.replace(/^Bearer\s+/i, '')
      || req.headers['x-client-token']
      || requestUrl.searchParams.get('access_token')
      || requestUrl.searchParams.get('access-token');
    if (accessToken && suppliedToken !== accessToken) return done(false, 401, 'Unauthorized');
    done(true);
  },
});

const locks = new Map();
const apiRequests = new Map();

function sendMessage(ws, event, text) {
  if (ws.readyState !== ws.OPEN) return;
  const isGroup = event.message_type === 'group';
  const params = isGroup
    ? { message_type: 'group', group_id: event.group_id, message: toOneBotMessage(text) }
    : { message_type: 'private', user_id: event.user_id, message: toOneBotMessage(text) };
  ws.send(JSON.stringify({ action: 'send_msg', params, echo: `reply-${Date.now()}` }));
}

function toOneBotMessage(text) {
  const value = String(text || '');
  const pattern = /\[CQ:(face|at|mface),([^\]]+)\]/gi;
  if (!pattern.test(value)) return value;
  pattern.lastIndex = 0;
  const message = [];
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const type = match[1].toLowerCase();
    if (type === 'mface') {
      const data = {};
      for (const part of match[2].split(',')) {
        const separator = part.indexOf('=');
        if (separator < 1) continue;
        data[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
      }
      if (!data.emoji_id || !data.emoji_package_id || !data.key) continue;
      if (match.index > cursor) message.push({ type: 'text', data: { text: value.slice(cursor, match.index) } });
      message.push({ type: 'mface', data: {
        emoji_id: data.emoji_id,
        emoji_package_id: data.emoji_package_id,
        key: data.key,
        summary: data.summary || '收藏表情',
      } });
      cursor = match.index + match[0].length;
      continue;
    }
    const key = type === 'face' ? 'id' : 'qq';
    const id = match[2].match(new RegExp(`(?:^|,)${key}=(\\d+)(?:,|$)`, 'i'))?.[1];
    if (!id) continue;
    if (match.index > cursor) message.push({ type: 'text', data: { text: value.slice(cursor, match.index) } });
    message.push({ type, data: { [key]: id } });
    cursor = match.index + match[0].length;
  }
  if (cursor < value.length) message.push({ type: 'text', data: { text: value.slice(cursor) } });
  return message.length ? message : value;
}

function sendImage(ws, event, file) {
  if (ws.readyState !== ws.OPEN) return;
  const target = event.message_type === 'group'
    ? { message_type: 'group', group_id: event.group_id }
    : { message_type: 'private', user_id: event.user_id };
  ws.send(JSON.stringify({
    action: 'send_msg',
    params: { ...target, message: [{ type: 'image', data: { file } }] },
    echo: `reply-${Date.now()}`,
  }));
}

function sendSticker(ws, event, sticker) {
  if (ws.readyState !== ws.OPEN) return;
  const target = event.message_type === 'group'
    ? { message_type: 'group', group_id: event.group_id }
    : { message_type: 'private', user_id: event.user_id };
  const hasNativeFace = sticker.emojiId && sticker.packageId && sticker.key;
  const segment = hasNativeFace
    ? { type: 'mface', data: {
      emoji_id: sticker.emojiId,
      emoji_package_id: Number(sticker.packageId),
      key: sticker.key,
      summary: sticker.name || '收藏表情',
    } }
    : { type: 'image', data: { file: sticker.url || sticker.file } };
  if (!segment.data.file && !hasNativeFace) return;
  ws.send(JSON.stringify({
    action: 'send_msg',
    params: { ...target, message: [segment] },
    echo: `sticker-${Date.now()}`,
  }));
}

function shanghaiDateParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

function shanghaiDateLabel() {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  }).format(new Date());
}

function shanghaiTimeLabel() {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date());
}

function shanghaiDateTimeLabel() {
  return `${shanghaiDateLabel()} ${shanghaiTimeLabel()}`;
}

function pickRandom(items, previous = '') {
  const candidates = items.filter((item) => item !== previous);
  return candidates[Math.floor(Math.random() * candidates.length)] || items[0];
}

function sendHolidayGreetingIfNeeded(ws, event) {
  if (event.message_type !== 'group') return;
  const { year, month, day } = shanghaiDateParts();
  const greetings = holidayGreetings.get(`${month}-${day}`);
  if (!greetings) return;
  const key = `${event.group_id}:${year}-${month}-${day}`;
  if (holidayGreetingsSent.has(key)) return;
  holidayGreetingsSent.set(key, true);
  sendMessage(ws, event, pickRandom(greetings));
}

function handleNotice(ws, event) {
  if (event.post_type !== 'notice' || event.notice_type !== 'group_increase') return;
  const groupId = String(event.group_id || '');
  const userId = String(event.user_id || '');
  if (!groupId || !userId || !allowedGroups.has(groupId) || userId === botId) return;
  const newcomer = event.card || event.nickname || `QQ ${userId}`;
  const previous = lastWelcomeByGroup.get(groupId) || '';
  const welcome = pickRandom(welcomeGreetings, previous);
  lastWelcomeByGroup.set(groupId, welcome);
  sendMessage(ws, { ...event, message_type: 'group', group_id: event.group_id },
    `[CQ:at,qq=${userId}] ${welcome}`);
  console.log(`Welcomed new group member ${newcomer} (${userId}) in ${groupId}.`);
}

async function sendAgentResponse(ws, event, text, stickerEntries = []) {
  const stickerIds = [...String(text).matchAll(/^STICKER_ID:\s*(\S+)\s*$/gim)]
    .map((match) => match[1].trim());
  const imagePaths = [...text.matchAll(/^IMAGE_PATH:\s*(.+)$/gim)]
    .map((match) => match[1].trim().replace(/^['"]|['"]$/g, ''))
    .filter((file) => /\.(png|jpe?g|webp|gif)$/i.test(file));
  const validImages = [];
  for (const file of imagePaths) {
    const absolute = path.resolve(file);
    if (!absolute.startsWith(`${projectDir}${path.sep}`)) continue;
    try {
      const info = await stat(absolute);
      if (info.isFile() && info.size <= 15 * 1024 * 1024) validImages.push(absolute);
    } catch {
      // Ignore paths that the backend reported but did not create.
    }
  }
  const stickerById = new Map(stickerEntries.map((sticker) => [sticker.id, sticker]));
  const validStickers = stickerIds.map((id) => stickerById.get(id))
    .filter((sticker) => sticker && (sticker.url || sticker.file || (sticker.emojiId && sticker.packageId && sticker.key)));
  const textWithoutPaths = text
    .replace(/^IMAGE_PATH:\s*.+$/gim, '')
    .replace(/^STICKER_ID:\s*\S+\s*$/gim, '')
    .trim();
  if (textWithoutPaths) for (const chunk of splitMessage(textWithoutPaths)) sendMessage(ws, event, chunk);
  for (const file of validImages) sendImage(ws, event, file);
  for (const sticker of validStickers) sendSticker(ws, event, sticker);
  if (!textWithoutPaths && validImages.length === 0 && validStickers.length === 0) {
    sendMessage(ws, event, '（没有收到文本或图片回复）');
  }
}

function callOneBot(ws, action, params) {
  const echo = `api-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      apiRequests.delete(echo);
      reject(new Error(`OneBot API 超时：${action}`));
    }, 10000);
    apiRequests.set(echo, { resolve: (data) => { clearTimeout(timer); resolve(data); }, reject });
    ws.send(JSON.stringify({ action, params, echo }));
  });
}

function normalizeFavoriteSticker(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.emoji_id || raw.emojiId || raw.res_id || raw.resId || raw.id || '').trim();
  if (!id) return null;
  return {
    id,
    name: String(raw.desc || raw.summary || raw.name || '').trim(),
    url: String(raw.url || raw.image_url || '').trim(),
    file: String(raw.file || raw.path || '').trim(),
    emojiId: String(raw.emoji_id || raw.emojiId || '').trim(),
    packageId: String(raw.emoji_package_id || raw.emojiPackageId || raw.package_id || raw.packageId || '').trim(),
    key: String(raw.key || raw.emojiKey || '').trim(),
  };
}

async function getFavoriteStickers(ws, force = false) {
  const cached = favoriteStickerCache.get(ws);
  if (!force && cached && Date.now() - cached.at < 60 * 1000) return cached.items;
  try {
    const result = await callOneBot(ws, 'fetch_custom_face_detail', { count: 100 });
    const raw = result?.data || result;
    const items = (Array.isArray(raw) ? raw : []).map(normalizeFavoriteSticker).filter(Boolean);
    favoriteStickerCache.set(ws, { at: Date.now(), items });
    return items;
  } catch (error) {
    console.warn(`无法读取 QQ 收藏表情：${error.message}`);
    const items = cached?.items || [];
    favoriteStickerCache.set(ws, { at: Date.now(), items });
    return items;
  }
}

function favoriteStickerPrompt(items) {
  if (!items.length) return '';
  const lines = items.slice(0, 100).map((item) => `- ${item.id}${item.name ? `：${item.name}` : ''}`);
  return `\n\n可用的 QQ 收藏表情：\n${lines.join('\n')}\n如果适合发送收藏表情，只能从上面的 ID 中选择，并单独输出一行 STICKER_ID: <ID>；桥接会把它作为单独的收藏表情发送。不要虚构 ID，不要把文字和 STICKER_ID 写在同一行。`;
}

function favoriteStickerSegments(segments) {
  return segments.filter((segment) => (segment?.type === 'image' || segment?.type === 'mface') && segment.data?.emoji_id)
    .map((segment) => {
      const name = segment.data?.summary || '未命名';
      return `[收藏表情：${name}]`;
    });
}

async function resolveImageSources(ws, sources) {
  const resolved = [];
  for (const source of sources) {
    const file = String(source.file || '').trim();
    const url = String(source.url || '').trim();
    const candidates = [];
    if (file && !/^https?:\/\//i.test(file)) {
      if (path.isAbsolute(file)) candidates.push(file);
      else {
        try {
          const result = await callOneBot(ws, 'get_image', { file });
          const image = result?.data || result;
          const values = [image?.file, image?.path, image?.url].filter((value) => typeof value === 'string');
          candidates.push(...values.filter((value) => path.isAbsolute(value)));
          candidates.push(...values.filter((value) => /^https?:\/\//i.test(value)));
        } catch (error) {
          console.warn(`NapCat get_image 失败：${error.message}`);
        }
      }
    }
    if (/^https?:\/\//i.test(file)) candidates.push(file);
    if (/^https?:\/\//i.test(url)) candidates.push(url);
    if (candidates.length) resolved.push([...new Set(candidates)]);
    else throw new Error('NapCat 没有返回可用的图片路径或链接。');
  }
  return resolved;
}

function messageSegmentsToText(message) {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  return message.map((segment) => {
    if (segment?.type === 'text') return segment.data?.text || '';
    if (segment?.type === 'mface') return `[收藏表情：${segment.data?.summary || '未命名'}]`;
    if (segment?.type === 'image') {
      return segment.data?.emoji_id
        ? `[收藏表情：${segment.data?.summary || '未命名'}]`
        : '[图片]';
    }
    if (segment?.type === 'at') return `[提及 ${segment.data?.qq || '某人'}]`;
    return segment?.type ? `[${segment.type}]` : '';
  }).join('').trim();
}

function mentionedUserIds(event, segments) {
  const ids = [];
  for (const segment of segments) {
    if (segment?.type === 'at' && segment.data?.qq != null) ids.push(String(segment.data.qq));
  }
  for (const match of String(event.raw_message || '').matchAll(/\[CQ:at,[^\]]*?qq=([^,\]]+)/gi)) {
    ids.push(String(match[1]));
  }
  return new Set(ids);
}

function memberLabel(member, fallbackId = '') {
  if (!member) return fallbackId ? `QQ ${fallbackId}` : '未知成员';
  const id = member.user_id ?? fallbackId;
  const name = member.card || member.nickname;
  if (name && id != null) return `${name}（QQ ${id}）`;
  if (name) return String(name);
  return id != null ? `QQ ${id}` : '未知成员';
}

function groupMemberContext(event, segments) {
  if (event.message_type !== 'group') return '';
  const sender = event.sender || { user_id: event.user_id };
  const role = sender.role === 'owner' ? '群主' : sender.role === 'admin' ? '管理员' : '成员';
  const mentioned = [...mentionedUserIds(event, segments)].filter((id) => id !== botId);
  const lines = [
    `群号：${event.group_id}`,
    `发送者：${memberLabel(sender, event.user_id)}`,
    `群身份：${role}`,
  ];
  if (mentioned.length) lines.push(`被@成员 QQ：${mentioned.join('、')}`);
  return `\n\n群成员信息：\n${lines.join('\n')}`;
}

function formatGroupMembers(members) {
  const roleWeight = { owner: 0, admin: 1, member: 2 };
  const roleName = { owner: '群主', admin: '管理员', member: '成员' };
  const sorted = [...members].sort((a, b) =>
    (roleWeight[a.role] ?? 2) - (roleWeight[b.role] ?? 2)
      || String(a.card || a.nickname || a.user_id).localeCompare(String(b.card || b.nickname || b.user_id), 'zh-CN'));
  return sorted.map((member, index) => {
    const name = member.card && member.nickname && member.card !== member.nickname
      ? `${member.card}（${member.nickname}）`
      : member.card || member.nickname || '未设置昵称';
    return `${index + 1}. ${name} | QQ ${member.user_id} | ${roleName[member.role] || '成员'}`;
  });
}

async function getReplyContext(ws, event, segments) {
  const replySegment = segments.find((segment) => segment?.type === 'reply');
  const rawReplyId = String(event.raw_message || '').match(/\[CQ:reply,id=([^,\]]+)/i)?.[1];
  const replyId = event.reply?.message_id || replySegment?.data?.id || rawReplyId;
  if (!replyId) return { text: '', userId: '' };
  let reply = event.reply;
  if (!reply) {
    try {
      const result = await callOneBot(ws, 'get_msg', { message_id: Number(replyId) || replyId });
      reply = result?.data || result;
    } catch (error) {
      console.warn(`无法读取引用消息 ${replyId}: ${error.message}`);
    }
  }
  const quoted = messageSegmentsToText(reply?.message);
  const replyUserId = reply?.sender?.user_id ?? reply?.user_id;
  const text = quoted ? `\n\n引用的消息：\n${quoted}` : `\n\n引用消息 ID：${replyId}`;
  return { text, userId: replyUserId == null ? '' : String(replyUserId) };
}

function splitMessage(text, limit = 1500) {
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    const addition = current ? `\n${line}` : line;
    if (current.length + addition.length > limit && current) {
      chunks.push(current);
      current = '';
    }
    for (let offset = 0; offset < line.length; offset += limit) {
      const part = line.slice(offset, offset + limit);
      if (current && current.length + part.length > limit) {
        chunks.push(current);
        current = '';
      }
      current += (current ? '\n' : '') + part;
      if (offset + limit < line.length) {
        chunks.push(current);
        current = '';
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : ['（没有收到文本回复）'];
}

function normalizePromptForComparison(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\[cq:[^\]]+\]/gi, '')
    .replace(/[\s\u3000，。！？、；：：“”‘’（）()【】《》〈〉「」『』,.!?;:'"()[\]{}<>\-_/\\|]+/g, '')
    .trim();
}

function promptSimilarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (shorter.length >= 6 && longer.includes(shorter)) return shorter.length / longer.length;
  if (shorter.length < 6) return 0;
  const makeBigrams = (value) => new Set([...value].map((_, index) => value.slice(index, index + 2)).filter((part) => part.length === 2));
  const a = makeBigrams(left);
  const b = makeBigrams(right);
  const intersection = [...a].filter((part) => b.has(part)).length;
  return intersection / (a.size + b.size - intersection || 1);
}

function isSimilarRecentPrompt(key, text, forceReply = false) {
  if (forceReply) return false;
  const normalized = normalizePromptForComparison(text);
  if (normalized.length < 6) return false;
  const now = Date.now();
  const recent = (recentPrompts.get(key) || []).filter((item) => now - item.at < messageDedupWindowMs);
  const duplicate = recent.some((item) => promptSimilarity(normalized, item.text) >= 0.72);
  recent.push({ text: normalized, at: now });
  recentPrompts.set(key, recent.slice(-12));
  return duplicate;
}

function eventHasImage(event) {
  return (Array.isArray(event.message) && event.message.some((segment) => segment?.type === 'image' || segment?.type === 'mface'))
    || /\[CQ:(?:image|mface)[,\]]/i.test(String(event.raw_message || ''));
}

function eventHasImmediateCommand(event) {
  const raw = String(event.raw_message || '')
    .replace(/\[CQ:[^\]]+\]/gi, '')
    .trim();
  return /^[/\\](help|members|models|stickers|version|time|date|new)$/i.test(raw);
}

async function getConfiguredDshModels() {
  // dsh-llm-deepseek ships these models in the official provider's catalog;
  // they are not repeated in a user's Web patch, so include them explicitly.
  const models = [
    { provider: 'deepseek-official', id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' },
    { provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
  ];
  const seen = new Set(models.map((model) => `${model.provider}:${model.id}`));
  if (!dshPatch) return models;
  try {
    const source = await readFile(dshPatch, 'utf8');
    const providerMatch = source.match(/\n\s{6}([\w-]+):\s*\n\s{8}displayName:/i);
    const provider = providerMatch?.[1] || 'custom';
    const matches = source.matchAll(/^\s{10}- id:\s*([^\s#]+)\s*\n\s{12}name:\s*(.+?)\s*$/gmi);
    for (const match of matches) {
      const id = match[1].trim();
      const name = match[2].trim().replace(/^['"]|['"]$/g, '');
      const key = `${provider}:${id}`;
      if (!seen.has(key)) {
        seen.add(key);
        models.push({ provider, id, name });
      }
    }
    return models;
  } catch (error) {
    console.warn(`无法读取 dsh 模型配置：${error.message}`);
    return models;
  }
}

async function getAvailableModels() {
  if (chatBackend === 'dsh') {
    return (await getConfiguredDshModels()).map((model) => ({ id: model.id, name: model.name, source: `dsh/${model.provider}` }));
  }
  if (chatBackend === 'official') {
    if (!deepseekApiKey) throw new Error('请先配置 DEEPSEEK_API_KEY，再读取官方 API 模型。');
    const response = await fetch(`${deepseekBaseUrl}/models`, {
      headers: { authorization: `Bearer ${deepseekApiKey}` },
    });
    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch { /* show a useful HTTP error below */ }
    if (!response.ok) throw new Error(payload?.error?.message || `模型接口返回 HTTP ${response.status}`);
    const models = Array.isArray(payload?.data) ? payload.data : [];
    return models.map((model) => ({ id: String(model.id || ''), name: String(model.name || model.id || ''), source: '官方 API' }))
      .filter((model) => model.id);
  }
  const configured = codexModel ? [{ id: codexModel, name: codexModel, source: '当前配置' }] : [];
  const candidates = [
    { id: 'gpt-5-codex', name: 'GPT-5 Codex', source: 'Codex 常见模型' },
    { id: 'codex-mini-latest', name: 'Codex Mini Latest', source: 'Codex 常见模型' },
  ];
  const seen = new Set();
  return [...configured, ...candidates].filter((model) => !seen.has(model.id) && seen.add(model.id));
}

async function getDshDefaultModel() {
  if (!dshPatch) return { provider: '', model: '', reasoningEffort: '' };
  try {
    const source = await readFile(dshPatch, 'utf8');
    const block = source.match(/- id:\s*agent-default-model\b[\s\S]*?(?=\n- id:|\s*$)/i)?.[0] || '';
    return {
      provider: block.match(/^\s+provider:\s*([^\s#]+)/mi)?.[1] || '',
      model: block.match(/^\s+model:\s*([^\s#]+)/mi)?.[1] || '',
      reasoningEffort: block.match(/^\s+reasoningEffort:\s*([^\s#]+)/mi)?.[1] || '',
    };
  } catch (error) {
    console.warn(`无法读取 dsh 默认模型配置：${error.message}`);
    return { provider: '', model: '', reasoningEffort: '' };
  }
}

async function dshVersionLabel() {
  const config = await getDshDefaultModel();
  const model = config.provider && config.model
    ? `${config.provider}/${config.model}`
    : `dsh/${dshProfile}`;
  let reasoning = config.reasoningEffort;
  if (!reasoning) {
    reasoning = '未设置（由 provider 默认处理）';
  }
  return `当前使用的模型：${model}，推理强度：${reasoning}`;
}

function eventSegments(event) {
  if (Array.isArray(event.message)) return event.message;
  if (typeof event.message === 'string') return [{ type: 'text', data: { text: event.message } }];
  const raw = String(event.raw_message || '').trim();
  return raw ? [{ type: 'text', data: { text: raw } }] : [];
}

function mergeMessageEvents(events) {
  const first = events[0];
  const latest = events[events.length - 1];
  const replyEvent = [...events].reverse().find((event) => event.reply
    || event.message?.some?.((segment) => segment?.type === 'reply')
    || /\[CQ:reply(?:,|\])/i.test(String(event.raw_message || '')));
  return {
    ...first,
    ...latest,
    message: events.flatMap(eventSegments),
    raw_message: events.map((event) => String(event.raw_message || '').trim()).filter(Boolean).join('\n'),
    ...(replyEvent?.reply ? { reply: replyEvent.reply } : {}),
  };
}

function messageBatchKey(event) {
  return event.message_type === 'group'
    ? `group:${event.group_id}:user:${event.user_id}`
    : `private:${event.user_id}`;
}

function enqueueMessage(ws, event) {
  if (eventHasImmediateCommand(event)) {
    handleMessage(ws, event).catch((error) => console.error('Message handler failed:', error));
    return;
  }
  const key = messageBatchKey(event);
  const pending = pendingMessageBatches.get(key) || { events: [], timer: null, ws };
  pending.events.push(event);
  pending.ws = ws;
  if (pending.timer) clearTimeout(pending.timer);
  const delay = pending.events.some(eventHasImage) ? messageImageBatchWindowMs : messageBatchWindowMs;
  pending.timer = setTimeout(() => {
    pendingMessageBatches.delete(key);
    handleMessage(pending.ws, mergeMessageEvents(pending.events))
      .catch((error) => console.error('Message handler failed:', error));
  }, delay);
  pendingMessageBatches.set(key, pending);
}

async function prepareImages(imageSources, tempRoot = os.tmpdir()) {
  if (!imageSources.length) return { paths: [], cleanup: async () => {} };
  const directory = await mkdtemp(path.join(tempRoot, '.qq-chat-images-'));
  const paths = [];
  try {
    for (const [index, source] of imageSources.entries()) {
      const candidates = Array.isArray(source) ? source : [source];
      let buffer;
      let extension = '.img';
      let lastError;
      for (const value of candidates) {
        try {
          if (/^https?:\/\//i.test(value)) {
            const response = await fetch(value);
            if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）`);
            const contentType = response.headers.get('content-type') || '';
            extension = contentType.includes('png') ? '.png'
              : contentType.includes('webp') ? '.webp'
                : contentType.includes('gif') ? '.gif' : '.jpg';
            buffer = Buffer.from(await response.arrayBuffer());
          } else {
            buffer = await readFile(value);
            extension = path.extname(value) || extension;
          }
          if (buffer.length > 15 * 1024 * 1024) throw new Error('图片过大，单张图片不能超过 15 MB');
          if (!imageMimeType('', buffer)) throw new Error('获取到的内容不是受支持的图片');
          break;
        } catch (error) {
          buffer = undefined;
          lastError = error;
        }
      }
      if (!buffer) throw new Error(`无法获取图片：${lastError?.message || '没有可用来源'}。请检查 NapCat 图片缓存和 Rkey 状态。`);
      const imagePath = path.join(directory, `image-${index}${extension}`);
      await writeFile(imagePath, buffer);
      paths.push(imagePath);
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { paths, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

async function runAgent(prompt, sessionId, imageSources = [], stickerEntries = [], conversationId = '') {
  const images = await prepareImages(imageSources, chatBackend === 'dsh' ? projectDir : os.tmpdir());
  const imageContext = images.paths.length && chatBackend === 'dsh'
    ? `\n\n用户附带的图片已保存到以下路径；如果需要理解图片，请使用 dsh 的文件工具读取：\n${images.paths.join('\n')}`
    : '';
  const promptWithPersona = `${defaultPersona}\n\n回复 QQ 时，数学公式不要使用 \\[...\\]、\\(...\\)、$$...$$ 或 LaTeX 反斜杠命令，因为 QQ 不会渲染 LaTeX。请改用纯文本和 Unicode 符号，例如“X(f) = ∫₋∞⁺∞ x(t) · e⁻ⁱ²πft dt”，并在必要时补一句符号含义。\n如果适合，可以在回复中使用 OneBot 标准 QQ 表情，例如 [CQ:face,id=14]；只使用你确定存在的数字表情 ID，不要伪造图片或自定义表情文件。群聊中如果需要直接回应某位成员，可以主动 @ 他，使用上下文里已有的 QQ 号并输出 [CQ:at,qq=123456]；只在确实需要点名、提醒或回应某人时使用，不要滥用，也不要猜测 QQ 号。\n如果适合使用 QQ 收藏表情，请从可用清单选择并单独输出 STICKER_ID: <ID>，不要虚构 ID，也不要把它和文字写在同一行。\n如果用户要求生成图片，只有在你确实使用可用工具创建了 PNG、JPG 或 WebP 文件，并确认文件存在时，才在回复末尾单独输出一行 IMAGE_PATH: <文件绝对路径>。如果当前没有图像生成工具或无法写入文件，请明确说明无法生成，不要伪造 IMAGE_PATH，也不要只把提示词当成已生成的图片。${favoriteStickerPrompt(stickerEntries)}\n\n用户消息：\n${prompt}${imageContext}`;
  if (chatBackend === 'dsh') {
    return runDsh(promptWithPersona, sessionId, images);
  }
  if (chatBackend === 'official') {
    return runOfficial(promptWithPersona, conversationId, images);
  }
  return runCodex(promptWithPersona, sessionId, images);
}

function officialMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => typeof part === 'string' ? part : part?.text || '').join('');
}

function imageMimeType(filePath, buffer) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.png' || buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg' || buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  if (extension === '.gif' || buffer.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  if (extension === '.webp' || (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP')) return 'image/webp';
  return '';
}

async function officialImageContent(imagePath) {
  const buffer = await readFile(imagePath);
  const mime = imageMimeType(imagePath, buffer);
  if (!mime) throw new Error(`无法识别图片格式：${path.basename(imagePath)}`);
  return {
    type: 'image_url',
    image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` },
  };
}

async function runOfficial(promptWithPersona, conversationId, images) {
  const key = conversationId || 'default';
  const previous = Array.isArray(officialHistories[key]) ? officialHistories[key] : [];
  const userContent = images.paths.length
    ? [{ type: 'text', text: promptWithPersona }, ...await Promise.all(images.paths.map(officialImageContent))]
    : promptWithPersona;
  const messages = [...previous, { role: 'user', content: userContent }];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), codexTimeoutMs);
  try {
    const requestBody = {
      model: deepseekModel,
      messages,
      max_tokens: deepseekMaxTokens,
      stream: false,
    };
    if (deepseekReasoningEffort) requestBody.reasoning_effort = deepseekReasoningEffort;
    const response = await fetch(`${deepseekBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${deepseekApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.message || raw.slice(0, 500);
      throw new Error(`DeepSeek API HTTP ${response.status}: ${detail || '请求失败'}`);
    }
    const text = officialMessageText(payload?.choices?.[0]?.message?.content).trim();
    if (!text) throw new Error('DeepSeek API 没有返回文本。');
    // Keep image data out of the persistent history; otherwise every later turn
    // would resend all previous Base64 images and quickly exhaust the request size.
    officialHistories[key] = [...previous, { role: 'user', content: promptWithPersona }, { role: 'assistant', content: text }].slice(-40);
    await saveOfficialHistories();
    return { sessionId: sessionIdForOfficial(key), text };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`DeepSeek 官方 API 调用超时（${Math.ceil(codexTimeoutMs / 1000)} 秒）`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    await images.cleanup();
  }
}

function sessionIdForOfficial(conversationId) {
  return `official:${conversationId}`;
}

async function runCodex(promptWithPersona, sessionId, images) {
  const imageArgs = images.paths.flatMap((imagePath) => ['--image', imagePath]);
  const modelArgs = codexModel ? ['--model', codexModel] : [];
  const reasoningArgs = codexReasoningEffort
    ? ['-c', `model_reasoning_effort=${JSON.stringify(codexReasoningEffort)}`]
    : [];
  const args = sessionId
    ? ['exec', 'resume', sessionId, '--json', '--skip-git-repo-check', ...modelArgs, ...reasoningArgs, promptWithPersona, ...imageArgs]
    : ['exec', '--json', '--approve-for-me', '--skip-git-repo-check', '--cd', projectDir, ...modelArgs, ...reasoningArgs, promptWithPersona, ...imageArgs];

  return new Promise((resolve, reject) => {
    const child = spawn(codexCommand, args, { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let session = sessionId;
    let finalText = '';
    let settled = false;
    let timeout;

    const finishError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      images.cleanup().catch(() => {});
      reject(error);
    };

    function handleEventLine(line) {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event.type === 'thread.started' && event.thread_id) session = event.thread_id;
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          finalText = event.item.text || event.item.content?.map((part) => part?.text || '').join('') || finalText;
        }
        if (event.type === 'turn.failed') finishError(new Error(event.error?.message || 'Codex turn failed'));
      } catch (error) {
        if (!(error instanceof SyntaxError)) finishError(error);
      }
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const lines = stdout.split('\n');
      stdout = lines.pop() || '';
      for (const line of lines) handleEventLine(line);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', finishError);
    timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finishError(new Error(`Codex 调用超时（${Math.ceil(codexTimeoutMs / 1000)} 秒）`));
    }, codexTimeoutMs);
    child.on('close', (code) => {
      if (settled) return;
      if (stdout.trim()) handleEventLine(stdout);
      if (code !== 0) {
        return finishError(new Error(stderr.trim() || `Codex exited with code ${code}`));
      }
      if (!session) {
        return finishError(new Error('Codex did not return a session ID.'));
      }
      settled = true;
      clearTimeout(timeout);
      images.cleanup().catch(() => {});
      resolve({ sessionId: session, text: finalText || '（Codex 没有返回文本）' });
    });
  });
}

async function runDsh(promptWithPersona, sessionId, images) {
  const args = ['--profile', dshProfile, '--json'];
  if (dshPatch) args.unshift('--patch', dshPatch);
  if (sessionId) args.push('--session-id', sessionId);
  args.push(promptWithPersona);
  return new Promise((resolve, reject) => {
    const child = spawn(dshCommand, args, {
      cwd: projectDir,
      env: dshHome ? { ...process.env, DSH_HOME: dshHome } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let session = sessionId;
    let finalText = '';
    let failedEvent;
    let settled = false;
    let timeout;
    const finishError = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      images.cleanup().catch(() => {});
      reject(error);
    };
    const handleEventLine = (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event.type === 'session' && event.sessionId) session = event.sessionId;
        if (event.type === 'final' && typeof event.text === 'string') finalText = event.text;
        if (event.type === 'error') failedEvent = new Error(event.message || 'dsh 执行失败');
        if (event.type === 'status' && event.phase === 'turn_end'
          && event.reason?.kind && event.reason.kind !== 'completed') {
          failedEvent = new Error(event.reason.error?.message || `dsh turn failed: ${event.reason.kind}`);
        }
      } catch {
        // dsh --json is newline-delimited JSON; ignore incomplete/noisy lines.
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const lines = stdout.split('\n');
      stdout = lines.pop() || '';
      for (const line of lines) handleEventLine(line);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', finishError);
    timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finishError(new Error(`dsh 调用超时（${Math.ceil(codexTimeoutMs / 1000)} 秒）`));
    }, codexTimeoutMs);
    child.on('close', (code) => {
      if (settled) return;
      if (stdout.trim()) handleEventLine(stdout);
      if (code !== 0 || failedEvent) {
        return finishError(failedEvent || new Error(stderr.trim() || `dsh exited with code ${code}`));
      }
      if (!session) return finishError(new Error('dsh did not return a session ID.'));
      settled = true;
      clearTimeout(timeout);
      images.cleanup().catch(() => {});
      resolve({ sessionId: session, text: finalText || '（dsh 没有返回文本）' });
    });
  });
}

async function handleMessage(ws, event) {
  if (event.post_type !== 'message' || !event.user_id) return;
  const segments = Array.isArray(event.message) ? event.message : [];
  const mentionedIds = mentionedUserIds(event, segments);
  if (event.message_type === 'group' && mentionedIds.size > 0 && !mentionedIds.has(botId)) return;
  const userId = String(event.user_id);
  if (botId && userId === botId) return;
  if (event.message_type === 'group') {
    if (!allowedGroups.has(String(event.group_id))) return;
  } else if (!allowedUsers.has(userId)) {
    return;
  }

  const hasReply = Boolean(event.reply || segments.some((segment) => segment?.type === 'reply')
    || /\[CQ:reply(?:,|\])/i.test(String(event.raw_message || '')));
  const reply = await getReplyContext(ws, event, segments);
  if (hasReply && (!botId || reply.userId !== botId)) return;
  const replyContext = reply.text;
  const imageSources = segments.filter((segment) => segment?.type === 'image' || segment?.type === 'mface')
    .map((segment) => ({ file: segment.data?.file, url: segment.data?.url }))
    .filter((source) => source.file || source.url);
  const cqImages = imageSources.length ? [] : [...String(event.raw_message || '').matchAll(/\[CQ:image,([^\]]+)\]/gi)]
    .map((match) => ({
      file: match[1].match(/(?:^|,)file=([^,]+)/i)?.[1],
      url: match[1].match(/(?:^|,)url=([^,]+)/i)?.[1],
    }))
    .filter((source) => source.file || source.url);
  const rawText = String(event.raw_message || '')
    || segments.filter((segment) => segment?.type === 'text').map((segment) => segment.data?.text || '').join(' ');
  const text = rawText
    .replace(/\[CQ:image,[^\]]*\]/gi, '')
    .replace(/\[CQ:mface,[^\]]*\]/gi, '')
    .replace(/\[CQ:reply,[^\]]*\]/gi, '')
    .replace(/\[CQ:at,[^\]]*\]/gi, '')
    .trim();
  if (!text && !imageSources.length && !cqImages.length && !hasReply) return;
  sendHolidayGreetingIfNeeded(ws, event);
  const conversationId = event.message_type === 'group'
    ? `group:${event.group_id}:user:${userId}`
    : `private:${userId}`;
  const command = text.match(/^[/\\](help|members|models|stickers|version|time|date|new)$/i)?.[1]?.toLowerCase() || '';

  if (command && event.message_type === 'group'
    && !['owner', 'admin'].includes(String(event.sender?.role || '').toLowerCase())) {
    sendMessage(ws, event, '只有群主或管理员可以使用这个命令。');
    return;
  }

  if (command === 'help') {
  sendMessage(ws, event, `直接发送需求即可与 ${backendName()} 对话。\n/new：新建会话\n/help：显示帮助\n/members：列出当前群成员\n/models：列出当前后端模型\n/stickers：列出 QQ 收藏表情\n/version：显示当前模型\n/time：查询当前时间\n/date：查询当前日期`);
    return;
  }
  if (command === 'members') {
    if (event.message_type !== 'group') {
      sendMessage(ws, event, '这个命令只能在群聊中使用。');
      return;
    }
    try {
      const result = await callOneBot(ws, 'get_group_member_list', { group_id: event.group_id });
      const members = result?.data || result;
      if (!Array.isArray(members) || members.length === 0) {
        sendMessage(ws, event, '没有获取到群成员列表。');
        return;
      }
      const lines = formatGroupMembers(members);
      for (const chunk of splitMessage(`本群共 ${members.length} 名成员：\n${lines.join('\n')}`)) {
        sendMessage(ws, event, chunk);
      }
    } catch (error) {
      console.error('Get group members failed:', error);
      sendMessage(ws, event, `获取群成员失败：${error.message.slice(0, 300)}`);
    }
    return;
  }
  if (command === 'models') {
    if (chatBackend === 'official') {
      sendMessage(ws, event, `DeepSeek 官方 API 模型：${deepseekModel}`);
      return;
    }
    if (chatBackend !== 'dsh') {
      sendMessage(ws, event, '当前后端不是 dsh 或 official。');
      return;
    }
    const models = await getConfiguredDshModels();
    if (!models.length) {
      sendMessage(ws, event, '没有从 dsh Web 配置中读取到模型列表。');
      return;
    }
    for (const chunk of splitMessage(`dsh 可用模型（${dshProfile}）：\n${models
      .map((model, index) => `${index + 1}. ${model.name}（${model.provider}/${model.id}）`).join('\n')}`)) {
      sendMessage(ws, event, chunk);
    }
    return;
  }
  if (command === 'stickers') {
    const stickers = await getFavoriteStickers(ws, true);
    if (!stickers.length) {
      sendMessage(ws, event, '没有读取到 QQ 收藏表情。请确认 NapCat 已登录，并支持 fetch_custom_face_detail。');
      return;
    }
    for (const chunk of splitMessage(`QQ 收藏表情（${stickers.length} 个）：\n${stickers
      .map((sticker, index) => `${index + 1}. ${sticker.name || '未命名'}（${sticker.id}）`).join('\n')}`)) {
      sendMessage(ws, event, chunk);
    }
    return;
  }
  if (command === 'version') {
    const version = chatBackend === 'dsh'
      ? await dshVersionLabel()
      : chatBackend === 'official'
        ? officialVersionLabel()
        : `当前使用的模型：${codexModel || 'Codex CLI 默认模型'}${codexReasoningEffort ? `，推理强度：${codexReasoningEffort}` : ''}`;
    sendMessage(ws, event, version);
    return;
  }
  if (command === 'time' || command === 'date') {
    sendMessage(ws, event, command === 'time'
      ? `当前时间（上海时区）：${shanghaiTimeLabel()}`
      : `当前日期（上海时区）：${shanghaiDateLabel()}`);
    return;
  }
  if (command === 'new') {
    delete sessions[conversationId];
    delete officialHistories[conversationId];
    await saveSessions();
    await saveOfficialHistories();
    sendMessage(ws, event, '已新建会话。');
    return;
  }
  if (/^(?:目前|当前)?(?:使用的)?模型(?:是什么|是哪个|呢)?[？?]?$/i.test(text)
    || /^(?:你|机器人)?(?:现在|目前|当前)?(?:使用|用)(?:的)?什么模型[？?]?$/i.test(text)) {
    const version = chatBackend === 'dsh'
      ? await dshVersionLabel()
      : chatBackend === 'official'
        ? officialVersionLabel()
        : `当前使用的模型：${codexModel || 'Codex CLI 默认模型'}${codexReasoningEffort ? `，推理强度：${codexReasoningEffort}` : ''}`;
    sendMessage(ws, event, version);
    return;
  }
  if (/^(?:现在|当前|目前)?(?:是)?几点(?:了|钟)?[？?]?$/i.test(text)
    || /^(?:现在|当前|目前)?时间(?:是多少|是什么|呢)?[？?]?$/i.test(text)) {
    sendMessage(ws, event, `当前时间（上海时区）：${shanghaiTimeLabel()}`);
    return;
  }
  if (/^(?:今天|当前|现在)?(?:的)?日期(?:是多少|是什么|呢)?[？?]?$/i.test(text)
    || /^今天(?:是)?几号[？?]?$/i.test(text)
    || /^今天(?:是)?几月几号(?:星期几)?[？?]?$/i.test(text)
    || /^今天星期几[？?]?$/i.test(text)) {
    sendMessage(ws, event, `当前日期（上海时区）：${shanghaiDateLabel()}`);
    return;
  }
  const dedupKey = conversationId;
  if (isSimilarRecentPrompt(dedupKey, text, hasReply)) return;
  if (text.length > maxPromptChars) {
    sendMessage(ws, event, `消息过长，请控制在 ${maxPromptChars} 个字符以内。`);
    return;
  }

  const previous = locks.get(conversationId) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    try {
      const memberContext = groupMemberContext(event, segments);
      const imageOnlyInstruction = '用户只发送了图片，没有提出具体问题。不要长篇描述图片，不要使用客服话术，不要列出“识字、解释、分析”之类的固定选项。像真实群友一样随机、简短地接一句，可以吐槽、调侃或反问，但别每次都用同一种句式；如果没有自然的接话内容，就只说“看到了”。';
      const incomingStickers = favoriteStickerSegments(segments);
      const stickerContext = incomingStickers.length
        ? `\n\n用户发送了${incomingStickers.join('、')}，请结合图片内容自然回应。`
        : '';
      const prompt = `当前系统时间（上海时区）：${shanghaiDateTimeLabel()}\n\n${text || imageOnlyInstruction}${replyContext}${memberContext}${stickerContext}`;
      const resolvedImages = await resolveImageSources(ws, [...imageSources, ...cqImages]);
      const stickerEntries = [...await getFavoriteStickers(ws), ...localStickerEntries()];
      let result;
      try {
        result = await runAgent(prompt, sessions[conversationId], resolvedImages, stickerEntries, conversationId);
      } catch (error) {
        const canStartNewSession = sessions[conversationId]
          && /session|thread|resume|not found|unknown id|unknown session|no stored session|adopt|不存在|找不到/i.test(error.message);
        if (!canStartNewSession) throw error;
        console.warn(`${chatBackend === 'dsh' ? 'dsh' : 'Codex'} 会话 ${sessions[conversationId]} 不可恢复，开始新会话。`);
        delete sessions[conversationId];
        await saveSessions();
        result = await runAgent(prompt, undefined, resolvedImages, stickerEntries, conversationId);
      }
      sessions[conversationId] = result.sessionId;
      await saveSessions();
      await sendAgentResponse(ws, event, result.text, stickerEntries);
    } catch (error) {
      const name = backendName();
      console.error(`${name} request failed:`, error);
      sendMessage(ws, event, `${name} 调用失败：${error.message.slice(0, 500)}`);
    }
  });
  locks.set(conversationId, current);
  await current;
  if (locks.get(conversationId) === current) locks.delete(conversationId);
}

wss.on('connection', (ws) => {
  oneBotSocket = ws;
  console.log('OneBot connected.');
  ws.on('message', (buffer) => {
    let event;
    try {
      event = JSON.parse(buffer.toString());
    } catch {
      return;
    }
    if (event.echo && apiRequests.has(event.echo)) {
      const request = apiRequests.get(event.echo);
      apiRequests.delete(event.echo);
      if (event.status === 'ok' && event.retcode === 0) request.resolve(event);
      else request.reject(new Error(event.message || event.wording || `OneBot API 失败：${event.retcode}`));
      return;
    }
    if (event.post_type === 'message') enqueueMessage(ws, event);
    if (event.post_type === 'notice') handleNotice(ws, event);
  });
  ws.on('close', () => {
    if (oneBotSocket === ws) oneBotSocket = null;
    console.log('OneBot disconnected.');
  });
});

httpServer.listen(port, host, () => {
  console.log(`QQ chat bridge listening on ws://${host}:${port}${wsPath}`);
  console.log(`Settings page: http://${host}:${port}/`);
});
httpServer.on('error', (error) => {
  console.error('HTTP/WebSocket server error:', error.message);
  process.exitCode = 1;
});
wss.on('error', (error) => {
  console.error('WebSocket server error:', error.message);
  process.exitCode = 1;
});
console.log(`Agent project directory: ${projectDir}`);
