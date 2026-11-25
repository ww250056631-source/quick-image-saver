import {fetchMediaResource} from './video-media.js';

const youtubeAgent = 'com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)';

async function request(url, options) {
  let failure;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchMediaResource(url, {timeout: 20000, ...options});
      if (response.ok) return response;
      failure = new Error(`平台返回 HTTP ${response.status}。请确认视频能正常播放。`);
      if (response.status === 429) break;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

function verifiedUrl(address, site) {
  let url;
  try { url = new URL(address); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname;
  if (site === 'YouTube' && /(?:^|\.)googlevideo\.com$/.test(host) && url.pathname === '/videoplayback') return url.href;
  if (site === 'X' && host === 'video.twimg.com' && /\.mp4$/i.test(url.pathname)) return url.href;
  if (site === 'B 站' && (/(?:^|\.)(?:bilivideo\.com|bilivideo\.cn|biliapi\.net)$/.test(host) ||
      /^upos-[a-z\d-]+\.akamaized\.net$/.test(host))) return url.href;
  return null;
}

const asList = value => Array.isArray(value) ? value : [];
const uniqueUrls = (values, site) => [...new Set(values.map(url => verifiedUrl(url, site)).filter(Boolean))];

export function readAssignedJson(html, variable) {
  const expression = new RegExp(`\\b${variable}\\s*=\\s*\\{`);
  const match = expression.exec(html);
  if (!match) return null;
  const start = match.index + match[0].length - 1;
  let depth = 0;
  let string = false;
  let escaped = false;
  for (let index = start; index < html.length; index++) {
    const char = html[index];
    if (string) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') string = false;
    } else if (char === '"') {
      string = true;
    } else if (char === '{') {
      depth++;
    } else if (char === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, index + 1)); } catch { return null; }
    }
  }
  return null;
}

function biliUrls(track) {
  return uniqueUrls([track?.baseUrl || track?.base_url, ...asList(track?.backupUrl ?? track?.backup_url)], 'B 站');
}

function biliPlan(playback, title) {
  const streams = playback?.data ?? playback?.result;
  if (!streams) return null;
  const videos = asList(streams.dash?.video).filter(track => /^avc/i.test(track.codecs ?? '') && biliUrls(track).length)
    .sort((a, b) => (b.height || b.id) - (a.height || a.id));
  const audios = asList(streams.dash?.audio).filter(track => /^mp4a/i.test(track.codecs ?? '') && biliUrls(track).length)
    .sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
  if (videos.length && audios.length) {
    return {title, picture: videos.map(biliUrls), sound: audios.map(biliUrls)};
  }
  const progressive = asList(streams.durl);
  if (progressive.length === 1 && (/mp4/i.test(streams.format ?? '') || /\.mp4(?:\?|$)/i.test(progressive[0].url))) {
    const urls = uniqueUrls([progressive[0].url, ...asList(progressive[0].backup_url)], 'B 站');
    if (urls.length) return {title, combined: urls};
  }
  return null;
}

async function resolveBilibili(video, pageData) {
  let data = pageData?.videoData;
  let title = data?.title || pageData?.title || 'B 站视频';
  const fromTab = biliPlan(pageData?.playback, title);
  if (fromTab) return fromTab;

  if (!data?.pages?.length) {
    const page = await (await request(video.url, {credentials: 'include'})).text();
    data = readAssignedJson(page, '__INITIAL_STATE__')?.videoData;
    title = data?.title || title;
    const fromPage = biliPlan(readAssignedJson(page, '__playinfo__'), title);
    if (fromPage) return fromPage;
  }
  const cid = asList(data?.pages)[video.page - 1]?.cid ?? (video.page === 1 ? data?.cid : null);
  if (!cid) throw new Error('B 站没有返回当前分集的信息。请确认视频已加载。');
  const partTitle = video.page > 1 ? asList(data.pages)[video.page - 1]?.part : null;
  if (partTitle) title += ' · ' + partTitle;
  const params = new URLSearchParams({
    ...(video.id.startsWith('BV') ? {bvid: video.id} : {avid: video.id.slice(2)}),
    cid: String(cid), qn: '80', fnver: '0', fnval: '16', fourk: '1'
  });
  const response = await request('https://api.bilibili.com/x/player/playurl?' + params, {credentials: 'include'});
  const plan = biliPlan(await response.json(), title);
  if (plan) return plan;
  throw new Error('B 站没有提供可保存的音视频格式。请确认视频能正常播放。');
}

function youtubePlan(data) {
  const title = data?.videoDetails?.title || 'YouTube 视频';
  const progressive = asList(data?.streamingData?.formats)
    .filter(item => /^video\/mp4/i.test(item.mimeType ?? '') && verifiedUrl(item.url, 'YouTube'))
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
  const adaptive = asList(data?.streamingData?.adaptiveFormats);
  const picture = adaptive.filter(item => /^video\/mp4.*avc/i.test(item.mimeType ?? '') &&
      Math.min(item.width ?? 1080, item.height ?? 1080) <= 1080 && verifiedUrl(item.url, 'YouTube'))
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0)).map(item => [verifiedUrl(item.url, 'YouTube')]);
  const sound = adaptive.filter(item => /^audio\/mp4.*mp4a/i.test(item.mimeType ?? '') && verifiedUrl(item.url, 'YouTube'))
    .sort((a, b) => Number(Boolean(a.isDrc)) - Number(Boolean(b.isDrc)) || (b.bitrate ?? 0) - (a.bitrate ?? 0));
  if (picture.length && sound.length) return {title, picture, sound: sound.map(item => [verifiedUrl(item.url, 'YouTube')])};
  if (progressive.length) return {title, combined: [verifiedUrl(progressive[0].url, 'YouTube')]};
  return null;
}

async function resolveYouTube(video, pageData) {
  const page = pageData?.playback;
  const fromPage = page?.videoDetails?.videoId === video.id && youtubePlan(page);
  if (fromPage) return fromPage;

  const client = {
    clientName: 'IOS', clientVersion: '20.11.6',
    deviceModel: 'iPhone10,4', osName: 'iOS', osVersion: '16.7.7.20H330',
    hl: 'en', gl: 'US', timeZone: 'UTC', utcOffsetMinutes: 0, userAgent: youtubeAgent
  };
  const response = await request('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST', headers: {'Content-Type': 'application/json', 'X-YouTube-Client-Name': '5',
      'X-YouTube-Client-Version': client.clientVersion, 'User-Agent': youtubeAgent},
    body: JSON.stringify({context: {client}, videoId: video.id,
      playbackContext: {contentPlaybackContext: {html5Preference: 'HTML5_PREF_WANTS'}}})
  });
  const payload = await response.json();
  const plan = youtubePlan(payload);
  if (plan && payload.videoDetails?.videoId === video.id) return plan;
  if (payload.playabilityStatus?.status === 'LOGIN_REQUIRED') {
    throw new Error('YouTube 要求登录或验证才能提供这条视频。');
  }
  throw new Error('YouTube 没有返回当前视频可保存的 MP4 音视频格式。');
}

async function resolveX(video) {
  const token = ((Number(video.id) / 1e15) * Math.PI).toString(36).replace(/0+|\./g, '');
  const response = await request('https://cdn.syndication.twimg.com/tweet-result?' + new URLSearchParams({id: video.id, token}));
  const post = await response.json();
  if (post.id_str && post.id_str !== video.id) throw new Error('X 返回了其他帖子的内容。');
  const media = [...asList(post.mediaDetails), ...asList(post.quoted_tweet?.mediaDetails)]
    .filter(item => item.type === 'video' || item.type === 'animated_gif');
  const variants = asList(media[video.index - 1]?.video_info?.variants)
    .filter(item => item.content_type === 'video/mp4')
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  const combined = variants.map(item => verifiedUrl(item.url, 'X')).find(Boolean);
  if (!combined) throw new Error('这条 X 帖子没有提供可保存的 MP4 视频。');
  const title = [post.user?.name, post.text?.replace(/https?:\/\/\S+/g, '').trim()].filter(Boolean).join(' · ') || 'X 视频';
  return {title, combined: [combined]};
}

export function resolvePlatformVideo(video, pageData) {
  if (video.name === 'B 站') return resolveBilibili(video, pageData);
  if (video.name === 'YouTube') return resolveYouTube(video, pageData);
  if (video.name === 'X') return resolveX(video);
  throw new Error('请打开 B 站、YouTube 或 X 的视频详情页。');
}
