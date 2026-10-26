// The composer reads a file on this machine before the task is sent. Pictures
// are shrunk here; documents are turned into text by read-file.js.

import { FILE_LIMITS, isImageName, readDocument } from '../lib/read-file.js';

/** `{ name, text, warning, images }` for one File. `warning` may be a short code. */
export async function readLocalFile(file) {
  if (file.size > FILE_LIMITS.maxBytes) return { name: file.name, text: '', warning: 'too-big', images: [] };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isImageName(file.name, file.type)) {
    try {
      return { name: file.name, text: '', warning: '', images: [await shrinkImage(bytes, file.type || 'image/png')] };
    } catch {
      return { name: file.name, text: '', warning: 'unreadable-image', images: [] };
    }
  }
  const read = await readDocument({ name: file.name, type: file.type, bytes });
  const images = [];
  for (const image of read.images ?? []) {
    if (images.length >= FILE_LIMITS.maxImages) break;
    try {
      images.push(await shrinkImage(image.bytes, image.mime));
    } catch { /* one picture inside the archive could not be decoded */ }
  }
  return { name: file.name, text: read.text, warning: read.warning, images };
}

async function shrinkImage(bytes, mime) {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
  const scale = Math.min(1, FILE_LIMITS.maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', 0.85);
}

export { FILE_LIMITS };
