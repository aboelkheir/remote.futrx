import { RFBInput } from './rfb-input.mjs';

const VERSION = Buffer.from('RFB 003.008\n');
const TIGHT = 7;
const DESKTOP_SIZE = -223;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_CLIPBOARD_BYTES = 32 * 1024;
const MAX_FRAME_BYTES = 0x3fffff;
const MAX_BUFFERED_OUTPUT = 2_000_000;

function compactLength(length) {
  const bytes = [length & 0x7f];
  if (length > 0x7f) {
    bytes[0] |= 0x80;
    bytes.push((length >> 7) & 0x7f);
    if (length > 0x3fff) {
      bytes[1] |= 0x80;
      bytes.push(length >> 14);
    }
  }
  return Buffer.from(bytes);
}

function rectangle(width, height, encoding) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(width, 4);
  header.writeUInt16BE(height, 6);
  header.writeInt32BE(encoding, 8);
  return header;
}

/**
 * A project-page RFB endpoint, not a host VNC server. The caller MUST authenticate
 * and authorize the outer WebSocket before construction. RFB security type None
 * is only the inner protocol; this class never opens an unauthenticated listener.
 * Only bounded input messages leave this class; clients cannot supply CDP targets.
 */
export class RFBConnection {
  constructor(socket, { onInput = () => {}, onReady = () => {}, onClose = () => {} } = {}) {
    this.socket = socket;
    this.onInput = onInput;
    this.onReady = onReady;
    this.onClose = onClose;
    this.state = 'version';
    this.buffer = Buffer.alloc(0);
    this.encodings = new Set();
    this.input = new RFBInput();
    this.inputQueue = Promise.resolve();
    this.pendingInputs = 0;
    this.width = 1280;
    this.height = 720;
    this.frame = null;
    this.sequence = 0;
    this.sentSequence = 0;
    this.updateRequested = false;
    this.fullUpdateRequested = false;
    this.sendingFrame = false;
    this.retryTimer = null;
    this.closed = false;
    this.closePromise = null;
    this.messagesAt = Date.now();
    this.messagesInWindow = 0;
    this.handleMessage = (data, isBinary = true) => {
      if (this.closed) return;
      if (!isBinary) return this.fail('RFB requires binary WebSocket messages');
      try {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (this.buffer.length + chunk.length > MAX_INPUT_BYTES) throw new Error('RFB input buffer limit reached');
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
        let processed = 0;
        while (!this.closed && this.parseMessage()) {
          if (++processed > 1024) throw new Error('RFB message batch limit reached');
          if (Date.now() - this.messagesAt >= 1000) {
            this.messagesAt = Date.now();
            this.messagesInWindow = 0;
          }
          if (++this.messagesInWindow > 4096) throw new Error('RFB message rate limit reached');
        }
      } catch (error) {
        this.fail(error.message || 'Invalid RFB message');
      }
    };
    this.handleClose = () => { void this.close(); };
    this.handleError = () => { this.fail('RFB connection error'); };
    socket.on('message', this.handleMessage);
    socket.on('close', this.handleClose);
    socket.on('error', this.handleError);
    this.handshakeTimer = setTimeout(() => this.fail('RFB handshake timed out'), 15_000);
    this.handshakeTimer.unref?.();
    this.send(VERSION);
  }

  take(length) {
    if (this.buffer.length < length) return null;
    const result = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return result;
  }

  parseMessage() {
    if (this.state === 'version') {
      const version = this.take(12);
      if (!version) return false;
      if (!version.equals(VERSION)) throw new Error('RFB 3.8 is required');
      this.state = 'security';
      this.send(Buffer.from([1, 1])); // One offered security type: None.
      return true;
    }
    if (this.state === 'security') {
      const choice = this.take(1);
      if (!choice) return false;
      if (choice[0] !== 1) throw new Error('Unsupported RFB security type');
      this.state = 'init';
      this.send(Buffer.alloc(4)); // SecurityResult: success.
      return true;
    }
    if (this.state === 'init') {
      const init = this.take(1);
      if (!init) return false;
      if (init[0] > 1) throw new Error('Invalid RFB shared flag');
      const name = Buffer.from('Remote project browser');
      const header = Buffer.alloc(24);
      header.writeUInt16BE(this.width, 0);
      header.writeUInt16BE(this.height, 2);
      header[4] = 32; header[5] = 24; header[6] = 0; header[7] = 1;
      header.writeUInt16BE(255, 8); header.writeUInt16BE(255, 10); header.writeUInt16BE(255, 12);
      header[14] = 16; header[15] = 8; header[16] = 0;
      header.writeUInt32BE(name.length, 20);
      this.state = 'ready';
      clearTimeout(this.handshakeTimer);
      this.send(Buffer.concat([header, name]));
      Promise.resolve().then(() => { if (!this.closed) return this.onReady(); }).catch(() => this.fail('RFB initialization failed'));
      return true;
    }
    if (!this.buffer.length) return false;
    switch (this.buffer[0]) {
      case 0: {
        const format = this.take(20);
        if (!format) return false;
        if (format[4] !== 32 || format[5] !== 24 || format[6] > 1 || format[7] !== 1 ||
            [8, 10, 12].some((offset) => format.readUInt16BE(offset) !== 255) ||
            [...format.subarray(14, 17)].sort((a, b) => a - b).join(',') !== '0,8,16') {
          throw new Error('RFB requires 24-bit true color');
        }
        return true;
      }
      case 2: {
        if (this.buffer.length < 4) return false;
        const count = this.buffer.readUInt16BE(2);
        if (count > 128) throw new Error('RFB encoding count limit reached');
        const message = this.take(4 + 4 * count);
        if (!message) return false;
        this.encodings = new Set(Array.from({ length: count }, (_, i) => message.readInt32BE(4 + 4 * i)));
        if (!this.encodings.has(TIGHT)) throw new Error('RFB client must support Tight encoding');
        this.flushFrame();
        return true;
      }
      case 3: {
        const message = this.take(10);
        if (!message) return false;
        if (message[1] > 1) throw new Error('Invalid RFB update request');
        // Full-page JPEG updates cover every requested rectangle. Requests are
        // coalesced, never accumulated into an unbounded queue.
        this.updateRequested = true;
        this.fullUpdateRequested ||= message[1] === 0;
        this.flushFrame();
        return true;
      }
      case 4: {
        const message = this.take(8);
        if (!message) return false;
        if (message[1] > 1) throw new Error('Invalid RFB key event');
        this.queueInputs(this.input.key(message.readUInt32BE(4), message[1] === 1));
        return true;
      }
      case 5: {
        const message = this.take(6);
        if (!message) return false;
        this.queueInputs(this.input.pointer(message[1], message.readUInt16BE(2), message.readUInt16BE(4), this.width, this.height));
        return true;
      }
      case 6: {
        if (this.buffer.length < 8) return false;
        const length = this.buffer.readInt32BE(4);
        // Extended clipboard was not advertised by this server. Standard RFB
        // clipboard is ISO-8859-1; Unicode paste uses the scoped control channel.
        if (length < 0 || length > MAX_CLIPBOARD_BYTES) throw new Error('RFB clipboard length limit reached');
        const message = this.take(8 + length);
        if (!message) return false;
        if (length) this.queueInputs([{ type: 'insertText', text: message.subarray(8).toString('latin1') }]);
        return true;
      }
      default:
        throw new Error('Unsupported RFB client message');
    }
  }

  queueInputs(messages) {
    if (this.pendingInputs + messages.length > 256) throw new Error('RFB input queue limit reached');
    for (const message of messages) {
      this.pendingInputs++;
      this.inputQueue = this.inputQueue
        .then(() => this.onInput(message))
        .catch(() => this.fail('Browser input failed'))
        .finally(() => { this.pendingInputs--; });
    }
  }

  setFrame({ data, width, height }) {
    if (this.closed) return false;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4096 || height > 4096 ||
        typeof data !== 'string' || data.length > Math.ceil(MAX_FRAME_BYTES / 3) * 4) return false;
    const jpeg = Buffer.from(data, 'base64');
    if (jpeg.length < 4 || jpeg.length > MAX_FRAME_BYTES || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return false;
    this.frame = { jpeg, width, height, sequence: ++this.sequence };
    this.flushFrame();
    return true;
  }

  flushFrame() {
    if (this.closed || this.state !== 'ready' || !this.encodings.has(TIGHT) || !this.updateRequested ||
        !this.frame || this.sendingFrame || (!this.fullUpdateRequested && this.frame.sequence === this.sentSequence)) return;
    if (this.socket.bufferedAmount > MAX_BUFFERED_OUTPUT) {
      if (!this.retryTimer) {
        this.retryTimer = setTimeout(() => { this.retryTimer = null; this.flushFrame(); }, 30);
        this.retryTimer.unref?.();
      }
      return;
    }
    const frame = this.frame;
    const resized = frame.width !== this.width || frame.height !== this.height;
    if (resized && !this.encodings.has(DESKTOP_SIZE)) return this.fail('RFB client must support desktop resizing');
    const parts = [Buffer.from([0, 0, 0, resized ? 2 : 1])];
    if (resized) parts.push(rectangle(frame.width, frame.height, DESKTOP_SIZE));
    parts.push(rectangle(frame.width, frame.height, TIGHT), Buffer.from([0x90]), compactLength(frame.jpeg.length), frame.jpeg);
    this.width = frame.width;
    this.height = frame.height;
    this.updateRequested = false;
    this.fullUpdateRequested = false;
    this.sentSequence = frame.sequence;
    this.sendingFrame = true;
    this.send(Buffer.concat(parts), () => {
      this.sendingFrame = false;
      this.flushFrame();
    });
  }

  sendClipboard(text) {
    if (this.state !== 'ready') return;
    const data = Buffer.from([...String(text).slice(0, MAX_CLIPBOARD_BYTES)].map((char) => char.codePointAt(0) <= 255 ? char : '?').join(''), 'latin1');
    const header = Buffer.alloc(8);
    header[0] = 3;
    header.writeUInt32BE(data.length, 4);
    this.send(Buffer.concat([header, data]));
  }

  send(data, callback = () => {}) {
    if (this.closed || this.socket.readyState !== 1) return;
    try {
      this.socket.send(data, { binary: true }, (error) => {
        if (error) this.fail('RFB send failed');
        else callback();
      });
    } catch {
      this.fail('RFB send failed');
    }
  }

  fail(reason) {
    if (this.closed) return;
    // Reasons are fixed protocol diagnostics, never page or clipboard contents.
    this.socket.close(1008, String(reason).slice(0, 120));
    void this.close();
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    clearTimeout(this.handshakeTimer);
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.buffer = Buffer.alloc(0);
    this.frame = null;
    this.socket.off('message', this.handleMessage);
    this.socket.off('close', this.handleClose);
    // Retain the error handler until the socket finishes closing, so late socket
    // errors cannot become an unhandled EventEmitter error.
    const releases = this.input.release();
    this.closePromise = this.inputQueue.then(async () => {
      for (const message of releases) await Promise.resolve().then(() => this.onInput(message)).catch(() => {});
      // The owner's close callback can itself call close(). Do not await its
      // return value and create a cycle back into this same promise.
      Promise.resolve().then(() => this.onClose()).catch(() => {});
    }).catch(() => {});
    return this.closePromise;
  }
}
