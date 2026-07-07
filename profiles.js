"use strict";
/*
 * Device profiles & static vocabulary for the Endgame Gear 8k series.
 * Every value here is binary-verified - see ../Endgame_8k_Mice_MultiDevice_Protocol.md
 * (per-device CPI clamps section 5.4, LOD lists section 5.5, capability matrix section 5.1) and
 * ../OP1_8k_v2_USB_Protocol.md (button-action vocabulary section 4.6).
 */

const EGG_VID = 0x3367;

const EGG_LOD_V1 = ["0.7 mm", "1 mm", "2 mm"];
const EGG_LOD_V2 = ["0.7 mm", "0.8 mm", "0.9 mm", "1.0 mm", "1.1 mm",
                    "1.2 mm", "1.3 mm", "1.4 mm", "1.5 mm", "1.6 mm", "1.7 mm"];
const EGG_LOD_V2_GLASS = ["1.0 mm", "2.0 mm"];

const EGG_POLLING = [
  { div: 8, hz: 1000 },
  { div: 4, hz: 2000 },
  { div: 2, hz: 4000 },
  { div: 1, hz: 8000 },
];

const EGG_PROFILES = {
  0x1964: {
    pid: 0x1964, name: "OP1 8k", family: "v1",
    cpiMin: 50, cpiMax: 26000, cpiStepLo: 50, cpiStepHi: 50,
    lodNormal: EGG_LOD_V1, lodGlass: null,
  },
  0x1966: {
    pid: 0x1966, name: "XM2 8k", family: "v1",
    cpiMin: 50, cpiMax: 26000, cpiStepLo: 50, cpiStepHi: 50,
    lodNormal: EGG_LOD_V1, lodGlass: null,
  },
  0x1976: {
    pid: 0x1976, name: "OP1 8k Purple Frost", family: "v1",
    cpiMin: 50, cpiMax: 30000, cpiStepLo: 50, cpiStepHi: 50,
    lodNormal: EGG_LOD_V1, lodGlass: null,
  },
  0x1978: {
    pid: 0x1978, name: "OP1 8k v2", family: "v2",
    cpiMin: 10, cpiMax: 30000, cpiStepLo: 10, cpiStepHi: 50,
    lodNormal: EGG_LOD_V2, lodGlass: EGG_LOD_V2_GLASS,
  },
  0x1980: {
    pid: 0x1980, name: "XM2 8k v2", family: "v2",
    cpiMin: 10, cpiMax: 30000, cpiStepLo: 10, cpiStepHi: 50,
    lodNormal: EGG_LOD_V2, lodGlass: EGG_LOD_V2_GLASS,
  },
};

/* CPI clamp - mirrors each tool's own quantizer (V1 FUN_00402910, V2 FUN_0040c9a0):
 * clamp to [min,max], then round-half-up to the step (V1: 50 uniform;
 * V2: 10 at <=10000, 50 above). */
function eggClampCpi(profile, v) {
  v = Math.round(Number(v) || 0);
  if (v < profile.cpiMin) v = profile.cpiMin;
  if (v > profile.cpiMax) v = profile.cpiMax;
  const step = (profile.family === "v2" && v <= 10000) ? profile.cpiStepLo : profile.cpiStepHi;
  const q = Math.floor(v / step), r = v % step;
  v = (r >= step / 2 ? q + 1 : q) * step;
  if (v > profile.cpiMax) v = profile.cpiMax;
  if (v < profile.cpiMin) v = profile.cpiMin;
  return v;
}

function eggLodList(profile, glassMode) {
  return (glassMode && profile.lodGlass) ? profile.lodGlass : profile.lodNormal;
}

/* ---------------- Button-action vocabulary (V2 doc section 4.6, universal) ------------- */

const EGG_ACTIONS = [
  { group: "Mouse", items: [
    { key: "m_left",    label: "Left Click",    type: 0x00, p0: 0x01 },
    { key: "m_right",   label: "Right Click",   type: 0x00, p0: 0x02 },
    { key: "m_middle",  label: "Middle Click",  type: 0x00, p0: 0x04 },
    { key: "m_back",    label: "Back",          type: 0x00, p0: 0x08 },
    { key: "m_forward", label: "Forward",       type: 0x00, p0: 0x10 },
  ]},
  { group: "Scroll", items: [
    { key: "s_up",   label: "Wheel Up",   type: 0x01, p0: 0x01 },
    { key: "s_down", label: "Wheel Down", type: 0x01, p0: 0xFF },
  ]},
  { group: "Keyboard", items: [
    { key: "kbd", label: "Keyboard shortcut", type: 0x02, custom: true },
  ]},
  { group: "CPI", items: [
    { key: "cpi_loop",  label: "CPI Loop", type: 0x09, p0: 0xF1 },
    { key: "cpi_fixed", label: "Fixed CPI", type: 0x0C, custom: true },
  ]},
  { group: "Media", items: [
    { key: "md_play",  label: "Play / Pause",   type: 0x20, p0: 0xCD },
    { key: "md_next",  label: "Next Track",     type: 0x20, p0: 0xB5 },
    { key: "md_prev",  label: "Previous Track", type: 0x20, p0: 0xB6 },
    { key: "md_mute",  label: "Mute",           type: 0x20, p0: 0xE2 },
    { key: "md_volup", label: "Volume Up",      type: 0x20, p0: 0xE9 },
    { key: "md_voldn", label: "Volume Down",    type: 0x20, p0: 0xEA },
  ]},
  { group: "System", items: [
    { key: "sys_browser",  label: "Browser Home",  type: 0x18, p0: 0x96 },
    { key: "sys_explorer", label: "File Explorer", type: 0x18, p0: 0x94 },
  ]},
  { group: "Other", items: [
    { key: "disabled", label: "Disabled", type: 0xFF },
  ]},
];

const EGG_ACTION_BY_KEY = (() => {
  const m = new Map();
  for (const g of EGG_ACTIONS) for (const it of g.items) m.set(it.key, it);
  return m;
})();

function eggDecodeAction(type, p) {
  switch (type) {
    case 0x00: {
      const k = { 0x01: "m_left", 0x02: "m_right", 0x04: "m_middle", 0x08: "m_back", 0x10: "m_forward" }[p[0]];
      return k ? { key: k } : { key: "raw" };
    }
    case 0x01:
      return p[0] === 0x01 ? { key: "s_up" } : p[0] === 0xFF ? { key: "s_down" } : { key: "raw" };
    case 0x02:
      return { key: "kbd", mods: p[0] & 0x0F, usage: p[1] };
    case 0x09:
      return { key: "cpi_loop" };
    case 0x0C:
      return { key: "cpi_fixed", x: p[1] | (p[2] << 8), y: p[3] | (p[4] << 8) };
    case 0x18:
      return p[0] === 0x96 ? { key: "sys_browser" } : p[0] === 0x94 ? { key: "sys_explorer" } : { key: "raw" };
    case 0x20: {
      const k = { 0xCD: "md_play", 0xB5: "md_next", 0xB6: "md_prev", 0xE2: "md_mute", 0xE9: "md_volup", 0xEA: "md_voldn" }[p[0]];
      return k ? { key: k } : { key: "raw" };
    }
    case 0xFF:
      return { key: "disabled" };
    default:
      return { key: "raw" };
  }
}

function eggEncodeAction(a) {
  const P = (...v) => { const p = [0, 0, 0, 0, 0]; v.forEach((x, i) => p[i] = x & 0xFF); return p; };
  switch (a.key) {
    case "m_left":       return { type: 0x00, params: P(0x01) };
    case "m_right":      return { type: 0x00, params: P(0x02) };
    case "m_middle":     return { type: 0x00, params: P(0x04) };
    case "m_back":       return { type: 0x00, params: P(0x08) };
    case "m_forward":    return { type: 0x00, params: P(0x10) };
    case "s_up":         return { type: 0x01, params: P(0x01) };
    case "s_down":       return { type: 0x01, params: P(0xFF) };
    case "kbd":          return { type: 0x02, params: P(a.mods & 0x0F, a.usage & 0xFF) };
    case "cpi_loop":     return { type: 0x09, params: P(0xF1) };
    case "cpi_fixed":    return { type: 0x0C, params: P(0, a.x & 0xFF, (a.x >> 8) & 0xFF, a.y & 0xFF, (a.y >> 8) & 0xFF) };
    case "md_play":      return { type: 0x20, params: P(0xCD) };
    case "md_next":      return { type: 0x20, params: P(0xB5) };
    case "md_prev":      return { type: 0x20, params: P(0xB6) };
    case "md_mute":      return { type: 0x20, params: P(0xE2) };
    case "md_volup":     return { type: 0x20, params: P(0xE9) };
    case "md_voldn":     return { type: 0x20, params: P(0xEA) };
    case "sys_browser":  return { type: 0x18, params: P(0x96) };
    case "sys_explorer": return { type: 0x18, params: P(0x94) };
    case "disabled":     return { type: 0xFF, params: P() };
    default:             return null; // "raw" - preserve original bytes, never re-encode
  }
}

/* ---------------- Keyboard: KeyboardEvent.code <-> USB HID usage IDs ------------ */

const EGG_HID_KEYS = (() => {
  const t = [];
  const add = (usage, code, label) => t.push({ usage, code, label });
  for (let i = 0; i < 26; i++) { const L = String.fromCharCode(65 + i); add(0x04 + i, "Key" + L, L); }
  for (let i = 1; i <= 9; i++) add(0x1E + i - 1, "Digit" + i, String(i));
  add(0x27, "Digit0", "0");
  add(0x28, "Enter", "Enter"); add(0x29, "Escape", "Esc"); add(0x2A, "Backspace", "Backspace");
  add(0x2B, "Tab", "Tab"); add(0x2C, "Space", "Space");
  add(0x2D, "Minus", "-"); add(0x2E, "Equal", "="); add(0x2F, "BracketLeft", "[");
  add(0x30, "BracketRight", "]"); add(0x31, "Backslash", "\\"); add(0x33, "Semicolon", ";");
  add(0x34, "Quote", "'"); add(0x35, "Backquote", "`"); add(0x36, "Comma", ",");
  add(0x37, "Period", "."); add(0x38, "Slash", "/"); add(0x39, "CapsLock", "CapsLock");
  for (let i = 1; i <= 12; i++) add(0x3A + i - 1, "F" + i, "F" + i);
  add(0x46, "PrintScreen", "PrtSc"); add(0x47, "ScrollLock", "ScrollLock"); add(0x48, "Pause", "Pause");
  add(0x49, "Insert", "Ins"); add(0x4A, "Home", "Home"); add(0x4B, "PageUp", "PgUp");
  add(0x4C, "Delete", "Del"); add(0x4D, "End", "End"); add(0x4E, "PageDown", "PgDn");
  add(0x4F, "ArrowRight", "->"); add(0x50, "ArrowLeft", "<-"); add(0x51, "ArrowDown", "Down"); add(0x52, "ArrowUp", "Up");
  add(0x53, "NumLock", "NumLock"); add(0x54, "NumpadDivide", "Num /"); add(0x55, "NumpadMultiply", "Num *");
  add(0x56, "NumpadSubtract", "Num -"); add(0x57, "NumpadAdd", "Num +"); add(0x58, "NumpadEnter", "Num Enter");
  for (let i = 1; i <= 9; i++) add(0x59 + i - 1, "Numpad" + i, "Num " + i);
  add(0x62, "Numpad0", "Num 0"); add(0x63, "NumpadDecimal", "Num .");
  return t;
})();
const EGG_KEY_BY_CODE = new Map(EGG_HID_KEYS.map(k => [k.code, k]));
const EGG_KEY_BY_USAGE = new Map(EGG_HID_KEYS.map(k => [k.usage, k]));

/* Wire modifier mask (V2 doc section 4.6): bit0 Ctrl, bit1 Shift, bit2 Alt, bit3 Win. */
const EGG_MODS = [
  { mask: 0x01, label: "Ctrl" },
  { mask: 0x02, label: "Shift" },
  { mask: 0x04, label: "Alt" },
  { mask: 0x08, label: "Win" },
];

function eggComboLabel(mods, usage) {
  const parts = EGG_MODS.filter(m => mods & m.mask).map(m => m.label);
  if (usage != null) {
    const k = EGG_KEY_BY_USAGE.get(usage);
    parts.push(k ? k.label : "0x" + usage.toString(16).padStart(2, "0"));
  }
  return parts.join(" + ") || "...";
}

function eggActionLabel(a) {
  if (!a) return "-";
  if (a.key === "raw") return "Custom (preserved)";
  if (a.key === "kbd") return eggComboLabel(a.mods, a.usage);
  if (a.key === "cpi_fixed") return a.x === a.y ? `CPI ${a.x}` : `X ${a.x} / Y ${a.y}`;
  const it = EGG_ACTION_BY_KEY.get(a.key);
  return it ? it.label : a.key;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    EGG_VID, EGG_PROFILES, EGG_POLLING, EGG_LOD_V1, EGG_LOD_V2, EGG_LOD_V2_GLASS,
    eggClampCpi, eggLodList, EGG_ACTIONS, EGG_ACTION_BY_KEY,
    eggDecodeAction, eggEncodeAction, eggActionLabel, eggComboLabel,
    EGG_HID_KEYS, EGG_KEY_BY_CODE, EGG_KEY_BY_USAGE, EGG_MODS,
  };
}
