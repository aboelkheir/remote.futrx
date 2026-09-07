import { WebSocketConnection } from "./webSocketConnection.ts";
import type { ReconnectingJsonWebSocketOptions } from "../types/transport";
import { JSON_SOCKET_RECONNECT_POLICY } from "../config/transport.ts";

export class ReconnectingJsonWebSocket<TMessage> {
  readonly #configuration: ReconnectingJsonWebSocketOptions<TMessage>;
  #connection: WebSocketConnection | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectAttempt = 0;
  #isStopped = true;

  constructor(options: ReconnectingJsonWebSocketOptions<TMessage>) {
    this.#configuration = options;
  }

  get isOpen(): boolean {
    return this.#connection?.isOpen ?? false;
  }

  start(): void {
    if (!this.#isStopped) return;
    this.#isStopped = false;
    this.#connect();
  }

  stop(): void {
    this.#isStopped = true;
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    const connection = this.#connection;
    this.#connection = null;
    connection?.close();
  }

  send(message: unknown): boolean {
    if (!this.isOpen || this.#connection === null) return false;
    this.#connection.send(JSON.stringify(message));
    return true;
  }

  #scheduleReconnect(): void {
    if (this.#isStopped) return;
    const delayMs = Math.min(
      JSON_SOCKET_RECONNECT_POLICY.maxDelayMs,
      JSON_SOCKET_RECONNECT_POLICY.initialDelayMs * 2 ** this.#reconnectAttempt
    );
    this.#reconnectAttempt++;
    this.#reconnectTimer = setTimeout(() => this.#connect(), delayMs);
  }

  #connect(): void {
    if (this.#isStopped) return;
    const connection = new WebSocketConnection({
      url: this.#configuration.resolveUrl(),
      onOpen: () => {
        if (this.#isStopped || this.#connection !== connection) return;
        this.#reconnectAttempt = 0;
        this.#configuration.onOpen?.();
      },
      onMessage: (data) => {
        if (this.#isStopped || this.#connection !== connection) return;
        try {
          this.#configuration.onMessage(JSON.parse(data as string) as TMessage);
        } catch {}
      },
      onClose: () => {
        if (this.#connection !== connection) return;
        this.#connection = null;
        this.#configuration.onClose?.();
        this.#scheduleReconnect();
      },
      onError: () => connection.close(),
    });
    this.#connection = connection;
  }
}
