// Explicitly run through the installed browser.mjs run helper on a dedicated
// test profile. Stop this client after the matrix; never route a real website.
const browserOrigin = new URL(process.env.COMPARISON_BROWSER_ORIGIN || 'http://browser-evaluation.test:18765');
const localOrigin = new URL(process.env.COMPARISON_LOCAL_ORIGIN || 'http://127.0.0.1:18765');
for (const url of [browserOrigin, localOrigin]) {
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Fixture URLs must be plain HTTP origins without credentials');
  }
}
if (!(browserOrigin.hostname.endsWith('.test') || ['localhost', '127.0.0.1', '[::1]'].includes(browserOrigin.hostname))) {
  throw new Error('Only a reserved .test or loopback browser origin may be intercepted');
}
if (!['localhost', '127.0.0.1', '[::1]'].includes(localOrigin.hostname)) throw new Error('Local fixture must be loopback');
await context.route(`${browserOrigin.origin}/**`, async route => {
  try {
    const req = route.request();
    const original = new URL(req.url());
    if (!original.pathname.startsWith('/case/') || !['GET', 'POST'].includes(req.method())) {
      await route.abort(); return;
    }
    const destination = new URL(original.pathname + original.search, localOrigin);
    const response = await fetch(destination, {
      method: req.method(), body: req.postData() || undefined,
      redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    await route.fulfill({ status: response.status,
      contentType: response.headers.get('content-type') || 'text/plain',
      body: Buffer.from(await response.arrayBuffer()) });
  } catch { await route.abort(); }
});
console.log('Benchmark fixture bridge ready; stop this client after the experiment');
await new Promise(() => {});
