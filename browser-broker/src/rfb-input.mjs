// RFB carries X11 keysyms, while Chromium's Input domain expects DOM keys.
// Keep this translation independent of pages, browser targets and host input.
// Reuse noVNC's pinned X11 character table for legacy Arabic, Hebrew, Cyrillic,
// Greek, etc. Import only the pure table: the public RFB entry needs browser DOM.
const { default: keysyms } = await import(new URL('./input/keysymdef.js', import.meta.resolve('@novnc/novnc')));
const legacyCodepoints = new Map();
for (let point = 0x100; point <= 0xffff; point++) {
  const keysym = keysyms.lookup(point);
  if (keysym < 0x01000000) legacyCodepoints.set(keysym, point);
}

const specialKeys = new Map([
  [0xff08, ['Backspace', 'Backspace', 8]],
  [0xff09, ['Tab', 'Tab', 9]],
  [0xfe20, ['Tab', 'Tab', 9]],
  [0xff0a, ['Enter', 'Enter', 13]],
  [0xff0d, ['Enter', 'Enter', 13]],
  [0xff13, ['Pause', 'Pause', 19]],
  [0xff14, ['ScrollLock', 'ScrollLock', 145]],
  [0xff1b, ['Escape', 'Escape', 27]],
  [0xff50, ['Home', 'Home', 36]],
  [0xff51, ['ArrowLeft', 'ArrowLeft', 37]],
  [0xff52, ['ArrowUp', 'ArrowUp', 38]],
  [0xff53, ['ArrowRight', 'ArrowRight', 39]],
  [0xff54, ['ArrowDown', 'ArrowDown', 40]],
  [0xff55, ['PageUp', 'PageUp', 33]],
  [0xff56, ['PageDown', 'PageDown', 34]],
  [0xff57, ['End', 'End', 35]],
  [0xff61, ['PrintScreen', 'PrintScreen', 44]],
  [0xff63, ['Insert', 'Insert', 45]],
  [0xff67, ['ContextMenu', 'ContextMenu', 93]],
  [0xff7f, ['NumLock', 'NumLock', 144]],
  [0xff8d, ['Enter', 'NumpadEnter', 13]],
  [0xff95, ['Home', 'Numpad7', 36]],
  [0xff96, ['ArrowLeft', 'Numpad4', 37]],
  [0xff97, ['ArrowUp', 'Numpad8', 38]],
  [0xff98, ['ArrowRight', 'Numpad6', 39]],
  [0xff99, ['ArrowDown', 'Numpad2', 40]],
  [0xff9a, ['PageUp', 'Numpad9', 33]],
  [0xff9b, ['PageDown', 'Numpad3', 34]],
  [0xff9c, ['End', 'Numpad1', 35]],
  [0xff9e, ['Insert', 'Numpad0', 45]],
  [0xff9f, ['Delete', 'NumpadDecimal', 46]],
  [0xffaa, ['*', 'NumpadMultiply', 106]],
  [0xffab, ['+', 'NumpadAdd', 107]],
  [0xffad, ['-', 'NumpadSubtract', 109]],
  [0xffae, ['.', 'NumpadDecimal', 110]],
  [0xffaf, ['/', 'NumpadDivide', 111]],
  [0xffe1, ['Shift', 'ShiftLeft', 16, 8]],
  [0xffe2, ['Shift', 'ShiftRight', 16, 8]],
  [0xffe3, ['Control', 'ControlLeft', 17, 2]],
  [0xffe4, ['Control', 'ControlRight', 17, 2]],
  [0xffe5, ['CapsLock', 'CapsLock', 20]],
  [0xffe7, ['Meta', 'MetaLeft', 91, 4]],
  [0xffe8, ['Meta', 'MetaRight', 92, 4]],
  [0xffe9, ['Alt', 'AltLeft', 18, 1]],
  [0xffea, ['Alt', 'AltRight', 18, 1]],
  [0xffeb, ['Meta', 'MetaLeft', 91, 4]],
  [0xffec, ['Meta', 'MetaRight', 92, 4]],
  // AltGraph produces a printable keysym itself; do not suppress its text.
  [0xfe03, ['AltGraph', 'AltRight', 225]],
  [0xffff, ['Delete', 'Delete', 46]],
]);
for (let i = 0; i < 24; i++) specialKeys.set(0xffbe + i, [`F${i + 1}`, `F${i + 1}`, 112 + i]);
for (let i = 0; i < 10; i++) specialKeys.set(0xffb0 + i, [String(i), `Numpad${i}`, 96 + i]);

const punctuation = [
  [';:', 'Semicolon', 186], ['=+', 'Equal', 187], [',<', 'Comma', 188],
  ['-_', 'Minus', 189], ['.>', 'Period', 190], ['/?', 'Slash', 191],
  ['`~', 'Backquote', 192], ['[{', 'BracketLeft', 219], ['\\|', 'Backslash', 220],
  [']}', 'BracketRight', 221], ["'\"", 'Quote', 222], [' ', 'Space', 32],
];
const shiftedDigits = ')!@#$%^&*(';

export function keysymToKey(keysym) {
  const special = specialKeys.get(keysym);
  if (special) return { key: special[0], code: special[1], windowsVirtualKeyCode: special[2], modifier: special[3] || 0 };
  const point = legacyCodepoints.get(keysym) ?? ((keysym & 0xff000000) === 0x01000000 ? keysym & 0x00ffffff : keysym);
  if (!((keysym >= 0x20 && keysym <= 0xff) || legacyCodepoints.has(keysym) || (keysym & 0xff000000) === 0x01000000) ||
      point < 0x20 || point === 0x7f || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return null;
  const key = String.fromCodePoint(point);
  if (/^[a-z]$/i.test(key)) return { key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0), modifier: 0 };
  const digit = /^[0-9]$/.test(key) ? Number(key) : shiftedDigits.indexOf(key);
  if (digit >= 0) return { key, code: `Digit${digit}`, windowsVirtualKeyCode: 48 + digit, modifier: 0 };
  const symbol = punctuation.find(([characters]) => characters.includes(key));
  return { key, code: symbol?.[1] || '', windowsVirtualKeyCode: symbol?.[2] || 0, modifier: 0 };
}

export class RFBInput {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.pressed = new Map();
    this.pointerMask = 0;
    this.x = 0;
    this.y = 0;
    this.clicks = new Map();
  }

  get modifiers() {
    let modifiers = 0;
    for (const key of this.pressed.values()) modifiers |= key.modifier;
    return modifiers;
  }

  key(keysym, down) {
    const mapped = keysymToKey(keysym);
    if (!mapped) return [];
    const autoRepeat = down && this.pressed.has(keysym);
    if (down) {
      if (!autoRepeat && this.pressed.size >= 64) throw new Error('too many held browser keys');
      this.pressed.set(keysym, mapped);
    } else {
      this.pressed.delete(keysym);
    }
    const modifiers = this.modifiers | (keysym === 0xfe20 ? 8 : 0);
    const printable = [...mapped.key].length === 1;
    const text = down && !(modifiers & 7) ? (printable ? mapped.key : mapped.key === 'Enter' ? '\r' : '') : '';
    return [{
      type: 'key', eventType: down ? 'keyDown' : 'keyUp', key: mapped.key, code: mapped.code,
      windowsVirtualKeyCode: mapped.windowsVirtualKeyCode, modifiers, text, unmodifiedText: text, autoRepeat,
    }];
  }

  pointer(mask, x, y, width = 1280, height = 720) {
    x = Math.max(0, Math.min(width - 1, x));
    y = Math.max(0, Math.min(height - 1, y));
    const result = [];
    const previous = this.pointerMask;
    let held = previous & 0x87;
    const buttons = (bits) => (bits & 1) | ((bits & 2) << 1) | ((bits & 4) >> 1) | ((bits & 128) >> 4);
    const base = { type: 'mouse', x, y, modifiers: this.modifiers };
    if (x !== this.x || y !== this.y) result.push({ ...base, eventType: 'mouseMoved', button: 'none', buttons: buttons(held) });
    for (const [bit, button] of [[1, 'left'], [2, 'middle'], [4, 'right'], [128, 'back']]) {
      if (!((mask ^ previous) & bit)) continue;
      const down = Boolean(mask & bit);
      held = down ? held | bit : held & ~bit;
      const prior = this.clicks.get(bit);
      let clickCount = prior?.count || 1;
      if (down) {
        const now = this.now();
        clickCount = prior && now - prior.at <= 500 && Math.hypot(prior.x - x, prior.y - y) <= 5 ? (prior.count % 3) + 1 : 1;
        this.clicks.set(bit, { at: now, x, y, count: clickCount });
      }
      result.push({ ...base, eventType: down ? 'mousePressed' : 'mouseReleased', button, buttons: buttons(held), clickCount });
    }
    const wheel = mask & ~previous;
    const deltaY = ((wheel & 16) ? 100 : 0) - ((wheel & 8) ? 100 : 0);
    const deltaX = ((wheel & 64) ? 100 : 0) - ((wheel & 32) ? 100 : 0);
    if (deltaX || deltaY) result.push({ ...base, eventType: 'mouseWheel', button: 'none', buttons: buttons(held), deltaX, deltaY });
    this.pointerMask = mask;
    this.x = x;
    this.y = y;
    return result;
  }

  release() {
    const events = [];
    for (const keysym of [...this.pressed.keys()]) events.push(...this.key(keysym, false));
    events.push(...this.pointer(0, this.x, this.y, 65536, 65536));
    return events;
  }
}
