/**
 * Uploading a file, both ways.
 *
 * The API offers two paths and picks between them on size, so this does too:
 *
 * **Inline**, at or below 1 MB — the bytes travel base64-encoded inside the
 * create request. One round trip, and it works without any R2 signing
 * credential at all, because the Worker writes through its own bucket binding.
 *
 * **Presigned**, above that — the create call returns a URL scoped to exactly
 * this file's object key, the browser PUTs the bytes straight to R2, and a
 * `complete` call flips the row from pending to active. The bytes never pass
 * through the Worker, which is the whole reason a 4 GB upload is possible at
 * all on a platform with a request size limit.
 *
 * `complete` matters more than it looks. Until it runs, the row is `pending`
 * and the file does not exist as far as every other endpoint is concerned — so
 * a PUT that succeeds and a `complete` that never fires leaves an object in the
 * bucket that nothing accounts for. That is why the failure path below reports
 * which of the two steps failed rather than a single "upload failed".
 */

/** Matches the server's own cap. Above this, the inline path is refused. */
export const MAX_INLINE_BYTES = 1024 * 1024;

async function toBase64(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  // Chunked rather than String.fromCharCode(...bytes): spreading a megabyte of
  // bytes into an argument list overflows the call stack in every browser.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Lowercase hex SHA-256, which is the form the API compares against. */
async function sha256Hex(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function joinPath(folder, name) {
  const base = (folder ?? '').replace(/\/+$/, '');
  return `${base}/${name}`.replace(/\/{2,}/g, '/');
}

/**
 * Upload one file. `onProgress` is called with 0..1 for the presigned path,
 * which is the only one where progress is meaningful — an inline upload is a
 * single request that either happened or did not.
 */
export async function uploadFile(api, workspaceId, file, { folder = '/', onProgress } = {}) {
  const path = joinPath(folder, file.name);
  const mimeType = file.type || 'application/octet-stream';

  if (file.size <= MAX_INLINE_BYTES) {
    const content = await toBase64(file);
    const { file: created } = await api.request('/v1/files', {
      method: 'POST',
      workspaceId,
      body: { path, mimeType, content }
    });
    onProgress?.(1);
    return created;
  }

  // The checksum is computed before the PUT so the server can reject a
  // corrupted transfer rather than accept whatever arrived.
  const checksumSha256 = await sha256Hex(file);

  const created = await api.request('/v1/files', {
    method: 'POST',
    workspaceId,
    body: { path, mimeType, sizeBytes: file.size, checksumSha256 }
  });

  const uploadUrl = created.upload?.url;
  if (!uploadUrl) {
    const err = new Error(
      'The server did not return an upload URL. Presigned uploads need an R2 signing credential.'
    );
    err.step = 'create';
    throw err;
  }

  await putWithProgress(uploadUrl, file, mimeType, onProgress);

  try {
    const { file: completed } = await api.request(`/v1/files/${created.file.id}/complete`, {
      method: 'POST',
      workspaceId,
      body: { sizeBytes: file.size, checksumSha256 }
    });
    return completed;
  } catch (err) {
    // The bytes are in the bucket but the row is still pending. Saying which
    // step failed is the difference between "retry" and "you have an orphan".
    err.step = 'complete';
    throw err;
  }
}

/**
 * XHR rather than fetch, purely for upload progress — `fetch` still cannot
 * report it, and a 4 GB upload with no progress bar is indistinguishable from
 * a hang.
 */
function putWithProgress(url, file, mimeType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    xhr.setRequestHeader('Content-Type', mimeType);

    xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        const err = new Error(`Storage rejected the upload (${xhr.status}).`);
        err.step = 'put';
        reject(err);
      }
    };
    xhr.onerror = () => {
      const err = new Error('The upload could not reach storage.');
      err.step = 'put';
      reject(err);
    };
    xhr.send(file);
  });
}
