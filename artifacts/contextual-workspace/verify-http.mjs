import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
const fixture = JSON.parse(readFileSync(new URL('./report.json', import.meta.url), 'utf8')).fixture;
const base = process.env.PERRY_VERIFY_URL ?? 'http://127.0.0.1:7385';
assert(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base), 'Only run against the isolated local test host.');
const key = 'workspace-verification-key';
const checks = [];
async function call(path, args, internal = false) {
  const response = await fetch(`${base}/api/backend/${internal ? 'admin' : 'call'}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(internal ? { 'x-perry-key': key } : {}) }, body: JSON.stringify({ path, args }) });
  const body = await response.json();
  assert(response.ok && !body.error, JSON.stringify(body));
  return body.value;
}
await call('dashboard:skipOnboarding', { key });
for (const [name, source, options] of [
  ['creative-preview.png', 'testsrc=size=320x180:duration=1', ['-frames:v', '1']],
  ['creative-preview.mp4', 'color=c=teal:s=320x180:d=1', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']],
]) {
  const result = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', source, ...options, join(fixture.home, 'files', name)]);
  assert.equal(result.status, 0, 'Install ffmpeg to regenerate the real media fixtures.');
}
const register = async (name) => await call('library:add', { path: join(fixture.home, 'files', name), conversationId: fixture.chat, how: 'added', by: 'perry' }, true);
writeFileSync(join(fixture.home, 'files', 'untrusted.html'), '<script>document.body.textContent="UNSAFE"</script>');
writeFileSync(join(fixture.home, 'files', 'untrusted.svg'), '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
for (const name of ['creative-preview.png', 'creative-preview.mp4', 'untrusted.html', 'untrusted.svg']) await register(name);
const page = await call('workspace:files', { key, conversationId: fixture.chat, scope: 'chat', working: false, hidden: false, paginationOpts: { numItems: 500, cursor: null } });
assert(!page.page.some((item) => item.name === 'intermediate.json'));
const cookie = { Cookie: `perry_media=${key}` };
for (const name of ['untrusted.html', 'untrusted.svg']) {
  const item = page.page.find((item) => item.name === name);
  const response = await fetch(base + item.url, { headers: cookie });
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert(response.headers.get('content-disposition').startsWith('attachment;'));
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert(response.headers.get('content-security-policy').includes('sandbox'));
}
checks.push('HTML and SVG download without active content execution');
const chosen = page.page.find((item) => item.id === fixture.version);
let response = await fetch(base + chosen.url, { headers: { ...cookie, Range: 'bytes=0-4' } });
assert.equal(response.status, 206); assert.equal(await response.text(), 'Final');
assert.equal(response.headers.get('cache-control'), 'private, no-store');
checks.push('bounded text preview, byte ranges and private uncached serving');
assert.equal((await fetch(base + chosen.url)).status, 401);
const wrongScope = new URL(chosen.url, base); wrongScope.searchParams.set('conversation', fixture.otherChat);
assert.equal((await fetch(wrongScope, { headers: cookie })).status, 404);
assert.equal((await fetch(base + chosen.url, { headers: { Cookie: 'perry_media=wrong' } })).status, 403);
checks.push('media route enforces both dashboard authentication and workspace membership');
const path = join(fixture.home, 'files', 'design-v2.md');
rmSync(path);
assert.equal((await fetch(base + chosen.url, { headers: cookie })).status, 404);
writeFileSync(path, 'Final design');
assert.equal((await fetch(base + chosen.url, { headers: cookie })).status, 200);
checks.push('missing-file delivery fails honestly and recovers after restoration');
const video = page.page.find((item) => item.name === 'creative-preview.mp4');
response = await fetch(base + video.url, { method: 'HEAD', headers: cookie });
assert.equal(response.headers.get('content-type'), 'video/mp4');
assert.equal(response.headers.get('accept-ranges'), 'bytes');
checks.push('real image/video assets register only in their originating scope');
writeFileSync(resolve('artifacts/contextual-workspace/http-report.json'), JSON.stringify({ passed: checks, createdAt: new Date().toISOString() }, null, 2) + '\n');
console.log(checks.map((check) => `PASS ${check}`).join('\n'));
