import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { VNCViewRegistry } from '../src/vnc-view-registry.mjs';

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  close(code, reason) { this.readyState = 3; this.code = code; this.reason = reason; this.emit('close', code); }
}
const viewer = '0cf6fe40-0e5c-45b9-a503-096f2b127fe7';
const record = (project) => ({ project, viewers: new Set() });

test('pairing IDs cannot join channels from different projects', async () => {
  const registry = new VNCViewRegistry();
  const alpha = record('alpha');
  const beta = record('beta');
  const alphaSocket = new Socket();
  const betaSocket = new Socket();
  registry.attach(alpha, 'control', viewer, alphaSocket);
  registry.attach(beta, 'control', viewer, betaSocket);
  assert.equal(registry.pairs.size, 2);
  assert.equal(alpha.viewers.size, 1);
  assert.equal(beta.viewers.size, 1);
  const alphaPair = [...alpha.viewers][0];
  alphaSocket.close(1000);
  await alphaPair.closePromise;
  assert.equal(registry.pairs.size, 1);
  assert.equal(betaSocket.readyState, 1);
  await registry.close();
  assert.equal(registry.pairs.size, 0);
});

test('duplicate channels and excess unpaired viewers are rejected', async () => {
  const registry = new VNCViewRegistry();
  const alpha = record('alpha');
  for (let i = 0; i < 4; i++) registry.attach(alpha, 'control', viewer.slice(0, -1) + i, new Socket());
  assert.equal(alpha.viewers.size, 4);
  const excess = new Socket();
  registry.attach(alpha, 'control', viewer, excess);
  assert.equal(excess.code, 1013);
  const duplicate = new Socket();
  registry.attach(alpha, 'control', viewer.slice(0, -1) + '0', duplicate);
  assert.equal(duplicate.code, 1008);
  assert.equal(alpha.viewers.size, 4);
  await registry.close();
});

test('abandoned channel pairs expire and release their viewer slot', async () => {
  const registry = new VNCViewRegistry({ pairingTimeoutMs: 10 });
  const alpha = record('alpha');
  const socket = new Socket();
  registry.attach(alpha, 'control', viewer, socket);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(socket.code, 1008);
  assert.equal(alpha.viewers.size, 0);
  assert.equal(registry.pairs.size, 0);
  await registry.close();
});

test('control messages cannot request raw key events or another CDP target', async () => {
  const registry = new VNCViewRegistry();
  const alpha = record('alpha');
  const socket = new Socket();
  registry.attach(alpha, 'control', viewer, socket);
  const pair = [...registry.pairs.values()][0];
  const received = [];
  pair.session = { messageQueue: Promise.resolve(), freeze() {}, async close() {} };
  pair.rfb = { inputQueue: Promise.resolve(), close() {} };
  pair.readyState = 1;
  pair.on('message', (data) => received.push(JSON.parse(data)));
  socket.emit('message', Buffer.from('{"type":"key","key":"a"}'), false);
  socket.emit('message', Buffer.from('{"type":"Target.attachToTarget","targetId":"beta"}'), false);
  socket.emit('message', Buffer.from('{"type":"navigate","url":"https://example.com"}'), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [{ type: 'navigate', url: 'https://example.com' }]);
  await registry.close();
});

test('closing viewers freeze immediately and retain their slot through input drain and CDP cleanup', { timeout: 2_000 }, async () => {
  const registry = new VNCViewRegistry();
  const alpha = record('alpha');
  const control = new Socket();
  registry.attach(alpha, 'control', viewer, control);
  const pair = [...registry.pairs.values()][0];
  for (let i = 0; i < 3; i++) registry.attach(alpha, 'control', viewer.slice(0, -1) + i, new Socket());
  assert.equal(alpha.viewers.size, 4);

  let releaseDrain;
  let releaseDetach;
  const drained = new Promise((resolve) => { releaseDrain = resolve; });
  const detached = new Promise((resolve) => { releaseDetach = resolve; });
  const inputs = [];
  let frozen = false;
  let cleanupStarted = false;
  let cleanupFinished = false;
  pair.readyState = 1;
  pair.session = {
    messageQueue: Promise.resolve(),
    freeze() { frozen = true; },
    async close() { cleanupStarted = true; await detached; cleanupFinished = true; },
  };
  pair.on('message', (data) => inputs.push(JSON.parse(data)));
  const releaseKey = { type: 'key', eventType: 'keyUp', key: 'Control' };
  pair.rfb = {
    inputQueue: drained,
    close: () => drained.then(() => pair.input(releaseKey)),
  };
  try {
    // This control was received before disconnect, but is still behind RFB
    // input. It must not navigate a replacement page once closing begins.
    control.emit('message', Buffer.from('{"type":"navigate","url":"https://example.com"}'), false);
    const closing = pair.close(1000);
    assert.equal(pair.close(1000), closing, 'close is idempotent while draining');
    assert.equal(frozen, true);
    assert.equal(cleanupStarted, false);
    assert.equal(alpha.viewers.size, 4);
    assert.equal(registry.pairs.size, 4);

    control.emit('message', Buffer.from('{"type":"newPage"}'), false);
    pair.input({ type: 'key', eventType: 'keyDown', key: 'a' });
    pair.input({ type: 'mouse', eventType: 'mouseMoved', x: 10, y: 10 });
    assert.deepEqual(inputs, [], 'no new controls or ordinary input after freeze');

    const duplicate = new Socket();
    registry.attach(alpha, 'vnc', viewer, duplicate);
    assert.equal(duplicate.code, 1008, 'cannot attach a missing channel to a closing pair');
    const excess = new Socket();
    registry.attach(alpha, 'control', viewer.slice(0, -1) + 'f', excess);
    assert.equal(excess.code, 1013, 'closing viewer still counts toward the four-viewer limit');

    releaseDrain();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(inputs, [releaseKey], 'only the held-key release survives input drain');
    assert.equal(cleanupStarted, true);
    assert.equal(cleanupFinished, false);
    assert.equal(alpha.viewers.size, 4, 'slot remains reserved while CDP detaches');

    releaseDetach();
    await closing;
    assert.equal(cleanupFinished, true);
    assert.equal(alpha.viewers.size, 3);
    assert.equal(registry.pairs.size, 3);
    assert.equal(pair.readyState, 3);
    assert.equal(pair.pendingControls, 0);
    const replacement = new Socket();
    registry.attach(alpha, 'control', viewer, replacement);
    assert.equal(replacement.readyState, 1);
    assert.equal(alpha.viewers.size, 4, 'the cleaned slot can now be reused');
  } finally {
    releaseDrain();
    releaseDetach();
    await registry.close();
  }
});
