import { useEffect, useState } from "preact/hooks";
import { ShieldCheck, Terminal as TerminalIcon, X } from "../primitives/icons";

export function HostTerminalSettings() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("closed");

  useEffect(() => {
    if (!open) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data?.source !== "remote-terminal") return;
      setStatus(event.data.status);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [open]);

  return (
    <section class="overflow-hidden rounded-card border border-line bg-surface">
      <div class="flex items-center gap-3 border-b border-line p-4">
        <div class="grid size-10 flex-none place-items-center rounded-md border border-line bg-tint">
          <TerminalIcon class="size-5 text-accent-blue" />
        </div>
        <div class="min-w-0 flex-1">
          <h2 class="text-[14.5px] font-semibold text-ink-50">Global terminal</h2>
          <p class="mt-1 text-[12.5px] leading-relaxed text-ink-300">
            The shared tmux session stays available when you close this page.
          </p>
        </div>
        <button
          type="button"
          onClick={() => { setOpen(!open); setStatus(open ? "closed" : "connecting"); }}
          class="inline-flex h-10 items-center gap-2 rounded-md border border-line bg-tint px-3 text-[13px] text-ink-100 hover:bg-tint-strong"
        >
          {open ? <X class="size-4" /> : <TerminalIcon class="size-4" />}
          {open ? "Close" : "Open terminal"}
        </button>
      </div>
      <div class="flex gap-2 border-b border-accent-yellow/30 bg-accent-yellow/10 px-4 py-3 text-[12.5px] text-ink-200">
        <ShieldCheck class="mt-0.5 size-4 flex-none text-accent-yellow" />
        <p>Commands run on the Remote host as the service account and can affect every project.</p>
      </div>
      {open && (
        <div class="p-3">
          <div class="mb-2 text-xs text-ink-300">{status} — host</div>
          <iframe
            title="Global host terminal"
            src="/host-terminal/index.html"
            class="h-[32rem] w-full rounded-md border border-line bg-inset"
          />
        </div>
      )}
    </section>
  );
}
