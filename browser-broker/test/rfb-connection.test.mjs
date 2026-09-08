import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { RFBConnection } from '../src/rfb-connection.mjs';

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent = [];
  deferred = [];
  holdSends = false;
  send(data, options, callback) {
    assert.equal(options.binary, true);
    this.sent.push(Buffer.from(data));
    if (this.holdSends) this.deferred.push(callback);
    else callback();
  }
  close(code, reason) {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
    this.emit('close');
  }
  receive(buffer) { this.emit('message', buffer, true); }
}

function encodings(values = [7, -223]) {
  const result = Buffer.alloc(4 + 4 * values.length);
  result[0] = 2;
  result.writeUInt16BE(values.length, 2);
  values.forEach((encoding, i) => result.writeInt32BE(encoding, 4 + i * 4));
  return result;
}
function update(incremental = true) {
  const result = Buffer.from([3, Number(incremental), 0, 0, 0, 0, 5, 0, 2, 208]);
  return result;
}
function key(keysym, down = true) {
  const result = Buffer.alloc(8);
  result[0] = 4;
  result[1] = Number(down);
  result.writeUInt32BE(keysym, 4);
  return result;
}
function cutText(text) {
  const bytes = Buffer.from(text, 'latin1');
  const header = Buffer.alloc(8);
  header[0] = 6;
  header.writeInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}
function connect(options = {}) {
  const socket = new Socket();
  const rfb = new RFBConnection(socket, options);
  socket.receive(Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1]), encodings()]));
  return { socket, rfb };
}
function jpeg(size = 12, fill = 10) {
  const data = Buffer.alloc(size, fill);
  data[0] = 0xff; data[1] = 0xd8;
  data[size - 2] = 0xff; data[size - 1] = 0xd9;
  return data;
}
function readTight(packet, offset = 16) {
  assert.equal(packet[offset++], 0x90);
  let length = packet[offset] & 127;
  if (packet[offset++] & 128) {
    length |= (packet[offset] & 127) << 7;
    if (packet[offset++] & 128) length |= packet[offset++] << 14;
  }
  return { length, jpeg: packet.subarray(offset) };
}

test('RFB 3.8 negotiates fragmented/coalesced packets and ordered input', async () => {
  const inputs = [];
  let ready = 0;
  const socket = new Socket();
  const rfb = new RFBConnection(socket, { onReady: () => ready++, onInput: (message) => inputs.push(message) });
  assert.equal(socket.sent[0].toString(), 'RFB 003.008\n');
  for (const byte of Buffer.from('RFB 003.008\n')) socket.receive(Buffer.from([byte]));
  assert.deepEqual(socket.sent[1], Buffer.from([1, 1]));
  socket.receive(Buffer.concat([Buffer.from([1, 1]), encodings(), key(97), key(97, false), cutText('café')]));
  await rfb.inputQueue;
  assert.equal(ready, 1);
  assert.deepEqual(socket.sent[2], Buffer.alloc(4));
  assert.equal(socket.sent[3].readUInt16BE(0), 1280);
  assert.equal(socket.sent[3].readUInt16BE(2), 720);
  assert.equal(socket.sent[3][4], 32);
  assert.deepEqual(inputs.map((message) => [message.type, message.text]), [['key', 'a'], ['key', ''], ['insertText', 'café']]);
  await rfb.close();
});

test('Tight JPEG forwards original image bytes using all compact length forms', async () => {
  const { socket, rfb } = connect();
  for (const size of [12, 128, 16_384, 100_000]) {
    const data = jpeg(size);
    rfb.setFrame({ data: data.toString('base64'), width: 1280, height: 720 });
    const before = socket.sent.length;
    socket.receive(update());
    assert.equal(socket.sent.length, before + 1);
    const packet = socket.sent.at(-1);
    assert.deepEqual([...packet.subarray(0, 4)], [0, 0, 0, 1]);
    assert.equal(packet.readInt32BE(12), 7);
    const decoded = readTight(packet);
    assert.equal(decoded.length, size);
    assert.deepEqual(decoded.jpeg, data);
  }
  await rfb.close();
});

test('framebuffer requests and blocked sends keep only the newest frame', async () => {
  const { socket, rfb } = connect();
  const frame = (fill) => ({ data: jpeg(12, fill).toString('base64'), width: 1280, height: 720 });
  rfb.setFrame(frame(1));
  assert.equal(socket.sent.length, 4, 'no unsolicited framebuffer');
  socket.holdSends = true;
  socket.receive(update());
  assert.equal(socket.sent.length, 5);
  socket.receive(update());
  rfb.setFrame(frame(2));
  rfb.setFrame(frame(3));
  assert.equal(socket.sent.length, 5, 'in-flight update prevents queued images');
  socket.deferred.shift()();
  assert.equal(socket.sent.length, 6);
  assert.deepEqual(readTight(socket.sent.at(-1)).jpeg, jpeg(12, 3));
  socket.deferred.shift()();
  socket.receive(update());
  assert.equal(socket.sent.length, 6, 'incremental request waits for a changed frame');
  socket.receive(update(false));
  assert.equal(socket.sent.length, 7, 'non-incremental request resends latest frame');
  socket.deferred.shift()();
  socket.bufferedAmount = 3_000_000;
  socket.receive(update());
  rfb.setFrame(frame(4));
  rfb.setFrame(frame(5));
  assert.equal(socket.sent.length, 7, 'slow sockets do not accumulate framebuffer writes');
  socket.bufferedAmount = 0;
  rfb.flushFrame();
  assert.equal(socket.sent.length, 8);
  assert.deepEqual(readTight(socket.sent.at(-1)).jpeg, jpeg(12, 5));
  await rfb.close();
});

test('frame dimension changes use a negotiated DesktopSize rectangle', async () => {
  const { socket, rfb } = connect();
  rfb.setFrame({ data: jpeg().toString('base64'), width: 800, height: 600 });
  socket.receive(update());
  const packet = socket.sent.at(-1);
  assert.equal(packet.readUInt16BE(2), 2);
  assert.equal(packet.readInt32BE(12), -223);
  assert.equal(packet.readUInt16BE(8), 800);
  assert.equal(packet.readUInt16BE(10), 600);
  assert.equal(packet.readInt32BE(24), 7);
  assert.equal(readTight(packet, 28).length, 12);
  assert.equal(rfb.width, 800);
  assert.equal(rfb.height, 600);
  await rfb.close();
});

test('malformed and oversized clients close without invoking page input', async (t) => {
  const invalidCases = [
    ['unknown message', Buffer.from([99])],
    ['too many encodings', Buffer.from([2, 0, 0, 129])],
    ['missing Tight', encodings([0])],
    ['oversized clipboard', Buffer.from([6, 0, 0, 0, 0, 1, 0, 0])],
    ['unnegotiated extended clipboard', Buffer.from([6, 0, 0, 0, 255, 255, 255, 252])],
    ['invalid key flag', Buffer.from([4, 2, 0, 0, 0, 0, 0, 97])],
    ['input buffer overflow', Buffer.alloc(65_537)],
    ['unsupported pixel format', Buffer.alloc(20)],
  ];
  for (const [name, data] of invalidCases) {
    await t.test(name, async () => {
      const inputs = [];
      const { socket, rfb } = connect({ onInput: (message) => inputs.push(message) });
      socket.receive(data);
      await rfb.close();
      assert.equal(socket.closeCode, 1008);
      assert.equal(inputs.length, 0);
      assert.equal(rfb.buffer.length, 0);
    });
  }
});

test('handshake rejects unsupported versions, security types and text messages', async () => {
  for (const invalid of ['version', 'security', 'text']) {
    const socket = new Socket();
    const rfb = new RFBConnection(socket);
    if (invalid === 'version') socket.receive(Buffer.from('RFB 003.003\n'));
    if (invalid === 'security') socket.receive(Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([2])]));
    if (invalid === 'text') socket.emit('message', Buffer.from('RFB 003.008\n'), false);
    assert.equal(socket.closeCode, 1008);
    await rfb.close();
  }
});

test('partial clipboard payload waits for its declared bytes before processing the next key', async () => {
  const inputs = [];
  const { socket, rfb } = connect({ onInput: (message) => inputs.push(message) });
  const clipboard = cutText('a'.repeat(32_768));
  socket.receive(clipboard.subarray(0, 500));
  await rfb.inputQueue;
  assert.equal(inputs.length, 0);
  socket.receive(Buffer.concat([clipboard.subarray(500), key(46), key(46, false)]));
  await rfb.inputQueue;
  assert.equal(inputs[0].text.length, 32_768);
  assert.deepEqual(inputs.slice(1).map((message) => message.text), ['.', '']);
  await rfb.close();
});

test('input flood closes at the bounded pending queue and still releases held keys', async () => {
  const inputs = [];
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const { socket, rfb } = connect({ onInput: async (message) => { await gate; inputs.push(message); } });
  socket.receive(Buffer.concat(Array.from({ length: 300 }, () => key(97))));
  assert.equal(socket.closeCode, 1008);
  assert.match(socket.closeReason, /input queue limit/);
  assert.ok(rfb.pendingInputs <= 256);
  unblock();
  await rfb.close();
  assert.equal(inputs.at(-1).eventType, 'keyUp');
  assert.equal(rfb.pendingInputs, 0);
});

test('non-input message floods are limited independently of the input queue', async () => {
  const { socket, rfb } = connect();
  const batch = Buffer.concat(Array.from({ length: 1000 }, () => update()));
  for (let i = 0; i < 5; i++) socket.receive(batch);
  assert.equal(socket.closeCode, 1008);
  assert.match(socket.closeReason, /message rate limit/);
  await rfb.close();
});

test('disconnect releases held keys before notifying owner and never repeats cleanup', async () => {
  const events = [];
  const { socket, rfb } = connect({ onInput: (message) => events.push(message.eventType), onClose: () => { events.push('closed'); return rfb.close(); } });
  socket.receive(Buffer.concat([key(0xffe3), key(97), Buffer.from([5, 1, 0, 10, 0, 10])]));
  socket.close(1000, 'done');
  await rfb.close();
  await Promise.resolve();
  assert.deepEqual(events, ['keyDown', 'keyDown', 'mouseMoved', 'mousePressed', 'keyUp', 'keyUp', 'mouseReleased', 'closed']);
  await rfb.close();
  assert.equal(events.filter((event) => event === 'closed').length, 1);
});

test('invalid frames cannot enlarge client memory or replace a valid frame', async () => {
  const { rfb } = connect();
  const valid = { data: jpeg().toString('base64'), width: 1280, height: 720 };
  assert.equal(rfb.setFrame(valid), true);
  for (const invalid of [{ ...valid, width: 0 }, { ...valid, height: 100_000 }, { ...valid, data: 'hello' }, { ...valid, data: 'A'.repeat(6_000_000) }]) {
    assert.equal(rfb.setFrame(invalid), false);
    assert.equal(rfb.frame.sequence, 1);
  }
  await rfb.close();
});
