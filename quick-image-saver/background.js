import {validateImageURL, friendlyError} from './image-utils.js';
import {ensureWriter} from './offscreen.js';
import './video.js';

async function save(url) {
  validateImageURL(url);
  await ensureWriter();
  const result = await chrome.runtime.sendMessage({target: 'writer', type: 'WRITE_IMAGE', url});
  if (!result) throw new Error('后台没有响应');
  if (result.ok) {
    await chrome.storage.local.set({lastSave: {filename: result.filename, folder: result.folder, time: Date.now()}});
  }
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.target !== 'background') return;
  if (message.type === 'SAVE_IMAGE') {
    save(message.url).then(respond, error => respond(friendlyError(error)));
    return true;
  }
  if (message.type === 'OPEN_SETTINGS') {
    chrome.runtime.openOptionsPage().then(() => respond({ok: true}), () => respond({ok: false}));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(async ({reason}) => {
  if (reason !== 'install') return;
  await chrome.storage.local.set({enabled: true});
  await chrome.runtime.openOptionsPage();
});
