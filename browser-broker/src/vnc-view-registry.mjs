import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { RFBConnection } from './rfb-connection.mjs';
import { ViewSession } from './view-session.mjs';

const controls = new Set(['navigate', 'reload', 'back', 'forward', 'newPage', 'selectPage', 'closePage', 'insertText', 'copySelection']);
export const validViewerID = (value) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value || '');

// Both channels pass the existing project authorization before attachment.
// The UUID only pairs channels within that project; it is never a credential.
export class VNCViewRegistry {
  constructor({ pairingTimeoutMs = 10_000 } = {}) {
    this.pairs = new Map();
    this.pairingTimeoutMs = pairingTimeoutMs;
  }

  attach(record, transport, viewerID, socket) {
    if (!['vnc', 'control'].includes(transport) || !validViewerID(viewerID)) {
      socket.close(1008, 'invalid browser transport');
      return;
    }
    const key = `${record.project}:${viewerID}`;
    let pair = this.pairs.get(key);
    if (!pair) {
      if (record.viewers.size >= 4) {
        socket.close(1013, 'browser viewer limit reached');
        return;
      }
      pair = new VNCViewPair(record, () => this.pairs.delete(key));
      this.pairs.set(key, pair);
      record.viewers.add(pair);
      pair.timer = setTimeout(() => pair.close(1008, 'browser channels did not connect'), this.pairingTimeoutMs);
      pair.timer.unref?.();
    }
    if (pair.record !== record || pair[transport]) {
      socket.close(1008, 'browser channel already attached');
      return;
    }
    pair.attach(transport, socket);
  }

  close() {
    for (const pair of this.pairs.values()) pair.close(1001, 'browser broker restarting');
  }
}

class VNCViewPair extends EventEmitter {
  constructor(record, onClose) {
    super();
    this.record = record;
    this.onClose = onClose;
    this.readyState = WebSocket.CONNECTING;
    this.control = null;
    this.vnc = null;
    this.rfb = null;
    this.session = null;
    this.timer = null;
    this.heartbeat = null;
    this.pendingControls = 0;
  }

  get bufferedAmount() { return this.vnc?.bufferedAmount || 0; }

  attach(transport, socket) {
    this[transport] = socket;
    socket.on('error', () => this.close(1011, 'browser transport error'));
    socket.on('close', (code) => this.close(code === 1000 ? 1000 : 1001, 'browser channel closed'));
    socket.alive = true;
    socket.on('pong', () => { socket.alive = true; });
    if (transport === 'control') {
      socket.on('message', (data, binary) => {
        if (this.closing) return;
        if (binary || data.length > 64 * 1024) {
          this.close(1008, 'invalid browser control');
          return;
        }
        try {
          const message = JSON.parse(data.toString('utf8'));
          if (message && controls.has(message.type) && this.session) {
            if (++this.pendingControls > 64) {
              this.close(1008, 'browser control queue limit reached');
              return;
            }
            // A toolbar click must wait for RFB keys already received (e.g.
            // Select All before Copy) to finish reaching the selected page.
            void Promise.resolve(this.rfb.inputQueue)
              .then(() => { if (!this.closing) return this.input(message); })
              .catch(() => this.close(1011, 'browser control failed'))
              .finally(() => { this.pendingControls--; });
          }
        } catch {
          this.close(1008, 'invalid browser control');
        }
      });
    }
    if (!this.vnc || !this.control) return;
    this.readyState = WebSocket.OPEN;
    this.rfb = new RFBConnection(this.vnc, {
      onInput: (message) => this.input(message),
      onReady: () => {
        if (this.readyState !== WebSocket.OPEN) return;
        clearTimeout(this.timer);
        this.timer = null;
        this.session = new ViewSession(this.record, this);
        void this.session.start().catch(() => this.close(1011, 'browser viewer failed'));
      },
      onClose: () => this.close(1001, 'browser VNC connection closed'),
    });
    this.heartbeat = setInterval(() => {
      for (const channel of [this.vnc, this.control]) {
        if (!channel.alive) {
          this.close(1001, 'browser heartbeat timed out');
          channel.terminate();
          return;
        }
        channel.alive = false;
        if (channel.readyState === WebSocket.OPEN) channel.ping();
      }
    }, 20_000);
    this.heartbeat.unref?.();
  }

  input(message) {
    if (this.readyState === WebSocket.OPEN && this.session) {
      this.emit('message', Buffer.from(JSON.stringify(message)));
      return this.session.messageQueue;
    }
  }

  send(data) {
    if (this.readyState !== WebSocket.OPEN) return;
    const message = JSON.parse(data);
    if (message.type === 'frame') {
      this.rfb.setFrame(message);
    } else if (this.control.readyState === WebSocket.OPEN && this.control.bufferedAmount < 256 * 1024) {
      this.control.send(data);
    }
  }

  close(code = 1000, reason = 'browser view closed') {
    if (this.closing) return;
    this.closing = true;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    this.record.viewers.delete(this);
    this.onClose();
    if (this.session && code !== 1000) {
      console.info(`browser-broker: viewer closed project=${this.record.project} code=${code} reason=${reason}`);
    }
    // Release held VNC keys before detaching CDP. This cleanup never replays
    // input onto a replacement connection or another project.
    void Promise.resolve(this.rfb?.close()).finally(() => {
      this.readyState = WebSocket.CLOSED;
      this.emit('close');
    });
    for (const channel of [this.vnc, this.control]) {
      if (channel && channel.readyState < WebSocket.CLOSING) channel.close(code, reason);
    }
  }
}
