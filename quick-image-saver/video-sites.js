const youtubeHosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'];
const xHosts = ['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'];

export function platformVideo(address) {
  let url;
  try { url = new URL(address); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.port || url.username || url.password) return null;
  const {hostname, pathname, searchParams} = url;

  if (youtubeHosts.includes(hostname) || hostname === 'youtu.be') {
    const id = hostname === 'youtu.be' ? /^\/([\w-]{11})\/?$/.exec(pathname)?.[1]
      : pathname === '/watch' ? searchParams.get('v')
      : /^\/(?:shorts|embed)\/([\w-]{11})\/?$/.exec(pathname)?.[1];
    if (id && /^[\w-]{11}$/.test(id)) return {name: 'YouTube', id, url: `https://www.youtube.com/watch?v=${id}`};
  }

  if (['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(hostname)) {
    const id = /^\/video\/(BV[0-9A-Za-z]{10}|av[0-9]{1,20})\/?$/.exec(pathname)?.[1];
    const part = searchParams.get('p');
    if (id) {
      const page = /^[1-9]\d{0,5}$/.test(part ?? '') ? Number(part) : 1;
      return {name: 'B 站', id, page, url: `https://www.bilibili.com/video/${id}${page > 1 ? `?p=${page}` : ''}`};
    }
  }

  if (xHosts.includes(hostname)) {
    const match = /^\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status\/(\d{1,20})(?:\/video\/([1-9]\d{0,2}))?\/?$/.exec(pathname);
    if (match) return {name: 'X', id: match[1], index: Number(match[2] ?? 1), url: `https://x.com/i/web/status/${match[1]}${match[2] ? `/video/${match[2]}` : ''}`};
  }

  return null;
}
