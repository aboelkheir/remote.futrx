import assert from "node:assert/strict";
import test from "node:test";
import { ReconnectingJsonWebSocket } from "./reconnectingJsonSocket.ts";

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly instances: FakeWebSocket[] = [];

  readyState = 0;
  binaryType: BinaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: string[] = [];
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(data: string): void {
    this.onmessage?.({ data });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }
}

test("reconnects a JSON socket after an established connection closes", async (context) => {
  const originalWebSocket = globalThis.WebSocket;
  FakeWebSocket.instances.length = 0;
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: FakeWebSocket,
  });
  context.after(() => {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    });
  });

  let opens = 0;
  let closes = 0;
  const messages: unknown[] = [];
  const socket = new ReconnectingJsonWebSocket({
    resolveUrl: () => "wss://remote.test/browser",
    onOpen: () => { opens++; },
    onClose: () => { closes++; },
    onMessage: (message) => messages.push(message),
  });
  context.after(() => socket.stop());

  socket.start();
  assert.equal(FakeWebSocket.instances.length, 1);
  FakeWebSocket.instances[0].open();
  FakeWebSocket.instances[0].receive('{"type":"tabs"}');
  assert.equal(opens, 1);
  assert.deepEqual(messages, [{ type: "tabs" }]);

  FakeWebSocket.instances[0].close();
  assert.equal(closes, 1);
  await new Promise((resolve) => setTimeout(resolve, 450));

  assert.equal(FakeWebSocket.instances.length, 2);
  FakeWebSocket.instances[1].open();
  assert.equal(opens, 2);
  assert.equal(socket.send({ type: "reload" }), true);
  assert.deepEqual(FakeWebSocket.instances[1].sent, ['{"type":"reload"}']);
});
