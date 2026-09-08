import WebSocket from 'ws';

function socketOpen(socket) {
  return socket.readyState === WebSocket.OPEN;
}

function safeURL(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return 'about:blank';
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(candidate);
  if (!['http:', 'https:', 'about:'].includes(parsed.protocol)) throw new Error('unsupported navigation protocol');
  return parsed.href;
}

export class ViewSession {
  constructor(record, socket) {
    this.record = record;
    this.socket = socket;
    this.page = null;
    this.cdp = null;
    this.generation = 0;
    this.tabsTimer = null;
    this.pageListeners = null;
    this.messageQueue = Promise.resolve();
    this.pendingMessages = 0;
    this.closed = false;
    this.lastFrameAt = 0;
    this.frameTimer = null;
    this.pendingFrame = null;
  }

  async start() {
    this.record.viewers.add(this.socket);
    this.socket.on('message', (data) => {
      if (++this.pendingMessages > 256) {
        this.pendingMessages--;
        this.socket.close(1008, 'browser input queue limit reached');
        return;
      }
      this.messageQueue = this.messageQueue
        .then(() => this.onMessage(data))
        .catch((error) => this.send({ type: 'error', message: error.message || 'Browser action failed' }))
        .finally(() => { this.pendingMessages--; });
    });
    this.socket.on('close', () => void this.close());
    this.socket.on('error', () => {});
    this.record.context.on('page', this.onPage);
    this.tabsTimer = setInterval(() => void this.sendTabs(), 1000);
    this.tabsTimer.unref?.();
    const pages = this.record.context.pages();
    await this.selectPage(pages.at(-1) || await this.record.context.newPage());
  }

  onPage = (page) => {
    void this.selectPage(page).catch(() => {});
  };

  pageID(page) {
    let id = this.record.pageIDs.get(page);
    if (!id) {
      id = String(this.record.nextPageID++);
      this.record.pageIDs.set(page, id);
    }
    return id;
  }

  send(payload) {
    if (socketOpen(this.socket)) this.socket.send(JSON.stringify(payload));
  }

  async sendTabs() {
    if (this.closed || this.closing) return;
    const pages = this.record.context.pages();
    const tabs = await Promise.all(pages.map(async (page) => ({
      id: this.pageID(page),
      title: (await page.title().catch(() => '')) || 'New tab',
      url: page.url(),
      active: page === this.page,
    })));
    this.send({ type: 'tabs', tabs });
  }

  async selectPage(page) {
    if (this.closed || this.closing) return;
    if (!page || page.isClosed() || page === this.page) {
      await this.sendTabs();
      return;
    }
    const generation = ++this.generation;
    this.clearPendingFrame();
    const previous = this.cdp;
    this.cdp = null;
    this.page = page;
    this.removePageListeners();
    if (previous) {
      await previous.send('Page.stopScreencast').catch(() => {});
      await previous.detach().catch(() => {});
    }
    if (this.closed || generation !== this.generation) return;
    await page.bringToFront().catch(() => {});
    const cdp = await this.record.context.newCDPSession(page);
    if (this.closed || generation !== this.generation) {
      await cdp.detach().catch(() => {});
      return;
    }
    this.cdp = cdp;
    this.lastFrameAt = 0;
    cdp.on('Page.screencastFrame', (event) => {
      void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
      // The RFB writer retains the newest frame during congestion. Dropping
      // it here would strand a static page on an old image after recovery.
      if (this.closing || this.cdp !== cdp || !socketOpen(this.socket)) return;
      const now = Date.now();
      const viewport = page.viewportSize() || { width: 1280, height: 720 };
      this.pendingFrame = { type: 'frame', data: event.data, width: viewport.width, height: viewport.height };
      if (!this.frameTimer) {
        this.frameTimer = setTimeout(() => {
          this.frameTimer = null;
          const frame = this.pendingFrame;
          this.pendingFrame = null;
          if (frame && !this.closed && this.cdp === cdp) {
            this.lastFrameAt = Date.now();
            this.send(frame);
          }
        }, Math.max(0, 66 - (now - this.lastFrameAt)));
        this.frameTimer.unref?.();
      }
    });
    const onClose = () => {
      if (this.page !== page) return;
      this.generation++;
      this.clearPendingFrame();
      this.page = null;
      this.cdp = null;
      this.removePageListeners();
      void cdp.detach().catch(() => {});
      const replacement = this.record.context.pages().at(-1);
      if (replacement) void this.selectPage(replacement).catch(() => {});
      else void this.sendTabs();
    };
    const onFrameNavigated = (frame) => {
      if (frame === page.mainFrame()) void this.sendTabs();
    };
    page.once('close', onClose);
    page.on('framenavigated', onFrameNavigated);
    this.pageListeners = { page, onClose, onFrameNavigated };
    await cdp.send('Page.enable');
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 72,
      maxWidth: 1280,
      maxHeight: 720,
      everyNthFrame: 1,
    });
    const initial = await page.screenshot({ type: 'jpeg', quality: 72, timeout: 2_000 }).catch(() => null);
    if (initial && !this.closed && this.cdp === cdp) {
      const viewport = page.viewportSize() || { width: 1280, height: 720 };
      this.send({ type: 'frame', data: initial.toString('base64'), width: viewport.width, height: viewport.height });
    }
    await this.sendTabs();
  }

  async onMessage(data) {
    if (this.closed || data.length > 64 * 1024) return;
    let message;
    try {
      message = JSON.parse(data.toString('utf8'));
    } catch {
      return;
    }
    const release = (message.type === 'key' && message.eventType === 'keyUp') ||
      (message.type === 'mouse' && message.eventType === 'mouseReleased');
    if (this.closing && !release) return;
    const page = this.page;
    const cdp = this.cdp;
    this.record.lastActivity = Date.now();
    try {
      switch (message.type) {
        case 'mouse':
          if (!page || page.isClosed() || !cdp) return;
          // Native context menus and X11 primary-selection paste are outside
          // the page-only viewer and can touch shared desktop clipboard state.
          if (['right', 'middle'].includes(message.button)) break;
          await cdp.send('Input.dispatchMouseEvent', {
            type: message.eventType,
            x: Number(message.x) || 0,
            y: Number(message.y) || 0,
            button: message.button || 'none',
            buttons: Number(message.buttons) || 0,
            clickCount: Number(message.clickCount) || 0,
            deltaX: Number(message.deltaX) || 0,
            deltaY: Number(message.deltaY) || 0,
            modifiers: Number(message.modifiers) || 0,
          });
          break;
        case 'key':
          if (!page || page.isClosed() || !cdp) return;
          // Chromium's native clipboard belongs to the shared process. Never
          // allow remote Ctrl/Cmd+C/X/V to access that cross-context resource.
          const key = String(message.key).toLowerCase();
          const mods = Number(message.modifiers) || 0;
          const clipboardAction = (mods & 6) && ['c', 'x', 'v'].includes(key) ? key :
            key === 'insert' && (mods & 2) ? 'c' : key === 'insert' && (mods & 8) ? 'v' :
            key === 'delete' && (mods & 8) ? 'x' : '';
          if (clipboardAction) {
            if (message.eventType === 'keyDown' && clipboardAction !== 'v') {
              const selected = await this.copySelection();
              if (selected && clipboardAction === 'x') await cdp.send('Input.insertText', { text: '' });
            }
            break;
          }
          // Native menus are outside the page stream and could expose shared
          // clipboard actions. The viewer supplies explicit scoped controls.
          if (key === 'contextmenu' || (key === 'f10' && (mods & 8))) break;
          await cdp.send('Input.dispatchKeyEvent', {
            type: message.eventType === 'keyUp' ? 'keyUp' : 'keyDown',
            key: String(message.key || ''),
            code: String(message.code || ''),
            text: message.eventType === 'keyDown' ? String(message.text || '') : '',
            unmodifiedText: message.eventType === 'keyDown' ? String(message.unmodifiedText ?? message.text ?? '') : '',
            modifiers: Number(message.modifiers) || 0,
            windowsVirtualKeyCode: Number(message.windowsVirtualKeyCode) || 0,
            autoRepeat: Boolean(message.autoRepeat),
            ...(key === 'a' && (mods & 4) && message.eventType !== 'keyUp' ? { commands: ['selectAll'] } : {}),
          });
          break;
        case 'copySelection':
          await this.copySelection();
          break;
        case 'insertText':
          if (page && !page.isClosed() && cdp && typeof message.text === 'string')
            await cdp.send('Input.insertText', { text: message.text.slice(0, 32_768) });
          break;
        case 'navigate':
          if (page && !page.isClosed()) await page.goto(safeURL(message.url));
          break;
        case 'reload':
          if (page && !page.isClosed()) await page.reload();
          break;
        case 'back':
          if (page && !page.isClosed()) await page.goBack();
          break;
        case 'forward':
          if (page && !page.isClosed()) await page.goForward();
          break;
        case 'newPage':
          await this.selectPage(await this.record.context.newPage());
          break;
        case 'selectPage': {
          const selected = this.record.context.pages().find((candidate) => this.pageID(candidate) === String(message.id));
          if (selected) await this.selectPage(selected);
          break;
        }
        case 'closePage': {
          const selected = this.record.context.pages().find((candidate) => this.pageID(candidate) === String(message.id));
          if (selected) await selected.close();
          if (!this.record.context.pages().length) await this.selectPage(await this.record.context.newPage());
          break;
        }
      }
    } catch (error) {
      this.send({ type: 'error', message: error.message || 'Browser action failed' });
    }
  }

  async copySelection() {
    if (!this.page || this.page.isClosed()) return '';
    // A project's window may be in the background of the shared X display.
    // Its active element still owns this viewer's selection. Follow focused
    // iframe elements only, never other pages/contexts or the OS clipboard.
    let frame = this.page.mainFrame();
    for (let depth = 0; depth < 16; depth++) {
      const active = await frame.evaluateHandle(() => document.activeElement);
      const nested = await active.asElement()?.contentFrame();
      await active.dispose();
      if (!nested) break;
      frame = nested;
    }
    const text = await frame.evaluate(() => {
        const field = document.activeElement;
        if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
          if (field instanceof HTMLInputElement && field.type === 'password') return '';
          return field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0).slice(0, 32_768);
        }
        return String(window.getSelection() || '').slice(0, 32_768);
      }).catch(() => '');
    this.send({ type: 'clipboard', text });
    return text;
  }

  freeze() {
    if (this.closing) return;
    this.closing = true;
    this.generation++;
    this.clearPendingFrame();
    if (this.tabsTimer) clearInterval(this.tabsTimer);
    this.tabsTimer = null;
    this.record.context.off('page', this.onPage);
    this.removePageListeners();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.freeze();
    const cdp = this.cdp;
    this.cdp = null;
    if (cdp) {
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cdp.detach().catch(() => {});
    }
    this.record.viewers.delete(this.socket);
  }

  clearPendingFrame() {
    clearTimeout(this.frameTimer);
    this.frameTimer = null;
    this.pendingFrame = null;
  }

  removePageListeners() {
    if (!this.pageListeners) return;
    const { page, onClose, onFrameNavigated } = this.pageListeners;
    page.off('close', onClose);
    page.off('framenavigated', onFrameNavigated);
    this.pageListeners = null;
  }
}
