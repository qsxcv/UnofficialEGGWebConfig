"use strict";
/*
 * Endgame Gear 8k Web Config - UI + device manager.
 * Requires profiles.js and protocol.js (classic scripts, loaded before this file).
 */
(() => {

/* ------------------------------- tiny helpers ---------------------------------- */

const $ = sel => document.querySelector(sel);

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}

const hex2 = n => n.toString(16).padStart(2, "0");

function setVal(el, v) {
  if (String(el.value) === String(v)) return;
  if (el === document.activeElement && (el.type === "number" || el.type === "text")) return;
  el.value = v;
}

function toast(msg, kind = "info", ms = 3500) {
  const t = h("div", { class: "toast " + kind }, msg);
  $("#toasts").append(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 300); }, ms);
}

const LOG_MAX = 400;
function log(msg) {
  const pre = $("#logPre");
  const ts = new Date().toLocaleTimeString();
  pre.textContent += `[${ts}] ${msg}\n`;
  const lines = pre.textContent.split("\n");
  if (lines.length > LOG_MAX) pre.textContent = lines.slice(lines.length - LOG_MAX).join("\n");
  pre.scrollTop = pre.scrollHeight;
}

function isLinuxDesktop() {
  const ua = navigator.userAgent || "";
  const uaPlatform = navigator.userAgentData && navigator.userAgentData.platform || "";
  const platform = uaPlatform || navigator.platform || "";
  const client = `${platform} ${ua}`;
  return /linux/i.test(client) && !/(android|cros|chrome os)/i.test(client);
}

/* ------------------------------- app state ------------------------------------- */

/*
 * UI slots vs. wire button records (hardware-verified on OP1 8k v2, right-handed
 * layout): record i's ctl byte (multiclick/SPDT) belongs to the i-th physical
 * button (L, R, M, F, B), but record i's MAPPING bytes belong to the next input
 * down the list - record 0 maps Right, 1 Middle, 2 Forward, 3 Back; record 4's
 * mapping is a hidden slot the app preserves untouched; records 5/6 map the wheel.
 * Left's mapping lives in the separate 6-byte slot at wire 71-76 (see slotMeta).
 */
const SLOTS = [
  { name: "Left",       ctlIndex: 0, mapIndex: null, mc: true,  spdt: true,  remap: false },
  { name: "Right",      ctlIndex: 1, mapIndex: 0,    mc: true,  spdt: true,  remap: true  },
  { name: "Middle",     ctlIndex: 2, mapIndex: 1,    mc: true,  spdt: false, remap: true  },
  { name: "Forward",    ctlIndex: 3, mapIndex: 2,    mc: true,  spdt: false, remap: true  },
  { name: "Back",       ctlIndex: 4, mapIndex: 3,    mc: true,  spdt: false, remap: true  },
  { name: "Wheel Up",   ctlIndex: null, mapIndex: 5, mc: false, spdt: false, remap: true  },
  { name: "Wheel Down", ctlIndex: null, mapIndex: 6, mc: false, spdt: false, remap: true  },
];

/*
 * Effective slot metadata under the current handedness (V2 doc section 4.6.1,
 * hardware-verified 2026-07-05 against an official-tool capture).
 * Physical Left's mapping always lives in the 6-byte slot at wire 71-76:
 * plain LEFT CLICK (00 01) when right-handed, the user's action when
 * left-handed (mapHanded). Record 0 is Right's mapping: the user's action
 * when right-handed, plain LEFT CLICK when left-handed. Multiclick/SPDT
 * ctl bytes always follow the physical button, so ctlIndex never changes.
 */
function slotMeta(slot, s = state.pending) {
  const meta = SLOTS[slot];
  if (!s || !s.leftHanded || slot > 1) return meta;
  return slot === 0
    ? { ...meta, mapIndex: null, remap: true, mapHanded: true } // Left: remappable via 71-76
    : { ...meta, mapIndex: 0, remap: false };                   // Right: fixed primary click
}

const LH_MARKER = [0x00, 0x01, 0, 0, 0, 0]; // plain Mouse/LEFT CLICK mapping bytes

const STAGE_PREFILL = [400, 800, 1600, 3200];
// Stage-indicator LED colours, fixed in firmware for CPI 1-4 (hardware-confirmed
// on OP1 8k v2). These are the LEDs the mouse actually shows; they are NOT the
// RGB bytes in the config blob (bytes 31-50), which differ and are preserved untouched.
const STAGE_COLORS = [
  [0, 0, 255],   // CPI 1 - blue
  [0, 255, 0],   // CPI 2 - green
  [255, 255, 0], // CPI 3 - yellow
  [255, 0, 0],   // CPI 4 - red
];

const state = {
  mice: [],            // EggMouse[], connected & opened
  active: null,        // EggMouse
  profile: null,
  applied: null,       // settings as last read from the device
  pending: null,       // settings as edited in the UI
  btnUI: [],           // per-slot { action, multiclick, spdt }
  uiSplit: [false, false, false, false],
  linkedFixed: [true, true, true, true, true, true, true],
  lodMem: 0,           // remembered normal-list LOD index while glass mode is on
  prevHexBlob: null,
  busy: false,
};

const E = {}; // element refs, filled in buildUI()

/* ------------------------------ UI construction -------------------------------- */

const stageEls = [];
const btnEls = [];

function buildUI() {
  // polling segmented control
  E.pollingSeg = $("#pollingSeg");
  for (const p of EGG_POLLING) {
    const inp = h("input", { type: "radio", name: "polling", value: p.div,
      onchange: () => { if (guard()) return; state.pending.pollingDivider = p.div; render(); } });
    E.pollingSeg.append(h("label", { class: "seg-opt" }, inp, h("span", {}, `${p.hz} Hz`)));
  }
  E.pollingCustom = h("span", { class: "seg-custom", hidden: "" });
  E.pollingSeg.append(E.pollingCustom);

  // stage count segmented control
  E.stageCountSeg = $("#stageCountSeg");
  for (let n = 1; n <= 4; n++) {
    const inp = h("input", { type: "radio", name: "stageCount", value: n,
      onchange: () => onStageCount(n) });
    E.stageCountSeg.append(h("label", { class: "seg-opt" }, inp, h("span", {}, String(n))));
  }

  // stage rows - the indicator colours are fixed in firmware; the blob's colour
  // bytes are preserved but not surfaced as editable controls.
  const rows = $("#stageRows");
  for (let i = 0; i < 4; i++) {
    const radio = h("input", { type: "radio", name: "activeStage",
      onchange: () => onActiveStage(i) });
    const sw = h("span", { class: "swatch", title: "Stage LED colour (fixed in firmware)" });
    const x = h("input", { type: "number", class: "cpi", onchange: () => onStageCpi(i, "x") });
    const y = h("input", { type: "number", class: "cpi", onchange: () => onStageCpi(i, "y") });
    const sep = h("span", { class: "xy-sep" }, "x");
    const splitBtn = h("button", { class: "chip-btn", title: "Independent X / Y CPI",
      onclick: () => onSplitToggle(i) }, "X/Y");
    const row = h("div", { class: "stage-row" },
      h("label", { class: "radio-wrap", title: "Active stage (applies instantly)" }, radio),
      h("span", { class: "stage-name" }, `CPI ${i + 1}`),
      sw,
      h("div", { class: "cpi-inputs" }, x, sep, y),
      h("div", { class: "xy-cell" }, splitBtn),
    );
    rows.append(row);
    stageEls.push({ row, radio, sw, x, y, sep, splitBtn });
  }

  // button rows
  // Two cards: "Button settings" (multiclick + SPDT, physical buttons only) and
  // "Button remapping" (action dropdown, all inputs). Both draw from the same
  // per-slot btnEls entry, so render() is unchanged apart from the element homes.
  const remapRows = $("#remapRows");
  const settingsRows = $("#settingsRows");
  for (let slot = 0; slot < 7; slot++) {
    const meta = SLOTS[slot];

    // --- remapping controls ---
    const mapSel = h("select", { class: "map-select", onchange: () => onMapChange(slot) });
    for (const g of EGG_ACTIONS) {
      const og = h("optgroup", { label: g.group });
      for (const it of g.items) og.append(h("option", { value: it.key }, it.label));
      mapSel.append(og);
    }
    mapSel.append(h("option", { value: "raw", disabled: "", hidden: "" }, "Custom (preserved)"));

    const fixedChip = h("span", { class: "chip", hidden: "" });
    const kbdChip = h("span", { class: "chip key", hidden: "" });
    const kbdEdit = h("button", { class: "chip-btn", hidden: "",
      onclick: () => editKbd(slot) }, "change...");
    const fx = h("input", { type: "number", class: "cpi", title: "X CPI",
      onchange: () => onFixedCpi(slot, "x") });
    const fy = h("input", { type: "number", class: "cpi", title: "Y CPI",
      onchange: () => onFixedCpi(slot, "y") });
    const flink = h("button", { class: "chip-btn", title: "Link X and Y",
      onclick: () => { state.linkedFixed[slot] = !state.linkedFixed[slot]; onFixedCpi(slot, "x"); } }, "X=Y");
    const fixedWrap = h("span", { class: "fixed-wrap", hidden: "" }, fx, h("span", { class: "xy-sep" }, "x"), fy, flink);

    const remapRow = h("div", { class: "remap-row" },
      h("span", { class: "btn-name" }, meta.name),
      h("span", { class: "map-cell" }, mapSel, fixedChip, kbdChip, kbdEdit, fixedWrap),
    );
    remapRows.append(remapRow);

    // --- settings controls (multiclick + SPDT), physical buttons only ---
    let mcRange = null, mcOut = null, spdtSel = null, settingsRow = null;
    if (meta.mc) {
      mcRange = h("input", { type: "range", min: 0, max: 25,
        oninput: ev => {
          if (guard()) return;
          state.btnUI[slot].multiclick = +ev.target.value;
          mcOut.textContent = ev.target.value;
          commitButton(slot);
        } });
      mcOut = h("output", {}, "8");
      spdtSel = meta.spdt
        ? h("select", { class: "spdt-select", title: "SPDT switch mode (Left/Right only)",
            onchange: ev => { if (guard()) return; state.btnUI[slot].spdt = ev.target.value; commitButton(slot); render(); } },
            h("option", { value: "off" }, "SPDT: Off"),
            h("option", { value: "speed" }, "GX Speed Mode"),
            h("option", { value: "safe" }, "GX Safe Mode"))
        : null;
      settingsRow = h("div", { class: "settings-row" },
        h("span", { class: "btn-name" }, meta.name),
        h("span", { class: "mc-wrap" }, mcRange, mcOut),
        h("span", { class: "spdt-cell" }, spdtSel ? [spdtSel] : []),
      );
      settingsRows.append(settingsRow);
    }

    btnEls.push({ remapRow, settingsRow, mapSel, fixedChip, kbdChip, kbdEdit, fixedWrap, fx, fy, flink, mcRange, mcOut, spdtSel });
  }

  // left-hand mode (buttons card header)
  $("#tglLefty").addEventListener("change", ev => {
    if (guard()) { ev.target.checked = !!(state.pending && state.pending.leftHanded); return; }
    setHandedness(ev.target.checked);
  });

  // static buttons
  $("#btnAdd").addEventListener("click", headerDeviceAction);
  $("#btnHeroConnect").addEventListener("click", requestNewDevice);
  $("#btnCopyUdev").addEventListener("click", copyUdevCommands);
  $("#btnApply").addEventListener("click", apply);
  $("#btnDiscard").addEventListener("click", discard);
  $("#btnReload").addEventListener("click", reload);
  $("#btnReset").addEventListener("click", factoryReset);
  $("#btnExport").addEventListener("click", exportJson);
  $("#btnImport").addEventListener("click", () => $("#fileImport").click());
  $("#fileImport").addEventListener("change", importJson);
  $("#btnForget").addEventListener("click", forgetDevice);
  $("#btnCopyDbg").addEventListener("click", copyDebugInfo);
  $("#btnDemoStage").addEventListener("click", demoPressDpi);
  $("#deviceSelect").addEventListener("change", ev => {
    const m = state.mice[+ev.target.value];
    if (m && m !== state.active) activateMouse(m);
  });

  // settings toggles (the glass/fps/led-lift ones only render for V2 profiles)
  wireToggle("#tglMotionSync", s => s.motionSync, (s, v) => s.motionSync = v);
  wireToggle("#tglAngleSnap", s => s.angleSnapping, (s, v) => s.angleSnapping = v);
  wireToggle("#tglRipple", s => s.rippleControl, (s, v) => s.rippleControl = v);
  wireToggle("#tglSlamclick", s => s.slamclick, (s, v) => s.slamclick = v);
  wireToggle("#tglJitter", s => s.motionJitter, (s, v) => s.motionJitter = v);
  wireToggle("#tglGlass", s => s.glassMode, (s, v) => onGlassToggle(v));
  wireToggle("#tglMaxFps", s => s.forceMaxFps, (s, v) => s.forceMaxFps = v);
  wireToggle("#tglLedLift", s => s.ledLiftoffDisabled, (s, v) => s.ledLiftoffDisabled = v);

  $("#lodSelect").addEventListener("change", ev => {
    if (guard()) return;
    state.pending.lodIndex = +ev.target.value;
    render();
  });

  const rng = $("#rngAngle"), num = $("#numAngle");
  rng.addEventListener("input", () => { if (guard()) return; state.pending.angleTuning = +rng.value; num.value = rng.value; markDirty(); });
  num.addEventListener("change", () => {
    if (guard()) return;
    const v = Math.max(-127, Math.min(127, Math.round(+num.value || 0)));
    state.pending.angleTuning = v; render();
  });

  window.addEventListener("beforeunload", ev => {
    if (isDirty()) { ev.preventDefault(); ev.returnValue = ""; }
  });
}

function wireToggle(sel, get, set) {
  const el = $(sel);
  el.addEventListener("change", () => {
    if (guard()) { el.checked = get(state.pending); return; }
    set(state.pending, el.checked);
    render();
  });
}

function guard() { return !state.pending || state.busy; }

/* ------------------------------ change handlers -------------------------------- */

function onStageCount(n) {
  if (guard()) return;
  const s = state.pending;
  s.stageCount = n;
  if (s.activeStage >= n) s.activeStage = n - 1;
  for (let i = 0; i < n; i++) {
    if (s.stages[i].x === 0) {
      const v = eggClampCpi(state.profile, STAGE_PREFILL[i]);
      s.stages[i].x = v; s.stages[i].y = v; s.stages[i].split = false;
    }
  }
  render();
}

function onActiveStage(i) {
  if (guard()) return;
  if (i >= state.pending.stageCount) { render(); return; }
  const prev = state.applied.activeStage;
  state.pending.activeStage = i;
  state.applied.activeStage = i;   // instant path - not part of the dirty diff
  render();
  if (state.active) {
    state.active.setActiveStage(i).then(() => {
      log(`active stage -> CPI ${i + 1} (instant write)`);
    }).catch(e => {
      state.pending.activeStage = prev;
      state.applied.activeStage = prev;
      render();
      toast("Stage switch failed: " + e.message, "error");
    });
  }
}

function onStageCpi(i, axis) {
  if (guard()) return;
  const el = axis === "x" ? stageEls[i].x : stageEls[i].y;
  const v = eggClampCpi(state.profile, el.value);
  const st = state.pending.stages[i];
  st[axis] = v;
  if (!state.uiSplit[i]) { st.x = v; st.y = v; }
  st.split = state.uiSplit[i];
  render();
}

function onSplitToggle(i) {
  if (guard()) return;
  state.uiSplit[i] = !state.uiSplit[i];
  const st = state.pending.stages[i];
  if (!state.uiSplit[i]) st.y = st.x;
  st.split = state.uiSplit[i];
  render();
}

function onGlassToggle(v) {
  const s = state.pending;
  if (v) {
    state.lodMem = s.lodIndex;
    s.glassMode = true;
    s.lodIndex = 0; // glass list: 0 = 1.0 mm (conservative default)
  } else {
    s.glassMode = false;
    s.lodIndex = state.lodMem < state.profile.lodNormal.length ? state.lodMem : 0;
  }
}

/*
 * Toggle handedness (section 4.6.1 - encoding verified against an official-tool
 * capture, OP1 8k v2 FW V1.07). Both directions reset the two main buttons to
 * the factory pair: the fixed primary a plain LEFT CLICK, the other a plain
 * RIGHT CLICK. Multiclick/SPDT bytes are physical and stay untouched.
 */
function setHandedness(lh) {
  const s = state.pending;
  if (!!s.leftHanded === lh) return;
  s.leftHanded = lh;
  s.writeHanded = true;
  const rec = s.buttons[0];
  rec.writeMapping = true;
  rec.type = 0x00;
  if (lh) {
    rec.params = [0x01, 0, 0, 0, 0];         // record 0 = Right = fixed LEFT CLICK
    s.handedSlot = [0x00, 0x02, 0, 0, 0, 0]; // 71-76 = Left's action, default Right Click
    toast("Left-hand mode: physical Right becomes the primary click after Apply.", "info", 5000);
  } else {
    rec.params = [0x02, 0, 0, 0, 0];         // record 0 = Right's action, default Right Click
    s.handedSlot = [0x00, 0x01, 0, 0, 0, 0]; // 71-76 = Left = fixed LEFT CLICK
  }
  state.btnUI[0] = decodeButtonUI(0, s);
  state.btnUI[1] = decodeButtonUI(1, s);
  render();
}

function onMapChange(slot) {
  if (guard()) return;
  const key = btnEls[slot].mapSel.value;
  const ui = state.btnUI[slot];
  if (key === "kbd") {
    captureKey().then(res => {
      if (res) { ui.action = { key: "kbd", mods: res.mods, usage: res.usage }; commitButton(slot); }
      render(); // re-sync select on cancel
    });
    return;
  }
  if (key === "cpi_fixed") {
    const v = eggClampCpi(state.profile, 1600);
    ui.action = { key: "cpi_fixed", x: v, y: v };
    state.linkedFixed[slot] = true;
  } else {
    ui.action = { key };
  }
  commitButton(slot);
  render();
}

function editKbd(slot) {
  if (guard()) return;
  captureKey().then(res => {
    if (res) {
      state.btnUI[slot].action = { key: "kbd", mods: res.mods, usage: res.usage };
      commitButton(slot);
    }
    render();
  });
}

function onFixedCpi(slot, axis) {
  if (guard()) return;
  const a = state.btnUI[slot].action;
  if (a.key !== "cpi_fixed") return;
  const el = axis === "x" ? btnEls[slot].fx : btnEls[slot].fy;
  const v = eggClampCpi(state.profile, el.value);
  a[axis] = v;
  if (state.linkedFixed[slot]) { a.x = v; a.y = v; }
  commitButton(slot);
  render();
}

function commitButton(slot) {
  const meta = slotMeta(slot);
  const ui = state.btnUI[slot];
  if (meta.ctlIndex != null && (meta.mc || meta.spdt)) {
    const rec = state.pending.buttons[meta.ctlIndex];
    rec.writeCtl = true;
    rec.ctl = (meta.spdt && ui.spdt !== "off")
      ? (ui.spdt === "speed" ? 0xF1 : 0xF0)
      : Math.max(0, Math.min(25, ui.multiclick | 0));
  }
  if (meta.mapHanded && ui.action.key !== "raw") {
    const enc = eggEncodeAction(ui.action);
    if (enc) {
      // Left's action lives in the 71-76 handedness slot; re-assert the fixed
      // LEFT CLICK marker in record 0 so a foreign layout is normalized to ours.
      state.pending.handedSlot = [enc.type, ...enc.params];
      state.pending.writeHanded = true;
      const rec = state.pending.buttons[0];
      rec.writeMapping = true;
      rec.type = LH_MARKER[0];
      rec.params = LH_MARKER.slice(1);
    }
  } else if (meta.mapIndex != null && meta.remap && ui.action.key !== "raw") {
    const enc = eggEncodeAction(ui.action);
    if (enc) {
      const rec = state.pending.buttons[meta.mapIndex];
      rec.writeMapping = true;
      rec.type = enc.type;
      rec.params = enc.params;
    }
  }
  markDirty();
}

function decodeButtonUI(slot, s) {
  const meta = slotMeta(slot, s);
  const ctlRec = meta.ctlIndex == null ? null : s.buttons[meta.ctlIndex];
  const mapRec = meta.mapIndex == null ? null : s.buttons[meta.mapIndex];
  let action;
  if (slot === 0) {
    // Physical Left always lives in the 71-76 slot: LEFT CLICK when right-handed
    // (fixed primary), the user's action when left-handed. All-zero is the broken
    // "disabled" state - surface it as the implicit primary rather than "raw".
    const hs = s.handedSlot || [];
    action = hs.some(v => v) ? eggDecodeAction(hs[0], hs.slice(1)) : { key: "m_left" };
  } else {
    action = mapRec ? eggDecodeAction(mapRec.type, mapRec.params) : { key: "m_left" };
  }
  return {
    action,
    multiclick: ctlRec && ctlRec.ctl < 0xF0 ? Math.min(25, ctlRec.ctl) : 8,
    spdt: ctlRec && ctlRec.ctl === 0xF1 ? "speed" : ctlRec && ctlRec.ctl === 0xF0 ? "safe" : "off",
  };
}

/* ------------------------------ dirty tracking --------------------------------- */

function snapshot(s) {
  return JSON.stringify({
    d: s.pollingDivider, sl: s.slamclick, mj: s.motionJitter, ll: s.ledLiftoffDisabled,
    lod: s.lodIndex, as: s.angleSnapping, rc: s.rippleControl, ms: s.motionSync,
    n: s.stageCount,
    st: s.stages.map(t => [t.split, t.x, t.y]),
    b: s.buttons.map(r => [r.ctl, r.type, r.params]),
    g: s.glassMode, at: s.angleTuning, ff: s.forceMaxFps,
    lh: s.leftHanded, hs: s.handedSlot,
  });
}
function isDirty() {
  return !!(state.pending && state.applied && snapshot(state.pending) !== snapshot(state.applied));
}
function markDirty() { $("#applyBar").hidden = !isDirty(); }

/* --------------------------------- render -------------------------------------- */

function render() {
  const p = state.profile, s = state.pending;
  const hasDevice = !!state.active;
  const offline = hasDevice && !state.active.connected && !state.active.demo;

  $("#hero").hidden = !!s;
  $("#panels").hidden = !s;
  $("#panels").classList.toggle("offline", !s ? false : (!hasDevice || offline));
  if (!s) { renderHeader(); return; }

  // --- DPI card ---
  E.stageCountSeg.querySelectorAll("input").forEach(inp => inp.checked = +inp.value === s.stageCount);
  $("#ledLiftWrap").hidden = p.family !== "v2";
  if (p.family === "v2") $("#tglLedLift").checked = s.ledLiftoffDisabled;
  for (let i = 0; i < 4; i++) {
    // Stage-indicator LED colours are FIXED in firmware (CPI 1-4 = blue, green,
    // yellow, red) and do NOT match the RGB bytes stored in the config blob, so
    // they are hardcoded rather than read from s.stageColors (hardware-confirmed).
    const el = stageEls[i], st = s.stages[i], col = STAGE_COLORS[i];
    const on = i < s.stageCount;
    el.row.classList.toggle("inactive", !on);
    el.radio.checked = s.activeStage === i;
    el.radio.disabled = !on;
    el.sw.style.background = `rgb(${col[0]},${col[1]},${col[2]})`;
    el.x.min = p.cpiMin; el.x.max = p.cpiMax; el.x.step = p.cpiStepLo;
    el.y.min = p.cpiMin; el.y.max = p.cpiMax; el.y.step = p.cpiStepLo;
    setVal(el.x, st.x); setVal(el.y, st.y);
    el.y.hidden = el.sep.hidden = !state.uiSplit[i];
    el.splitBtn.classList.toggle("on", state.uiSplit[i]);
    el.x.disabled = el.y.disabled = !on;
  }

  // --- performance card ---
  const knownDiv = EGG_POLLING.some(o => o.div === s.pollingDivider);
  E.pollingSeg.querySelectorAll("input").forEach(inp => inp.checked = +inp.value === s.pollingDivider);
  E.pollingCustom.hidden = knownDiv;
  if (!knownDiv) E.pollingCustom.textContent =
    s.pollingDivider ? `custom: ${Math.round(8000 / s.pollingDivider)} Hz (divider ${s.pollingDivider})` : "custom: ?";
  const glassLock = !!p.lodGlass && s.glassMode; // divider left to firmware while glass is on
  E.pollingSeg.classList.toggle("locked", glassLock);
  E.pollingSeg.querySelectorAll("input").forEach(inp => inp.disabled = glassLock);

  const lodSel = $("#lodSelect");
  const lodList = eggLodList(p, s.glassMode);
  lodSel.textContent = "";
  lodList.forEach((label, i) => lodSel.append(h("option", { value: i }, label)));
  if (s.lodIndex >= lodList.length) {
    lodSel.append(h("option", { value: s.lodIndex }, `index ${s.lodIndex} (?)`));
  }
  lodSel.value = s.lodIndex;

  $("#tglMotionSync").checked = s.motionSync;
  $("#tglAngleSnap").checked = s.angleSnapping;
  $("#tglRipple").checked = s.rippleControl;
  $("#tglSlamclick").checked = s.slamclick;
  $("#tglJitter").checked = s.motionJitter;
  $("#v2Box").hidden = $("#angleRow").hidden = p.family !== "v2";
  if (p.family === "v2") {
    $("#tglGlass").checked = s.glassMode;
    $("#tglMaxFps").checked = s.forceMaxFps;
    setVal($("#rngAngle"), s.angleTuning);
    setVal($("#numAngle"), s.angleTuning);
  }

  // --- buttons card ---
  $("#tglLefty").checked = !!s.leftHanded;
  for (let slot = 0; slot < 7; slot++) {
    const el = btnEls[slot], ui = state.btnUI[slot], meta = slotMeta(slot);
    const a = ui.action;

    if (!meta.remap) {
      el.mapSel.hidden = true;
      el.fixedChip.hidden = false;
      el.fixedChip.textContent = a.key === "m_left" ? "Left Click (primary)" : "Custom mapping (preserved)";
    } else {
      el.mapSel.hidden = false;
      el.fixedChip.hidden = true;
      el.mapSel.value = a.key === "raw" ? "raw" : a.key;
    }

    const isKbd = meta.remap && a.key === "kbd";
    el.kbdChip.hidden = el.kbdEdit.hidden = !isKbd;
    if (isKbd) el.kbdChip.textContent = eggComboLabel(a.mods, a.usage);

    const isFixed = meta.remap && a.key === "cpi_fixed";
    el.fixedWrap.hidden = !isFixed;
    if (isFixed) {
      el.fx.min = el.fy.min = p.cpiMin; el.fx.max = el.fy.max = p.cpiMax;
      el.fx.step = el.fy.step = p.cpiStepLo;
      setVal(el.fx, a.x); setVal(el.fy, a.y);
      el.fy.hidden = state.linkedFixed[slot];
      el.flink.classList.toggle("on", !state.linkedFixed[slot]);
    }

    if (meta.mc) {
      const spdtOn = meta.spdt && ui.spdt !== "off";
      el.mcRange.value = ui.multiclick;
      el.mcOut.textContent = ui.multiclick;
      el.mcRange.disabled = spdtOn;
      el.mcRange.closest(".mc-wrap").classList.toggle("dim", spdtOn);
    }
    if (meta.spdt) el.spdtSel.value = ui.spdt;
  }

  renderHeader();
  markDirty();
}

function renderHeader() {
  const m = state.active, p = state.profile;
  const dot = $("#statusDot"), txt = $("#statusText");
  dot.className = "dot";
  if (!m) {
    txt.textContent = state.mice.length ? "select a device" : "no device";
  } else if (m.demo) {
    dot.classList.add("demo"); txt.textContent = `${p.name} - demo`;
  } else if (!m.connected) {
    dot.classList.add("err"); txt.textContent = `${p.name} - disconnected`;
  } else if (state.busy) {
    dot.classList.add("busy"); txt.textContent = `${p.name} - working...`;
  } else {
    dot.classList.add("ok"); txt.textContent = p.name;
  }

  const fw = $("#fwChip");
  fw.hidden = !(m && m.fwVersion);
  if (m && m.fwVersion) fw.textContent = "FW " + m.fwVersion;

  const sel = $("#deviceSelect");
  sel.hidden = state.mice.length < 2;
  if (!sel.hidden) {
    sel.textContent = "";
    state.mice.forEach((mm, i) => {
      const dup = state.mice.filter(o => o.profile.pid === mm.profile.pid).length > 1;
      const label = dup ? `${mm.profile.name} #${i + 1}` : mm.profile.name;
      sel.append(h("option", { value: i }, label));
    });
    sel.value = String(state.mice.indexOf(state.active));
  }

  $("#btnDemoStage").hidden = !(m && m.demo);
  const dis = !m || state.busy || (!m.connected && !m.demo);
  $("#btnReload").hidden = !m;
  $("#btnReset").hidden = !m;
  for (const id of ["#btnApply", "#btnReload", "#btnReset", "#btnExport", "#btnImport"]) $(id).disabled = dis;
  $("#btnForget").disabled = !m || m.demo;

  const headerBtn = $("#btnAdd");
  headerBtn.hidden = !m;
  headerBtn.textContent = "Disconnect";
  headerBtn.disabled = state.busy;
}

/* --------------------------- device management ---------------------------------- */

/* Full-blob dump (all 1041 bytes): the handedness mechanism appears to involve
 * state outside the documented 16..130 window, so nothing may be cropped away.
 * Runs of all-zero unchanged rows past the documented region are collapsed. */
function updateHexDump(blob) {
  const prev = state.prevHexBlob;
  let out = "        0  1  2  3  4  5  6  7  8  9  a  b  c  d  e  f\n";
  let skipping = false;
  for (let base = 0; base < blob.length; base += 16) {
    let line = "0x" + base.toString(16).padStart(4, "0") + "  ";
    let allZero = true, anyChg = false;
    for (let i = 0; i < 16 && base + i < blob.length; i++) {
      const v = blob[base + i];
      const chg = prev && prev[base + i] !== v;
      if (v !== 0) allZero = false;
      if (chg) anyChg = true;
      line += " " + hex2(v) + (chg ? "*" : " ");
    }
    if (allZero && !anyChg && base >= 144) {
      if (!skipping) { out += "        -- all zero --\n"; skipping = true; }
      continue;
    }
    skipping = false;
    out += line + "\n";
  }
  out += "(* = changed since previous read; offsets are absolute report offsets)";
  $("#hexDump").textContent = out;
  state.prevHexBlob = blob.slice();
}

function loadSettingsFromBlob(blob) {
  state.applied = eggParseConfig(blob);
  state.pending = structuredClone(state.applied);
  state.btnUI = SLOTS.map((_, i) => decodeButtonUI(i, state.applied));
  state.uiSplit = state.applied.stages.map(t => t.split || t.x !== t.y);
  state.linkedFixed = state.btnUI.map(u =>
    !(u.action.key === "cpi_fixed" && u.action.x !== u.action.y));
  state.lodMem = state.applied.glassMode ? 0 : state.applied.lodIndex;
  updateHexDump(blob);
}

async function activateMouse(mouse) {
  state.active = mouse;
  state.profile = mouse.profile;
  state.busy = true;
  $("#dbgWrap").hidden = false;
  renderHeader();
  try {
    const blob = await mouse.readConfig();
    loadSettingsFromBlob(blob);
    log(`config read OK from ${mouse.profile.name} (header ${[...blob.slice(0, 4)].map(hex2).join(" ")})`);
    if (!mouse.fwVersion) {
      try {
        const v = await mouse.readVersion();
        log(`firmware query -> ${v.text || "unrecognized"} (raw ${[...v.raw].map(hex2).join(" ")})`);
      } catch (e) { log("firmware query failed: " + e.message); }
    }
  } catch (e) {
    toast(`Could not read config from ${mouse.profile.name}: ${e.message} - full transaction log at the bottom of the page`,
      "error", 8000);
    log("config read failed: " + e.message);
    $("#dbg").open = true;
    state.applied = state.pending = null;
  } finally {
    state.busy = false;
    render();
  }
}

function wireMouseEvents(mouse) {
  mouse.addEventListener("stagechange", ev => {
    if (mouse !== state.active || !state.pending) return;
    state.applied.activeStage = ev.detail.stage;
    state.pending.activeStage = ev.detail.stage;
    render();
    stageEls[ev.detail.stage]?.row.animate(
      [{ background: "rgba(242,178,27,.25)" }, { background: "transparent" }], 600);
    log(`device event: active stage -> CPI ${ev.detail.stage + 1}`);
  });
  mouse.addEventListener("pollingchange", ev => {
    if (mouse !== state.active || !state.pending) return;
    state.applied.pollingDivider = ev.detail.divider;
    state.pending.pollingDivider = ev.detail.divider;
    render();
    const hz = ev.detail.divider ? Math.round(8000 / ev.detail.divider) : 0;
    toast(`Polling changed on device: ${hz} Hz`);
    log(`device event: polling -> divider ${ev.detail.divider} (${hz} Hz)`);
  });
  mouse.addEventListener("telemetry", ev => {
    log(`device event 0x${hex2(ev.detail.type)} value ${ev.detail.value}`);
  });
}

async function connectMouse(primary, siblings, score) {
  if (state.mice.some(m => m.primary === primary)) return;
  const profile = EGG_PROFILES[primary.productId];
  const mouse = new EggMouse(primary, siblings, profile);
  try {
    await mouse.open();
  } catch (e) {
    toast(`Could not open ${profile.name}: ${e.message} - on Linux, run the permission block on the front screen`,
      "error", 8000);
    log(`open failed for ${profile.name}: ${e.message}`);
    return;
  }
  mouse.onTrace = line => log(`hid: ${line}`);
  log(`interfaces for ${profile.name}:`);
  log(`  [primary] ${eggDescribeDevice(primary)}`);
  siblings.forEach((s, i) => log(`  [sibling ${i}] ${eggDescribeDevice(s)}`));
  log(`report payload sizes: cfg=${mouse._cfgLen} cmd=${mouse._cmdLen}`);
  if (score < 2) log("warning: no interface declares feature report 0xA0 - using best vendor collection");
  wireMouseEvents(mouse);
  state.mice.push(mouse);
  log(`connected ${profile.name} (PID 0x${profile.pid.toString(16)})`);
  toast(`Connected: ${profile.name}`, "ok");
  if (!state.active || (!state.active.connected && !state.active.demo)) {
    // replace a disconnected mouse of the same model transparently
    if (state.active) state.mice = state.mice.filter(m => m !== state.active);
    await activateMouse(mouse);
  } else {
    renderHeader();
  }
}

async function adoptGranted() {
  const devs = await navigator.hid.getDevices();
  const byPid = new Map();
  for (const d of devs) {
    if (d.vendorId !== EGG_VID || !EGG_PROFILES[d.productId]) continue;
    if (!byPid.has(d.productId)) byPid.set(d.productId, []);
    byPid.get(d.productId).push(d);
  }
  for (const group of byPid.values()) {
    // Primary = the interface that declares the 0xA0 config feature report (score 2),
    // falling back to any vendor collection; all other interfaces of the same mouse
    // ride along as siblings so the 0x03 event channel is caught wherever it lives.
    const scored = group.map(d => [eggDeviceScore(d), d]).sort((a, b) => b[0] - a[0]);
    if (scored[0][0] === 0) continue; // no usable vendor collection visible
    const primary = scored[0][1];
    await connectMouse(primary, group.filter(d => d !== primary), scored[0][0]);
  }
  updateHero();
}

async function requestNewDevice() {
  if (!("hid" in navigator)) return;
  const filters = Object.keys(EGG_PROFILES).map(pid => ({
    vendorId: EGG_VID, productId: +pid, usagePage: 0xFF01, usage: 0x02,
  }));
  try {
    await navigator.hid.requestDevice({ filters });
  } catch (e) {
    log("requestDevice: " + e.message);
    return;
  }
  await adoptGranted(); // requestDevice granted -> getDevices() now includes it
}

async function headerDeviceAction() {
  if (!state.active) return;
  await disconnectActiveDevice();
}

async function disconnectActiveDevice() {
  const m = state.active;
  if (!m) return;
  try { await m.close(); } catch (e) { log("disconnect: " + e.message); }
  state.mice = state.mice.filter(x => x !== m);
  state.active = null;
  state.profile = null;
  state.applied = state.pending = null;
  state.prevHexBlob = null;
  $("#dbg").open = false;
  $("#dbgWrap").hidden = true;
  const next = state.mice[0];
  if (next) await activateMouse(next); else { updateHero(); render(); }
}

function onHidDisconnect(dev) {
  const mouse = state.mice.find(m => m.primary === dev || m.siblings.includes(dev));
  if (!mouse) return;
  if (dev !== mouse.primary) return; // sibling interface going away is fine
  log(`${mouse.profile.name} disconnected`);
  toast(`${mouse.profile.name} disconnected - will reconnect automatically`, "warn");
  if (mouse !== state.active) state.mice = state.mice.filter(m => m !== mouse);
  render();
}

async function forgetDevice() {
  const m = state.active;
  if (!m || m.demo) return;
  if (!await confirmDlg(`Forget ${m.profile.name}? The browser permission is revoked; it will no longer auto-connect.`)) return;
  try { await m.close(); } catch (e) {}
  try { await m.primary.forget(); } catch (e) { log("forget: " + e.message); }
  state.mice = state.mice.filter(x => x !== m);
  state.active = null; state.profile = null;
  state.applied = state.pending = null;
  state.prevHexBlob = null;
  $("#dbg").open = false;
  $("#dbgWrap").hidden = true;
  const next = state.mice[0];
  if (next) await activateMouse(next); else { updateHero(); render(); }
}

function updateHero() {
  const linux = isLinuxDesktop();
  const hint = $("#heroHint");
  const connect = $("#btnHeroConnect");
  $("#linuxSetup").hidden = !linux;

  if (!navigator.hid) {
    hint.textContent = "Chromium-based browser required (e.g., Chrome, Edge, Opera).";
    hint.hidden = false;
    connect.disabled = true;
  } else if (!window.isSecureContext) {
    hint.textContent = "Serve this page from localhost or https to use WebHID.";
    hint.hidden = false;
    connect.disabled = true;
  } else {
    hint.textContent = "";
    hint.hidden = true;
    connect.disabled = false;
  }
}

async function copyUdevCommands() {
  try {
    const commands = $("#udevCommands").textContent;
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(commands);
    } else {
      const txt = h("textarea", {}, commands);
      txt.style.position = "fixed";
      txt.style.left = "-9999px";
      document.body.append(txt);
      txt.select();
      document.execCommand("copy");
      txt.remove();
    }
    toast("Linux setup commands copied", "ok");
  } catch (e) {
    toast("Could not copy commands: " + e.message, "error");
  }
}

/* ---------------------------- apply / device ops -------------------------------- */

async function withBusy(fn) {
  if (state.busy) return;
  state.busy = true;
  renderHeader();
  try { await fn(); }
  finally { state.busy = false; render(); }
}

async function apply() {
  const m = state.active;
  if (!m || !isDirty()) return;
  await withBusy(async () => {
    try {
      const written = { blob: null };
      const readBack = await m.transact(async mm => {
        const fresh = await mm.readRaw();                       // read-
        written.blob = eggSerializeConfig(fresh, state.pending, state.profile); // modify-
        await mm.writeRaw(written.blob);                        // write
        return await mm.readRaw();                              // verify
      });
      const diffs = [];
      for (let off = 2; off < readBack.length; off++) {   // full blob - canonicalization
        if (written.blob[off] !== readBack[off]) diffs.push(off);   // may land anywhere
      }
      if (diffs.length) {
        log("read-back differs at offsets: " + diffs.join(", ") +
            " - written->readback: " +
            diffs.slice(0, 24).map(o => `@${o} ${hex2(written.blob[o])}->${hex2(readBack[o])}`).join(" ") +
            (diffs.length > 24 ? " ..." : ""));
      }
      loadSettingsFromBlob(readBack);
      log("apply OK" + (diffs.length ? ` (${diffs.length} byte(s) canonicalized by device)` : ""));
      toast("Settings applied OK", "ok");
    } catch (e) {
      toast("Apply failed: " + e.message, "error", 6000);
      log("apply failed: " + e.message);
    }
  });
}

function discard() {
  if (!state.applied) return;
  state.pending = structuredClone(state.applied);
  state.btnUI = SLOTS.map((_, i) => decodeButtonUI(i, state.applied));
  state.uiSplit = state.applied.stages.map(t => t.split || t.x !== t.y);
  render();
}

async function reload() {
  const m = state.active;
  if (!m) return;
  await withBusy(async () => {
    try {
      const blob = await m.readConfig();
      loadSettingsFromBlob(blob);
      log("reloaded config from device");
      toast("Reloaded from mouse", "ok");
    } catch (e) {
      toast("Reload failed: " + e.message, "error");
    }
  });
}

async function factoryReset() {
  const m = state.active;
  if (!m) return;
  if (!await confirmDlg(
    `Factory-reset ${m.profile.name}? All on-device settings are reset immediately - there is no undo.`)) return;
  await withBusy(async () => {
    try {
      await m.factoryReset();
      log("factory reset acknowledged");
      const blob = await m.readConfig();
      loadSettingsFromBlob(blob);
      toast("Factory reset done", "ok");
    } catch (e) {
      toast("Factory reset failed: " + e.message, "error", 6000);
      log("factory reset failed: " + e.message);
    }
  });
}

/* ------------------------------ import / export -------------------------------- */

function exportJson() {
  if (!state.pending) return;
  const data = {
    app: "egg-8k-webconfig", version: 1,
    device: state.profile.name, pid: state.profile.pid,
    settings: state.pending,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = h("a", {
    href: URL.createObjectURL(blob),
    download: `egg-${state.profile.name.replace(/\s+/g, "_")}.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

function importJson(ev) {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file || !state.pending) return;
  file.text().then(txt => {
    const data = JSON.parse(txt);
    if (data.app !== "egg-8k-webconfig" || !data.settings) throw new Error("not an export of this app");
    const src = data.settings;
    const dst = state.pending;
    for (const k of ["pollingDivider", "slamclick", "motionJitter", "ledLiftoffDisabled", "lodIndex",
                     "angleSnapping", "rippleControl", "motionSync", "stageCount",
                     "glassMode", "angleTuning", "forceMaxFps"]) {
      if (k in src) dst[k] = src[k];
    }
    if ("leftHanded" in src) {          // pre-handedness exports leave 71-76 untouched
      dst.leftHanded = !!src.leftHanded;
      dst.handedSlot = dst.leftHanded && Array.isArray(src.handedSlot) && src.handedSlot.some(v => v)
        ? src.handedSlot.slice(0, 6).map(v => v & 255)
        : dst.leftHanded ? [0x00, 0x02, 0, 0, 0, 0]
                         : [0x00, 0x01, 0, 0, 0, 0]; // righty = fixed LEFT CLICK, never zeros
      dst.writeHanded = true;
    }
    if (Array.isArray(src.stages)) for (let i = 0; i < 4; i++) if (src.stages[i]) {
      const t = src.stages[i];
      dst.stages[i] = {
        split: !!t.split,
        x: eggClampCpi(state.profile, t.x),
        y: eggClampCpi(state.profile, t.y),
      };
    }
    if (Array.isArray(src.buttons)) for (let i = 0; i < 7; i++) if (src.buttons[i]) {
      const r = src.buttons[i];
      const rec = {
        ctl: r.ctl & 255, type: r.type & 255,
        params: (r.params || [0, 0, 0, 0, 0]).slice(0, 5).map(v => v & 255),
        writeCtl: SLOTS.some(meta => meta.ctlIndex === i && (meta.mc || meta.spdt)),
        writeMapping: SLOTS.some((_, si) => {
          const m = slotMeta(si, dst);
          return m.mapIndex === i && m.remap;
        }),
      };
      dst.buttons[i] = rec;
    }
    // left-handed: record 0 carries the fixed primary marker - always write it
    if (dst.leftHanded && dst.buttons[0]) dst.buttons[0].writeMapping = true;
    state.btnUI = SLOTS.map((_, i) => decodeButtonUI(i, dst));
    for (let i = 0; i < 7; i++) {
      const meta = slotMeta(i, dst), rec = meta.mapIndex == null ? null : dst.buttons[meta.mapIndex];
      if (rec && meta.remap && state.btnUI[i].action.key === "raw") rec.writeMapping = false;
    }
    if (dst.lodIndex >= eggLodList(state.profile, dst.glassMode).length) dst.lodIndex = 0;
    if (dst.activeStage >= dst.stageCount) dst.activeStage = dst.stageCount - 1;
    state.uiSplit = dst.stages.map(t => t.split || t.x !== t.y);
    render();
    toast(`Imported "${file.name}" - review and Apply`, "ok");
    if (data.pid !== state.profile.pid) {
      toast("Import came from a different model - values were re-clamped for this device", "warn", 6000);
    }
  }).catch(e => toast("Import failed: " + e.message, "error", 6000));
}

/* Bundle everything needed to debug protocol issues (handedness captures etc.)
 * into one clipboard paste: device identity, parsed handedness state, the hex
 * dump with change markers, and the transaction log tail. */
async function copyDebugInfo() {
  const m = state.active, p = state.profile, s = state.pending;
  const head = [
    "egg-8k-webconfig debug - " + new Date().toISOString(),
    m ? `device: ${p.name} (PID 0x${p.pid.toString(16)}), FW ${m.fwVersion || "?"}${m.demo ? ", demo mode" : ""}`
      : "device: none",
    s ? `leftHanded=${!!s.leftHanded}  handedSlot@71..76=[${(s.handedSlot || []).map(hex2).join(" ")}]`
      : "no settings loaded",
  ].join("\n");
  const text = head +
    "\n\n== config hex dump ==\n" + $("#hexDump").textContent +
    "\n\n== log tail ==\n" + $("#logPre").textContent.split("\n").slice(-60).join("\n");
  try {
    await navigator.clipboard.writeText(text);
    toast("Debug info copied - paste it wherever needed", "ok");
  } catch (e) {
    toast("Clipboard unavailable - select and copy the Debug text manually", "error");
  }
}

/* -------------------------------- dialogs -------------------------------------- */

let keyResolve = null;
function captureKey() {
  return new Promise(res => {
    keyResolve = res;
    $("#keyPreview").textContent = "...";
    $("#dlgKey").showModal();
  });
}
function keyDone(v) {
  $("#dlgKey").close();
  const r = keyResolve; keyResolve = null;
  if (r) r(v);
}
function modsFromEvent(e) {
  return (e.ctrlKey ? 1 : 0) | (e.shiftKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
}
function wireKeyDialog() {
  const dlg = $("#dlgKey");
  dlg.addEventListener("keydown", e => {
    e.preventDefault();
    e.stopPropagation();
    if (e.code === "Escape") { keyDone(null); return; }
    if (/^(Control|Shift|Alt|Meta)/.test(e.code)) {
      $("#keyPreview").textContent = eggComboLabel(modsFromEvent(e), null);
      return;
    }
    const k = EGG_KEY_BY_CODE.get(e.code);
    if (!k) { $("#keyPreview").textContent = `Unsupported key (${e.code})`; return; }
    keyDone({ mods: modsFromEvent(e), usage: k.usage });
  });
  dlg.addEventListener("cancel", e => { e.preventDefault(); keyDone(null); });
  $("#keyEsc").addEventListener("click", () => keyDone({ mods: 0, usage: 0x29 }));
  $("#keyCancel").addEventListener("click", () => keyDone(null));
}

function confirmDlg(text) {
  return new Promise(res => {
    const dlg = $("#dlgConfirm");
    $("#confirmText").textContent = text;
    const ok = $("#confirmOk"), cancel = $("#confirmCancel");
    const done = v => { dlg.close(); ok.onclick = cancel.onclick = dlg.oncancel = null; res(v); };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    dlg.oncancel = e => { e.preventDefault(); done(false); };
    dlg.showModal();
  });
}

/* -------------------------------- demo mode ------------------------------------ */

function demoDefaultBlob(profile) {
  const b = new Uint8Array(EGG_CFG_LEN);
  b[0] = EGG_REPORT.CFG; b[1] = 0x01;
  b[EGG_OFF.POLLING] = 8;
  b[EGG_OFF.LED_LIFTOFF] = 1;
  b[EGG_OFF.LOD] = profile.family === "v2" ? 3 : 1; // 1.0 mm either way
  b[EGG_OFF.MOTION_SYNC] = 1;
  b[EGG_OFF.HANDED + 1] = 0x01; // factory right-handed: Left slot = plain LEFT CLICK
  b[EGG_OFF.ACTIVE_STAGE] = 1;
  b[EGG_OFF.STAGE_COUNT] = 4;
  const cpis = [400, 800, 1600, 3200];
  for (let i = 0; i < 4; i++) {
    const c = EGG_OFF.COLORS + i * 5;
    b[c] = STAGE_COLORS[i][0]; b[c + 1] = STAGE_COLORS[i][1];
    b[c + 2] = STAGE_COLORS[i][2]; b[c + 3] = 1; b[c + 4] = i + 1;
    const p = EGG_OFF.STAGES + i * 5;
    b[p + 1] = cpis[i] & 255; b[p + 2] = cpis[i] >> 8;
    b[p + 3] = cpis[i] & 255; b[p + 4] = cpis[i] >> 8;
  }
  const btns = [
    [8, 0, 2],      // Left ctl, Right mapping
    [8, 0, 4],      // Right ctl, Middle mapping
    [8, 0, 16],     // Middle ctl, Forward mapping
    [8, 0, 8],      // Forward ctl, Back mapping
    [8, 9, 0xF1],   // Back ctl, preserved CPI-loop mapping slot
    [0, 1, 1],
    [0, 1, 0xFF],
  ];
  btns.forEach((v, i) => {
    const o = EGG_OFF.BUTTONS + i * 7;
    b[o] = v[0]; b[o + 1] = v[1]; b[o + 2] = v[2];
  });
  return b;
}

class FakeMouse extends EventTarget {
  constructor(profile) {
    super();
    this.profile = profile;
    this.demo = true;
    this.primary = { productId: profile.pid, opened: true };
    this.siblings = [];
    this.lastBlob = demoDefaultBlob(profile);
    this.fwVersion = profile.family === "v2" ? "V1.07" : "V1.12";
  }
  get connected() { return true; }
  async open() {}
  async close() {}
  transact(fn) { return Promise.resolve(fn(this)); }
  async readRaw() { await eggSleep(60); const b = this.lastBlob.slice(); b[1] = 0x01; return b; }
  async writeRaw(blob) { await eggSleep(120); this.lastBlob = blob.slice(); }
  readConfig() { return this.readRaw(); }
  async setActiveStage(i) { this.lastBlob[EGG_OFF.ACTIVE_STAGE] = i & 3; await eggSleep(80); }
  async factoryReset() { await eggSleep(400); this.lastBlob = demoDefaultBlob(this.profile); }
  async readVersion() { return { text: this.fwVersion, raw: new Uint8Array(16) }; }
}

function demoPressDpi() {
  const m = state.active;
  if (!m || !m.demo) return;
  const n = Math.max(1, m.lastBlob[EGG_OFF.STAGE_COUNT]);
  const next = (m.lastBlob[EGG_OFF.ACTIVE_STAGE] + 1) % n;
  m.lastBlob[EGG_OFF.ACTIVE_STAGE] = next;
  m.dispatchEvent(new CustomEvent("stagechange", { detail: { stage: next } }));
}

/* ---------------------------------- boot ---------------------------------------- */

async function boot() {
  buildUI();
  wireKeyDialog();
  updateHero();

  const params = new URLSearchParams(location.search);
  const demo = params.get("demo");
  if (demo) {
    const pid = { v1: 0x1964, xm2: 0x1966, purple: 0x1976, v2: 0x1978, xm2v2: 0x1980 }[demo] || 0x1978;
    const mouse = new FakeMouse(EGG_PROFILES[pid]);
    wireMouseEvents(mouse);
    state.mice.push(mouse);
    log(`demo mode: simulating ${mouse.profile.name}`);
    await activateMouse(mouse);
    if (params.has("selftest")) { // demo-only automation hooks
      window.__EGG_DEBUG = { state, apply, render };
      document.body.append(h("script", { src: "test/selftest.js" }));
    }
    return;
  }

  if (!navigator.hid || !window.isSecureContext) return;

  navigator.hid.addEventListener("connect", () => { adoptGranted(); });
  navigator.hid.addEventListener("disconnect", ev => onHidDisconnect(ev.device));
  await adoptGranted(); // auto-connect to every previously-authorized mouse
}

document.addEventListener("DOMContentLoaded", boot);

})();
