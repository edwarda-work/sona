const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../src/background.js'), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function setup() {
  const data = {};
  const listeners = {};
  const event = name => ({ addListener(listener) { listeners[name] = listener; } });
  const chrome = {
    runtime: { onMessage: event('message') },
    tabs: { onRemoved: event('removed'), onUpdated: event('updated') },
    storage: { session: {
      async get() { return { ...data }; },
      async set(value) { Object.assign(data, value); },
      async remove(keys) { for (const key of [keys].flat()) delete data[key]; }
    } }
  };
  vm.runInNewContext(source, { chrome });
  return { data, listeners };
}

test('keeps frame states separate and clears them when the tab navigates', async () => {
  const { data, listeners } = setup();
  listeners.message({ type: 'sona.status', phase: 'filtering' }, { tab: { id: 4 }, frameId: 0 });
  listeners.message({ type: 'sona.status', phase: 'fallback' }, { tab: { id: 4 }, frameId: 2 });
  await tick();
  assert.equal(data['sona.status.4.0'], 'filtering');
  assert.equal(data['sona.status.4.2'], 'fallback');
  listeners.message({ type: 'sona.status', phase: 'closed' }, { tab: { id: 4 }, frameId: 2 });
  await tick();
  assert.equal(data['sona.status.4.2'], undefined);
  listeners.updated(4, { status: 'loading' });
  await tick();
  assert.equal(data['sona.status.4.0'], undefined);
});
