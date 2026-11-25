import {readSetting} from './db.js';
import {fetchImage, safeFilename, unusedFilename, SaveError, friendlyError} from './image-utils.js';

// All saves share one queue, even when they originate in different tabs.
let queue = Promise.resolve();
async function saveImage(url, directory) {
  if (!directory) throw new SaveError('NEED_DIRECTORY', '请先点击扩展图标，选择保存文件夹。');
  if (await directory.queryPermission({mode: 'readwrite'}) !== 'granted') {
    throw new SaveError('NEED_PERMISSION', `「${directory.name}」需要重新授权，图片未保存到其他位置。请点击扩展图标恢复权限。`);
  }
  const {blob, extension} = await fetchImage(url);
  const filename = await unusedFilename(directory, safeFilename(url, extension));
  const file = await directory.getFileHandle(filename, {create: true});
  let stream;
  try {
    stream = await file.createWritable();
    await stream.write(blob);
    await stream.close();
  } catch (error) {
    try { await stream?.abort(); } catch { /* Already closed. */ }
    // Never delete or overwrite another file after a failed write.
    throw error;
  }
  return {ok: true, filename, folder: directory.name, bytes: blob.size};
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.target !== 'writer' || message.type !== 'WRITE_IMAGE') return;
  // Capture the chosen directory when accepting the task, rather than when it
  // eventually reaches the front of the queue. Changing folders cannot redirect
  // images the user has already asked to save.
  const destination = readSetting('directory').then(directory => ({directory}), error => ({error}));
  queue = queue.catch(() => {}).then(async () => {
    const captured = await destination;
    if (captured.error) throw captured.error;
    return saveImage(message.url, captured.directory);
  });
  queue.then(respond, error => respond(friendlyError(error)));
  return true;
});
