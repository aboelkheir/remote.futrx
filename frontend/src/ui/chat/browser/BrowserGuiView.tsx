import { useEffect, useRef, useState } from "preact/hooks";
import type { AgentBrowserStatus } from "../../../models/project";
import { ReconnectingJsonWebSocket } from "../../../transport/reconnectingJsonSocket";
import { syncBrowserAddress } from "./browserAddressState";

interface BrowserTab {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

interface BrowserFrameMessage {
  type: "frame";
  data: string;
  width: number;
  height: number;
}

type BrowserViewMessage =
  | BrowserFrameMessage
  | { type: "tabs"; tabs: BrowserTab[] }
  | { type: "error"; message: string };

function socketURL(path: string): string {
  const target = new URL(path, window.location.href);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  return target.toString();
}

function modifiers(event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">): number {
  return (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0);
}

function mouseButton(button: number): "none" | "left" | "middle" | "right" {
  if (button === 0) return "left";
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return "none";
}

// BrowserGuiView renders one project BrowserContext streamed from the shared
// host Chromium. The authenticated application WebSocket proxies a scoped
// broker connection, so no broker credential reaches the DOM.
export function BrowserGuiView({
  status,
  url,
  error,
  reloadKey,
  projectName,
  resizing,
}: {
  status: AgentBrowserStatus;
  url: string;
  error: string | null;
  reloadKey: number;
  projectName: string;
  resizing: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const socketRef = useRef<ReconnectingJsonWebSocket<BrowserViewMessage> | null>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const frameSizeRef = useRef({ width: 1280, height: 720 });
  const frameSequenceRef = useRef(0);
  const pendingPointerRef = useRef<Record<string, unknown> | null>(null);
  const pointerAnimationRef = useRef(0);
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [address, setAddress] = useState("");
  const [connected, setConnected] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);

  const sharedView = url.startsWith("/api/projects/") && url.endsWith("/agent-browser/view");

  function send(message: Record<string, unknown>) {
    socketRef.current?.send(message);
  }

  useEffect(() => {
    if (status !== "ready" || !url || !sharedView) return;
    let disposed = false;
    const socket = new ReconnectingJsonWebSocket<BrowserViewMessage>({
      resolveUrl: () => socketURL(url),
      onOpen: () => {
        if (disposed) return;
        setConnected(true);
        setStreamError(null);
      },
      onClose: () => {
        if (disposed) return;
        setConnected(false);
        setStreamError("The browser view disconnected. Reconnecting…");
      },
      onMessage: (message) => {
        if (disposed) return;
        if (message.type === "tabs") {
          setTabs(message.tabs);
          setAddress((current) => syncBrowserAddress(
            current,
            message.tabs,
            document.activeElement === addressInputRef.current,
          ));
          return;
        }
        if (message.type === "error") {
          setStreamError(message.message);
          return;
        }
        if (message.type !== "frame") return;
        const sequence = ++frameSequenceRef.current;
        const image = new Image();
        image.onload = () => {
          if (disposed || sequence !== frameSequenceRef.current) return;
          const canvas = canvasRef.current;
          const context = canvas?.getContext("2d");
          if (!canvas || !context) return;
          const width = Math.max(1, Number(message.width) || image.naturalWidth || 1280);
          const height = Math.max(1, Number(message.height) || image.naturalHeight || 720);
          frameSizeRef.current = { width, height };
          if (canvas.width !== width) canvas.width = width;
          if (canvas.height !== height) canvas.height = height;
          context.drawImage(image, 0, 0, width, height);
        };
        image.src = `data:image/jpeg;base64,${message.data}`;
      },
    });
    socketRef.current = socket;
    setConnected(false);
    setStreamError(null);
    socket.start();

    return () => {
      disposed = true;
      frameSequenceRef.current++;
      pendingPointerRef.current = null;
      if (pointerAnimationRef.current) cancelAnimationFrame(pointerAnimationRef.current);
      pointerAnimationRef.current = 0;
      if (socketRef.current === socket) socketRef.current = null;
      socket.stop();
    };
  }, [status, url, reloadKey, sharedView]);

  function pointerPosition(event: PointerEvent) {
    const bounds = canvasRef.current?.getBoundingClientRect();
    const size = frameSizeRef.current;
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(size.width, (event.clientX - bounds.left) * size.width / bounds.width)),
      y: Math.max(0, Math.min(size.height, (event.clientY - bounds.top) * size.height / bounds.height)),
    };
  }

  function sendPointer(event: PointerEvent, eventType: "mousePressed" | "mouseReleased" | "mouseMoved") {
    const point = pointerPosition(event);
    const message = {
      type: "mouse",
      eventType,
      ...point,
      button: eventType === "mouseMoved" ? "none" : mouseButton(event.button),
      buttons: event.buttons,
      clickCount: eventType === "mouseMoved" ? 0 : 1,
      modifiers: modifiers(event),
    };
    if (eventType !== "mouseMoved") {
      send(message);
      return;
    }
    pendingPointerRef.current = message;
    if (pointerAnimationRef.current) return;
    pointerAnimationRef.current = requestAnimationFrame(() => {
      pointerAnimationRef.current = 0;
      const pending = pendingPointerRef.current;
      pendingPointerRef.current = null;
      if (pending) send(pending);
    });
  }

  function sendKey(event: KeyboardEvent, eventType: "keyDown" | "keyUp") {
    event.preventDefault();
    event.stopPropagation();
    const text = eventType === "keyDown" && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey
      ? event.key
      : "";
    send({ type: "key", eventType, key: event.key, code: event.code, text, modifiers: modifiers(event) });
  }

  function navigate(event: Event) {
    event.preventDefault();
    send({ type: "navigate", url: address });
  }

  if (status === "ready" && url) {
    if (!sharedView) {
      return (
        <div class="flex-1 min-h-0 bg-white">
          <iframe
            key={`legacy-gui:${url}:${reloadKey}`}
            src={url}
            title={`Agent browser for ${projectName || "container"}`}
            class={`h-full w-full border-0 bg-white ${resizing ? "pointer-events-none" : ""}`}
            allow="clipboard-read; clipboard-write"
          />
        </div>
      );
    }
    return (
      <div class="flex-1 min-h-0 flex flex-col bg-[#202124] text-white">
        <div class="h-8 shrink-0 flex items-end gap-1 overflow-x-auto bg-[#292a2d] px-2 pt-1">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              class={`group h-7 max-w-48 min-w-24 rounded-t-lg pl-2 text-[11px] flex items-center ${tab.active ? "bg-[#35363a]" : "bg-[#252629] hover:bg-[#303134]"}`}
            >
              <button
                type="button"
                onClick={() => send({ type: "selectPage", id: tab.id })}
                class="h-full min-w-0 flex-1 truncate text-left"
                title={tab.title}
              >{tab.title || "New tab"}</button>
              <button
                type="button"
                aria-label={`Close ${tab.title || "tab"}`}
                class="h-full w-7 shrink-0 text-white/50 hover:text-white"
                onClick={(event) => {
                  event.stopPropagation();
                  send({ type: "closePage", id: tab.id });
                }}
              >×</button>
            </div>
          ))}
          <button type="button" class="mb-1 h-6 w-6 rounded hover:bg-white/10" onClick={() => send({ type: "newPage" })} title="New tab">+</button>
        </div>
        <form class="h-10 shrink-0 flex items-center gap-1.5 bg-[#35363a] px-2" onSubmit={navigate}>
          <button type="button" class="h-7 w-7 rounded hover:bg-white/10" onClick={() => send({ type: "back" })} title="Back">←</button>
          <button type="button" class="h-7 w-7 rounded hover:bg-white/10" onClick={() => send({ type: "forward" })} title="Forward">→</button>
          <button type="button" class="h-7 w-7 rounded hover:bg-white/10" onClick={() => send({ type: "reload" })} title="Reload">↻</button>
          <input
            ref={addressInputRef}
            value={address}
            onInput={(event) => setAddress(event.currentTarget.value)}
            class="h-7 min-w-0 flex-1 rounded-full bg-[#202124] px-3 text-[12px] text-white outline-none focus:ring-1 focus:ring-accent"
            aria-label="Browser address"
            placeholder="Search or enter address"
          />
          <span class={`h-2 w-2 rounded-full ${connected ? "bg-emerald-400" : "bg-amber-400"}`} title={connected ? "Live" : "Connecting"} />
        </form>
        {streamError && <div class="shrink-0 bg-amber-950 px-3 py-1.5 text-[11px] text-amber-100">{streamError}</div>}
        <div class="relative flex-1 min-h-0 grid place-items-center overflow-hidden bg-white">
          {!connected && !streamError && <div class="absolute inset-0 z-10 grid place-items-center bg-surface text-[13px] text-ink-300">Connecting to browser…</div>}
          <canvas
            ref={canvasRef}
            tabIndex={0}
            aria-label={`Interactive agent browser for ${projectName || "project"}`}
            class={`max-h-full max-w-full h-auto w-auto outline-none ${resizing ? "pointer-events-none" : "cursor-default"}`}
            onPointerDown={(event) => {
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              sendPointer(event, "mousePressed");
            }}
            onPointerMove={(event) => sendPointer(event, "mouseMoved")}
            onPointerUp={(event) => sendPointer(event, "mouseReleased")}
            onContextMenu={(event) => event.preventDefault()}
            onWheel={(event) => {
              event.preventDefault();
              const bounds = event.currentTarget.getBoundingClientRect();
              const size = frameSizeRef.current;
              send({
                type: "mouse",
                eventType: "mouseWheel",
                x: (event.clientX - bounds.left) * size.width / bounds.width,
                y: (event.clientY - bounds.top) * size.height / bounds.height,
                deltaX: event.deltaX,
                deltaY: event.deltaY,
                modifiers: modifiers(event),
              });
            }}
            onKeyDown={(event) => sendKey(event, "keyDown")}
            onKeyUp={(event) => sendKey(event, "keyUp")}
            onPaste={(event) => {
              event.preventDefault();
              send({ type: "insertText", text: event.clipboardData?.getData("text") || "" });
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div class="flex-1 min-h-0 grid place-items-center bg-surface px-6 text-center">
      <div class="max-w-sm text-[13px] leading-relaxed text-ink-300">
        {status === "error" ? (
          <p class="text-ink-200">{error || "Couldn't start the agent browser."}</p>
        ) : status === "stopped" ? (
          <p>Agent browser stopped. Toggle it on again to restart.</p>
        ) : (
          <p>Starting an isolated browser context… log in once it loads; the agent shares only this project's tabs.</p>
        )}
      </div>
    </div>
  );
}
