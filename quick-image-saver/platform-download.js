import {ensureWriter} from './offscreen.js';

const jobKey = 'platformVideoJob';
const busy = new Set(['starting', 'downloading', 'processing', 'saving']);
const headerRuleId = 13001;
const googleMediaRuleId = 13002;
let launching = false;

const readJob = async () => (await chrome.storage.session.get(jobKey))[jobKey];
const writeJob = job => chrome.storage.session.set({[jobKey]: job});
const sendWriter = (type, fields) => chrome.runtime.sendMessage({target: 'video-writer', type, ...fields});

function capturePlayer(site, expectedId, expectedPart) {
  try {
    if (site === 'B 站') {
      const state = globalThis.__INITIAL_STATE__;
      const videoData = state?.videoData;
      const actualPart = Number(new URLSearchParams(location.search).get('p')) || 1;
      if (!videoData || actualPart !== expectedPart ||
          (videoData.bvid !== expectedId && 'av' + videoData.aid !== expectedId)) return null;
      return {playback: globalThis.__playinfo__, videoData, title: document.title};
    }
    if (site !== 'YouTube') return null;
    const player = document.getElementById('movie_player');
    const candidate = player?.getPlayerResponse?.() ?? globalThis.ytInitialPlayerResponse;
    if (candidate?.videoDetails?.videoId !== expectedId) return null;
    return {playback: {streamingData: candidate.streamingData, videoDetails: candidate.videoDetails}, title: document.title};
  } catch { return null; }
}

async function setPlatformHeaders(site) {
  if (site === 'X') return;
  const bili = site === 'B 站';
  const addRules = [{
    id: headerRuleId, priority: 1,
    action: {type: 'modifyHeaders', requestHeaders: bili ? [
      {header: 'Referer', operation: 'set', value: 'https://www.bilibili.com/'}
    ] : [
      {header: 'User-Agent', operation: 'set', value: 'com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)'},
      {header: 'Origin', operation: 'remove'}
    ]},
    condition: {
      initiatorDomains: [chrome.runtime.id],
      ...(bili
        ? {requestDomains: ['api.bilibili.com', 'bilivideo.com', 'bilivideo.cn', 'akamaized.net', 'biliapi.net']}
        : {urlFilter: '|https://www.youtube.com/youtubei/v1/player?', requestMethods: ['post']}),
      resourceTypes: ['xmlhttprequest']
    }
  }];
  if (!bili) addRules.push({
    id: googleMediaRuleId, priority: 1,
    action: {type: 'modifyHeaders', requestHeaders: [{header: 'Origin', operation: 'remove'}]},
    condition: {initiatorDomains: [chrome.runtime.id], urlFilter: '||googlevideo.com/videoplayback?',
      requestMethods: ['get'], resourceTypes: ['xmlhttprequest']}
  });
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [headerRuleId, googleMediaRuleId], addRules
  });
}

export async function startPlatformDownload(video, tab, notify = false) {
  if (launching) throw new Error('正在准备另一个视频。');
  launching = true;
  let job;
  try {
    const previous = await readJob();
    if (busy.has(previous?.status)) throw new Error('正在保存另一个视频，请等待当前任务完成。');
    job = {id: crypto.randomUUID(), site: video.name, status: 'starting', text: '正在读取视频信息…', notify, tabId: tab?.id};
    await writeJob(job);
    await setPlatformHeaders(video.name);
    const pageData = Number.isInteger(tab?.id) && video.name !== 'X' ?
      (await chrome.scripting.executeScript({
        target: {tabId: tab.id}, world: 'MAIN', func: capturePlayer, args: [video.name, video.id, video.page ?? 1]
      }).catch(() => []))[0]?.result : null;
    await ensureWriter();
    const reply = await sendWriter('START_VIDEO', {id: job.id, video, pageData});
    if (!reply?.ok) throw new Error(reply?.error || '无法启动视频下载。请重新加载扩展后重试。');
  } catch (error) {
    if (job) await finish(job, 'error', error.message);
    throw error;
  } finally {
    launching = false;
  }
}

function safeName(title) {
  const clean = String(title || '网页视频').normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 96).replace(/[. ]+$/, '');
  return /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(clean) ? '_' + clean : clean || '网页视频';
}

async function finish(job, status, text, extra = {}) {
  if (job.site !== 'X') {
    await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds: [headerRuleId, googleMediaRuleId]}).catch(() => {});
  }
  await sendWriter('RELEASE_VIDEO', {id: job.id}).catch(() => {});
  await writeJob({...job, status, text, percent: null, ...extra});
  if (status === 'error' && job.notify && Number.isInteger(job.tabId)) {
    await chrome.tabs.sendMessage(job.tabId, {type: 'VIDEO_SAVE_ERROR', text}, {frameId: 0}).catch(() => {});
  }
}

async function settleDownload(job, item) {
  if (item?.state === 'complete') {
    await finish(job, 'done', job.hasAudio ? '已保存 MP4' : '已保存 MP4 · 源视频无音轨', {path: item.filename});
  } else if (item?.state === 'interrupted') {
    await finish(job, 'error', item.error === 'USER_CANCELED' ? '下载已取消。' : 'Chrome 未能把文件写入下载位置。');
  }
}

async function handleWriterMessage(message) {
  const job = await readJob();
  if (job?.id !== message.id || !busy.has(job.status)) return;
  if (message.type === 'VIDEO_PROGRESS') {
    if (job.status === 'saving') return;
    const status = message.stage === 'processing' ? 'processing' : 'downloading';
    const text = status === 'processing' ? '正在合并音视频…' : '正在下载音视频…';
    await writeJob({...job, status, text, percent: Number.isFinite(message.percent) ? message.percent : null});
    return;
  }
  if (message.type === 'VIDEO_FAILED') {
    await finish(job, 'error', String(message.error || '视频下载失败。'));
    return;
  }
  if (message.type !== 'VIDEO_READY' || job.status === 'saving') return;
  try {
    if (typeof message.url !== 'string' || !message.url.startsWith('blob:' + chrome.runtime.getURL(''))) {
      throw new Error('浏览器没有收到有效的 MP4 文件。');
    }
    const saving = {...job, status: 'saving', text: '正在保存到下载位置…', hasAudio: message.hasAudio === true, percent: null};
    await writeJob(saving);
    const downloadId = await chrome.downloads.download({
      url: message.url, filename: safeName(message.title) + '.mp4', conflictAction: 'uniquify'
    });
    const tracked = {...saving, downloadId};
    await writeJob(tracked);
    await settleDownload(tracked, (await chrome.downloads.search({id: downloadId}))[0]);
  } catch (error) {
    await finish(job, 'error', '无法开始 Chrome 下载。请检查浏览器的下载设置。');
  }
}

let writerUpdates = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('writer.html') ||
      message?.target !== 'video-background') return;
  const update = writerUpdates.then(() => handleWriterMessage(message));
  writerUpdates = update.catch(console.error);
  update.then(() => respond(true), () => respond(false));
  return true;
});

chrome.downloads.onChanged.addListener(delta => {
  if (!delta.state) return;
  writerUpdates = writerUpdates.then(async () => {
    const job = await readJob();
    if (job?.downloadId !== delta.id || job.status !== 'saving') return;
    await settleDownload(job, (await chrome.downloads.search({id: delta.id}))[0]);
  }).catch(console.error);
});
