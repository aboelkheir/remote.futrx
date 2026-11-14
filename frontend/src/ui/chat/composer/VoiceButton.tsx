import { useEffect, useRef, useState } from "preact/hooks";
import { Loader, Microphone, Square } from "../../primitives/icons";

export function VoiceButton({ disconnected, text, onTextChange }: {
  disconnected: boolean;
  text: string;
  onTextChange: (text: string) => void;
}) {
  const [phase, setPhase] = useState<"idle" | "recording" | "transcribing">("idle");
  const [error, setError] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const latestText = useRef(text);
  latestText.current = text;

  useEffect(() => () => {
    recorder.current?.stop();
    stream.current?.getTracks().forEach((track) => track.stop());
  }, []);

  async function transcribe(blob: Blob) {
    if (!blob.size) {
      setError("No audio was recorded. Try again.");
      setPhase("idle");
      return;
    }
    if (blob.size > 25 * 1024 * 1024) {
      setError("Recording is too large. Keep it under 25 MB.");
      setPhase("idle");
      return;
    }
    setPhase("transcribing");
    try {
      const extension = blob.type.includes("mp4") ? "mp4" : blob.type.includes("ogg") ? "ogg" : "webm";
      const form = new FormData();
      form.append("file", blob, `recording.${extension}`);
      const response = await fetch("/api/voice/transcription", { method: "POST", body: form });
      const result = await response.json() as { text?: string; error?: string };
      if (!response.ok || !result.text) throw new Error(result.error || "Transcription failed");
      const prefix = latestText.current.trimEnd();
      onTextChange(prefix ? `${prefix}\n${result.text}` : result.text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transcription failed");
    } finally {
      setPhase("idle");
    }
  }

  async function toggle() {
    if (phase === "recording") {
      recorder.current?.stop();
      return;
    }
    if (phase !== "idle") return;
    setError("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Microphone recording is unavailable in this browser.");
      return;
    }
    try {
      const audio = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = audio;
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"]
        .find((type) => MediaRecorder.isTypeSupported(type));
      const instance = new MediaRecorder(audio, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      instance.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      instance.onstop = () => {
        audio.getTracks().forEach((track) => track.stop());
        stream.current = null;
        recorder.current = null;
        void transcribe(new Blob(chunks, { type: instance.mimeType }));
      };
      recorder.current = instance;
      instance.start();
      setPhase("recording");
    } catch (err) {
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
      setError(err instanceof Error ? err.message : "Could not start the microphone");
    }
  }

  return (
    <div class="relative flex-none">
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={disconnected || phase === "transcribing"}
        class={`codex-icon-button grid h-8 w-8 place-items-center rounded-control transition-colors active:scale-[0.97] disabled:opacity-40 ${phase === "recording" ? "bg-red-500/20 text-red-400" : "text-ink-400 hover:bg-tint-strong hover:text-ink-100"}`}
        aria-label={phase === "recording" ? "Stop recording and transcribe" : phase === "transcribing" ? "Transcribing audio" : "Record voice message"}
        title={phase === "recording" ? "Stop and transcribe" : "Record voice to text"}
      >
        {phase === "recording" ? <Square class="h-3.5 w-3.5" /> : phase === "transcribing" ? <Loader class="h-4 w-4 animate-spin" /> : <Microphone class="h-4 w-4" />}
      </button>
      {error && <div role="alert" class="absolute bottom-full left-0 z-30 mb-2 w-64 rounded-control border border-red-500/30 bg-surface px-2 py-1.5 text-xs text-red-400 shadow-pop">{error}</div>}
    </div>
  );
}
