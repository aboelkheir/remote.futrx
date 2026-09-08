// noVNC's app/ui.js uses a padded textarea and input differences for mobile
// keyboards that omit usable keydown events. Keep that pattern, comparing
// Unicode code points so a composed character is sent as one RFB keysym.
export const BROWSER_KEYBOARD_PADDING = "_".repeat(100);

export function browserKeyboardChanges(previous: string, next: string): { backspaces: number; text: string } {
  const before = Array.from(previous);
  const after = Array.from(next);
  let common = 0;
  while (common < before.length && common < after.length && before[common] === after[common]) common++;
  return { backspaces: before.length - common, text: after.slice(common).join("") };
}

export function browserCharacterKeysym(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  if (code === 10) return 0xff0d; // Return
  if (code === 9) return 0xff09; // Tab
  return code <= 0xff ? code : 0x01000000 | code;
}
