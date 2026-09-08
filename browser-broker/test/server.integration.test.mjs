import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { issueControlToken, issueProjectToken } from '../src/auth.mjs';

const runBrowserIntegration = process.env.BROWSER_BROKER_INTEGRATION === '1';
const brokerDir = fileURLToPath(new URL('../', import.meta.url));

async function reservePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function upgradeStatus(url, token, legacyMessage) {
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('view upgrade did not respond')), 5_000);
      const finish = (status) => { clearTimeout(timer); resolve(status); };
      socket.once('unexpected-response', (_request, response) => { response.resume(); finish(response.statusCode); });
      socket.once('error', () => {});
      socket.once('open', () => {
        // This only executes if the retired JSON transport regresses. The
        // synthetic fixture has no sensitive page state; the status assertion
        // below fails regardless of whether the old handler processes a key.
        if (legacyMessage) socket.send(JSON.stringify(legacyMessage));
        finish(101);
      });
    });
  } finally { socket.terminate(); }
}

test('public viewer accepts only paired VNC transports and rejects legacy raw key messages', {
  skip: !runBrowserIntegration,
  timeout: 40_000,
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'remote-browser-server-'));
  const secret = randomBytes(48).toString('hex');
  const secretFile = path.join(root, 'broker.secret');
  await writeFile(secretFile, secret, { mode: 0o600 });
  const projectToken = issueProjectToken(Buffer.from(secret), 'route-test');
  const controlToken = issueControlToken(Buffer.from(secret), 'route-test');
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  const wsOrigin = `ws://127.0.0.1:${port}`;
  // The test may run as container-root, where Chromium's sandbox cannot start.
  // Only this disposable child launcher is adjusted; server routing is real.
  const bootstrap = `import { DirectChromiumLauncher } from './src/direct-chromium.mjs';
    const launch = DirectChromiumLauncher.prototype.launch;
    DirectChromiumLauncher.prototype.launch = function (...args) {
      this.chromiumSandbox = process.getuid?.() !== 0;
      return launch.apply(this, args);
    };
    await import('./src/server.mjs');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
    cwd: brokerDir,
    env: {
      ...process.env,
      BROWSER_BROKER_HOST: '127.0.0.1',
      BROWSER_BROKER_PORT: String(port),
      BROWSER_BROKER_SECRET_FILE: secretFile,
      BROWSER_BROKER_DATA_DIR: root,
      BROWSER_BROKER_RUNTIME_DIR: path.join(root, 'runtime'),
      BROWSER_BROKER_OUTPUT_DIR: path.join(root, 'output'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { logs = (logs + data).slice(-8_000); });
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(8_000, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  let healthy = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    healthy = await fetch(`${origin}/health`).then((response) => response.ok).catch(() => false);
    if (healthy || child.exitCode !== null) break;
    await delay(50);
  }
  assert.equal(healthy, true, `test broker did not start: ${logs}`);
  const started = await fetch(`${origin}/v1/start`, {
    method: 'POST',
    headers: { authorization: `Bearer ${controlToken}` },
  });
  assert.equal(started.status, 200, `test browser did not start: ${logs}`);
  await started.arrayBuffer();

  const malformedKey = { type: 'key', eventType: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 86, modifiers: 2 };
  assert.equal(await upgradeStatus(`${wsOrigin}/view`, projectToken, malformedKey), 401,
    'retired raw JSON viewer cannot accept forged key/CDP field combinations');
  for (const query of [
    `viewer=${randomUUID()}`,
    'transport=vnc',
    `transport=json&viewer=${randomUUID()}`,
    'transport=control&viewer=not-a-viewer-uuid',
  ]) {
    assert.equal(await upgradeStatus(`${wsOrigin}/view?${query}`, projectToken), 401,
      `invalid viewer transport query must fail before WebSocket upgrade: ${query}`);
  }

  const viewer = randomUUID();
  assert.equal(await upgradeStatus(`${wsOrigin}/view?transport=vnc&viewer=${viewer}`, controlToken), 401,
    'lifecycle control credential cannot open a viewer');
  const control = new WebSocket(`${wsOrigin}/view?transport=control&viewer=${viewer}`, {
    headers: { authorization: `Bearer ${projectToken}` },
  });
  sockets.push(control);
  control.on('error', () => {});
  await once(control, 'open');
  const vnc = new WebSocket(`${wsOrigin}/view?transport=vnc&viewer=${viewer}`, {
    headers: { authorization: `Bearer ${projectToken}` },
  });
  sockets.push(vnc);
  vnc.on('error', () => {});
  const [greeting, binary] = await once(vnc, 'message');
  assert.equal(binary, true);
  assert.equal(greeting.toString(), 'RFB 003.008\n', 'paired project transport starts the RFB handshake');
});
