import assert from "node:assert/strict";
import test from "node:test";
import { BROWSER_KEYBOARD_PADDING, browserCharacterKeysym, browserKeyboardChanges } from "./browserKeyboardInput.ts";

test("mobile typing keeps existing text through punctuation, deletion, and composition", () => {
  const initial = BROWSER_KEYBOARD_PADDING;
  assert.deepEqual(browserKeyboardChanges(initial, initial + "a."), { backspaces: 0, text: "a." });
  assert.deepEqual(browserKeyboardChanges(initial + "a.", initial + "a."), { backspaces: 0, text: "" });
  assert.deepEqual(browserKeyboardChanges(initial + "a.", initial + "a"), { backspaces: 1, text: "" });
  assert.deepEqual(browserKeyboardChanges(initial + "cafe", initial + "café"), { backspaces: 1, text: "é" });
  assert.deepEqual(browserKeyboardChanges(initial + "🙂", initial + "日"), { backspaces: 1, text: "日" });
  assert.equal(browserCharacterKeysym("日"), 0x010065e5);
  assert.equal(browserCharacterKeysym("🙂"), 0x0101f642);
  assert.equal(browserCharacterKeysym("\n"), 0xff0d);
});
