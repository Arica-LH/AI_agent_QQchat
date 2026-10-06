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
const themeDefaults = {
  default: { mode:'dark', accent:'#d8f36b', bg:'#101314', glow:'#2d3a35', panel:'#181d1e', panel2:'#202728', field:'#101515', card:'#151a1a', line:'#303939', text:'#e9efed', muted:'#9aa8a4' },
  ocean: { mode:'dark', accent:'#72d7ff', bg:'#0d151b', glow:'#173c4c', panel:'#14222a', panel2:'#1c303a', field:'#0c171d', card:'#112028', line:'#2a424c', text:'#e8f5f8', muted:'#95aeb5' },
  plum: { mode:'dark', accent:'#e6a8ff', bg:'#17121b', glow:'#43294f', panel:'#241b2b', panel2:'#34253c', field:'#17121c', card:'#211827', line:'#4a3552', text:'#f7edf9', muted:'#bba9c0' },
  light: { mode:'light', accent:'#25745f', bg:'#f3f5f1', glow:'#d9e9df', panel:'#ffffff', panel2:'#edf1ed', field:'#f8faf8', card:'#f0f4f1', line:'#cad6ce', text:'#1d2a23', muted:'#65756b' },
};

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
function applyTheme(theme) {
  const root = document.documentElement;
  Object.entries(theme).forEach(([key, value]) => root.style.setProperty(`--${key}`, value));
  root.style.colorScheme = theme.mode || 'dark';
  document.querySelector('#themeMode').value = theme.mode || 'dark';
  document.querySelector('#accentColor').value = theme.accent;
  document.querySelector('#backgroundColor').value = theme.bg;
  document.querySelector('#panelColor').value = theme.panel;
  document.querySelector('#textColor').value = theme.text;
}
function readTheme() {
  const root = getComputedStyle(document.documentElement);
  return { mode: document.querySelector('#themeMode').value, accent: root.getPropertyValue('--accent').trim(), bg: root.getPropertyValue('--bg').trim(), glow: root.getPropertyValue('--glow').trim(), panel: root.getPropertyValue('--panel').trim(), panel2: root.getPropertyValue('--panel-2').trim(), field: root.getPropertyValue('--field').trim(), card: root.getPropertyValue('--card').trim(), line: root.getPropertyValue('--line').trim(), text: root.getPropertyValue('--text').trim(), muted: root.getPropertyValue('--muted').trim() };
}
function saveTheme() { localStorage.setItem('qq-bridge-theme', JSON.stringify(readTheme())); document.querySelector('#themeStatus').textContent = '已保存到当前浏览器'; }
function initTheme() {
  try { const saved = JSON.parse(localStorage.getItem('qq-bridge-theme') || 'null'); if (saved) applyTheme(saved); } catch { localStorage.removeItem('qq-bridge-theme'); }
  document.querySelector('#themePreset').addEventListener('change', (event) => { if (themeDefaults[event.target.value]) applyTheme(themeDefaults[event.target.value]); else return; saveTheme(); });
  document.querySelector('#themeMode').addEventListener('change', (event) => { document.documentElement.style.colorScheme = event.target.value; saveTheme(); });
  [['accentColor','accent'],['backgroundColor','bg'],['panelColor','panel'],['textColor','text']].forEach(([id, variable]) => document.querySelector(`#${id}`).addEventListener('input', (event) => { document.documentElement.style.setProperty(`--${variable}`, event.target.value); document.querySelector('#themePreset').value = 'custom'; saveTheme(); }));
  document.querySelector('#resetThemeButton').addEventListener('click', () => { applyTheme(themeDefaults.default); document.querySelector('#themePreset').value = 'default'; saveTheme(); });
}

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
initTheme();
loadConfig().catch((error) => { setMessage(error.message, 'error'); statusText.textContent = '读取失败'; runtimeBadge.textContent = '离线'; });
