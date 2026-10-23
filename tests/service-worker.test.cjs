'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadWorker() {
  const listeners = new Map();
  const deleted = [];
  const self = {
    location: { origin: 'https://example.test' },
    registration: { scope: 'https://example.test/my-app/' },
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
    addEventListener: (type, callback) => listeners.set(type, callback)
  };
  const caches = {
    keys: async () => ['another-pwa-v1', 'ofertanalisis-preanalitica-v8'],
    delete: async (key) => { deleted.push(key); return true; }
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8'),
    { self, caches, URL },
    { filename: 'sw.js' }
  );
  return { listeners, deleted };
}

test('service worker does not intercept another application on the same origin', () => {
  const { listeners } = loadWorker();
  const handler = listeners.get('fetch');
  assert.equal(typeof handler, 'function');
  for (const url of [
    'https://example.test/other-app/index.html',
    'https://external.test/my-app/index.html'
  ]) {
    let responded = false;
    handler({
      request: { method: 'GET', url, mode: 'navigate' },
      respondWith: () => { responded = true; }
    });
    assert.equal(responded, false, url);
  }
});

test('activation does not delete caches belonging to other applications', async () => {
  const { listeners, deleted } = loadWorker();
  let promise;
  listeners.get('activate')({ waitUntil: (value) => { promise = value; } });
  await promise;
  assert.deepEqual(deleted, []);
});
