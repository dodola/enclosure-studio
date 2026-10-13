import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createServer } from 'node:http';
import { protectInternal } from '../http-auth.mjs';
import { uid } from '../../shared/browser-id.mjs';

test('Pi internal HTTP service rejects requests without the private service token', async t => {
  const token = 'test-only-service-token';
  let called = 0;
  const server = createServer(protectInternal((_req, res) => { called++; res.end('ok'); }, token));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/api/ai/config`;
  for (const headers of [{}, { 'X-Enclosure-Internal': 'wrong' }, { 'X-Enclosure-Internal': 'x'.repeat(token.length) }]) {
    const response = await fetch(url, { headers });
    assert.equal(response.status, 401); assert.ok(!(await response.text()).includes(token));
  }
  assert.equal(called, 0);
  assert.equal((await fetch(url, { headers: { 'X-Enclosure-Internal': token } })).status, 200);
  assert.equal(called, 1);
});

test('component and chat IDs work on HTTP without crypto.randomUUID', () => {
  const insecureContextCrypto = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) };
  const ids = Array.from({ length: 20 }, () => uid(insecureContextCrypto));
  for (const id of ids) assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(new Set(ids).size, 20);
});
