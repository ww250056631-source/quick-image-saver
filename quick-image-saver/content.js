(() => {
  if (globalThis.__quickImageSaver) return;
  globalThis.__quickImageSaver = true;
  let enabled = true;
  let currentImage;
  let hideTimer;
  let toastTimer;
  const pending = new Set();
  const host = document.createElement('quick-image-saver-ui');
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;display:block!important;';
  const shadow = host.attachShadow({mode: 'closed'});
  shadow.innerHTML = `
    <style>
      *{box-sizing:border-box}button{font:500 13px/1.3 system-ui,"Microsoft YaHei",sans-serif;cursor:pointer;border:0}
      #save{position:fixed;display:none;pointer-events:auto;background:#2563eb;color:white;padding:9px 12px;border:1px solid #ffffff80;border-radius:9px;box-shadow:0 3px 14px #0004;white-space:nowrap;align-items:center;gap:5px}
      #save:hover{background:#1d4ed8}#save:focus-visible{outline:3px solid #fbbf24;outline-offset:2px}#save:disabled{cursor:wait;opacity:.85}
      #toast{display:none;position:fixed;bottom:24px;left:50%;transform:translateX(-50%);max-width:min(580px,calc(100vw - 24px));background:#10243b;color:#fff;border:1px solid #ffffff30;border-radius:12px;padding:13px 16px;box-shadow:0 8px 32px #0003;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;pointer-events:auto;overflow-wrap:anywhere}
      #toast[data-error="true"]{background:#7f1d1d}#setup{margin-left:10px;padding:5px 9px;border-radius:6px;color:#10243b;background:#fff}#close{margin-left:10px;background:none;color:#fff;font-size:17px}
    </style>
    <button id="save" type="button" aria-label="保存这张图片到设置的文件夹">↓ 快存</button>
    <div id="toast" role="status" aria-live="polite"><span id="text"></span><button id="setup" type="button" hidden>设置文件夹</button><button id="close" type="button" aria-label="关闭提示">×</button></div>`;
  (document.documentElement || document.body).append(host);
  const button = shadow.getElementById('save');
  const toast = shadow.getElementById('toast');
  const setup = shadow.getElementById('setup');

  function showToast(text, error = false, needsSetup = false) {
    clearTimeout(toastTimer);
    shadow.getElementById('text').textContent = text;
    toast.dataset.error = String(error);
    setup.hidden = !needsSetup;
    toast.style.display = 'block';
    toastTimer = setTimeout(() => {toast.style.display = 'none';}, error ? 10000 : 3500);
  }
  setup.addEventListener('click', () => chrome.runtime.sendMessage({target: 'background', type: 'OPEN_SETTINGS'}).catch(() => {}));
  shadow.getElementById('close').addEventListener('click', () => {toast.style.display = 'none';});
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'VIDEO_SAVE_ERROR') return;
    showToast(message.text, true);
    respond(true);
  });

  function hide() { currentImage = null; button.style.display = 'none'; }
  function position() {
    if (!currentImage?.isConnected || !enabled) return hide();
    const rect = currentImage.getBoundingClientRect();
    if (rect.width < 48 || rect.height < 48 || rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) return hide();
    const width = button.offsetWidth || 78;
    const height = button.offsetHeight || 38;
    const left = Math.max(4, Math.min(rect.right - width - 6, innerWidth - width - 4));
    const top = Math.max(4, Math.min(Math.max(0, rect.top) + 6, rect.bottom - height - 4, innerHeight - height - 4));
    button.style.left = left + 'px'; button.style.top = top + 'px';
    button.style.display = 'flex';
  }
  document.addEventListener('pointerover', event => {
    if (!enabled) return;
    if (event.target === host) {clearTimeout(hideTimer);return;}
    const image = event.composedPath().find(node => node instanceof HTMLImageElement);
    if (image && (image.currentSrc || image.src)) {
      clearTimeout(hideTimer); currentImage = image; position();
    } else {
      clearTimeout(hideTimer); hideTimer = setTimeout(hide, 180);
    }
  }, true);
  document.addEventListener('pointerout', event => {
    if (!event.relatedTarget) hideTimer = setTimeout(hide, 180);
  }, true);
  button.addEventListener('pointerenter', () => clearTimeout(hideTimer));
  button.addEventListener('pointerleave', () => {hideTimer = setTimeout(hide, 180);});
  window.addEventListener('scroll', position, {passive: true, capture: true});
  window.addEventListener('resize', position, {passive: true});
  button.addEventListener('pointerdown', event => {event.stopPropagation();});

  async function blobURLToDataURL(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const response = await fetch(url, {signal: controller.signal});
      const blob = await response.blob();
      if (blob.size > 100 * 1024 * 1024) throw new Error('图片超过 100 MB，暂不支持保存。');
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();reader.onload = () => resolve(reader.result);reader.onerror = () => reject(new Error('读取图片失败。'));reader.readAsDataURL(blob);
      });
    } finally {clearTimeout(timer);}
  }

  button.addEventListener('click', async event => {
    event.preventDefault();event.stopPropagation();
    let url = currentImage?.currentSrc || currentImage?.src;
    if (!url || pending.has(url)) return;
    const original = url;
    pending.add(original);button.disabled = true;button.textContent = '保存中…';
    try {
      if (url.startsWith('blob:')) url = await blobURLToDataURL(url);
      const result = await chrome.runtime.sendMessage({target: 'background', type: 'SAVE_IMAGE', url});
      if (!result?.ok) {
        const code = result?.code;
        showToast(result?.error || '保存失败，请重新加载网页再试。', true, ['NEED_DIRECTORY', 'NEED_PERMISSION', 'FOLDER_MISSING'].includes(code));
      } else showToast(`已保存到「${result.folder}」：${result.filename}`);
    } catch (error) {
      showToast(/context invalidated|receiving end/i.test(error.message) ? '扩展已更新，请刷新网页后重试。' : (error.message || '保存失败，请重试。'), true);
    } finally {pending.delete(original);button.disabled = false;button.textContent = '↓ 快存';}
  });

  chrome.storage.local.get('enabled').then(result => {enabled = result.enabled !== false; if (!enabled) hide();});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.enabled) {enabled = changes.enabled.newValue !== false;if (!enabled) hide();}
  });
})();
