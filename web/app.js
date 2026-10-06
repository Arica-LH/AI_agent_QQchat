const form = document.querySelector('#settingsForm');
const backendInputs = [...document.querySelectorAll('input[name="CHAT_BACKEND"]')];
const saveStatus = document.querySelector('#saveStatus');
const runtimeBadge = document.querySelector('#runtimeBadge');
const statusText = document.querySelector('#statusText');
const statusDetail = document.querySelector('#statusDetail');
const changesPanel = document.querySelector('#changesPanel');
const changesList = document.querySelector('#changesList');
const changeCount = document.querySelector('#changeCount');
const secretKeys = new Set(['ONEBOT_ACCESS_TOKEN', 'DEEPSEEK_API_KEY']);
const fieldLabels = {
  CHAT_BACKEND:'对话后端', CODEX_BIN:'Codex 可执行文件', CODEX_MODEL:'Codex 模型', CODEX_REASONING_EFFORT:'Codex 推理强度',
  CHAT_DSH_BIN:'dsh 可执行文件', CHAT_DSH_PROFILE:'dsh Profile', CHAT_DSH_HOME:'dsh Home', CHAT_DSH_PATCH:'dsh Patch',
  DEEPSEEK_API_KEY:'DeepSeek API Key', DEEPSEEK_BASE_URL:'API Base URL', DEEPSEEK_MODEL:'官方 API 模型',
  DEEPSEEK_REASONING_EFFORT:'官方 API 推理强度', DEEPSEEK_MAX_TOKENS:'最大输出 tokens', DEFAULT_PERSONA:'默认人格提示',
  ONEBOT_ACCESS_TOKEN:'OneBot Access Token', BOT_QQ_ID:'机器人 QQ 号', ALLOWED_USER_IDS:'允许私聊用户', ALLOWED_GROUP_IDS:'允许群号',
  HOST:'监听地址', PORT:'端口', WS_PATH:'WebSocket 路径', PROJECT_DIR:'项目目录', CODEX_TIMEOUT_MS:'请求超时', MAX_PROMPT_CHARS:'单条消息上限',
};
let baseline = {};

function field(name) { return form.elements.namedItem(name); }
function setBackend(value) {
  backendInputs.forEach((input) => { input.checked = input.value === value; });
  document.querySelector('#codexFields').classList.toggle('hidden', value !== 'codex');
  document.querySelector('#dshFields').classList.toggle('hidden', value !== 'dsh');
  document.querySelector('#officialFields').classList.toggle('hidden', value !== 'official');
}
function setMessage(text, kind = '') { saveStatus.textContent = text; saveStatus.className = `muted ${kind}`; }
function currentValues() {
  const values = {};
  [...form.elements].filter((element) => element.name).forEach((element) => {
    if (element.type === 'radio' && !element.checked) return;
    values[element.name] = element.value || '';
  });
  return values;
}
function changedValues() {
  return Object.entries(currentValues()).filter(([key, value]) => {
    if (secretKeys.has(key)) return Boolean(value);
    return value !== (baseline[key] || '');
  });
}
function displayChangeValue(key, value) { return secretKeys.has(key) ? '已修改（内容不显示）' : (value || '清空'); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char])); }
function renderChanges() {
  const changes = changedValues();
  changesPanel.classList.toggle('hidden', changes.length === 0);
  changeCount.textContent = changes.length ? `${changes.length} 项` : '';
  changesList.innerHTML = changes.map(([key, value]) => `<div class="change-row"><span class="change-key">${fieldLabels[key] || key}</span><span class="change-value">${escapeHtml(displayChangeValue(key, value))}</span></div>`).join('');
}
function markBaseline() {
  baseline = currentValues();
  secretKeys.forEach((key) => { baseline[key] = ''; });
  renderChanges();
}
function isDirty() { return changedValues().length > 0; }

async function loadConfig() {
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) throw new Error('无法读取配置');
  const result = await response.json();
  Object.entries(result.config).forEach(([key, item]) => {
    if (!field(key) || secretKeys.has(key)) return;
    field(key).value = item.value || '';
  });
  secretKeys.forEach((key) => { if (result.config[key]?.configured) field(key).placeholder = '已配置（留空保持不变）'; });
  setBackend(result.config.CHAT_BACKEND?.value || 'codex');
  markBaseline();
  runtimeBadge.textContent = `${result.running.backend} · 在线`;
  statusText.textContent = '桥接服务在线';
  statusDetail.textContent = `WebSocket ${result.running.wsPath} · 端口 ${result.running.port}`;
}
async function saveConfig() {
  const payload = {};
  [...form.elements].filter((element) => element.name).forEach((element) => {
    if (secretKeys.has(element.name) && !element.value) return;
    payload[element.name] = element.value;
  });
  const response = await fetch('/api/config', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(payload) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '保存失败');
  secretKeys.forEach((key) => { field(key).value = ''; });
  markBaseline();
  return result;
}
async function restartService() {
  const response = await fetch('/api/restart', { method:'POST' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '重启失败');
  statusText.textContent = '服务正在重启'; runtimeBadge.textContent = '重启中';
  setTimeout(() => location.reload(), 1800);
}

backendInputs.forEach((input) => input.addEventListener('change', () => { setBackend(input.value); renderChanges(); }));
form.addEventListener('input', renderChanges);
form.addEventListener('change', renderChanges);
document.querySelector('#saveButton').addEventListener('click', async () => {
  setMessage('正在保存…');
  try { await saveConfig(); setMessage('已保存配置。', 'success'); } catch (error) { setMessage(error.message, 'error'); }
});
form.addEventListener('submit', async (event) => {
  event.preventDefault(); setMessage('正在保存并重启…');
  try { await saveConfig(); setMessage('配置已保存，正在重启服务…', 'success'); await restartService(); } catch (error) { setMessage(error.message, 'error'); }
});
document.querySelector('#restartButton').addEventListener('click', async () => {
  if (isDirty()) {
    setMessage('有未保存的修改，请先点击“保存并重启”或“仅保存”。', 'error');
    changesPanel.scrollIntoView({ behavior:'smooth', block:'center' });
    return;
  }
  if (!confirm('确认重启桥接服务？当前 QQ 连接会短暂断开。')) return;
  setMessage('正在重启…');
  try { await restartService(); } catch (error) { setMessage(error.message, 'error'); }
});
loadConfig().catch((error) => { setMessage(error.message, 'error'); statusText.textContent = '读取失败'; runtimeBadge.textContent = '离线'; });
