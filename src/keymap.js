// Maps uiohook-napi keycodes -> @nut-tree-fork/nut-js Key keycodes by name.
// Names differ between the two enums; this table is the translation layer.

const NAME_ALIASES = {
  // letters/digits/F-keys map 1:1 by name
  // modifiers
  Shift: "LeftShift",
  ShiftRight: "RightShift",
  Ctrl: "LeftControl",
  CtrlRight: "RightControl",
  Alt: "LeftAlt",
  AltRight: "RightAlt",
  Meta: "LeftMeta",
  MetaRight: "RightMeta",
  // punctuation
  Backquote: "Grave",
  BracketLeft: "LeftBracket",
  BracketRight: "RightBracket",
  // numpad
  Numpad0: "NumPad0", Numpad1: "NumPad1", Numpad2: "NumPad2",
  Numpad3: "NumPad3", Numpad4: "NumPad4", Numpad5: "NumPad5",
  Numpad6: "NumPad6", Numpad7: "NumPad7", Numpad8: "NumPad8",
  Numpad9: "NumPad9",
  NumpadMultiply: "Multiply", NumpadAdd: "Add",
  NumpadSubtract: "Subtract", NumpadDecimal: "Decimal",
  NumpadDivide: "Divide", NumpadEnter: "Enter",
  NumLock: "NumLock",
};

// Names present identically in both enums.
const DIRECT = [
  "A","B","C","D","E","F","G","H","I","J","K","L","M",
  "N","O","P","Q","R","S","T","U","V","W","X","Y","Z",
  "0","1","2","3","4","5","6","7","8","9",
  "F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12",
  "Escape","Tab","CapsLock","Space","Backspace","Enter","Delete",
  "Insert","Home","End","PageUp","PageDown",
  "ArrowUp","ArrowDown","ArrowLeft","ArrowRight",
  "Minus","Equal","Backslash","Semicolon","Quote","Comma","Period","Slash",
];

function buildKeyMap(UiohookKey, Key) {
  const u2n = {};
  const n2name = {};

  for (const name of DIRECT) {
    if (UiohookKey[name] !== undefined && Key[name] !== undefined) {
      u2n[UiohookKey[name]] = Key[name];
      n2name[Key[name]] = name;
    }
  }
  for (const [uName, nName] of Object.entries(NAME_ALIASES)) {
    if (UiohookKey[uName] !== undefined && Key[nName] !== undefined) {
      u2n[UiohookKey[uName]] = Key[nName];
      n2name[Key[nName]] = uName;
    }
  }
  return { u2n, n2name };
}

module.exports = { buildKeyMap };
