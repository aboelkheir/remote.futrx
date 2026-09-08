import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { controlProjectFromRequest, projectFromRequest } from './auth.mjs';
import { BrowserPool } from './browser-pool.mjs';
import { MCPRouter } from './mcp-router.mjs';
import { EncryptedStateStore } from './state-store.mjs';
import { VNCViewRegistry, validViewerID } from './vnc-view-registry.mjs';

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function readSecret(file) {
  const secret = Buffer.from((await readFile(file, 'utf8')).trim(), 'utf8');
  if (secret.length < 32) throw new Error('browser broker secret must contain at least 32 bytes');
  return secret;
}

function json(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function authorizedProject(secret, request, response) {
  const project = projectFromRequest(secret, request);
  if (!project) json(response, 401, { error: 'unauthorized' });
  return project;
}

const host = process.env.BROWSER_BROKER_HOST || '127.0.0.1';
const port = positiveInteger(process.env.BROWSER_BROKER_PORT, 9323);
const secretFile = process.env.BROWSER_BROKER_SECRET_FILE;
const dataDir = process.env.BROWSER_BROKER_DATA_DIR || '/var/lib/remote-futrx-browser';
if (!secretFile) throw new Error('BROWSER_BROKER_SECRET_FILE is required');

const secret = await readSecret(secretFile);
const stateStore = new EncryptedStateStore(dataDir, secret);
const pool = new BrowserPool({
  stateStore,
  idleBrowserMs: positiveInteger(process.env.BROWSER_PROCESS_IDLE_MS, 30_000),
  maxContexts: positiveInteger(process.env.BROWSER_MAX_CONTEXTS, 32),
});
const mcp = new MCPRouter(pool, { outputRoot: process.env.BROWSER_BROKER_OUTPUT_DIR });
const webSockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
const vncViews = new VNCViewRegistry();

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://browser-broker.local');
    if (request.method === 'GET' && url.pathname === '/health') {
      json(response, 200, pool.health());
      return;
    }
    if (url.pathname === '/mcp') {
      const project = authorizedProject(secret, request, response);
      if (!project) return;
      await mcp.handle(project, request, response);
      return;
    }
    const project = controlProjectFromRequest(secret, request);
    if (!project) {
      json(response, 401, { error: 'unauthorized' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/status') {
      json(response, 200, pool.status(project));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/start-core') {
      await pool.ensure(project);
      mcp.openProject(project);
      json(response, 200, pool.status(project));
      return;
    }
    if (request.method === 'POST' && (url.pathname === '/v1/start' || url.pathname === '/v1/start-view')) {
      await pool.ensure(project, { view: true });
      mcp.openProject(project);
      json(response, 200, pool.status(project));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/stop-view') {
      await pool.stopView(project);
      json(response, 200, pool.status(project));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/stop') {
      await mcp.closeProject(project);
      await pool.stop(project);
      json(response, 200, pool.status(project));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/delete') {
      await mcp.closeProject(project);
      await pool.delete(project);
      await mcp.deleteProjectArtifacts(project);
      json(response, 200, pool.status(project));
      return;
    }
    json(response, 404, { error: 'not found' });
  } catch (error) {
    console.error(`browser-broker: request failed: ${error.stack || error.message}`);
    if (!response.headersSent) json(response, 500, { error: 'browser broker request failed' });
    else response.destroy();
  }
});

server.on('upgrade', async (request, socket, head) => {
  try {
    const url = new URL(request.url, 'http://browser-broker.local');
    const project = projectFromRequest(secret, request);
    const record = project ? pool.records.get(project) : null;
    const transport = url.searchParams.get('transport');
    const viewerID = url.searchParams.get('viewer');
    if (url.pathname !== '/view' || !record?.viewEnabled ||
        !['vnc', 'control'].includes(transport) || !validViewerID(viewerID)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      vncViews.attach(record, transport, viewerID, webSocket);
    });
  } catch {
    socket.destroy();
  }
});

const saveTimer = setInterval(
  () => void pool.saveAll(),
  positiveInteger(process.env.BROWSER_STATE_SAVE_MS, 60_000),
);
saveTimer.unref?.();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(saveTimer);
  server.close();
  await vncViews.close();
  webSockets.clients.forEach((socket) => socket.close(1001, 'browser broker restarting'));
  await mcp.close();
  await pool.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

server.listen(port, host, () => {
  console.log(`browser-broker: listening on http://${host}:${port}`);
});
