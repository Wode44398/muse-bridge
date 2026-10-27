const KEY_DEFS = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
};

export function parseKeySpec(spec) {
  const parts = String(spec).toLowerCase().split('+').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) throw new Error('empty key spec');
  let modifiers = 0;
  const modifierBits = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 };
  while (parts.length > 1 && modifierBits[parts[0]] != null) {
    modifiers |= modifierBits[parts.shift()];
  }
  const base = parts.join('+');
  let key = KEY_DEFS[base];
  if (!key && base.length === 1) {
    const upper = base.toUpperCase();
    key = {
      key: modifiers & 8 ? upper : base,
      code: /[a-z]/.test(base) ? `Key${upper}` : /[0-9]/.test(base) ? `Digit${base}` : upper,
      keyCode: upper.charCodeAt(0),
      text: modifiers & ~8 ? undefined : modifiers & 8 ? upper : base,
    };
  }
  if (!key) {
    throw new Error(`unsupported key "${spec}" (named: ${Object.keys(KEY_DEFS).join('|')}; or a single char, with ctrl/alt/shift/meta+ prefixes)`);
  }
  return { key, modifiers };
}
