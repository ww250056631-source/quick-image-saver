import {readSetting} from './db.js';
import {platformVideo} from './video-sites.js';
const folder = document.getElementById('folder-name');
const status = document.getElementById('status');
const toggle = document.getElementById('enabled');
const videoToggle = document.getElementById('video-enabled');
const videoError = document.getElementById('video-setting-error');
let videoEnabled = false;
let currentVideo;
let currentJob;
let requesting = false;
const downloadPanel = document.getElementById('platform-download');
const downloadButton = document.getElementById('save-platform');
const hint = document.getElementById('platform-hint');
const progress = document.getElementById('video-progress');
const jobNotice = document.getElementById('video-job');
document.getElementById('settings').addEventListener('click', async () => {
  await chrome.runtime.openOptionsPage(); window.close();
});
toggle.addEventListener('change', () => chrome.storage.local.set({enabled: toggle.checked}));

function reflectVideoSetting(enabled) {
  videoEnabled = enabled === true;
  videoToggle.checked = videoEnabled;
  renderDownloadPanel();
}

function renderDownloadPanel() {
  const busy = ['starting', 'downloading', 'processing', 'saving'].includes(currentJob?.status);
  downloadPanel.hidden = !videoEnabled && !busy;
  downloadButton.disabled = !videoEnabled || !currentVideo || requesting || busy;
  hint.textContent = currentVideo ? '保存到 Chrome 下载位置' : '打开 B 站、YouTube 或 X 的视频详情页。';
  jobNotice.hidden = !currentJob;
  if (currentJob) {
    jobNotice.dataset.error = String(currentJob.status === 'error');
    jobNotice.textContent = [currentJob.text, currentJob.path].filter(Boolean).join('\n');
  }
  progress.hidden = !busy;
  if (Number.isFinite(currentJob?.percent)) progress.value = currentJob.percent;
  else progress.removeAttribute('value');
}

chrome.tabs.query({active: true, lastFocusedWindow: true}).then(([tab]) => {
  currentVideo = platformVideo(tab?.url);
  renderDownloadPanel();
}).catch(console.error);

chrome.storage.session.get('platformVideoJob').then(data => {
  currentJob = data.platformVideoJob;
  renderDownloadPanel();
}).catch(console.error);

downloadButton.addEventListener('click', async () => {
  requesting = true;
  renderDownloadPanel();
  try {
    const reply = await chrome.runtime.sendMessage({type: 'SAVE_PLATFORM_VIDEO'});
    if (!reply?.ok) throw new Error(reply?.error || '无法提交视频下载。');
  } catch (error) {
    currentJob = {status: 'error', text: error.message};
  } finally {
    requesting = false;
    renderDownloadPanel();
  }
});


function showVideoSettingError(text) {
  videoError.textContent = text;
  videoError.hidden = false;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.videoEnabled) reflectVideoSetting(changes.videoEnabled.newValue);
  if (area === 'session' && changes.platformVideoJob) {
    currentJob = changes.platformVideoJob.newValue;
    renderDownloadPanel();
  }
});
chrome.storage.local.get('videoEnabled').then(data => {
  reflectVideoSetting(data.videoEnabled);
  videoToggle.disabled = false;
}, () => showVideoSettingError('无法读取视频开关。请重新打开扩展弹窗。'));

videoToggle.addEventListener('change', async () => {
  const enabled = videoToggle.checked;
  videoToggle.disabled = true;
  videoError.hidden = true;
  try {
    const result = await chrome.runtime.sendMessage({type: 'SET_VIDEO_ENABLED', enabled});
    if (!result?.ok) throw new Error('视频开关保存失败');
  } catch {
    videoToggle.checked = videoEnabled;
    showVideoSettingError('视频开关更新失败，请重试。');
  } finally {
    videoToggle.disabled = false;
  }
});

try {
  const directory = await readSetting('directory');
  folder.textContent = directory?.name || '尚未选择';
  const ready = directory && await directory.queryPermission({mode: 'readwrite'}) === 'granted';
  status.dataset.ready = String(Boolean(ready));
  status.textContent = ready ? '已授权 · 可以保存' : (directory ? '需要重新授权，请打开设置' : '先选择一个文件夹');
  if (directory && !ready) document.getElementById('settings').textContent = '重新授权 / 更改图片保存位置';
  const data = await chrome.storage.local.get(['enabled', 'lastSave']);
  toggle.checked = data.enabled !== false;
  document.getElementById('last-save').textContent = data.lastSave ? `最近保存：${data.lastSave.filename}` : '';
} catch {
  folder.textContent = '读取失败';status.textContent = '请打开设置重新选择文件夹';
}
