import type RFB from "@novnc/novnc";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AgentBrowserStatus } from "../../../models/project";
import { BrowserViewerConnection, type BrowserViewerState } from "../../../transport/browserViewerConnection";
import { syncBrowserAddress } from "./browserAddressState";
import { BROWSER_KEYBOARD_PADDING, browserCharacterKeysym, browserKeyboardChanges } from "./browserKeyboardInput";

interface BrowserTab {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

type BrowserViewMessage =
  | { type: "tabs"; tabs: BrowserTab[] }
  | { type: "clipboard"; text: string }
  | { type: "error"; message: string };

function socketURL(path: string): string {
  const target = new URL(path, window.location.href);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  return target.toString();
}

// noVNC controls a virtual screen containing only this viewer's selected page.
// Authentication stays on the application proxy; no broker token reaches DOM.
export function BrowserGuiView({ status, url, error, reloadKey, projectName, resizing }: {
  status: AgentBrowserStatus;
  url: string;
  error: string | null;
  reloadKey: number;
  projectName: string;
  resizing: boolean;
}) {
  const displayRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const connectionRef = useRef<BrowserViewerConnection<BrowserViewMessage> | null>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const keyboardRef = useRef<HTMLTextAreaElement>(null);
  const keyboardValueRef = useRef(BROWSER_KEYBOARD_PADDING);
  const copyRequestRef = useRef<{
    resolve: (text: string) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [address, setAddress] = useState("");
  const [connectionState, setConnectionState] = useState<BrowserViewerState>("connecting");
  const [streamError, setStreamError] = useState<string | null>(null);
  const [frozenFrame, setFrozenFrame] = useState<string | null>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [clipboardOpen, setClipboardOpen] = useState(false);
  const [clipboardText, setClipboardText] = useState("");
  const [clipboardNotice, setClipboardNotice] = useState<string | null>(null);
  const connected = connectionState === "connected";
  const sharedView = url.startsWith("/api/projects/") && url.endsWith("/agent-browser/view");

  function send(message: Record<string, unknown>): boolean {
    return connectionRef.current?.send(message) ?? false;
  }

  function cancelCopy() {
    const pending = copyRequestRef.current;
    if (!pending) return;
    copyRequestRef.current = null;
    clearTimeout(pending.timer);
    pending.reject(new Error("Browser disconnected before copying the selection."));
  }

  function resetKeyboard() {
    keyboardValueRef.current = BROWSER_KEYBOARD_PADDING;
    if (keyboardRef.current) {
      keyboardRef.current.value = BROWSER_KEYBOARD_PADDING;
      keyboardRef.current.setSelectionRange(BROWSER_KEYBOARD_PADDING.length, BROWSER_KEYBOARD_PADDING.length);
    }
  }

  useEffect(() => {
    if (status !== "ready" || !url || !sharedView || !displayRef.current) return;
    let disposed = false;
    let connection: BrowserViewerConnection<BrowserViewMessage> | null = null;
    setConnectionState("connecting");
    const start = async () => {
      const { default: RFB } = await import("@novnc/novnc");
      if (disposed) return;
      connection = new BrowserViewerConnection<BrowserViewMessage>({
        url: socketURL(url),
        createDisplay: (endpoint) => {
          const rfb = new RFB(displayRef.current!, endpoint, { shared: true });
          rfb.scaleViewport = true;
          rfb.resizeSession = false;
          rfb.viewOnly = true;
          rfb.background = "#202124";
          rfb.showDotCursor = true;
          rfbRef.current = rfb;
          return rfb;
        },
        onState: (state, detail) => {
          if (disposed) return;
          setConnectionState(state);
          if (rfbRef.current) rfbRef.current.viewOnly = state !== "connected";
          if (state === "connected") {
            setStreamError(null);
            setFrozenFrame(null);
            resetKeyboard();
            return;
          }
          cancelCopy();
          keyboardRef.current?.blur();
          setKeyboardOpen(false);
          if (state === "reconnecting") {
            try {
              const frame = rfbRef.current?.toDataURL("image/jpeg", 0.8);
              if (frame && frame !== "data:,") setFrozenFrame(frame);
            } catch { /* The first handshake may fail before a frame exists. */ }
            setStreamError(`${detail || "The browser view disconnected."} Reconnecting…`);
          }
        },
        onMessage: (message) => {
          if (disposed) return;
          if (message.type === "tabs") {
            setTabs(message.tabs);
            setAddress((current) => syncBrowserAddress(current, message.tabs, document.activeElement === addressInputRef.current));
          } else if (message.type === "error") {
            setStreamError(message.message);
          } else if (message.type === "clipboard" && copyRequestRef.current) {
            const pending = copyRequestRef.current;
            copyRequestRef.current = null;
            clearTimeout(pending.timer);
            setClipboardText(message.text);
            pending.resolve(message.text);
          }
        },
      });
      connectionRef.current = connection;
      setTabs([]);
      setAddress("");
      setClipboardText("");
      setClipboardNotice(null);
      setClipboardOpen(false);
      setStreamError(null);
      setFrozenFrame(null);
      resetKeyboard();
      connection.start();
    };
    void start().catch(() => {
      if (!disposed) setStreamError("Unable to load the browser viewer. Reconnect to try again.");
    });
    return () => {
      disposed = true;
      cancelCopy();
      connection?.stop();
      if (connectionRef.current === connection) connectionRef.current = null;
      rfbRef.current = null;
    };
  }, [status, url, reloadKey, sharedView]);

  function navigate(event: Event) {
    event.preventDefault();
    if (send({ type: "navigate", url: address })) {
      addressInputRef.current?.blur();
      rfbRef.current?.focus();
    }
  }

  function keyboardInput(event: Event) {
    const input = event.currentTarget as HTMLTextAreaElement;
    if (!connectionRef.current?.isOpen || (event as InputEvent).isComposing) return;
    const change = browserKeyboardChanges(keyboardValueRef.current, input.value);
    for (let index = 0; index < change.backspaces; index++) rfbRef.current?.sendKey(0xff08, "Backspace");
    for (const character of change.text) rfbRef.current?.sendKey(browserCharacterKeysym(character));
    keyboardValueRef.current = input.value;
    if (input.value.length === 0 || input.value.length > 200) resetKeyboard();
  }

  async function pasteClipboard() {
    setClipboardNotice(null);
    const connection = connectionRef.current;
    const generation = connection?.generation;
    try {
      const text = await navigator.clipboard.readText();
      // The broker control transport preserves Unicode; baseline RFB clipboard
      // text is Latin-1. Do not send a completed permission prompt to a new pair.
      if (connection !== connectionRef.current || generation !== connection?.generation || !connection?.isOpen || !connection.send({ type: "insertText", text })) return;
      rfbRef.current?.focus();
    } catch {
      setClipboardOpen(true);
      setClipboardNotice("Paste your text below, then choose Paste into page.");
    }
  }

  async function copySelection() {
    if (!connectionRef.current?.isOpen || copyRequestRef.current) return;
    setClipboardNotice(null);
    const text = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        copyRequestRef.current = null;
        reject(new Error("The browser did not return a selection. Try again."));
      }, 5000);
      copyRequestRef.current = { resolve, reject, timer };
    });
    // Start the clipboard operation within the click's user activation, while
    // allowing the selected text to arrive asynchronously from the broker.
    const supportsAsyncCopy = !!navigator.clipboard?.write && typeof ClipboardItem !== "undefined";
    if (!send({ type: "copySelection" })) cancelCopy();
    try {
      const write = supportsAsyncCopy
        ? navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((value) => new Blob([value], { type: "text/plain" })) })])
        : null;
      if (write) {
        await write;
        setClipboardNotice("Selection copied.");
      } else {
        await text;
        setClipboardOpen(true);
        setClipboardNotice("Select and copy the text below.");
      }
    } catch {
      // Keep a manual path when clipboard permission or browser support varies.
      try { await text; setClipboardNotice("Select and copy the text below."); }
      catch (reason) { setClipboardNotice(reason instanceof Error ? reason.message : "Could not copy the selection."); }
      setClipboardOpen(true);
    }
  }

  if (status === "ready" && url) {
    if (!sharedView) {
      return (
        <div class="flex-1 min-h-0 bg-white">
          <iframe key={`legacy-gui:${url}:${reloadKey}`} src={url} title={`Agent browser for ${projectName || "container"}`}
            class={`h-full w-full border-0 bg-white ${resizing ? "pointer-events-none" : ""}`} allow="clipboard-read; clipboard-write" />
        </div>
      );
    }
    return (
      <div class="flex-1 min-h-0 flex flex-col bg-[#202124] text-white">
        <div class="h-8 shrink-0 flex items-end gap-1 overflow-x-auto bg-[#292a2d] px-2 pt-1">
          {tabs.map((tab) => (
            <div key={tab.id} class={`group h-7 max-w-48 min-w-24 rounded-t-lg pl-2 text-[11px] flex items-center ${tab.active ? "bg-[#35363a]" : "bg-[#252629] hover:bg-[#303134]"}`}>
              <button type="button" disabled={!connected} onClick={() => send({ type: "selectPage", id: tab.id })}
                class="h-full min-w-0 flex-1 truncate text-left" title={tab.title}>{tab.title || "New tab"}</button>
              <button type="button" disabled={!connected} aria-label={`Close ${tab.title || "tab"}`}
                class="h-full w-7 shrink-0 text-white/50 hover:text-white"
                onClick={() => send({ type: "closePage", id: tab.id })}>×</button>
            </div>
          ))}
          <button type="button" disabled={!connected} class="mb-1 h-6 w-6 rounded hover:bg-white/10" onClick={() => send({ type: "newPage" })} title="New tab">+</button>
        </div>
        <form class="h-10 shrink-0 flex items-center gap-1.5 bg-[#35363a] px-2" onSubmit={navigate}>
          <button type="button" disabled={!connected} class="h-7 w-7 rounded hover:bg-white/10" onClick={() => send({ type: "back" })} title="Back">←</button>
          <button type="button" disabled={!connected} class="h-7 w-7 rounded hover:bg-white/10" onClick={() => send({ type: "forward" })} title="Forward">→</button>
          <button type="button" disabled={!connected} class="h-7 w-7 rounded hover:bg-white/10" onClick={() => send({ type: "reload" })} title="Reload">↻</button>
          <input ref={addressInputRef} value={address} onInput={(event) => setAddress(event.currentTarget.value)}
            class="h-7 min-w-0 flex-1 rounded-full bg-[#202124] px-3 text-[12px] text-white outline-none focus:ring-1 focus:ring-accent"
            aria-label="Browser address" placeholder="Search or enter address" />
          <span role="status" aria-label={connected ? "Browser connected" : "Browser reconnecting"}
            class={`h-2 w-2 shrink-0 rounded-full ${connected ? "bg-emerald-400" : "bg-amber-400"}`} title={connected ? "Live" : "Connecting"} />
        </form>
        <div class="shrink-0 flex items-center gap-1 bg-[#292a2d] px-2 py-1 text-[11px]">
          <button type="button" disabled={!connected} aria-label="Toggle remote keyboard" aria-pressed={keyboardOpen}
            class={`rounded px-2 py-1 hover:bg-white/10 disabled:opacity-40 ${keyboardOpen ? "bg-white/15" : ""}`}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              if (keyboardOpen) keyboardRef.current?.blur();
              else { resetKeyboard(); keyboardRef.current?.focus(); }
            }}>Keyboard</button>
          <button type="button" disabled={!connected} class="rounded px-2 py-1 hover:bg-white/10 disabled:opacity-40" onClick={copySelection} title="Copy selected page text">Copy</button>
          <button type="button" disabled={!connected} class="rounded px-2 py-1 hover:bg-white/10 disabled:opacity-40" onClick={pasteClipboard} title="Paste clipboard into the page">Paste</button>
          {clipboardNotice && <span class="min-w-0 flex-1 truncate text-white/70" title={clipboardNotice} role="status">{clipboardNotice}</span>}
        </div>
        {clipboardOpen && <div class="shrink-0 bg-[#292a2d] px-2 pb-2 text-[11px]">
          <textarea aria-label="Browser clipboard" rows={3} value={clipboardText} onInput={(event) => setClipboardText(event.currentTarget.value)}
            class="w-full resize-y rounded bg-[#202124] p-2 text-white" />
          <button type="button" disabled={!connected} class="mr-3 py-1 hover:underline" onClick={() => {
            if (send({ type: "insertText", text: clipboardText })) { setClipboardOpen(false); rfbRef.current?.focus(); }
          }}>Paste into page</button>
          <button type="button" class="py-1 hover:underline" onClick={() => setClipboardOpen(false)}>Close</button>
        </div>}
        {streamError && <div class="shrink-0 flex items-center gap-2 bg-amber-950 px-3 py-1.5 text-[11px] text-amber-100" role="status">
          <span class="flex-1">{streamError}</span>
          <button type="button" class="shrink-0 underline" onClick={() => {
            if (connectionRef.current) connectionRef.current.retry();
            else window.location.reload();
          }}>Reconnect now</button>
        </div>}
        <div class="relative flex-1 min-h-0 overflow-hidden bg-[#202124]">
          {frozenFrame && !connected && <img src={frozenFrame} alt="Last browser frame before disconnecting" class="pointer-events-none absolute inset-0 z-10 h-full w-full object-contain opacity-50" />}
          {!connected && <div class="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-black/20 text-[13px] text-white">{connectionState === "reconnecting" ? "Reconnecting to browser…" : "Connecting to browser…"}</div>}
          <div ref={displayRef} aria-label={`Interactive agent browser for ${projectName || "project"}`}
            class={`h-full w-full ${resizing || !connected ? "pointer-events-none" : ""}`}
            onKeyDownCapture={(event) => {
              const modifier = event.ctrlKey || event.metaKey;
              const copy = (modifier && !event.shiftKey && event.key.toLowerCase() === "c") || (event.ctrlKey && event.key === "Insert");
              const paste = (modifier && !event.shiftKey && event.key.toLowerCase() === "v") || (event.shiftKey && event.key === "Insert");
              if (!copy && !paste) return;
              event.preventDefault();
              event.stopPropagation();
              if (event.repeat) return;
              if (copy) void copySelection();
              if (paste) void pasteClipboard();
            }}
            onMouseDownCapture={(event) => {
              if (document.activeElement === keyboardRef.current) event.preventDefault();
            }}
            onPaste={(event) => {
              if (!connectionRef.current?.isOpen) return;
              event.preventDefault();
              send({ type: "insertText", text: event.clipboardData?.getData("text") || "" });
            }} />
          <textarea ref={keyboardRef} aria-label="Remote browser keyboard" tabIndex={-1}
            class="absolute left-0 top-0 h-px w-px resize-none overflow-hidden opacity-0"
            autoCapitalize="off" autoComplete="off" spellcheck={false}
            onFocus={() => { setKeyboardOpen(true); if (rfbRef.current) rfbRef.current.focusOnClick = false; }}
            onBlur={() => { setKeyboardOpen(false); if (rfbRef.current) rfbRef.current.focusOnClick = true; }}
            onInput={keyboardInput} onCompositionEnd={keyboardInput}
            onKeyDown={(event) => {
              const special: Record<string, number> = { Tab: 0xff09, Escape: 0xff1b, ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54 };
              if (special[event.key] && connectionRef.current?.isOpen) {
                event.preventDefault();
                rfbRef.current?.sendKey(special[event.key], event.code);
              }
            }} />
        </div>
      </div>
    );
  }

  return (
    <div class="flex-1 min-h-0 grid place-items-center bg-surface px-6 text-center">
      <div class="max-w-sm text-[13px] leading-relaxed text-ink-300">
        {status === "error" ? <p class="text-ink-200">{error || "Couldn't start the agent browser."}</p>
          : status === "stopped" ? <p>Agent browser stopped. Toggle it on again to restart.</p>
          : <p>Starting an isolated browser context… log in once it loads; the agent shares only this project's tabs.</p>}
      </div>
    </div>
  );
}
