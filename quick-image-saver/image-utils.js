export const MAX_IMAGE_BYTES = 100 * 1024 * 1024;

export class SaveError extends Error {
  constructor(code, message) { super(message); this.name = 'SaveError'; this.code = code; }
}

export function validateImageURL(value) {
  if (typeof value !== 'string' || value.length > 145 * 1024 * 1024) {
    throw new SaveError('BAD_URL', '图片地址无效。');
  }
  let url;
  try { url = new URL(value); } catch { throw new SaveError('BAD_URL', '图片地址无效。'); }
  if (!['http:', 'https:', 'data:'].includes(url.protocol) || url.username || url.password) {
    throw new SaveError('BAD_URL', '这种图片地址暂不支持保存。');
  }
  if (url.protocol === 'data:' && !/^data:image\//i.test(value)) {
    throw new SaveError('NOT_IMAGE', '仅支持图片数据。');
  }
  return url;
}

export async function imageExtension(blob) {
  const bytes = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
  const ascii = (start, count) => String.fromCharCode(...bytes.slice(start, start + count));
  if (bytes[0] === 0x89 && ascii(1, 3) === 'PNG' && bytes[4] === 13 && bytes[5] === 10) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp';
  if (ascii(4, 4) === 'ftyp') {
    const brands = ascii(8, 56);
    if (/avif|avis/.test(brands)) return 'avif';
    if (/heic|heix|hevc|hevx|mif1|msf1/.test(brands)) return 'heic';
  }
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp';
  if (['II*\0', 'MM\0*'].includes(ascii(0, 4))) return 'tif';
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return 'ico';
  const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '').trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE\s+svg[^>]*>\s*)?<svg[\s>]/i.test(text)) return 'svg';
  const supported = {'image/jxl': 'jxl'};
  if (supported[blob.type] && bytes[0] === 0xff && bytes[1] === 0x0a) return supported[blob.type];
  throw new SaveError('NOT_IMAGE', '服务器返回的内容不是支持的图片，可能需要登录或遇到了防盗链。');
}

export function safeFilename(urlValue, extension, now = new Date()) {
  let name = '';
  try {
    const url = new URL(urlValue);
    if (url.protocol !== 'data:') name = decodeURIComponent(url.pathname.split('/').pop() || '');
  } catch { /* Use a generated name for invalid encodings. */ }
  name = name.replace(/\.(?:jpe?g|png|gif|webp|avif|bmp|tiff?|ico|svg|heic|heif|jxl)$/i, '');
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/g, '_')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '').replace(/^[. ]+|[. ]+$/g, '');
  name = Array.from(name).slice(0, 100).join('').replace(/[. ]+$/g, '');
  if (!name) name = '图片_' + now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name + '.' + extension;
}

export async function unusedFilename(directory, filename) {
  const dot = filename.lastIndexOf('.');
  const stem = filename.slice(0, dot);
  const ext = filename.slice(dot);
  for (let i = 0; i < 10000; i++) {
    const candidate = i === 0 ? filename : `${stem} (${i})${ext}`;
    try {
      await directory.getFileHandle(candidate);
    } catch (error) {
      if (error.name === 'NotFoundError') {
        // A directory with this name is also a collision.
        try { await directory.getDirectoryHandle(candidate); }
        catch (dirError) {
          if (dirError.name === 'NotFoundError') return candidate;
          if (dirError.name !== 'TypeMismatchError') throw dirError;
        }
      } else if (error.name !== 'TypeMismatchError') throw error;
    }
  }
  throw new SaveError('NAME_CONFLICT', '这个文件夹里的同名文件过多，请切换文件夹。');
}

export async function fetchImage(urlValue, fetchFn = fetch) {
  validateImageURL(urlValue);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetchFn(urlValue, {credentials: 'include', signal: controller.signal, cache: 'default'});
    if (!response.ok) throw new SaveError('HTTP_ERROR', `图片下载失败（HTTP ${response.status}），请确认登录状态或换一张图片。`);
    const length = Number(response.headers.get('content-length'));
    if (length > MAX_IMAGE_BYTES) throw new SaveError('TOO_LARGE', '图片超过 100 MB，暂不支持保存。');
    const reader = response.body?.getReader();
    if (!reader) throw new SaveError('EMPTY_IMAGE', '图片内容为空。');
    const chunks = [];
    let size = 0;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new SaveError('TOO_LARGE', '图片超过 100 MB，暂不支持保存。');
      }
      chunks.push(value);
    }
    if (!size) throw new SaveError('EMPTY_IMAGE', '图片内容为空。');
    const blob = new Blob(chunks, {type: response.headers.get('content-type')?.split(';')[0].trim() || ''});
    const extension = await imageExtension(blob);
    return {blob, extension};
  } catch (error) {
    if (error.name === 'AbortError') throw new SaveError('TIMEOUT', '图片下载超时，请稍后重试。');
    if (error instanceof SaveError) throw error;
    throw new SaveError('NETWORK_ERROR', '无法获取图片，可能是网络、登录状态或网站防盗链限制。');
  } finally { clearTimeout(timer); }
}

export function friendlyError(error) {
  if (error instanceof SaveError) return {ok: false, code: error.code, error: error.message};
  if (['NotAllowedError', 'SecurityError'].includes(error?.name)) {
    return {ok: false, code: 'NEED_PERMISSION', error: '保存权限已失效，请点击扩展图标，重新授权文件夹。'};
  }
  if (error?.name === 'QuotaExceededError') return {ok: false, code: 'DISK_FULL', error: '磁盘空间不足，请清理空间或更换文件夹。'};
  if (error?.name === 'NotFoundError') return {ok: false, code: 'FOLDER_MISSING', error: '保存文件夹已移动或删除，请重新选择。'};
  return {ok: false, code: 'SAVE_FAILED', error: '保存失败，请检查文件夹是否可写，或重新选择保存位置。'};
}
