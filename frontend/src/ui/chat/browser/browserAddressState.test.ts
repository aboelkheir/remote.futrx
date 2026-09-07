import assert from "node:assert/strict";
import test from "node:test";
import { syncBrowserAddress } from "./browserAddressState.ts";

test("preserves an address draft while the input is being edited", () => {
  assert.equal(
    syncBrowserAddress("example.com", [{ url: "about:blank", active: true }], true),
    "example.com",
  );
});

test("synchronizes the active tab address when editing has finished", () => {
  assert.equal(
    syncBrowserAddress("example.com", [{ url: "https://remote.futrx.xyz/", active: true }], false),
    "https://remote.futrx.xyz/",
  );
  assert.equal(
    syncBrowserAddress("stale", [{ url: "about:blank", active: true }], false),
    "",
  );
});

test("keeps the current address when no tab is active", () => {
  assert.equal(syncBrowserAddress("draft", [], false), "draft");
});
