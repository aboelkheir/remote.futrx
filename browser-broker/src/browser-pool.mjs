import { DirectChromiumLauncher } from './direct-chromium.mjs';
import { ProjectNetworkPolicy } from './network-policy.mjs';

const defaultViewport = { width: 1280, height: 720 };

export class BrowserPool {
  constructor({ stateStore, idleBrowserMs = 30_000, maxContexts = 32, launcher = new DirectChromiumLauncher() } = {}) {
    this.stateStore = stateStore;
    this.idleBrowserMs = idleBrowserMs;
    this.maxContexts = maxContexts;
    this.launcher = launcher;
    this.browser = null;
    this.browserPromise = null;
    this.browserIdleTimer = null;
    this.records = new Map();
    this.pendingCreates = new Set();
    this.projectOperations = new Map();
  }

  async ensure(project, { view = false } = {}) {
    return this.serializedProject(project, async () => {
      if (this.browserIdleTimer) {
        clearTimeout(this.browserIdleTimer);
        this.browserIdleTimer = null;
      }
      let record = this.records.get(project);
      if (!record) record = await this.createRecord(project);
      record.lastActivity = Date.now();
      if (view) record.viewEnabled = true;
      return record;
    });
  }

  async createRecord(project) {
    if (this.records.size + this.pendingCreates.size >= this.maxContexts)
      throw new Error(`browser context limit reached (${this.maxContexts})`);
    this.pendingCreates.add(project);
    let context;
    try {
      const browser = await this.ensureBrowser();
      let storageState;
      try {
        storageState = await this.stateStore.load(project);
      } catch (error) {
        console.error(`browser-broker: ignoring unreadable state for ${project}: ${error.message}`);
      }
      context = await browser.newContext({
        viewport: defaultViewport,
        acceptDownloads: true,
        serviceWorkers: 'block',
        storageState,
      });
      const networkPolicy = new ProjectNetworkPolicy(project);
      await context.route('**/*', async (route) => {
        if (await networkPolicy.allows(route.request().url())) await route.continue();
        else await route.abort('blockedbyclient');
      });
      await context.routeWebSocket('**/*', async (webSocket) => {
        if (await networkPolicy.allows(webSocket.url())) webSocket.connectToServer();
        else await webSocket.close({ code: 1008, reason: 'network target blocked' });
      });
      await context.addInitScript(() => {
        // WebRTC does not flow through Playwright's HTTP/WebSocket routing and
        // can otherwise become a direct private-network side channel.
        for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
          try { Object.defineProperty(globalThis, name, { value: undefined, configurable: false }); } catch {}
        }
      });
      const record = {
        project,
        context,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        viewEnabled: false,
        viewers: new Set(),
        pageIDs: new WeakMap(),
        nextPageID: 1,
      };
      this.records.set(project, record);
      context.on('close', () => {
        for (const viewer of record.viewers) viewer.close(1011, 'browser context closed');
        record.viewers.clear();
        if (this.records.get(project)?.context === context) {
          this.records.delete(project);
          this.scheduleBrowserIdleClose();
        }
      });
      await context.newPage();
      return record;
    } catch (error) {
      await context?.close().catch(() => {});
      throw error;
    } finally {
      this.pendingCreates.delete(project);
      this.scheduleBrowserIdleClose();
    }
  }

  status(project) {
    const record = this.records.get(project);
    if (!record) {
      return { status: 'stopped', core: 'off', view: 'off', viewerCount: 0, uptimeSec: 0 };
    }
    return {
      status: record.viewEnabled ? 'ready' : 'core-ready',
      core: 'ready',
      view: record.viewEnabled ? 'ready' : 'off',
      viewerCount: record.viewers.size,
      uptimeSec: Math.max(0, Math.floor((Date.now() - record.createdAt) / 1000)),
    };
  }

  async stopView(project) {
    return this.serializedProject(project, () => this.stopViewNow(project));
  }

  async stopViewNow(project) {
    const record = this.records.get(project);
    if (!record) return;
    record.viewEnabled = false;
    await Promise.all([...record.viewers].map((viewer) => viewer.close(1001, 'browser view stopped')));
    record.viewers.clear();
  }

  async stop(project) {
    return this.serializedProject(project, () => this.stopNow(project));
  }

  async stopNow(project) {
    const record = this.records.get(project);
    if (!record) return;
    await this.stopViewNow(project);
    let saveError;
    try {
      await this.saveRecord(record);
    } catch (error) {
      saveError = error;
    }
    this.records.delete(project);
    await record.context.close().catch(() => {});
    this.scheduleBrowserIdleClose();
    if (saveError) throw saveError;
  }

  async saveAll() {
    await Promise.allSettled([...this.records.values()].map((record) => this.saveRecord(record)));
  }

  async saveRecord(record) {
    if (this.records.get(record.project) !== record || record.deleting) return;
    let state;
    try {
      state = await record.context.storageState({ indexedDB: true });
    } catch {
      state = await record.context.storageState();
    }
    if (this.records.get(record.project) !== record || record.deleting) return;
    await this.stateStore.save(record.project, state);
  }

  async delete(project) {
    return this.serializedProject(project, () => this.deleteNow(project));
  }

  async deleteNow(project) {
    const record = this.records.get(project);
    if (record) {
      record.deleting = true;
      await this.stopViewNow(project);
      this.records.delete(project);
      await record.context.close().catch(() => {});
      this.scheduleBrowserIdleClose();
    }
    await this.stateStore.delete(project);
  }

  async ensureBrowser() {
    if (this.browser?.isConnected()) return this.browser;
    if (this.browserPromise) return this.browserPromise;
    this.browserPromise = this.launcher.launch({
      headless: false,
      chromiumSandbox: true,
      args: [
        '--disable-dev-shm-usage',
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      ],
    }).then((browser) => {
      this.browser = browser;
      browser.on('disconnected', () => {
        if (this.browser === browser) this.browser = null;
        for (const record of this.records.values()) {
          for (const viewer of record.viewers) viewer.close(1011, 'browser process stopped');
          record.viewers.clear();
        }
        this.records.clear();
      });
      return browser;
    }).finally(() => {
      this.browserPromise = null;
    });
    return this.browserPromise;
  }

  scheduleBrowserIdleClose() {
    if (this.records.size || this.pendingCreates.size || !this.browser || this.browserIdleTimer) return;
    this.browserIdleTimer = setTimeout(() => {
      this.browserIdleTimer = null;
      if (!this.records.size && !this.pendingCreates.size) void this.closeBrowser();
    }, this.idleBrowserMs);
    this.browserIdleTimer.unref?.();
  }

  async closeBrowser() {
    const browser = this.browser;
    this.browser = null;
    await browser?.close().catch(() => {});
  }

  async close() {
    if (this.browserIdleTimer) clearTimeout(this.browserIdleTimer);
    this.browserIdleTimer = null;
    await Promise.allSettled([...this.records.keys()].map((project) => this.stop(project)));
    await this.closeBrowser();
  }

  async serializedProject(project, operation) {
    const previous = this.projectOperations.get(project) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.projectOperations.set(project, current);
    try {
      return await current;
    } finally {
      if (this.projectOperations.get(project) === current) this.projectOperations.delete(project);
    }
  }

  health() {
    return {
      ok: true,
      browserConnected: Boolean(this.browser?.isConnected()),
      contexts: this.records.size,
      viewers: [...this.records.values()].reduce((sum, record) => sum + record.viewers.size, 0),
    };
  }
}
