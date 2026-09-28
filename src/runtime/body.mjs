// Read a request body (with a max-size cap) into a UTF-8 string. JSON.parse it
// at the call site so callers can pick the size budget and the error response.
// Kept tiny on purpose — the chunked upload route uses streaming I/O directly
// rather than buffering through this.

export function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, done = false;
    // Buffer raw bytes and decode once at the end — concatenating Buffers onto a
    // string mid-stream corrupts any multibyte char (e.g. a 中文 character) that
    // straddles a chunk boundary.
    req.on('data', (c) => {
      if (done) return;
      size += c.length; // Buffer.length is bytes, so this is an accurate byte cap
      if (size > maxBytes) {
        // Keep the socket alive long enough for the caller to send its 413/400.
        // Destroying IncomingMessage also destroys the shared socket, so the
        // response never reaches the client and it waits for the server timeout.
        // `done` makes this listener discard later chunks without retaining them.
        done = true;
        chunks.length = 0;
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', (err) => { if (!done) { done = true; reject(err); } });
  });
}
