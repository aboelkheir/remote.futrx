import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { BrowserPool } from '../src/browser-pool.mjs';
import { DirectChromiumLauncher } from '../src/direct-chromium.mjs';
import { EncryptedStateStore } from '../src/state-store.mjs';
import { VNCViewRegistry } from '../src/vnc-view-registry.mjs';

const runBrowserIntegration = process.env.BROWSER_BROKER_INTEGRATION === '1';
const noVNCRoot = path.resolve(fileURLToPath(new URL('../../frontend/node_modules/@novnc/novnc/', import.meta.url)));

async function eventually(check, description) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail(`condition did not become true: ${description}`);
}

// Load the shipped noVNC client in a separate browser. Keyboard and pointer
// actions below go through its real DOM listeners, RFB encoding and WebSocket;
// inspecting the remote page with Playwright is only the assertion side.
const viewerHTML = `<!doctype html>
<html><head><style>
  html, body { margin: 0; }
  #screen { width: 1280px; height: 720px; }
</style></head><body><div id="screen"></div><script type="module">
  import RFB from '/novnc/core/rfb.js';
  const project = new URL(location.href).searchParams.get('project');
  window.messages = [];
  window.connectionCount = 0;
  window.disconnectCount = 0;
  window.clientErrors = [];
  window.openViewer = async () => {
    window.rfb?.disconnect();
    window.control?.close();
    document.querySelector('#screen').replaceChildren();
    const viewer = crypto.randomUUID();
    const address = (transport) => 'ws://' + location.host + '/view?' +
      new URLSearchParams({ project, transport, viewer });
    const control = new WebSocket(address('control'));
    window.control = control;
    control.onmessage = (event) => window.messages.push(JSON.parse(event.data));
    await new Promise((resolve, reject) => {
      control.onopen = resolve;
      control.onerror = reject;
    });
    const rfb = new RFB(document.querySelector('#screen'), address('vnc'));
    window.rfb = rfb;
    rfb.scaleViewport = false;
    rfb.resizeSession = false;
    rfb.focusOnClick = true;
    rfb.addEventListener('connect', () => { window.connectionCount++; });
    rfb.addEventListener('disconnect', () => { window.disconnectCount++; });
    rfb.addEventListener('securityfailure', (event) => window.clientErrors.push(event.detail.reason));
  };
  await window.openViewer();
</script></body></html>`;

function fixture(color, initialValue) {
  return `<!doctype html><html><body style="margin:0;height:2500px;background:${color}">
    <input id="field" value="${initialValue}" style="position:absolute;left:20px;top:20px;width:400px;height:40px">
    <button style="position:absolute;left:20px;top:90px;width:180px;height:45px">Activate</button>
    <button id="application-copy" style="position:absolute;left:230px;top:90px;width:180px;height:45px">Application copy</button>
    <input id="password" type="password" value="project-password" style="position:absolute;left:20px;top:160px;width:400px;height:40px">
    <script>
      window.activated = 0;
      window.inputEvents = [];
      document.querySelector('button').onclick = () => { window.activated++; };
      document.querySelector('#application-copy').onclick = () => {
        const temporary = document.createElement('textarea');
        temporary.value = 'shared-host-clipboard-must-not-leak';
        document.body.append(temporary);
        temporary.select();
        window.nativeCopySucceeded = document.execCommand('copy');
        temporary.remove();
      };
      for (const type of ['keydown', 'keyup', 'input', 'mousedown', 'mouseup', 'wheel']) {
        document.addEventListener(type, event => {
          window.inputEvents.push({ type, key: event.key, trusted: event.isTrusted });
        }, true);
      }
    </script>
  </body></html>`;
}

async function samplePixel(viewer) {
  return viewer.evaluate(() => {
    const frame = window.rfb.getImageData();
    const offset = (600 * frame.width + 1000) * 4;
    return Array.from(frame.data.slice(offset, offset + 4));
  });
}

test('real noVNC displays isolated pooled pages and preserves typing, clipboard and reconnect state', {
  skip: !runBrowserIntegration,
  timeout: 90_000,
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'remote-browser-novnc-'));
  const pool = new BrowserPool({
    stateStore: new EncryptedStateStore(root, randomBytes(48)),
    launcher: new DirectChromiumLauncher({
      runtimeDir: path.join(root, 'runtime'),
      chromiumSandbox: process.getuid?.() !== 0,
    }),
  });
  const registry = new VNCViewRegistry();
  const connections = new Map();
  const webSockets = new WebSocketServer({ noServer: true });
  let viewerBrowser;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(viewerHTML);
      return;
    }
    const resolved = path.resolve(noVNCRoot, url.pathname.slice('/novnc/'.length));
    if (!url.pathname.startsWith('/novnc/') || !resolved.startsWith(`${noVNCRoot}${path.sep}`)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const content = await readFile(resolved);
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(content);
    } catch {
      response.writeHead(404).end();
    }
  });
  t.after(async () => {
    await viewerBrowser?.close();
    for (const socket of webSockets.clients) socket.terminate();
    await registry.close();
    await pool.close();
    await new Promise((resolve) => webSockets.close(resolve));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const alpha = await pool.ensure('alpha', { view: true });
  const beta = await pool.ensure('beta', { view: true });
  const sharedBrowser = pool.browser;
  const alphaPage = alpha.context.pages()[0];
  const betaPage = beta.context.pages()[0];
  await alphaPage.setContent(fixture('rgb(220,30,30)', ''));
  await betaPage.setContent(fixture('rgb(30,50,220)', 'beta-only'));

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost');
    const record = { alpha, beta }[url.searchParams.get('project')];
    if (!record || url.pathname !== '/view') {
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      const key = `${record.project}/${url.searchParams.get('transport')}`;
      connections.set(key, webSocket);
      registry.attach(record, url.searchParams.get('transport'), url.searchParams.get('viewer'), webSocket);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  viewerBrowser = await chromium.launch({ headless: true, chromiumSandbox: process.getuid?.() !== 0 });
  const viewerContext = await viewerBrowser.newContext({ viewport: { width: 1280, height: 760 } });
  const alphaViewer = await viewerContext.newPage();
  const betaViewer = await viewerContext.newPage();
  await alphaViewer.goto(`${origin}/?project=alpha`);
  await betaViewer.goto(`${origin}/?project=beta`);
  await eventually(() => alphaViewer.evaluate(() => window.connectionCount === 1), 'alpha noVNC handshake');
  await eventually(() => betaViewer.evaluate(() => window.connectionCount === 1), 'beta noVNC handshake');
  await eventually(async () => {
    const [red, green, blue] = await samplePixel(alphaViewer);
    return red > 180 && green < 80 && blue < 80;
  }, 'alpha renders its red page via RFB JPEG');
  await eventually(async () => {
    const [red, green, blue] = await samplePixel(betaViewer);
    return red < 80 && green < 100 && blue > 180;
  }, 'beta renders its blue page via RFB JPEG');

  await alphaViewer.locator('canvas').click({ position: { x: 60, y: 40 } });
  await alphaViewer.keyboard.type('alpha.a', { delay: 15 });
  await eventually(async () => await alphaPage.locator('#field').inputValue() === 'alpha.a', 'typing through noVNC');
  await alphaViewer.keyboard.press('Period');
  await eventually(async () => await alphaPage.locator('#field').inputValue() === 'alpha.a.', 'period key down and up');
  // A complete background tabs heartbeat must not erase the edited field.
  await delay(1_200);
  assert.equal(await alphaPage.locator('#field').inputValue(), 'alpha.a.');
  await alphaViewer.keyboard.press('Backspace');
  await eventually(async () => await alphaPage.locator('#field').inputValue() === 'alpha.a', 'Backspace');
  await alphaViewer.keyboard.press('Control+a');
  await alphaViewer.keyboard.type('replacement.');
  await eventually(async () => await alphaPage.locator('#field').inputValue() === 'replacement.', 'Ctrl+A replacement');
  await alphaViewer.keyboard.press('Tab');
  await alphaViewer.keyboard.press('Enter');
  await eventually(() => alphaPage.evaluate(() => window.activated === 1), 'Tab focuses and Enter activates button');

  await alphaViewer.locator('canvas').click({ position: { x: 60, y: 40 } });
  await alphaViewer.keyboard.press('Control+a');
  await alphaViewer.evaluate(() => window.rfb.clipboardPasteFrom('alpha clipboard'));
  await alphaViewer.keyboard.press('Control+v');
  await eventually(async () => await alphaPage.locator('#field').inputValue() === 'alpha clipboard', 'RFB clipboard paste');
  await alphaViewer.keyboard.press('Control+a');
  await eventually(() => alphaPage.locator('#field').evaluate((field) => field.selectionStart === 0 && field.selectionEnd === field.value.length), 'select before Unicode control paste');
  await alphaViewer.evaluate(() => window.control.send(JSON.stringify({ type: 'insertText', text: 'שלום café 日本語 🚀' })));
  await eventually(async () => await alphaPage.locator('#field').inputValue() === 'שלום café 日本語 🚀', 'explicit Unicode clipboard insertion');
  await alphaViewer.keyboard.press('Control+a');
  await eventually(() => alphaPage.locator('#field').evaluate((field) => field.selectionStart === 0 && field.selectionEnd === field.value.length), 'alpha selects the complete Unicode value');
  await alphaViewer.evaluate(() => window.control.send(JSON.stringify({ type: 'copySelection' })));
  await eventually(() => alphaViewer.evaluate(() => window.messages.some((message) => message.type === 'clipboard' && message.text === 'שלום café 日本語 🚀')), 'copy selection returns only alpha selection');

  // Websites can write the native Chromium clipboard on a trusted click even
  // though the viewer never uses it. Seed it to prove both paste shortcut
  // variants are isolated from that shared browser-process resource.
  await alphaViewer.locator('canvas').click({ position: { x: 290, y: 110 } });
  await eventually(() => alphaPage.evaluate(() => window.nativeCopySucceeded === true), 'fixture seeds native Chromium clipboard');

  await betaViewer.locator('canvas').click({ position: { x: 60, y: 40 } });
  await betaViewer.keyboard.press('End');
  await betaViewer.keyboard.press('Control+v');
  await betaViewer.keyboard.press('Shift+Insert');
  // Wait for a following input round trip before asserting the preceding paste
  // could not have retrieved alpha's clipboard from the shared Chromium host.
  await betaViewer.keyboard.type('!');
  await eventually(async () => await betaPage.locator('#field').inputValue() === 'beta-only!', 'beta cannot paste alpha clipboard');
  await betaViewer.keyboard.press('Control+a');
  await betaViewer.keyboard.press('Control+Insert');
  await eventually(() => betaViewer.evaluate(() => window.messages.some((message) => message.type === 'clipboard' && message.text === 'beta-only!')), 'beta copy selection remains isolated');
  await betaViewer.keyboard.press('Shift+Delete');
  await eventually(async () => await betaPage.locator('#field').inputValue() === '', 'alternate cut shortcut deletes scoped selection');
  await betaViewer.keyboard.type('beta-after-cut');
  await eventually(async () => await betaPage.locator('#field').inputValue() === 'beta-after-cut', 'typing after alternate cut');
  assert.equal(await alphaPage.locator('#field').inputValue(), 'שלום café 日本語 🚀');

  await alphaViewer.locator('canvas').click({ position: { x: 60, y: 180 } });
  await alphaViewer.keyboard.press('Control+a');
  await alphaViewer.evaluate(() => { window.messages = []; });
  await alphaViewer.keyboard.press('Control+c');
  await eventually(() => alphaViewer.evaluate(() => window.messages.some((message) => message.type === 'clipboard' && message.text === '')), 'password selection is not exposed by copy');

  await alphaViewer.mouse.move(600, 450);
  await alphaViewer.mouse.wheel(0, 350);
  await eventually(() => alphaPage.evaluate(() => window.scrollY > 0), 'noVNC wheel scroll');
  assert.equal(await betaPage.evaluate(() => window.scrollY), 0);
  assert.equal(await alphaPage.evaluate(() => window.inputEvents.length > 15 && window.inputEvents.every((event) => event.trusted)), true);

  // A dropped display connection destroys the viewer pair, not its project's
  // BrowserContext. Recreate both transports exactly as the frontend does.
  connections.get('alpha/vnc').terminate();
  await eventually(() => alphaViewer.evaluate(() => window.disconnectCount === 1), 'forced RFB socket disconnect');
  await alphaViewer.evaluate(() => window.openViewer());
  await eventually(() => alphaViewer.evaluate(() => window.connectionCount === 2), 'new noVNC connection after drop');
  await eventually(async () => (await samplePixel(alphaViewer))[0] > 180, 'frame returns after reconnect');
  assert.equal(pool.browser, sharedBrowser);
  assert.equal(pool.records.get('alpha'), alpha);
  assert.equal(alpha.context.pages()[0], alphaPage);
  assert.equal(await alphaPage.locator('#field').inputValue(), 'שלום café 日本語 🚀');
  assert.equal(await betaPage.locator('#field').inputValue(), 'beta-after-cut');
  assert.deepEqual(await alphaViewer.evaluate(() => window.clientErrors), []);
  assert.deepEqual(await betaViewer.evaluate(() => window.clientErrors), []);
});
