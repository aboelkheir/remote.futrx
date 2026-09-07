import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { BrowserPool } from '../src/browser-pool.mjs';
import { DirectChromiumLauncher } from '../src/direct-chromium.mjs';
import { EncryptedStateStore } from '../src/state-store.mjs';
import { ViewSession } from '../src/view-session.mjs';

const runBrowserIntegration = process.env.BROWSER_BROKER_INTEGRATION === '1';

async function eventually(check) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('condition did not become true');
}

test('live view streams frames and relays human input to the project page', {
  skip: !runBrowserIntegration,
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'remote-browser-view-'));
  const pool = new BrowserPool({
    stateStore: new EncryptedStateStore(root, randomBytes(48)),
    launcher: new DirectChromiumLauncher({
      runtimeDir: path.join(root, 'runtime'),
      chromiumSandbox: process.getuid?.() !== 0,
    }),
  });
  const record = await pool.ensure('alpha', { view: true });
  const page = record.context.pages()[0];
  await page.setContent(`
    <button style="position:fixed;left:0;top:0;width:100px;height:60px">click</button>
    <input autofocus>
    <script>
      window.clicked = false;
      window.entered = false;
      window.inputTrust = [];
      document.querySelector('button').onclick = () => { window.clicked = true; };
      document.addEventListener('keydown', event => { if (event.key === 'Enter') window.entered = true; });
      for (const type of ['keydown', 'keyup', 'mousedown', 'mouseup']) {
        document.addEventListener(type, event => window.inputTrust.push(event.isTrusted), true);
      }
    </script>
  `);
  await page.locator('input').focus();

  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', (socket) => {
    const session = new ViewSession(record, socket);
    void session.start();
  });
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  const messages = [];
  client.on('message', (data) => messages.push(JSON.parse(data.toString('utf8'))));
  await once(client, 'open');

  try {
    await eventually(() => messages.some((message) => message.type === 'frame'));
    await eventually(() => messages.some((message) => message.type === 'tabs'));

    client.send(JSON.stringify({ type: 'insertText', text: 'separate-alpha-input' }));
    await eventually(async () => await page.locator('input').inputValue() === 'separate-alpha-input');

    client.send(JSON.stringify({ type: 'key', eventType: 'keyDown', key: 'a', code: 'KeyA', text: 'a' }));
    client.send(JSON.stringify({ type: 'key', eventType: 'keyUp', key: 'a', code: 'KeyA' }));
    await eventually(async () => await page.locator('input').inputValue() === 'separate-alpha-inputa');

    client.send(JSON.stringify({ type: 'key', eventType: 'keyDown', key: '.', code: 'Period', text: '.' }));
    client.send(JSON.stringify({ type: 'key', eventType: 'keyUp', key: '.', code: 'Period' }));
    await eventually(async () => await page.locator('input').inputValue() === 'separate-alpha-inputa.');

    client.send(JSON.stringify({ type: 'key', eventType: 'keyDown', key: 'Enter', code: 'Enter' }));
    client.send(JSON.stringify({ type: 'key', eventType: 'keyUp', key: 'Enter', code: 'Enter' }));
    await eventually(() => page.evaluate(() => window.entered));

    client.send(JSON.stringify({ type: 'mouse', eventType: 'mousePressed', x: 20, y: 20, button: 'left', buttons: 1, clickCount: 1 }));
    client.send(JSON.stringify({ type: 'mouse', eventType: 'mouseReleased', x: 20, y: 20, button: 'left', buttons: 0, clickCount: 1 }));
    await eventually(() => page.evaluate(() => window.clicked));
    assert.equal(await page.evaluate(() => window.inputTrust.length >= 6 && window.inputTrust.every(Boolean)), true);

    await page.close();
    await eventually(() => record.context.pages().length === 0);
    client.send(JSON.stringify({ type: 'newPage' }));
    await eventually(() => record.context.pages().length === 1);
    client.send(JSON.stringify({ type: 'navigate', url: 'about:blank#replacement' }));
    await eventually(() => record.context.pages()[0].url() === 'about:blank#replacement');
  } finally {
    client.close();
    await once(client, 'close');
    await new Promise((resolve) => server.close(resolve));
    await pool.close();
    await rm(root, { recursive: true, force: true });
  }
});
