let creatingWriter;

export async function ensureWriter() {
  const url = chrome.runtime.getURL('writer.html');
  const contexts = await chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url]});
  if (contexts.length) return;
  if (!creatingWriter) {
    creatingWriter = chrome.offscreen.createDocument({
      url: 'writer.html',
      reasons: ['BLOBS'],
      justification: 'Save the selected image or prepare a video file in browser storage after an explicit save request.'
    }).finally(() => { creatingWriter = undefined; });
  }
  await creatingWriter;
}
