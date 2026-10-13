import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, configFor } from '../pi.mjs';
import { createHandler } from '../server.mjs';

const listen = async server => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; };
const close = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
const post = (url, path, body, headers = {}) => fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

async function fixture(t) {
  const agentDir = await mkdtemp(join(tmpdir(), 'enclosure-settings-'));
  const env = { PI_AGENT_DIR: agentDir };
  const context = await createRuntime(env), requests = [];
  let failureStatus, failureCode;
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ body: JSON.parse(raw), auth: req.headers.authorization });
    if (failureStatus) { res.writeHead(failureStatus, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: req.headers.authorization, code: failureCode } })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'OK' }, null], [{}, 'stop']]) {
      res.write('data: ' + JSON.stringify({ id: 'settings-test', object: 'chat.completion.chunk', created: 1, model: 'vision-test', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    }
    res.end('data: [DONE]\n\n');
  });
  const baseUrl = await listen(provider);
  const handler = createHandler({ context, geometry: async () => ({ issues: [] }) });
  const server = createServer(handler), url = await listen(server);
  t.after(async () => { handler.dispose(); await close(server); await close(provider); await rm(agentDir, { recursive: true, force: true }); });
  const body = { provider: 'custom', mode: 'custom', model: 'vision-test', baseUrl: baseUrl + '/v1', api: 'openai-completions', vision: true, apiKey: 'test-only-private-key' };
  return { context, env, agentDir, url, body, requests, fail: (status = 401, code) => { failureStatus = status; failureCode = code; } };
}

test('page credentials activate Pi immediately, survive restart, and stay out of public responses', async t => {
  const f = await fixture(t);
  const response = await post(f.url, '/api/ai/settings', f.body);
  assert.equal(response.status, 200);
  const text = await response.text(); assert.ok(!text.includes(f.body.apiKey));
  const config = JSON.parse(text);
  assert.equal(config.defaultModel, 'custom/vision-test'); assert.equal(config.revision, 1);
  assert.ok(config.models.find(m => m.provider === 'custom' && m.vision && m.configured));
  assert.equal((await stat(join(f.agentDir, 'ai-settings.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(f.agentDir)).mode & 0o777, 0o700);
  const testResponse = await post(f.url, '/api/ai/test', { provider: 'custom', model: 'vision-test' });
  assert.equal(testResponse.status, 200); assert.equal((await testResponse.json()).ok, true);
  assert.equal(f.requests[0].auth, 'Bearer ' + f.body.apiKey); assert.equal(f.requests[0].body.model, f.body.model);
  const restored = await createRuntime(f.env);
  assert.ok(restored.runtime.hasConfiguredAuth('custom')); assert.equal(restored.preferred, f.body.model);
  assert.ok(!JSON.stringify(configFor(restored)).includes(f.body.apiKey));
  const envOverride = await createRuntime({ ...f.env, PI_PROVIDER: 'custom', PI_MODEL: 'outdated', PI_BASE_URL: 'http://127.0.0.1:1/v1', PI_API_KEY: 'old-test-env-key' });
  assert.equal(envOverride.runtime.getRegisteredProviderConfig('custom').baseUrl, f.body.baseUrl);
  assert.equal(envOverride.preferred, f.body.model);
  f.fail();
  const failed = await post(f.url, '/api/ai/test', { provider: 'custom', model: 'vision-test' });
  assert.equal(failed.status, 502); assert.ok(!(await failed.text()).includes(f.body.apiKey));
});

test('blank keys preserve credentials per provider; failed edits leave saved configuration intact', async t => {
  const f = await fixture(t);
  assert.equal((await post(f.url, '/api/ai/settings', f.body)).status, 200);
  assert.equal((await post(f.url, '/api/ai/settings', { provider: 'anthropic', mode: 'builtin', model: 'claude-sonnet-4-6', apiKey: 'test-only-second-key' })).status, 200);
  assert.equal((await post(f.url, '/api/ai/settings', { ...f.body, model: 'vision-test-v2', apiKey: '' })).status, 200);
  const persisted = JSON.parse(await readFile(join(f.agentDir, 'ai-settings.json'), 'utf8'));
  assert.equal(persisted.providers.custom.apiKey, f.body.apiKey);
  assert.equal(persisted.providers.anthropic.apiKey, 'test-only-second-key');
  assert.equal((await post(f.url, '/api/ai/test', { provider: 'custom', model: 'vision-test-v2' })).status, 200);
  assert.equal(f.requests[0].auth, 'Bearer ' + f.body.apiKey);
  const before = await readFile(join(f.agentDir, 'ai-settings.json'), 'utf8');
  for (const patch of [
    { baseUrl: 'file:///tmp/model' }, { baseUrl: 'https://key:password@example.com' },
    { baseUrl: 'https://example.com/v1?api_key=test' }, { apiKey: '!cat /tmp/secret' },
    { apiKey: '$OPENAI_API_KEY' }, { provider: '../invalid' }, { api: 'arbitrary-api' },
    { baseUrl: 'https://other.example/v1', apiKey: '' },
  ]) assert.equal((await post(f.url, '/api/ai/settings', { ...f.body, ...patch })).status, 422);
  assert.equal(await readFile(join(f.agentDir, 'ai-settings.json'), 'utf8'), before);
  assert.equal(f.context.preferred, 'vision-test-v2');
});

test('credential routes reject cross-site writes, non-JSON requests and oversized bodies', async t => {
  const f = await fixture(t);
  assert.equal((await post(f.url, '/api/ai/settings', f.body, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await post(f.url, '/api/ai/settings', f.body, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post(f.url, '/api/ai/settings', f.body, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(f.url, '/api/ai/settings', { ...f.body, apiKey: 'x'.repeat(20000) })).status, 413);
  assert.equal(f.context.revision, 0);
  assert.equal(f.requests.length, 0);
});

test('connection diagnostics identify upstream 403 and distinguish auth, model and quota errors without echoing secrets', async t => {
  const f = await fixture(t);
  assert.equal((await post(f.url, '/api/ai/settings', f.body)).status, 200);
  for (const [status, code, detail] of [
    [403, 'bad_response_status_code', '权限'],
    [401, 'invalid_api_key', '凭据'],
    [404, 'model_not_found', '模型'],
    [429, 'insufficient_quota', '额度'],
    [400, 'invalid_request_error', '参数'],
  ]) {
    f.fail(status, code);
    const response = await post(f.url, '/api/ai/test', { provider: 'custom', model: f.body.model });
    const text = await response.text(), result = JSON.parse(text);
    assert.equal(response.status, 502);
    assert.equal(result.diagnostics?.upstreamStatus, status);
    assert.equal(result.diagnostics?.code, code);
    assert.equal(result.diagnostics?.api, 'openai-completions');
    assert.ok(result.detail.includes(detail));
    assert.ok(!text.includes(f.body.apiKey));
    assert.ok(!text.includes('Bearer'));
  }
  f.fail(403, 'untrusted-code-' + f.body.apiKey);
  const result = await (await post(f.url, '/api/ai/test', { provider: 'custom', model: f.body.model })).text();
  assert.ok(!result.includes(f.body.apiKey));
});
