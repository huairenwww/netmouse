// Parse a hotkey spec like "Ctrl+Alt+Shift+Q" into groups of acceptable uiohook
// keycodes. A spec matches when *every* group has at least one key held down —
// which lets "Ctrl" accept either Ctrl or CtrlRight, "Alt" either Alt/AltRight,
// and so on. Pure (no side effects) so the selftest can assert on it.

const MOD_ALIASES = {
  ctrl: ["Ctrl", "CtrlRight"],
  control: ["Ctrl", "CtrlRight"],
  alt: ["Alt", "AltRight"],
  option: ["Alt", "AltRight"],
  shift: ["Shift", "ShiftRight"],
  meta: ["Meta", "MetaRight"],
  super: ["Meta", "MetaRight"],
  win: ["Meta", "MetaRight"],
  cmd: ["Meta", "MetaRight"],
  command: ["Meta", "MetaRight"],
};

// Returns { groups: number[][] } or null when the spec is empty/invalid.
function parseHotkey(spec, UiohookKey) {
  if (!spec || typeof spec !== "string" || !UiohookKey) return null;
  const parts = spec
    .split("+")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  const groups = [];
  let main = null;
  for (const p of parts) {
    const key = p.toLowerCase();
    if (MOD_ALIASES[key]) {
      const codes = MOD_ALIASES[key].map((n) => UiohookKey[n]).filter((v) => v !== undefined);
      if (!codes.length) return null;
      groups.push(codes);
      continue;
    }
    const name = p.length === 1 ? p.toUpperCase() : p;
    const code = UiohookKey[name];
    if (code === undefined) return null;
    main = [code];
  }
  if (!main || groups.length === 0) return null;
  groups.push(main); // the non-modifier key must be held too
  return { groups };
}

// `pressed` is a Set/array of currently-held keycodes.
function hotkeyMatches(hotkey, pressed) {
  if (!hotkey) return false;
  const has = typeof pressed.has === "function" ? (c) => pressed.has(c) : (c) => pressed.includes(c);
  return hotkey.groups.every((g) => g.some((c) => has(c)));
}

module.exports = { parseHotkey, hotkeyMatches, MOD_ALIASES };
