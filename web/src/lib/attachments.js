// Shared lifecycle for attachments stored in Svelte 5 deep-reactive arrays.
// `push` first, then read the array element back: that element is the proxy whose
// field updates drive the UI. Callers keep ownership of validation and policy.

export function filesFromInput(event) {
  const files = [...(event?.target?.files || [])];
  if (event?.target) event.target.value = '';
  return files;
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function revokeAttachmentUrl(attachment) {
  if (!attachment?.url || !String(attachment.url).startsWith('blob:')) return;
  try { URL.revokeObjectURL(attachment.url); } catch {}
}

export function removeAttachment(items, attachment) {
  revokeAttachmentUrl(attachment);
  const index = items.indexOf(attachment);
  if (index >= 0) items.splice(index, 1);
}

export async function uploadAttachment(items, file, {
  draft,
  upload,
  applyResult = (live, result) => {
    live.path = result.path;
    live.name = result.name || live.name;
    live.pending = false;
  },
  onError,
} = {}) {
  items.push(typeof draft === 'function' ? draft(file) : draft);
  const live = items[items.length - 1];
  try {
    const result = await upload(file, live);
    applyResult(live, result);
    return live;
  } catch (error) {
    removeAttachment(items, live);
    onError?.(error, file);
    return null;
  }
}
