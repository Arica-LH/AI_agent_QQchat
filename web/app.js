const form = document.querySelector('#settingsForm');
const backendInputs = [...document.querySelectorAll('input[name="CHAT_BACKEND"]')];
const saveStatus = document.querySelector('#saveStatus');
const runtimeBadge = document.querySelector('#runtimeBadge');
const statusText = document.querySelector('#statusText');
const statusDetail = document.querySelector('#statusDetail');
const secretKeys = new Set(['ONEBOT_ACCESS_TOKEN', 'DEEPSEEK_API_KEY']);

function field(name) { return form.elements.namedItem(name); }
function setBackend(value) {
  backendInputs.forEach((input) => { input.checked = input.value === value; });
  document.querySelector('#codexFields').classList.toggle('hidden', value !== 'codex');
  document.querySelector('#dshFields').classList.toggle('hidden', value !== 'dsh');
  document.querySelector('#officialFields').classList.toggle('hidden', value !== 'official');
}
function setMessage(text, kind = '') { saveStatus.textContent = text; saveStatus.className = `muted ${kind}`; }

async function loadConfig() {
  const response = await fetch('/api/config', { cache: 'no-store' });
  if (!response.ok) throw new Error('无法读取配置');
  const result = await response.json();
  Object.entries(result.config).forEach(([key, item]) => {
    if (!field(key) || secretKeys.has(key)) return;
    field(key).value = item.value || '';
  });
  secretKeys.forEach((key) => {
    if (result.config[key]?.configured) field(key).placeholder = '已配置（留空保持不变）';
  });
  setBackend(result.config.CHAT_BACKEND?.value || 'codex');
  runtimeBadge.textContent = `${result.running.backend} · 在线`;
  statusText.textContent = '桥接服务在线';
  statusDetail.textContent = `WebSocket ${result.running.wsPath} · 端口 ${result.running.port}`;
}

backendInputs.forEach((input) => input.addEventListener('change', () => setBackend(input.value)));
form.addEventListener('submit', async (event) => {
  event.preventDefault(); setMessage('正在保存…');
  const payload = {};
  [...form.elements].filter((element) => element.name).forEach((element) => {
    if (secretKeys.has(element.name) && !element.value) return;
    payload[element.name] = element.value;
  });
  try {
    const response = await fetch('/api/config', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '保存失败');
    field('ONEBOT_ACCESS_TOKEN').value = ''; field('DEEPSEEK_API_KEY').value = '';
    setMessage('已保存。请点击右上角“重启服务”使配置生效。', 'success');
  } catch (error) { setMessage(error.message, 'error'); }
});
document.querySelector('#restartButton').addEventListener('click', async () => {
  if (!confirm('确认重启桥接服务？当前 QQ 连接会短暂断开。')) return;
  setMessage('正在重启…');
  try { await fetch('/api/restart', { method:'POST' }); statusText.textContent = '服务正在重启'; runtimeBadge.textContent = '重启中'; setTimeout(() => location.reload(), 1800); }
  catch (error) { setMessage(error.message, 'error'); }
});
loadConfig().catch((error) => { setMessage(error.message, 'error'); statusText.textContent = '读取失败'; runtimeBadge.textContent = '离线'; });
