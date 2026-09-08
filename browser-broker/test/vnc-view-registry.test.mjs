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

test('pairing IDs cannot join channels from different projects', () => {
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
  alphaSocket.close(1000);
  assert.equal(registry.pairs.size, 1);
  assert.equal(betaSocket.readyState, 1);
  registry.close();
  assert.equal(registry.pairs.size, 0);
});

test('duplicate channels and excess unpaired viewers are rejected', () => {
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
  registry.close();
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
});

test('control messages cannot request raw key events or another CDP target', async () => {
  const registry = new VNCViewRegistry();
  const alpha = record('alpha');
  const socket = new Socket();
  registry.attach(alpha, 'control', viewer, socket);
  const pair = [...registry.pairs.values()][0];
  const received = [];
  pair.session = {};
  pair.rfb = { inputQueue: Promise.resolve(), close() {} };
  pair.readyState = 1;
  pair.on('message', (data) => received.push(JSON.parse(data)));
  socket.emit('message', Buffer.from('{"type":"key","key":"a"}'), false);
  socket.emit('message', Buffer.from('{"type":"Target.attachToTarget","targetId":"beta"}'), false);
  socket.emit('message', Buffer.from('{"type":"navigate","url":"https://example.com"}'), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [{ type: 'navigate', url: 'https://example.com' }]);
  registry.close();
});
