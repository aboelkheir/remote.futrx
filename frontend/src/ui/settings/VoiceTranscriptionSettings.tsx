import { useEffect, useState } from "preact/hooks";
import { requestJson } from "../../api/apiRequest";
import { API_ROUTES } from "../../config/routes";
import { Check, ExternalLink, Key, Loader } from "../primitives/icons";

type VoiceSettings = { configured: boolean };

export function VoiceTranscriptionSettings() {
  const [settings, setSettings] = useState<VoiceSettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    requestJson<VoiceSettings>("GET", API_ROUTES.voiceApiKey)
      .then((value) => { if (!cancelled) setSettings(value); })
      .catch((cause) => { if (!cancelled) setError((cause as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function save(event: Event) {
    event.preventDefault();
    if (!apiKey.trim()) return;
    setSaving(true);
    setError("");
    try {
      setSettings(await requestJson<VoiceSettings>("PUT", API_ROUTES.voiceApiKey, { apiKey: apiKey.trim() }));
      setApiKey("");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    setError("");
    try {
      setSettings(await requestJson<VoiceSettings>("DELETE", API_ROUTES.voiceApiKey));
      setApiKey("");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section class="rounded-card border border-line bg-surface overflow-hidden">
      <header class="px-4 py-3 flex items-start gap-3 border-b border-line">
        <div class="h-9 w-9 rounded-md bg-tint border border-line grid place-items-center flex-none">
          <Key class="w-4 h-4 text-ink-200" />
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <div class="text-[14.5px] font-semibold text-ink-50">Voice transcription</div>
            {loading ? <Loader class="w-3.5 h-3.5 text-ink-300 animate-spin" /> : settings?.configured ? (
              <span class="inline-flex items-center gap-1 text-[11px] text-accent-green"><Check class="w-3.5 h-3.5" /> configured</span>
            ) : <span class="text-[11px] text-accent-yellow">API key needed</span>}
          </div>
          <div class="text-[12px] text-ink-300 mt-1 leading-relaxed">
            The microphone in chat uses OpenAI speech to text. Link your Pro benefit to an API organization, then create a key in that same organization to use its API credits.
          </div>
        </div>
      </header>
      <form onSubmit={save} class="p-3 space-y-3">
        <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" class="inline-flex items-center gap-1 text-xs text-accent-blue hover:underline">
          Create a key in the linked API organization <ExternalLink class="w-3.5 h-3.5" />
        </a>
        <label class="block space-y-1.5">
          <span class="text-xs text-ink-300">OpenAI API key</span>
          <input type="password" value={apiKey} onInput={(event) => setApiKey((event.currentTarget as HTMLInputElement).value)}
            placeholder={settings?.configured ? "Enter a new key to replace the current one" : "Paste your API key"}
            autocomplete="new-password" spellcheck={false}
            class="w-full h-10 rounded-md bg-inset border border-line px-3 text-sm text-ink-100 placeholder:text-ink-400 focus:outline-none focus:border-accent-blue" />
        </label>
        {error && <div role="alert" class="text-xs text-accent-red">{error}</div>}
        <div class="flex items-center gap-3">
          <button type="submit" disabled={saving || loading || !apiKey.trim()} class="btn btn-primary disabled:opacity-50 inline-flex items-center gap-2">
            {saving && <Loader class="w-3.5 h-3.5 animate-spin" />}
            {settings?.configured ? "Update API key" : "Save API key"}
          </button>
          {settings?.configured && <button type="button" onClick={() => void remove()} disabled={saving} class="btn disabled:opacity-50">Remove key</button>}
        </div>
      </form>
    </section>
  );
}
