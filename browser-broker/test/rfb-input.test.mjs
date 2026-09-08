import assert from 'node:assert/strict';
import test from 'node:test';
import { keysymToKey, RFBInput } from '../src/rfb-input.mjs';

test('RFB typing preserves punctuation and Unicode through keyup', () => {
  const input = new RFBInput();
  for (const [keysym, character] of [[97, 'a'], [46, '.'], [0xe9, 'é'], [0x01004e16, '世'], [0x0101f642, '🙂']]) {
    const [down] = input.key(keysym, true);
    const [up] = input.key(keysym, false);
    assert.equal(down.text, character);
    assert.equal(up.key, character);
    assert.equal(up.text, '');
    assert.equal(up.eventType, 'keyUp');
  }
  assert.equal(input.pressed.size, 0);
  assert.equal(keysymToKey(0x01110000), null);
  assert.equal(keysymToKey(0x0100d800), null);
  assert.equal(keysymToKey(0xdeadbeef), null);
});

test('RFB modifiers, native editing keys and repeat keep their state', () => {
  const input = new RFBInput();
  assert.equal(input.key(0xffe3, true)[0].modifiers, 2);
  const [selectAll] = input.key(97, true);
  assert.equal(selectAll.code, 'KeyA');
  assert.equal(selectAll.windowsVirtualKeyCode, 65);
  assert.equal(selectAll.modifiers, 2);
  assert.equal(selectAll.text, '');
  assert.equal(input.key(97, true)[0].autoRepeat, true);
  input.key(97, false);
  assert.equal(input.key(0xffe3, false)[0].modifiers, 0);
  input.key(0xffe1, true);
  assert.equal(input.key(65, true)[0].text, 'A');
  input.key(65, false);
  input.key(0xffe2, true);
  assert.equal(input.key(0xffe1, false)[0].modifiers, 8, 'right Shift remains held');
  input.key(0xffe2, false);
  for (const [keysym, key, virtualCode] of [[0xff08, 'Backspace', 8], [0xff09, 'Tab', 9], [0xff0d, 'Enter', 13], [0xff51, 'ArrowLeft', 37], [0xffff, 'Delete', 46]]) {
    const [event] = input.key(keysym, true);
    assert.equal(event.key, key);
    assert.equal(event.windowsVirtualKeyCode, virtualCode);
    assert.equal(event.text, key === 'Enter' ? '\r' : '');
    input.key(keysym, false);
  }
  input.key(0xfe03, true);
  assert.equal(input.key(0x010020ac, true)[0].text, '€', 'AltGraph must not suppress international text');
});

test('legacy X11 international keysyms use the same character table as noVNC', () => {
  const input = new RFBInput();
  for (const [keysym, character] of [[0x05c7, 'ا'], [0x05e4, 'ل'], [0x0ce0, 'א'], [0x06d1, 'я'], [0x07e1, 'α'], [0x01b1, 'ą']]) {
    assert.equal(input.key(keysym, true)[0].text, character);
    assert.equal(input.key(keysym, false)[0].key, character);
  }
});

test('RFB pointer converts button bits, drag, wheel, double click and bounds', () => {
  let now = 1000;
  const input = new RFBInput({ now: () => now });
  assert.deepEqual(input.pointer(1, 20, 30).map((event) => [event.eventType, event.buttons, event.clickCount]), [
    ['mouseMoved', 0, undefined], ['mousePressed', 1, 1],
  ]);
  assert.equal(input.pointer(1, 25, 35)[0].buttons, 1);
  assert.equal(input.pointer(0, 25, 35)[0].eventType, 'mouseReleased');
  now += 100;
  assert.equal(input.pointer(1, 22, 31).at(-1).clickCount, 2);
  assert.equal(input.pointer(0, 22, 31)[0].clickCount, 2);
  assert.equal(input.pointer(2, 22, 31)[0].buttons, 4, 'RFB middle maps to CDP bit 2');
  input.pointer(0, 22, 31);
  assert.equal(input.pointer(4, 22, 31)[0].buttons, 2, 'RFB right maps to CDP bit 1');
  input.pointer(0, 22, 31);
  assert.equal(input.pointer(8, 22, 31)[0].deltaY, -100);
  assert.equal(input.pointer(8, 22, 31).length, 0, 'held wheel bit is not a second wheel tick');
  input.pointer(0, 22, 31);
  assert.equal(input.pointer(64, 22, 31)[0].deltaX, 100);
  const outside = input.pointer(0, 65535, 65535)[0];
  assert.equal(outside.x, 1279);
  assert.equal(outside.y, 719);
});

test('disconnect releases every held key and pointer button exactly once', () => {
  const input = new RFBInput();
  input.key(0xffe3, true);
  input.key(97, true);
  input.pointer(1, 100, 200);
  const release = input.release();
  assert.deepEqual(release.map((event) => event.eventType), ['keyUp', 'keyUp', 'mouseReleased']);
  assert.equal(release.at(-1).buttons, 0);
  assert.equal(input.modifiers, 0);
  assert.deepEqual(input.release(), []);
});
