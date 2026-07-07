"use strict";
/*
 * HID transport + config-blob codec for the Endgame Gear 8k series.
 *
 * All offsets are ABSOLUTE report offsets (byte 0 = the report ID), exactly as in
 * notes/OP1_8k_v2_USB_Protocol.md section 3 - the universal layout for both families.
 * WebHID's sendFeatureReport() takes the payload WITHOUT the report-ID byte.
 * receiveFeatureReport() is less consistent for these mice: short 0xA1 reports are
 * returned as payload-only, but full config reads can arrive with byte 0 as a
 * zero placeholder, 0xA0, or 0xA1 and byte 1 holding status. eggNormalizeFeature()
 * pins every variant to the "byte 0 = report ID, byte 1 = status" shape so the
 * doc offsets apply 1:1.
 */

/* node interop (tests only): pull profiles.js symbols into the global scope the same
 * way the browser's classic-script loading order does. */
if (typeof module !== "undefined" && typeof globalThis.eggClampCpi === "undefined") {
  Object.assign(globalThis, require("./profiles.js"));
}

const EGG_REPORT = { CFG: 0xA0, CMD: 0xA1, EVT: 0x03 };
const EGG_CFG_LEN = 1041; // incl. report-ID byte (Windows HID convention, as documented)
const EGG_CMD_LEN = 64;
const EGG_OP = { STORE: 0x11, LOAD: 0x12, RESET: 0x13, VERSION: 0x02 };

const EGG_OFF = {
  POLLING: 21,        // divider; Hz = 8000/divider
  FILTERS: 22,        // bit0 Slamclick, bit4 Motion Jitter (preserve other bits)
  LED_LIFTOFF: 24,    // V2 only; INVERTED: byte = NOT(checkbox "disable LED on lift-off")
  LOD: 25,            // list index (family-specific list)
  ANGLE_SNAP: 26,
  RIPPLE: 27,
  MOTION_SYNC: 28,
  ACTIVE_STAGE: 29,   // 0..3, instant-write path
  STAGE_COUNT: 30,    // 1..4
  COLORS: 31,         // 4 x {R,G,B,enable,stage#}
  STAGES: 51,         // 4 x {split, X u16 LE, Y u16 LE}
  HANDED: 71,         // 6-byte {type, params[5]} mapping slot for physical Left (section 4.6.1).
                      // Hardware-verified (OP1 8k v2 FW V1.07, official-tool capture):
                      // right-handed = 00 01 (plain LEFT CLICK); left-handed = Left's
                      // user action here with record 0 = 00 01. All-zero DISABLES Left.
  BUTTONS: 77,        // 7 x 7-byte records
  GLASS: 127,         // sensor capability (v2 mice + Purple Frost); gated on profile.lodGlass, not family
  ANGLE_TUNE: 128,    // V2 only, int8 -127..+127
  MAX_FPS: 129,       // V2 only
  MC_MASTER: 130,     // in the V2 layout; not surfaced by this app - preserved on writes
};

const EGG_STATUS = { OK: 0x01, BUSY: 0x03 };

function eggSleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function eggHex(n) { return n.toString(16).padStart(2, "0"); }

function eggTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(what + " timed out")), ms)),
  ]);
}

function eggIsVendorCollection(c) { return c.usagePage === 0xFF01 && c.usage === 0x02; }

function eggHexBytes(u, n) {
  return Array.from(u.slice(0, n)).map(eggHex).join(" ");
}

function eggIsConfigStructFrame(u, payloadLen) {
  return payloadLen === EGG_CFG_LEN - 1 &&
         u.length === payloadLen &&
         (u[0] === 0x00 || u[0] === EGG_REPORT.CFG || u[0] === EGG_REPORT.CMD) &&
         (u[1] === EGG_STATUS.OK || u[1] === EGG_STATUS.BUSY);
}

function eggFormatVersionBytes(buf) {
  for (const off of [17, 16, 18, 2, 4, 6]) {
    const patch = buf[off], major = buf[off + 1];
    if (major >= 1 && major <= 9 && patch <= 99) {
      return "V" + major + "." + String(patch).padStart(2, "0");
    }
  }
  for (const off of [17, 16, 18, 2, 4, 6]) {
    const v = buf[off] | (buf[off + 1] << 8);
    if (v >= 50 && v <= 5000) return "V" + (v / 100).toFixed(2);
  }
  return null;
}

/* Human-readable summary of an interface's collections & declared report IDs -
 * logged at connect so protocol problems can be diagnosed from the debug panel. */
function eggDescribeDevice(dev) {
  const ids = rs => (rs || []).map(r => "0x" + eggHex(r.reportId)).join(",") || "-";
  return (dev.collections || []).map(c =>
    `page=0x${c.usagePage.toString(16)}/usage=0x${c.usage.toString(16)}` +
    ` in[${ids(c.inputReports)}] out[${ids(c.outputReports)}] feat[${ids(c.featureReports)}]`
  ).join("  ;  ") || "(no collections visible)";
}

/* Interface preference: 2 = vendor collection that declares feature report 0xA0
 * (the real config surface), 1 = vendor collection, 0 = not usable as primary. */
function eggDeviceScore(dev) {
  let score = 0;
  for (const c of dev.collections || []) {
    if (!eggIsVendorCollection(c)) continue;
    score = Math.max(score, 1);
    if ((c.featureReports || []).some(r => r.reportId === EGG_REPORT.CFG)) score = 2;
  }
  return score;
}

/* Payload length (without report ID) declared by the descriptor for a feature report;
 * falls back to the documented size if the descriptor is unavailable. */
function eggFeaturePayloadLen(dev, reportId, fallback) {
  for (const c of dev.collections || []) {
    for (const r of c.featureReports || []) {
      if (r.reportId !== reportId) continue;
      let bits = 0;
      for (const it of r.items || []) bits += (it.reportSize || 0) * (it.reportCount || 0);
      if (bits > 0) return Math.ceil(bits / 8);
    }
  }
  return fallback;
}

/* Normalize a received feature report to a buffer where buf[0] === reportId,
 * padded to expectTotal bytes. Whether the platform includes the leading report-ID
 * byte differs. Full config frames on Chrome can also be returned in struct shape
 * (`00 01 ...`, `a0 01 ...`, or `a1 01 ...`) rather than report-payload shape
 * (`01 ...`), so preserve their field offsets and replace only byte 0. */
function eggNormalizeFeature(dv, reportId, expectTotal, payloadLen) {
  let u = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  if (expectTotal === EGG_CFG_LEN && eggIsConfigStructFrame(u, payloadLen)) {
    const t = new Uint8Array(expectTotal);
    t.set(u);
    t[0] = reportId;
    return t;
  }
  let includesId;
  if (payloadLen && u.length === payloadLen) includesId = false;
  else if (payloadLen && u.length === payloadLen + 1 && u[0] === reportId) includesId = true;
  else includesId = !!(u.length && u[0] === reportId);
  if (!includesId) {
    const t = new Uint8Array(u.length + 1);
    t[0] = reportId; t.set(u, 1);
    u = t;
  }
  if (u.length < expectTotal) {
    const t = new Uint8Array(expectTotal);
    t.set(u);
    u = t;
  }
  return u;
}

/* ------------------------------- transport ------------------------------------ */

class EggMouse extends EventTarget {
  /**
   * @param {HIDDevice} primary  interface with the vendor collection (0xFF01/0x02)
   * @param {HIDDevice[]} siblings  other interfaces of the same physical mouse -
   *        opened opportunistically so the 0x03 event channel is caught wherever it lives
   * @param {object} profile  entry from EGG_PROFILES
   */
  constructor(primary, siblings, profile) {
    super();
    this.primary = primary;
    this.siblings = siblings || [];
    this.profile = profile;
    this.lastBlob = null;     // last blob read from / written to the device (incl. ID byte)
    this.fwVersion = null;
    this.demo = false;
    this._chain = Promise.resolve();
    this._onReport = this._onReport.bind(this);
    this._cfgLen = EGG_CFG_LEN - 1;
    this._cmdLen = EGG_CMD_LEN - 1;
  }

  get connected() { return this.primary.opened; }

  async open() {
    if (!this.primary.opened) await this.primary.open();
    this.primary.addEventListener("inputreport", this._onReport);
    for (const s of this.siblings) {
      try {
        if (!s.opened) await s.open();
        s.addEventListener("inputreport", this._onReport);
      } catch (e) {
        /* protected/busy interface - events usually arrive on the primary anyway */
      }
    }
    this._cfgLen = eggFeaturePayloadLen(this.primary, EGG_REPORT.CFG, EGG_CFG_LEN - 1);
    this._cmdLen = eggFeaturePayloadLen(this.primary, EGG_REPORT.CMD, EGG_CMD_LEN - 1);
  }

  async close() {
    this.primary.removeEventListener("inputreport", this._onReport);
    try { await this.primary.close(); } catch (e) {}
    for (const s of this.siblings) {
      s.removeEventListener("inputreport", this._onReport);
      try { await s.close(); } catch (e) {}
    }
  }

  _onReport(e) {
    if (e.reportId !== EGG_REPORT.EVT) return;
    const type = e.data.byteLength > 0 ? e.data.getUint8(0) : 0;
    const value = e.data.byteLength > 1 ? e.data.getUint8(1) : 0;
    if (type === 0x02) {            // active DPI stage changed on-device
      if (this.lastBlob) this.lastBlob[EGG_OFF.ACTIVE_STAGE] = value & 3;
      this.dispatchEvent(new CustomEvent("stagechange", { detail: { stage: value & 3 } }));
    } else if (type === 0x06) {     // polling rate changed on-device
      if (this.lastBlob) this.lastBlob[EGG_OFF.POLLING] = value;
      this.dispatchEvent(new CustomEvent("pollingchange", { detail: { divider: value } }));
    } else {
      this.dispatchEvent(new CustomEvent("telemetry", { detail: { type, value } }));
    }
  }

  /* All HID transactions are funnelled through one promise chain so feature-report
   * request/response pairs never interleave. */
  _run(fn) {
    const p = this._chain.then(fn);
    this._chain = p.catch(() => {});
    return p;
  }
  transact(fn) { return this._run(() => fn(this)); }

  /* Optional diagnostic sink; the app points this at the debug log. */
  _trace(msg) { if (this.onTrace) try { this.onTrace(msg); } catch (e) {} }

  async _sendCmd(op) {
    const buf = new Uint8Array(this._cmdLen);
    buf[0] = op;
    await this.primary.sendFeatureReport(EGG_REPORT.CMD, buf);
  }

  async _recvFeature(reportId, expectTotal, payloadLen) {
    const dv = await eggTimeout(
      this.primary.receiveFeatureReport(reportId), 3000, `GetFeature 0x${eggHex(reportId)}`);
    return { buf: eggNormalizeFeature(dv, reportId, expectTotal, payloadLen), rawLen: dv.byteLength };
  }

  _payloadLenFor(reportId) {
    return reportId === EGG_REPORT.CFG ? this._cfgLen : this._cmdLen;
  }

  /* Poll a feature report until `accept` passes (default: status byte [1] == 0x01,
   * the short-ack convention). The device may transiently report busy or serve a
   * stale frame right after a command, so every rejected poll is retried with
   * back-off and traced. */
  async _pollOk(reportId, expectTotal, polls, what, trace, accept) {
    const ok = accept || (buf => buf[1] === EGG_STATUS.OK);
    let delay = 60;
    for (let poll = 0; poll < polls; poll++) {
      const { buf, rawLen } = await this._recvFeature(reportId, expectTotal, this._payloadLenFor(reportId));
      if (ok(buf, rawLen)) return buf;
      const line = `${what} poll ${poll}: len=${rawLen} [${eggHexBytes(buf, 8)} ...] stages=${buf[EGG_OFF.STAGE_COUNT]}`;
      trace.push(line);
      this._trace(line);
      await eggSleep(delay);
      delay = Math.min(delay * 2, 400);
    }
    return null;
  }

  /* Structural validation of a config-blob frame. The blob's status byte alone is
   * not trustworthy (stale ack frames also carry 0x01), so a frame is accepted only
   * when its fields are plausible - which safely rejects the near-all-zero acks. */
  _blobOk(buf, rawLen) {
    if (rawLen < 131) return false;
    const stages = buf[EGG_OFF.STAGE_COUNT];
    const cpi1 = buf[EGG_OFF.STAGES + 1] | (buf[EGG_OFF.STAGES + 2] << 8);
    return buf[1] === EGG_STATUS.OK &&
           stages >= 1 && stages <= 4 &&
           buf[EGG_OFF.ACTIVE_STAGE] <= 3 &&
           buf[EGG_OFF.POLLING] >= 1 && buf[EGG_OFF.POLLING] <= 64 &&
           cpi1 >= 10 && cpi1 <= 30000;
  }

  /* Unqueued primitives - use only inside transact(). */

  async readRaw() {
    const trace = [];
    /* Read flow: after the 0x12 load command, firmware/Chrome combinations have
     * been observed serving the full 1040-byte config response on either 0xA1 or
     * 0xA0. Probe both without discarding the 0xA1 frame: a short ack is rejected
     * structurally, while a full blob is accepted and canonicalized to report 0xA0. */
    for (let round = 0; round < 3; round++) {
      await this._sendCmd(EGG_OP.LOAD);
      await eggSleep(80);
      let delay = 60;
      for (let poll = 0; poll < 6; poll++) {
        for (const reportId of [EGG_REPORT.CMD, EGG_REPORT.CFG]) {
          const { buf, rawLen } = await this._recvFeature(reportId, EGG_CFG_LEN, this._cfgLen);
          if (this._blobOk(buf, rawLen)) {
            buf[0] = EGG_REPORT.CFG;
            this.lastBlob = buf;
            return buf.slice();
          }
          const line = `read r${round} GET(0x${eggHex(reportId)}) poll ${poll}: ` +
            `len=${rawLen} [${eggHexBytes(buf, 8)} ...] stages=${buf[EGG_OFF.STAGE_COUNT]}`;
          trace.push(line);
          this._trace(line);
        }
        await eggSleep(delay);
        delay = Math.min(delay * 2, 400);
      }
      this._trace(`read round ${round} exhausted - re-sending load command`);
    }
    throw new Error(
      `config read failed - no valid blob frame. Last headers: ${trace.slice(-3).join(" | ")}`);
  }

  async writeRaw(blob) {
    const payload = new Uint8Array(this._cfgLen);
    payload.set(blob.subarray(1, 1 + Math.min(blob.length - 1, this._cfgLen)));
    payload[0] = EGG_OP.STORE;
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await this.primary.sendFeatureReport(EGG_REPORT.CFG, payload);
        lastErr = null;
        break;
      } catch (e) { lastErr = e; await eggSleep(50); }
    }
    if (lastErr) throw lastErr;
    await eggSleep(300);
    const trace = [];
    const st = await this._pollOk(EGG_REPORT.CMD, EGG_CMD_LEN, 8, "write-ack", trace);
    if (!st) {
      throw new Error(`write not acknowledged. Last headers: ${trace.slice(-3).join(" | ")}`);
    }
    const b = blob.slice();
    b[1] = EGG_OP.STORE;
    this.lastBlob = b;
  }

  /* Queued public operations. */

  readConfig() { return this._run(() => this.readRaw()); }
  writeConfig(blob) { return this._run(() => this.writeRaw(blob)); }

  /* Instant stage switch: fresh read -> change byte 29 only -> write (no UI regather),
   * mirroring the official tool's no-Apply stage path (V2 doc section 4.3.1). */
  setActiveStage(stage) {
    return this._run(async () => {
      const blob = await this.readRaw();
      blob[EGG_OFF.ACTIVE_STAGE] = stage & 3;
      blob[1] = EGG_OP.STORE;
      await this.writeRaw(blob);
    });
  }

  factoryReset() {
    return this._run(async () => {
      await this._sendCmd(EGG_OP.RESET);
      await eggSleep(1100);
      const trace = [];
      const st = await this._pollOk(EGG_REPORT.CMD, EGG_CMD_LEN, 8, "reset-ack", trace);
      if (!st) {
        throw new Error(`factory reset not acknowledged. Last headers: ${trace.slice(-3).join(" | ")}`);
      }
    });
  }

  /* Firmware version: the hardware response observed on OP1 8k v2 stores patch/major
   * around offsets 17/18 (07 01 => V1.07), matching the unofficial hidapi client.
   * Keep a fixed-point fallback for older notes/tools that treated this as raw/100. */
  readVersion() {
    return this._run(async () => {
      await this._sendCmd(EGG_OP.VERSION);
      await eggSleep(50);
      const trace = [];
      let st = await this._pollOk(EGG_REPORT.CMD, EGG_CMD_LEN, 4, "version", trace);
      if (!st) st = (await this._recvFeature(EGG_REPORT.CMD, EGG_CMD_LEN, this._cmdLen)).buf; // best effort
      this.fwVersion = eggFormatVersionBytes(st);
      return { text: this.fwVersion, raw: st.slice(0, 20) };
    });
  }
}

/* ------------------------------ blob codec ------------------------------------- */

function eggParseConfig(blob) {
  const b = blob;
  const s = {};
  s.pollingDivider = b[EGG_OFF.POLLING];
  s.slamclick = !!(b[EGG_OFF.FILTERS] & 0x01);
  s.motionJitter = !!(b[EGG_OFF.FILTERS] & 0x10);
  s.ledLiftoffDisabled = b[EGG_OFF.LED_LIFTOFF] === 0; // inverted storage
  s.lodIndex = b[EGG_OFF.LOD];
  s.angleSnapping = !!b[EGG_OFF.ANGLE_SNAP];
  s.rippleControl = !!b[EGG_OFF.RIPPLE];
  s.motionSync = !!b[EGG_OFF.MOTION_SYNC];
  s.activeStage = Math.min(b[EGG_OFF.ACTIVE_STAGE], 3);
  s.stageCount = Math.min(Math.max(b[EGG_OFF.STAGE_COUNT], 1), 4);
  s.stageColors = [];
  s.stages = [];
  for (let i = 0; i < 4; i++) {
    const c = EGG_OFF.COLORS + i * 5;
    s.stageColors.push({ r: b[c], g: b[c + 1], b: b[c + 2], enabled: !!b[c + 3] });
    const p = EGG_OFF.STAGES + i * 5;
    s.stages.push({
      split: !!b[p],
      x: b[p + 1] | (b[p + 2] << 8),
      y: b[p + 3] | (b[p + 4] << 8),
    });
  }
  s.buttons = [];
  for (let i = 0; i < 7; i++) {
    const o = EGG_OFF.BUTTONS + i * 7;
    s.buttons.push({
      ctl: b[o],
      type: b[o + 1],
      params: [b[o + 2], b[o + 3], b[o + 4], b[o + 5], b[o + 6]],
    });
  }
  // Handedness (section 4.6.1, hardware-verified): 71-76 is physical Left's mapping slot.
  // Right-handed <=> it holds the plain LEFT CLICK (00 01 00 00 00 00) - the exact
  // rule the official tool uses. All-zero is also treated as right-handed: it is
  // a broken "Left disabled" state some writes leave behind, never a lefty one.
  const ho = EGG_OFF.HANDED;
  s.handedSlot = [b[ho], b[ho + 1], b[ho + 2], b[ho + 3], b[ho + 4], b[ho + 5]];
  const hsPlainLeft = b[ho] === 0x00 && b[ho + 1] === 0x01 &&
    !(b[ho + 2] | b[ho + 3] | b[ho + 4] | b[ho + 5]);
  s.leftHanded = !hsPlainLeft && s.handedSlot.some(v => v !== 0);
  s.glassMode = !!b[EGG_OFF.GLASS];
  s.angleTuning = b[EGG_OFF.ANGLE_TUNE] > 127 ? b[EGG_OFF.ANGLE_TUNE] - 256 : b[EGG_OFF.ANGLE_TUNE];
  s.forceMaxFps = !!b[EGG_OFF.MAX_FPS];
  return s;
}

/*
 * Serialize settings onto a freshly-read base blob (read-modify-write golden rule,
 * multi-device doc section 4.6): only the bytes this app manages are touched; reserved,
 * unknown and family-foreign bytes ride through untouched. Per-button records honour
 * writeCtl / writeMapping flags so un-decoded ("raw") mappings and non-editable slots
 * are preserved byte-for-byte.
 */
function eggSerializeConfig(base, s, profile) {
  const out = new Uint8Array(EGG_CFG_LEN);
  out.set(base.subarray(0, Math.min(base.length, EGG_CFG_LEN)));
  out[0] = EGG_REPORT.CFG;
  out[1] = EGG_OP.STORE;

  const div = s.pollingDivider | 0;
  if (div >= 1 && div <= 255) out[EGG_OFF.POLLING] = div;
  out[EGG_OFF.FILTERS] = (out[EGG_OFF.FILTERS] & ~0x11)
    | (s.slamclick ? 0x01 : 0) | (s.motionJitter ? 0x10 : 0);
  out[EGG_OFF.LOD] = s.lodIndex & 0xFF;
  out[EGG_OFF.ANGLE_SNAP] = s.angleSnapping ? 1 : 0;
  out[EGG_OFF.RIPPLE] = s.rippleControl ? 1 : 0;
  out[EGG_OFF.MOTION_SYNC] = s.motionSync ? 1 : 0;

  const n = Math.min(4, Math.max(1, s.stageCount | 0));
  out[EGG_OFF.STAGE_COUNT] = n;
  out[EGG_OFF.ACTIVE_STAGE] = Math.min(n - 1, Math.max(0, s.activeStage | 0));

  for (let i = 0; i < 4; i++) {
    // Indicator colours are fixed in firmware (blue/green/yellow/red for stages
    // 1-4). RGB, enable and index bytes ride through untouched.
    const c = EGG_OFF.COLORS + i * 5;
    const st = s.stages[i], p = EGG_OFF.STAGES + i * 5;
    const x = eggClampCpi(profile, st.x);
    const y = st.split ? eggClampCpi(profile, st.y) : x;
    out[p] = x !== y ? 1 : 0; // wire flag means "X and Y differ"
    out[p + 1] = x & 0xFF;
    out[p + 2] = (x >> 8) & 0xFF;
    out[p + 3] = y & 0xFF;
    out[p + 4] = (y >> 8) & 0xFF;
  }

  for (let i = 0; i < 7; i++) {
    const rec = s.buttons[i];
    if (!rec) continue;
    const o = EGG_OFF.BUTTONS + i * 7;
    if (rec.writeCtl) out[o] = rec.ctl & 0xFF;
    if (rec.writeMapping) {
      out[o + 1] = rec.type & 0xFF;
      for (let k = 0; k < 5; k++) out[o + 2 + k] = (rec.params[k] || 0) & 0xFF;
    }
  }

  // Handedness slot (section 4.6.1, hardware-verified): written only when the user
  // changed handedness or remapped Left in left-handed mode (writeHanded).
  // Right-handed: always the plain LEFT CLICK (00 01) - never zeros, which
  // would disable the Left button. Left-handed: Left's user action.
  if (s.writeHanded) {
    let hs = s.leftHanded && Array.isArray(s.handedSlot) && s.handedSlot.some(v => v)
      ? s.handedSlot
      : s.leftHanded ? [0x00, 0x02, 0, 0, 0, 0]   // lefty fallback: Right Click
                     : [0x00, 0x01, 0, 0, 0, 0];  // righty: fixed LEFT CLICK
    for (let k = 0; k < 6; k++) out[EGG_OFF.HANDED + k] = (hs[k] || 0) & 0xFF;
  }

  // Glass mode is a sensor capability (PAW3950, v2 mice + Purple Frost's generic
  // part) - independent of the MCU-level v2-only features below.
  if (profile.lodGlass) out[EGG_OFF.GLASS] = s.glassMode ? 1 : 0;

  if (profile.family === "v2") {
    out[EGG_OFF.LED_LIFTOFF] = s.ledLiftoffDisabled ? 0 : 1; // inverted storage
    out[EGG_OFF.ANGLE_TUNE] = Math.max(-127, Math.min(127, s.angleTuning | 0)) & 0xFF;
    out[EGG_OFF.MAX_FPS] = s.forceMaxFps ? 1 : 0;
  }
  return out;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    EGG_REPORT, EGG_CFG_LEN, EGG_CMD_LEN, EGG_OP, EGG_OFF, EGG_STATUS,
    eggSleep, eggHex, eggHexBytes, eggIsVendorCollection,
    eggIsConfigStructFrame, eggFormatVersionBytes, eggDescribeDevice, eggDeviceScore,
    eggFeaturePayloadLen, eggNormalizeFeature, EggMouse,
    eggParseConfig, eggSerializeConfig,
  };
}
