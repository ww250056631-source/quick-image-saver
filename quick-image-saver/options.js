import {readSetting, writeSetting} from './db.js';
const name = document.getElementById('folder-name');
const status = document.getElementById('status');
const choose = document.getElementById('choose');
const authorize = document.getElementById('authorize');
const test = document.getElementById('test');
const notice = document.getElementById('notice');
const toggle = document.getElementById('enabled');
let directory;
let refreshVersion = 0;

function message(text, error = false) {
  notice.textContent = text;notice.dataset.error = String(error);notice.hidden = false;
}
async function refresh() {
  const version = ++refreshVersion;
  const selected = await readSetting('directory');
  const ready = selected && await selected.queryPermission({mode: 'readwrite'}) === 'granted';
  if (version !== refreshVersion) return;
  directory = selected;
  name.textContent = directory?.name || '尚未选择文件夹';
  status.dataset.ready = String(Boolean(ready));
  status.textContent = ready ? '已授权 · 只保存到这个位置' : (directory ? '位置已记住 · 需要重新授权' : '选择文件夹后即可开始');
  authorize.hidden = !directory || ready;
  test.disabled = !ready;
  choose.textContent = directory ? '更改保存文件夹' : '选择保存文件夹';
}
choose.addEventListener('click', async () => {
  try {
    // Call the picker before awaiting anything, preserving the user gesture.
    const next = await window.showDirectoryPicker({id: 'quick-image-save', mode: 'readwrite', ...(directory ? {startIn: directory} : {})});
    const permission = await next.queryPermission({mode: 'readwrite'}) === 'granted'
      ? 'granted' : await next.requestPermission({mode: 'readwrite'});
    if (permission !== 'granted') {
      message('没有获得所选文件夹的写入权限，保存位置未更改。请重新选择并允许写入。', true);
      return;
    }
    await writeSetting('directory', next);
    await refresh();
    message(`保存位置已设为「${next.name}」。之后加入的图片任务只会存到你刚才选中的位置。可先保存一张测试图片确认。`);
  } catch (error) {
    if (error.name === 'AbortError') return;
    message(error.name === 'SecurityError' ? '浏览器未允许访问这个文件夹，保存位置未更改。请重新选择你有写入权限的位置。' : '无法设置这个文件夹，保存位置未更改。请重试。' , true);
  }
});
authorize.addEventListener('click', async () => {
  try {
    if (!directory) return;
    const permission = await directory.requestPermission({mode: 'readwrite'});
    await refresh();
    message(permission === 'granted' ? `已恢复「${directory.name}」的保存权限，保存位置没有变化。` : '没有获得写入权限，保存位置仍被记住，但暂时无法写入。请重新授权。', permission !== 'granted');
  } catch {message('授权失败，请重新选择保存文件夹。', true);}
});
toggle.addEventListener('change', () => chrome.storage.local.set({enabled: toggle.checked}));
test.addEventListener('click', async () => {
  test.disabled = true;
  try {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" rx="32" fill="#eff6ff"/><rect x="264" y="84" width="112" height="112" rx="28" fill="#2563eb"/><path d="M320 110v54m-20-19 20 20 20-20m-46 33h52" fill="none" stroke="white" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/><text x="320" y="267" text-anchor="middle" font-size="32" font-family="sans-serif" fill="#14283f">Quick Image Saver</text><text x="320" y="310" text-anchor="middle" font-size="18" font-family="sans-serif" fill="#64748b">Your folder is ready.</text></svg>';
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    const result = await chrome.runtime.sendMessage({target: 'background', type: 'SAVE_IMAGE', url});
    message(result?.ok ? `测试成功！已保存到「${result.folder}」：${result.filename}。可以打开这个文件夹检查。` : (result?.error || '测试失败，请重试。'), !result?.ok);
  } catch {message('测试失败，请重新加载设置页面后重试。', true);}
  finally {await refresh();}
});
chrome.storage.local.get('enabled').then(data => {toggle.checked = data.enabled !== false;});
window.addEventListener('focus', () => refresh().catch(() => {}));
if (!window.showDirectoryPicker) {
  choose.disabled = true;message('当前浏览器不支持文件夹选择，请使用桌面版 Chrome 116 或更新版本。', true);
}
refresh().catch(() => message('读取本地设置失败，请重新加载扩展。', true));
