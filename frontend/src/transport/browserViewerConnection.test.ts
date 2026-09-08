import assert from "node:assert/strict";
import test from "node:test";
import { BrowserViewerConnection } from "./browserViewerConnection.ts";

class FakeControl extends EventTarget {
  readyState = 0;
  sent: string[] = [];
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
}
class FakeDisplay extends EventTarget {
  closed = false;
  open() { this.dispatchEvent(new Event("connect")); }
  disconnect() { this.closed = true; this.dispatchEvent(new Event("disconnect")); }
}

test("paired viewer waits for both transports, replaces both on failure, and never replays input", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const controls: FakeControl[] = [];
  const displays: FakeDisplay[] = [];
  const urls: string[] = [];
  const states: string[] = [];
  const received: unknown[] = [];
  let identifier = 0;
  const viewer = new BrowserViewerConnection({
    url: "wss://remote.test/api/projects/alpha/agent-browser/view",
    createViewerID: () => `viewer-${++identifier}`,
    createSocket: (url) => { urls.push(url); const socket = new FakeControl(); controls.push(socket); return socket as unknown as WebSocket; },
    createDisplay: (url) => { urls.push(url); const display = new FakeDisplay(); displays.push(display); return display; },
    onState: (state) => states.push(state),
    onMessage: (message) => received.push(message),
  });
  viewer.start();
  assert.deepEqual(urls.map((url) => new URL(url).searchParams.get("viewer")), ["viewer-1", "viewer-1"]);
  controls[0].open();
  assert.equal(viewer.isOpen, false);
  assert.equal(viewer.send({ type: "insertText", text: "not queued" }), false);
  displays[0].open();
  assert.equal(viewer.isOpen, true);
  assert.equal(viewer.send({ type: "reload" }), true);
  assert.deepEqual(controls[0].sent, ['{"type":"reload"}']);
  displays[0].disconnect();
  assert.equal(controls[0].readyState, 3);
  assert.equal(viewer.isOpen, false);
  assert.equal(viewer.send({ type: "insertText", text: "not replayed" }), false);
  context.mock.timers.tick(400);
  assert.equal(controls.length, 2);
  assert.equal(viewer.generation, 2);
  assert.deepEqual(urls.slice(2).map((url) => new URL(url).searchParams.get("viewer")), ["viewer-2", "viewer-2"]);
  displays[0].open();
  controls[0].dispatchEvent(new MessageEvent("message", { data: '{"type":"stale"}' }));
  assert.equal(viewer.isOpen, false);
  assert.deepEqual(received, []);
  displays[1].open();
  controls[1].open();
  assert.equal(viewer.isOpen, true);
  assert.deepEqual(controls[1].sent, []);
  controls[1].close();
  assert.equal(displays[1].closed, true);
  viewer.stop();
  context.mock.timers.tick(20000);
  assert.equal(controls.length, 2);
  assert.deepEqual(states, ["connecting", "connected", "reconnecting", "reconnecting", "connected", "reconnecting"]);
});

test("an incomplete RFB handshake times out and manual retry cancels its scheduled retry", (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const controls: FakeControl[] = [];
  const displays: FakeDisplay[] = [];
  const viewer = new BrowserViewerConnection({
    url: "wss://remote.test/browser",
    createViewerID: () => "test-viewer",
    createSocket: () => { const control = new FakeControl(); controls.push(control); return control as unknown as WebSocket; },
    createDisplay: () => { const display = new FakeDisplay(); displays.push(display); return display; },
    onState: () => {}, onMessage: () => {},
  });
  viewer.start();
  controls[0].open();
  context.mock.timers.tick(15000);
  assert.equal(controls[0].readyState, 3);
  assert.equal(displays[0].closed, true);
  viewer.retry();
  assert.equal(controls.length, 2);
  context.mock.timers.tick(400);
  assert.equal(controls.length, 2);
  viewer.stop();
  context.mock.timers.tick(30000);
  assert.equal(controls.length, 2);
});
