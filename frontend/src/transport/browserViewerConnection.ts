export interface BrowserDisplayConnection extends EventTarget {
  disconnect(): void;
}

export type BrowserViewerState = "connecting" | "connected" | "reconnecting";

interface BrowserViewerOptions<T> {
  url: string;
  createDisplay: (url: string) => BrowserDisplayConnection;
  createSocket?: (url: string) => WebSocket;
  createViewerID?: () => string;
  onState: (state: BrowserViewerState, detail?: string) => void;
  onMessage: (message: T) => void;
}

interface BrowserConnectionPair {
  display: BrowserDisplayConnection | null;
  control: WebSocket | null;
  displayReady: boolean;
  controlReady: boolean;
  established: boolean;
  timeout: ReturnType<typeof setTimeout> | null;
}

// A viewer has two transports, but one lifetime. Neither is usable until both
// connect. Retrying creates a fresh pair and never queues or replays input.
export class BrowserViewerConnection<T> {
  readonly #options: BrowserViewerOptions<T>;
  #pair: BrowserConnectionPair | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #attempt = 0;
  #generation = 0;
  #stopped = true;

  constructor(options: BrowserViewerOptions<T>) {
    this.#options = options;
  }

  get isOpen(): boolean {
    return this.#pair?.established ?? false;
  }

  get generation(): number {
    return this.#generation;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#clearRetry();
    this.#disposePair();
  }

  retry(): void {
    if (this.#stopped) return;
    this.#clearRetry();
    this.#disposePair();
    this.#attempt = 0;
    this.#connect();
  }

  send(message: unknown): boolean {
    const pair = this.#pair;
    if (!pair?.established || pair.control?.readyState !== 1) return false;
    try {
      pair.control.send(JSON.stringify(message));
      return true;
    } catch {
      this.#failed(pair, "Browser controls disconnected.");
      return false;
    }
  }

  #clearRetry(): void {
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  #disposePair(): void {
    const pair = this.#pair;
    this.#pair = null;
    if (!pair) return;
    if (pair.timeout !== null) clearTimeout(pair.timeout);
    pair.control?.close();
    pair.display?.disconnect();
  }

  #ready(pair: BrowserConnectionPair): void {
    if (this.#pair !== pair || !pair.displayReady || !pair.controlReady || pair.established) return;
    pair.established = true;
    if (pair.timeout !== null) clearTimeout(pair.timeout);
    pair.timeout = null;
    this.#attempt = 0;
    this.#options.onState("connected");
  }

  #failed(pair: BrowserConnectionPair, detail: string): void {
    if (this.#stopped || this.#pair !== pair) return;
    this.#options.onState("reconnecting", detail);
    this.#disposePair();
    const delay = Math.min(5000, 400 * 2 ** Math.min(this.#attempt++, 4));
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#connect();
    }, delay);
  }

  #connect(): void {
    if (this.#stopped) return;
    this.#generation++;
    this.#options.onState(this.#attempt === 0 ? "connecting" : "reconnecting");
    const pair: BrowserConnectionPair = {
      display: null, control: null, displayReady: false, controlReady: false,
      established: false, timeout: null,
    };
    this.#pair = pair;
    try {
      const viewer = this.#options.createViewerID?.() ?? crypto.randomUUID();
      const endpoint = (transport: string) => {
        const target = new URL(this.#options.url);
        target.searchParams.set("viewer", viewer);
        target.searchParams.set("transport", transport);
        return target.toString();
      };
      const control = this.#options.createSocket?.(endpoint("control")) ?? new WebSocket(endpoint("control"));
      pair.control = control;
      control.addEventListener("open", () => {
        if (this.#pair !== pair) return;
        pair.controlReady = true;
        this.#ready(pair);
      });
      control.addEventListener("message", (event) => {
        if (this.#pair !== pair || typeof event.data !== "string") return;
        let message: T;
        try { message = JSON.parse(event.data) as T; } catch { return; }
        this.#options.onMessage(message);
      });
      control.addEventListener("close", (event) => this.#failed(pair, `Browser controls disconnected (code ${event.code}).`));
      control.addEventListener("error", () => this.#failed(pair, "Unable to connect browser controls."));
      const display = this.#options.createDisplay(endpoint("vnc"));
      pair.display = display;
      display.addEventListener("connect", () => {
        if (this.#pair !== pair) return;
        pair.displayReady = true;
        this.#ready(pair);
      });
      display.addEventListener("disconnect", () => this.#failed(pair, "Browser display disconnected."));
      display.addEventListener("securityfailure", () => this.#failed(pair, "Browser display connection was rejected."));
      pair.timeout = setTimeout(() => this.#failed(pair, "Browser connection timed out."), 15000);
    } catch {
      this.#failed(pair, "Unable to connect to the browser.");
    }
  }
}
