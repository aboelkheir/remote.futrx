import assert from "node:assert/strict";
import test from "node:test";
import { agentQuotaApi } from "./agentQuotaApi.ts";

test("quota requests bypass caches, carry cancellation, and preserve provider order and zero", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const controller = new AbortController();
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "/api/agent-quota");
    assert.equal(init?.method, "GET");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.signal, controller.signal);
    return Response.json({ agents: [
      { provider: "codex", session: { usedPercent: 0, measuredAt: 1000 } },
      { provider: "claude", weekly: { status: "allowed", measuredAt: 2000 } },
    ] });
  };

  const quotas = await agentQuotaApi.list(controller.signal);
  assert.deepEqual(quotas.map((quota) => quota.provider), ["codex", "claude"]);
  assert.equal(quotas[0].session?.usedPercent, 0);
  assert.equal(quotas[0].session?.window, "session");
  assert.equal(quotas[1].weekly?.usedPercent, undefined);
  assert.equal(quotas[1].weekly?.window, "weekly");
});

test("missing optional quota lists remain valid empty snapshots", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const body of [{}, { agents: null }, { agents: [] }]) {
    globalThis.fetch = async () => Response.json(body);
    assert.deepEqual(await agentQuotaApi.list(), []);
  }
});

test("unsuccessful and malformed responses reject instead of erasing a good snapshot", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const status of [401, 403, 500, 503]) {
    globalThis.fetch = async () => new Response("unavailable", { status });
    await assert.rejects(agentQuotaApi.list(), /Failed to load subscription quota/);
  }
  for (const body of [
    null,
    [],
    { error: "unavailable" },
    { agents: {} },
    { agents: [null] },
    { agents: [{ provider: "" }] },
    { agents: [{ provider: "claude", session: [] }] },
    { agents: [{ provider: "claude", session: { window: "weekly" } }] },
    { agents: [{ provider: "claude", weekly: { window: "monthly" } }] },
    { agents: [{ provider: "claude", weekly: { window: null } }] },
  ]) {
    globalThis.fetch = async () => Response.json(body);
    await assert.rejects(agentQuotaApi.list(), /Invalid subscription quota/);
  }
  globalThis.fetch = async () => new Response("{broken JSON");
  await assert.rejects(agentQuotaApi.list(), SyntaxError);
});

test("optional malformed reading fields cannot become a false zero or fresh timestamp", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json({ agents: [{
    provider: "claude",
    session: { usedPercent: "0", measuredAt: "2000", resetsAt: -1, status: {} },
  }] });

  const window = (await agentQuotaApi.list())[0].session;
  assert.equal(window?.usedPercent, undefined);
  assert.equal(window?.measuredAt, 0);
  assert.equal(window?.resetsAt, undefined);
  assert.equal(window?.status, undefined);
});
