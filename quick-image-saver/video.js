import {platformVideo} from './video-sites.js';
import {startPlatformDownload} from './platform-download.js';

const menuId = 'quick-save-video';
const defaults = {videoEnabled: false};
let menuUpdate = Promise.resolve();

function updateVideoMenu(visible) {
  return new Promise((resolve, reject) => {
    chrome.contextMenus.update(menuId, {visible}, () => {
      if (!chrome.runtime.lastError) {
        resolve();
        return;
      }
      chrome.contextMenus.create({
        id: menuId,
        title: '保存视频',
        contexts: ['video'],
        documentUrlPatterns: ['http://*/*', 'https://*/*'],
        visible
      }, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  });
}

function applyVideoSetting(requested) {
  const update = menuUpdate.then(async () => {
    const {videoEnabled} = await chrome.storage.local.get(defaults);
    const enabled = requested ?? videoEnabled;
    await updateVideoMenu(enabled);
    if (enabled !== videoEnabled) {
      try {
        await chrome.storage.local.set({videoEnabled: enabled});
      } catch (error) {
        await updateVideoMenu(videoEnabled);
        throw error;
      }
    }
  });
  menuUpdate = update.catch(error => console.error('更新视频菜单失败', error));
  return update;
}

chrome.runtime.onInstalled.addListener(() => { applyVideoSetting(); });
chrome.runtime.onStartup.addListener(() => { applyVideoSetting(); });

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return;
  if (message?.type === 'SET_VIDEO_ENABLED' && typeof message.enabled === 'boolean') {
    applyVideoSetting(message.enabled).then(() => respond({ok: true}), () => respond({ok: false}));
    return true;
  }
  if (message?.type === 'SAVE_PLATFORM_VIDEO') {
    saveCurrentPlatformVideo().then(() => respond({ok: true}), error => respond({ok: false, error: error.message}));
    return true;
  }
});

async function videoIsEnabled() {
  await menuUpdate;
  const {videoEnabled} = await chrome.storage.local.get(defaults);
  return videoEnabled;
}

async function saveCurrentPlatformVideo() {
  if (!(await videoIsEnabled())) throw new Error('请先开启「保存视频」。');
  const [tab] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
  const video = platformVideo(tab?.url);
  if (!video) throw new Error('请打开 B 站、YouTube 或 X 的视频详情页。');
  await startPlatformDownload(video, tab);
}

const errorMessages = {
  unsupported: '此视频没有可直接下载的文件地址。可保存 MP4、WebM 等普通视频文件。',
  failed: '无法开始下载视频。请确认视频仍能播放，再试一次。'
};

async function showVideoError(tab, frameId, reason, text = errorMessages[reason]) {
  if (Number.isInteger(tab?.id)) {
    const message = {type: 'VIDEO_SAVE_ERROR', text};
    const frames = frameId ? [frameId, 0] : [0];
    for (const id of frames) {
      // A page opened before installation or an update may not have the current content script.
      const shown = await chrome.tabs.sendMessage(tab.id, message, {frameId: id}).catch(() => false);
      if (shown) return;
    }
  }
  await chrome.tabs.create({url: chrome.runtime.getURL(`video-error.html#${reason}`)});
}

async function downloadVideo(info, tab) {
  if (!(await videoIsEnabled())) return;

  const video = platformVideo(info.frameUrl) || platformVideo(info.pageUrl) || platformVideo(tab?.url);
  if (video) {
    try { await startPlatformDownload(video, tab, true); }
    catch (error) { await showVideoError(tab, info.frameId, 'platform', error.message); }
    return;
  }

  let source;
  try { source = new URL(info.srcUrl); } catch { /* The video may not have a file URL. */ }
  if (!source || !['http:', 'https:'].includes(source.protocol) || /\.(m3u8?|mpd)$/i.test(source.pathname)) {
    await showVideoError(tab, info.frameId, 'unsupported');
    return;
  }

  try {
    await chrome.downloads.download({url: source.href, conflictAction: 'uniquify'});
  } catch {
    await showVideoError(tab, info.frameId, 'failed');
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== menuId) return;
  downloadVideo(info, tab).catch(error => console.error('保存视频失败', error));
});
