import {platformVideo} from './video-sites.js';
import {resolvePlatformVideo} from './platform-resolvers.js';
import {downloadTrack, inspectMp4, mergeMp4} from './video-media.js';

let currentJob;
const retained = new Map();

const tellBackground = (id, type, data = {}) =>
  chrome.runtime.sendMessage({target: 'video-background', type, id, ...data});

async function cacheFolder() {
  const origin = await navigator.storage.getDirectory();
  return origin.getDirectoryHandle('platform-video-cache', {create: true});
}

async function discard(cache, id) {
  await cache.removeEntry(id, {recursive: true}).catch(() => {});
}

async function release(id) {
  const entry = retained.get(id);
  if (!entry) return;
  retained.delete(id);
  URL.revokeObjectURL(entry.url);
  await discard(entry.cache, id);
  if (currentJob === id) currentJob = undefined;
}

function progressFor(id) {
  let lastUpdate = 0;
  let pending = Promise.resolve();
  return (stage, percent, force = false) => {
    if (!force && Date.now() - lastUpdate < 450) return pending;
    lastUpdate = Date.now();
    pending = pending.then(() => tellBackground(id, 'VIDEO_PROGRESS', {stage, percent})).catch(() => {});
    return pending;
  };
}

async function trackFrom(directory, filename, candidates, onBytes) {
  let lastError;
  for (const urls of candidates) {
    try { return await downloadTrack(directory, filename, urls, onBytes); }
    catch (error) { lastError = error; }
  }
  throw lastError || new Error('没有找到可下载的媒体文件。');
}

async function createFile(id, video, pageData) {
  const report = progressFor(id);
  let cache;
  try {
    const plan = await resolvePlatformVideo(video, pageData);
    cache = await cacheFolder();
    for await (const [name] of cache.entries()) {
      if (/^[a-f0-9-]{36}$/.test(name) && !retained.has(name)) await discard(cache, name);
    }
    const directory = await cache.getDirectoryHandle(id, {create: true});
    const bytes = (start, span) => (written, total) =>
      report('downloading', total ? Math.min(99, Math.round(start + written / total * span)) : null);
    await report('downloading', 0, true);
    let result;
    if (plan.combined) {
      result = await downloadTrack(directory, 'result.mp4', plan.combined, bytes(0, 100));
    } else {
      const picture = await trackFrom(directory, 'picture.mp4', plan.picture, bytes(0, 85));
      const sound = await trackFrom(directory, 'sound.m4a', plan.sound, bytes(85, 15));
      await report('processing', null, true);
      result = await mergeMp4(directory, picture, sound);
    }
    const hasAudio = await inspectMp4(result);
    const url = URL.createObjectURL(new File([result], 'video.mp4', {type: 'video/mp4'}));
    retained.set(id, {cache, url});
    await tellBackground(id, 'VIDEO_READY', {url, title: plan.title, hasAudio});
  } catch (error) {
    if (cache && !retained.has(id)) await discard(cache, id);
    await release(id);
    const message = error.name === 'QuotaExceededError' ? '浏览器存储空间不足，无法完成下载。'
      : error.message?.length <= 180 ? error.message : '无法完成视频下载，请重试。';
    await tellBackground(id, 'VIDEO_FAILED', {error: message}).catch(() => {});
  } finally {
    if (currentJob === id) currentJob = undefined;
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.tab ||
      (sender.url && sender.url !== chrome.runtime.getURL('background.js')) ||
      message?.target !== 'video-writer' || !/^[a-f0-9-]{36}$/.test(message.id || '')) return;
  if (message.type === 'RELEASE_VIDEO') {
    release(message.id).then(() => respond(true), () => respond(false));
    return true;
  }
  if (message.type === 'START_VIDEO') {
    const video = platformVideo(message.video?.url);
    if (currentJob || !video) {
      respond({ok: false, error: currentJob ? '已有视频正在下载。' : '无法识别当前视频页面。'});
      return;
    }
    currentJob = message.id;
    createFile(message.id, video, message.pageData);
    respond({ok: true});
  }
});
