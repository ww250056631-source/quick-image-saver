import {
  BlobSource, EncodedAudioPacketSource, EncodedPacketSink, EncodedVideoPacketSource,
  Input, MP4, Mp4OutputFormat, Output, StreamTarget
} from './vendor/mediabunny.min.mjs';

const networkMessage = '视频连接中断。请确认网页能播放，再点一次保存。';
const chunkSize = 2 * 1024 * 1024;

export async function fetchMediaResource(url, {timeout = 30000, ...options} = {}) {
  let response;
  try {
    response = await fetch(url, {
      credentials: 'omit', signal: AbortSignal.timeout(timeout), ...options
    });
  } catch {
    throw new Error(networkMessage);
  }
  return response;
}

async function requestYouTubeRange(address, offset, limit) {
  const url = new URL(address);
  if (!/(?:^|\.)googlevideo\.com$/.test(url.hostname) || url.pathname !== '/videoplayback' ||
      (url.searchParams.get('sparams') || '').split(',').includes('range')) return null;
  const total = Number(url.searchParams.get('clen'));
  if (!Number.isSafeInteger(total) || total <= offset || url.searchParams.has('range')) return null;
  const length = Math.min(limit, total - offset);
  const rangeAddress = address + '&range=' + offset + '-' + (offset + length - 1);
  const response = await fetchMediaResource(rangeAddress);
  const size = Number(response.headers.get('content-length'));
  if (!response.ok || size !== length) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const data = new Uint8Array(await response.arrayBuffer());
  return data.byteLength === length ? {data, total} : null;
}

async function requestRange(sources, offset, limit) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const url of sources) {
      try {
        const response = await fetchMediaResource(url, {headers: {Range: `bytes=${offset}-${offset + limit - 1}`}});
        if (response.status === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
          if (range && Number(range[1]) === offset && Number(range[2]) >= offset &&
              Number(range[2]) < Number(range[3]) && Number(range[3]) <= Number.MAX_SAFE_INTEGER) {
            const data = new Uint8Array(await response.arrayBuffer());
            if (data.byteLength === Number(range[2]) - offset + 1) return {data, total: Number(range[3])};
          }
          lastError = new Error('媒体服务器返回了不完整的数据。');
        } else if (response.ok && offset === 0 && response.body &&
                   !/(?:html|json|text\/plain)/i.test(response.headers.get('content-type') ?? '')) {
          return {body: response.body, total: Number(response.headers.get('content-length')) || null};
        } else {
          const rejected = [401, 403, 404, 410, 429].includes(response.status);
          lastError = new Error(rejected ? `媒体服务器拒绝了下载请求（HTTP ${response.status}）。请重新打开视频页后重试。` : `媒体服务器返回 HTTP ${response.status}。请稍后重试。`);
          lastError.status = response.status;
        }
        await response.body?.cancel().catch(() => {});
      } catch (error) {
        lastError = error;
      }
      try {
        const alternative = await requestYouTubeRange(url, offset, limit);
        if (alternative) return alternative;
      } catch { /* Try the next available source. */ }
    }
    if ([401, 403, 404, 410, 429].includes(lastError?.status)) break;
  }
  throw lastError ?? new Error(networkMessage);
}

export async function downloadTrack(directory, name, sources, report) {
  const handle = await directory.getFileHandle(name, {create: true});
  const file = await handle.createWritable();
  const youtube = /(?:^|\.)googlevideo\.com$/.test(new URL(sources[0]).hostname);
  let limit = chunkSize;
  let offset = 0;
  let total;
  try {
    do {
      let chunk;
      while (!chunk) {
        try { chunk = await requestRange(sources, offset, limit); }
        catch (error) {
          if (!youtube || limit <= 256 * 1024) throw error;
          limit /= 2;
        }
      }
      if (total && chunk.total !== total) throw new Error('视频文件在下载期间发生变化，请重试。');
      total = chunk.total;
      if (chunk.body) {
        const reader = chunk.body.getReader();
        try {
          while (true) {
            const {value, done} = await reader.read();
            if (done) break;
            await file.write(value);
            offset += value.byteLength;
            report(offset, total);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        break;
      }
      await file.write(chunk.data);
      offset += chunk.data.byteLength;
      report(offset, total);
    } while (offset < total);

    if (!offset || (total && offset !== total)) throw new Error('视频文件没有完整下载。');
    await file.close();
    return handle.getFile();
  } catch (error) {
    await file.abort().catch(() => {});
    throw error;
  }
}

function openMp4(blob) {
  return new Input({formats: [MP4], source: new BlobSource(blob)});
}

export async function inspectMp4(blob) {
  const input = openMp4(blob);
  try {
    if (!(await input.getPrimaryVideoTrack())) throw new Error('文件缺少可播放的视频轨道。');
    return Boolean(await input.getPrimaryAudioTrack());
  } finally { input.dispose(); }
}

async function pipePackets(track, source) {
  const config = await track.getDecoderConfig();
  if (!config) throw new Error('浏览器无法识别音视频轨道。');
  let meta = {decoderConfig: config};
  for await (const packet of new EncodedPacketSink(track).packets()) {
    await source.add(packet, meta);
    meta = undefined;
  }
  source.close();
}

export async function mergeMp4(directory, videoFile, audioFile) {
  const video = openMp4(videoFile);
  const audio = openMp4(audioFile);
  let output;
  try {
    const videoTrack = await video.getPrimaryVideoTrack();
    const audioTrack = await audio.getPrimaryAudioTrack();
    const videoCodec = await videoTrack?.getCodec();
    const audioCodec = await audioTrack?.getCodec();
    if (!videoCodec || !audioCodec) throw new Error('网页返回的音视频格式无法合并。');
    const handle = await directory.getFileHandle('result.mp4', {create: true});
    const target = new StreamTarget(await handle.createWritable(), {chunked: true});
    output = new Output({target, format: new Mp4OutputFormat({fastStart: false})});
    const videoSource = new EncodedVideoPacketSource(videoCodec);
    const audioSource = new EncodedAudioPacketSource(audioCodec);
    output.addVideoTrack(videoSource, {rotation: await videoTrack.getRotation()});
    output.addAudioTrack(audioSource);
    await output.start();
    await Promise.all([pipePackets(videoTrack, videoSource), pipePackets(audioTrack, audioSource)]);
    await output.finalize();
    return handle.getFile();
  } catch (error) {
    await output?.cancel().catch(() => {});
    throw error;
  } finally {
    video.dispose();
    audio.dispose();
  }
}
