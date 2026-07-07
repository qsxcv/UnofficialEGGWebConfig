"use strict";
/*
 * Offline sanity tests for the blob codec, CPI clamps and action encoders.
 * Run with:  node test/roundtrip.js
 */
const P = require("../profiles.js");
const T = require("../protocol.js");

let failures = 0;
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { console.log("  ok  " + what); }
  else { failures++; console.error(`FAIL  ${what}\n      expected ${e}\n      got      ${a}`); }
}

const V1 = P.EGG_PROFILES[0x1964];
const PURPLE = P.EGG_PROFILES[0x1976];
const V2 = P.EGG_PROFILES[0x1978];

/* ------------------------- CPI clamp (doc section 5.4) -------------------------------- */
console.log("CPI clamps:");
eq(P.eggClampCpi(V1, 1), 50, "V1 min clamp 1->50");
eq(P.eggClampCpi(V1, 74), 50, "V1 round-half-up 74->50 (r=24)");
eq(P.eggClampCpi(V1, 75), 100, "V1 round-half-up 75->100 (r=25)");
eq(P.eggClampCpi(V1, 25999), 26000, "V1 26000 ceiling round");
eq(P.eggClampCpi(V1, 99999), 26000, "V1 max clamp");
eq(P.eggClampCpi(PURPLE, 99999), 30000, "Purple max 30000");
eq(P.eggClampCpi(V2, 4), 10, "V2 min clamp 4->10");
eq(P.eggClampCpi(V2, 9995), 10000, "V2 step-10 round 9995->10000");
eq(P.eggClampCpi(V2, 10024), 10000, "V2 step-50 above 10k, 10024->10000");
eq(P.eggClampCpi(V2, 10025), 10050, "V2 step-50 above 10k, 10025->10050");
eq(P.eggClampCpi(V2, 1604), 1600, "V2 step-10 round 1604->1600");
eq(P.eggClampCpi(V2, 1605), 1610, "V2 step-10 round 1605->1610");
eq(P.eggClampCpi(V2, 30001), 30000, "V2 max clamp");

/* --------------------- action encode/decode round trip ------------------------- */
console.log("Actions:");
for (const g of P.EGG_ACTIONS) {
  for (const it of g.items) {
    if (it.custom) continue;
    const enc = P.eggEncodeAction({ key: it.key });
    const dec = P.eggDecodeAction(enc.type, enc.params);
    eq(dec.key, it.key, `round-trip ${it.key}`);
  }
}
{
  const enc = P.eggEncodeAction({ key: "kbd", mods: 0x05, usage: 0x06 }); // Ctrl+Alt+C
  eq([enc.type, enc.params], [0x02, [0x05, 0x06, 0, 0, 0]], "kbd Ctrl+Alt+C encoding");
  const dec = P.eggDecodeAction(enc.type, enc.params);
  eq([dec.key, dec.mods, dec.usage], ["kbd", 0x05, 0x06], "kbd decode");
}
{
  const enc = P.eggEncodeAction({ key: "cpi_fixed", x: 12345, y: 678 });
  eq([enc.type, enc.params], [0x0C, [0, 0x39, 0x30, 0xA6, 0x02]], "fixed-CPI u16 LE packing");
  const dec = P.eggDecodeAction(enc.type, enc.params);
  eq([dec.x, dec.y], [12345, 678], "fixed-CPI decode");
}
eq(P.eggDecodeAction(0x09, [0xF1, 0, 0, 0, 0]).key, "cpi_loop", "cpi_loop decode");
eq(P.eggDecodeAction(0x77, [1, 2, 3, 4, 5]).key, "raw", "unknown type decodes as raw");

/* ---------------------- parse / serialize round trip --------------------------- */
console.log("Blob codec:");

// base blob with a recognizable pattern in every byte
const base = new Uint8Array(T.EGG_CFG_LEN);
for (let i = 0; i < base.length; i++) base[i] = i & 0xFF;
base[T.EGG_OFF.STAGE_COUNT] = 4;
base[T.EGG_OFF.ACTIVE_STAGE] = 1;
base[T.EGG_OFF.POLLING] = 8;
base[T.EGG_OFF.FILTERS] = 0xFF; // all bits set - foreign bits must survive
base[T.EGG_OFF.ANGLE_TUNE] = 0x81; // int8 -127

const s = T.eggParseConfig(base);
eq(s.pollingDivider, 8, "parse polling divider");
eq([s.slamclick, s.motionJitter], [true, true], "parse filter bits");
eq(s.angleTuning, -127, "parse angle tuning int8 0x81->-127");
eq(s.stages[0].x, base[52] | (base[53] << 8), "parse stage-1 X u16");
eq(s.buttons[4].params[1], base[105 + 3], "parse raw button record 4 param1 @109");

// identity serialize: untouched-buttons settings on the same base
{
  const out = T.eggSerializeConfig(base, s, V2);
  // reserved / unknown bytes must ride through untouched
  for (const off of [16, 17, 18, 19, 20, 23, 71, 72, 73, 74, 75, 76, 126, 131, 200, 500, 1040]) {
    eq(out[off], base[off], `reserved byte ${off} preserved`);
  }
  // button records had no write flags -> preserved byte-for-byte
  let same = true;
  for (let off = 77; off <= 125; off++) if (out[off] !== base[off]) same = false;
  eq(same, true, "button records preserved without write flags");
  eq(out[T.EGG_OFF.FILTERS] & ~0x11, 0xFF & ~0x11, "foreign filter bits preserved");
  eq(out[T.EGG_OFF.FILTERS] & 0x11, 0x11, "managed filter bits re-applied");
  eq(out[0], 0xA0, "report id");
  eq(out[1], 0x11, "store opcode");
  // LED colours are fixed in firmware: RGB + enable + index bytes preserved
  eq([out[31], out[32], out[33]], [base[31], base[32], base[33]], "stage-1 RGB bytes preserved");
  eq([out[35], out[40], out[45], out[50]], [base[35], base[40], base[45], base[50]], "stage index bytes preserved");
  eq(out[34], base[34], "stage-1 LED enable byte preserved");
}

// targeted modifications
{
  const st = structuredClone(s);
  st.stages[0] = { split: false, x: 1595, y: 9999 }; // -> clamp 1600, y follows x
  st.stageCount = 2;
  st.activeStage = 3; // must clamp to stage-count-1
  st.slamclick = false;
  st.motionJitter = false;
  st.ledLiftoffDisabled = true;
  st.angleTuning = -300; // clamps to -127
  st.stageColors[1] = { r: 0x12, g: 0x34, b: 0x56, enabled: false }; // LED colour/enable edits must NOT reach the wire
  st.buttons[4] = { ctl: 8, type: 0x02, params: [0x01, 0x06, 0, 0, 0], writeCtl: true, writeMapping: true }; // raw record 4 -> Ctrl+C
  st.buttons[6] = { ctl: 0xEE, type: 0x01, params: [0xFF, 0, 0, 0, 0], writeCtl: false, writeMapping: true }; // wheel: ctl NOT written
  const out = T.eggSerializeConfig(base, st, V2);
  eq([out[51], out[52], out[53], out[54], out[55]], [0, 0x40, 0x06, 0x40, 0x06], "stage-1 1595->1600, y=x, split=0");
  eq(out[T.EGG_OFF.STAGE_COUNT], 2, "stage count 2");
  eq(out[T.EGG_OFF.ACTIVE_STAGE], 1, "active stage clamped to count-1");
  eq(out[T.EGG_OFF.FILTERS], 0xFF & ~0x11, "both managed filter bits cleared");
  eq(out[T.EGG_OFF.LED_LIFTOFF], 0, "LED-liftoff-disable stored inverted (checked->0)");
  eq(out[T.EGG_OFF.ANGLE_TUNE], (-127) & 0xFF, "angle tuning clamped to -127");
  eq([out[36], out[37], out[38], out[39]], [base[36], base[37], base[38], base[39]], "stage-2 RGB and enable preserved");
  eq([out[105], out[106], out[107], out[108]], [8, 0x02, 0x01, 0x06], "raw record 4 = Ctrl+C when writeMapping=true");
  eq(out[119], base[119], "wheel ctl byte untouched (writeCtl=false)");
  eq([out[120], out[121]], [0x01, 0xFF], "wheel-down mapping written");
}

// V1 must never touch the V2-only bytes
{
  const st = structuredClone(s);
  st.ledLiftoffDisabled = true;
  st.glassMode = true;
  st.angleTuning = 55;
  st.forceMaxFps = true;
  const out = T.eggSerializeConfig(base, st, V1);
  for (const off of [24, 127, 128, 129, 130]) {
    eq(out[off], base[off], `V1 leaves V2-only byte ${off} untouched`);
  }
  eq(P.eggLodList(V1, true).length, 3, "V1 LOD list is 3 entries even if glass flag set");
  eq(P.eggLodList(V2, false).length, 11, "V2 normal LOD list 11 entries");
  eq(P.eggLodList(V2, true), ["1.0 mm", "2.0 mm"], "V2 glass LOD list");
}

// Purple Frost: generic PAW3950 gets glass mode (byte 127) but stays off the
// MCU-level V2-only bytes (LED lift-off, angle tune, max fps).
{
  const st = structuredClone(s);
  st.ledLiftoffDisabled = true;
  st.glassMode = true;
  st.angleTuning = 55;
  st.forceMaxFps = true;
  const out = T.eggSerializeConfig(base, st, PURPLE);
  eq(out[T.EGG_OFF.GLASS], 1, "Purple Frost writes glass byte");
  for (const off of [24, 128, 129, 130]) {
    eq(out[off], base[off], `Purple Frost leaves MCU-only byte ${off} untouched`);
  }
  eq(P.eggLodList(PURPLE, true), ["1.0 mm", "2.0 mm"], "Purple Frost glass LOD list matches V2's");
}

// Byte 130 is not surfaced in the app; preserve it like other device-owned data.
{
  const st = structuredClone(s);
  st.forceMaxFps = !st.forceMaxFps;
  const out = T.eggSerializeConfig(base, st, V2);
  eq(out[T.EGG_OFF.MC_MASTER], base[T.EGG_OFF.MC_MASTER], "byte 130 preserved on V2 writes");
}

// handedness slot 71-76 (section 4.6.1, hardware-verified): 71-76 = physical Left's
// mapping. Right-handed <=> plain LEFT CLICK (00 01) there; all-zero is the
// broken "Left disabled" state and must also read as right-handed.
{
  eq(s.leftHanded, true, "arbitrary nonzero 71-76 parses as left-handed");
  eq(s.handedSlot, [71, 72, 73, 74, 75, 76], "handedSlot bytes surfaced verbatim");
  const factory = base.slice();
  factory[71] = 0x00; factory[72] = 0x01;
  for (let o = 73; o <= 76; o++) factory[o] = 0;
  eq(T.eggParseConfig(factory).leftHanded, false, "factory 00 01 parses as right-handed");
  const zeroed = base.slice();
  for (let o = 71; o <= 76; o++) zeroed[o] = 0;
  eq(T.eggParseConfig(zeroed).leftHanded, false, "all-zero 71-76 parses as right-handed");
  const lefty = factory.slice();
  lefty[72] = 0x02;
  eq(T.eggParseConfig(lefty).leftHanded, true, "00 02 (Right Click) parses as left-handed");

  const st = structuredClone(s);
  st.leftHanded = true;
  st.handedSlot = [0x00, 0x02, 0, 0, 0, 0];
  const noFlag = T.eggSerializeConfig(base, st, V2);
  let same = true;
  for (let o = 71; o <= 76; o++) if (noFlag[o] !== base[o]) same = false;
  eq(same, true, "71-76 preserved without writeHanded");

  st.writeHanded = true;
  const lh = T.eggSerializeConfig(base, st, V2);
  eq([lh[71], lh[72], lh[73], lh[74], lh[75], lh[76]], [0, 2, 0, 0, 0, 0],
     "left-handed writes Left's action into 71-76");

  st.handedSlot = [0, 0, 0, 0, 0, 0]; // degenerate lefty slot must not disable Left
  const lhFix = T.eggSerializeConfig(base, st, V2);
  eq([lhFix[71], lhFix[72]], [0, 2], "all-zero lefty handedSlot falls back to Right Click");

  st.leftHanded = false;
  st.handedSlot = [0x00, 0x02, 0, 0, 0, 0]; // stale lefty content must be ignored
  const rh = T.eggSerializeConfig(base, st, V2);
  eq([rh[71], rh[72], rh[73], rh[74], rh[75], rh[76]], [0, 1, 0, 0, 0, 0],
     "right-handed always restores plain LEFT CLICK at 71-76 (never zeros)");
}

// xy_split flag is derived from actual inequality
{
  const st = structuredClone(s);
  st.stages[1] = { split: true, x: 800, y: 800 }; // split requested but equal -> wire 0
  st.stages[2] = { split: true, x: 800, y: 1600 };
  const out = T.eggSerializeConfig(base, st, V2);
  eq(out[56], 0, "equal X/Y -> split byte 0");
  eq(out[61], 1, "different X/Y -> split byte 1");
}

/* -------------------------- normalizeFeature shim ------------------------------ */
console.log("Feature-report normalization:");
{
  const withId = new DataView(Uint8Array.from([0xA0, 0x01, 7, 7]).buffer);
  const u = T.eggNormalizeFeature(withId, 0xA0, 8);
  eq([u[0], u[1], u.length], [0xA0, 0x01, 8], "report-id already present -> padded only");
  const withoutId = new DataView(Uint8Array.from([0x01, 7, 7]).buffer);
  const v = T.eggNormalizeFeature(withoutId, 0xA0, 8);
  eq([v[0], v[1], v.length], [0xA0, 0x01, 8], "report-id missing -> prepended");

  // length-deterministic mode (payloadLen known)
  const stripped = new Uint8Array(1040); stripped[0] = 0x00; stripped[1] = 0x01;
  const s1 = T.eggNormalizeFeature(new DataView(stripped.buffer), 0xA0, 1041, 1040);
  eq([s1[0], s1[1], s1[2], s1.length], [0xA0, 0x01, 0x00, 1041], "full WebHID config payload keeps field offsets");

  const observed = new Uint8Array(1040);
  observed[0] = 0x00; observed[1] = 0x01;
  observed[T.EGG_OFF.POLLING] = 8;
  observed[T.EGG_OFF.ACTIVE_STAGE] = 1;
  observed[T.EGG_OFF.STAGE_COUNT] = 4;
  observed[T.EGG_OFF.STAGES + 1] = 0x20;
  observed[T.EGG_OFF.STAGES + 2] = 0x03;
  const sObs = T.eggNormalizeFeature(new DataView(observed.buffer), 0xA1, 1041, 1040);
  eq([sObs[0], sObs[1], sObs[T.EGG_OFF.POLLING], sObs[T.EGG_OFF.STAGE_COUNT],
      sObs[T.EGG_OFF.STAGES + 1] | (sObs[T.EGG_OFF.STAGES + 2] << 8)],
     [0xA1, 0x01, 8, 4, 800], "observed 00 01 full-report shape is not shifted");
  const validator = new T.EggMouse({
    opened: true, collections: [], addEventListener() {}, removeEventListener() {},
  }, [], V2);
  eq(validator._blobOk(sObs, 1040), true, "valid full config frame accepted");
  const busyObs = sObs.slice(); busyObs[1] = T.EGG_STATUS.BUSY;
  eq(validator._blobOk(busyObs, 1040), false, "busy full config frame rejected");

  const returnedWithId = observed.slice();
  returnedWithId[0] = 0xA1; returnedWithId[1] = 0x01;
  const sId = T.eggNormalizeFeature(new DataView(returnedWithId.buffer), 0xA0, 1041, 1040);
  eq([sId[0], sId[1], sId[2], sId[T.EGG_OFF.POLLING], sId[T.EGG_OFF.STAGE_COUNT],
      sId[T.EGG_OFF.STAGES + 1] | (sId[T.EGG_OFF.STAGES + 2] << 8)],
     [0xA0, 0x01, 0x00, 8, 4, 800], "1040-byte A1 01 frame keeps config offsets");

  const coincidence = new Uint8Array(1040); coincidence[0] = 0xA0; // data byte that looks like an ID
  const s2 = T.eggNormalizeFeature(new DataView(coincidence.buffer), 0xA0, 1041, 1040);
  eq([s2[0], s2[1]], [0xA0, 0xA0], "len==payload beats first-byte coincidence");

  const included = new Uint8Array(1041); included[0] = 0xA0; included[1] = 0x00;
  const s3 = T.eggNormalizeFeature(new DataView(included.buffer), 0xA0, 1041, 1040);
  eq([s3[0], s3[1], s3.length], [0xA0, 0x00, 1041], "len==payload+1 with ID -> kept as-is");

  const ack = new Uint8Array(63); ack[0] = 0x01;
  const s4 = T.eggNormalizeFeature(new DataView(ack.buffer), 0xA1, 64, 63);
  eq([s4[0], s4[1], s4.length], [0xA1, 0x01, 64], "63-byte stripped ack -> [A1][01]");
}

console.log("Firmware version formatting:");
{
  const v107 = new Uint8Array(20); v107[17] = 0x07; v107[18] = 0x01;
  eq(T.eggFormatVersionBytes(v107), "V1.07", "patch/major bytes 07 01 -> V1.07");
  const fixed = new Uint8Array(20); fixed[17] = 0x68; fixed[18] = 0x00;
  eq(T.eggFormatVersionBytes(fixed), "V1.04", "fixed-point fallback 104 -> V1.04");
}

/* ------------------- transport vs. device state machine ------------------------ */
async function runTransportTests() {
  console.log("Transport (mock device):");

  const makeConfig = firstByte => {
    const cfg = new Uint8Array(1040);
    cfg[0] = firstByte; cfg[1] = 0x01;       // placeholder/report byte + status
    cfg[21] = 8;
    cfg[29] = 1; cfg[30] = 4;
    cfg[52] = 0x20; cfg[53] = 0x03;         // stage-1 CPI 800
    return cfg;
  };
  const ack = () => {
    const a = new Uint8Array(63); a[0] = 0x01;
    return new DataView(a.buffer);
  };
  const readViaMock = async (mock, what) => {
    const mouse = new T.EggMouse(mock, [], P.EGG_PROFILES[0x1978]);
    try {
      await mouse.open();
      const blob = await mouse.readConfig();
      eq([blob[0], blob[1]], [0xA0, 0x01], `${what}: normalized header`);
      eq(blob[21], 8, `${what}: polling divider survives`);
      eq(blob[52] | (blob[53] << 8), 800, `${what}: stage-1 CPI survives`);
      eq(mock.gets < 10, true, `${what}: no poll storm (${mock.gets} GETs)`);
    } catch (e) {
      failures++;
      console.error(`FAIL  ${what}: ` + e.message);
    }
  };

  await readViaMock({
    opened: true,
    collections: [],
    pendingAck: false, blobArmed: false, gets: 0,
    addEventListener() {}, removeEventListener() {},
    async open() {},
    async sendFeatureReport(reportId, data) {
      if (reportId === 0xA1) {
        this.pendingAck = true;              // ack queued, blocks everything
        if (data[0] === 0x12) this.blobArmed = true;
      }
    },
    async receiveFeatureReport(reportId) {
      this.gets++;
      if (reportId === 0xA1) {
        this.pendingAck = false;             // GET(0xA1) consumes the ack
        return ack();
      }
      if (!this.blobArmed) return ack();
      return new DataView(makeConfig(0xA1).buffer);
    },
  }, "mock read A1-shaped config on GET(0xA0)");

  await readViaMock({
    opened: true,
    collections: [],
    gets: 0,
    addEventListener() {}, removeEventListener() {},
    async open() {},
    async sendFeatureReport() {},
    async receiveFeatureReport(reportId) {
      this.gets++;
      if (reportId === 0xA1) return new DataView(makeConfig(0xA1).buffer);
      return ack();
    },
  }, "mock read full config on GET(0xA1)");
}

runTransportTests().finally(() => {
  console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL TESTS PASSED");
  process.exit(failures ? 1 : 0);
});
