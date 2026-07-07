# Endgame Gear 8k Mice — Multi-Device HID Configuration Protocol

Reverse-engineered from the five official Windows configuration tools. This document is
organized for building **one application that drives every device**: a **common core**
that is byte-for-byte identical on all of them, followed by the **per-family / per-device
deltas** you must branch on.

> **Companion document.** [`OP1_8k_v2_USB_Protocol.md`](OP1_8k_v2_USB_Protocol.md) is the
> exhaustive byte-level reference for the **V2 family**. Because the wire layout is shared
> (proven in §3), that document's §4 encodings apply verbatim to the **V1 family** too for
> every setting the V1 devices expose. This file is the umbrella spec; it does not repeat
> every byte table — it tells you which parts of the V2 doc are universal and which are
> V2-only.

> **Confidence legend:** ✅ verified in the binary (decompiled code / string / resource).
> 🟧 position known, meaning inferred — confirm on hardware.

---

## 1. Device matrix

All five devices are the same VID with a per-model PID. PIDs below are taken from the
**actual `hid_open(vid,pid)` call and the SetupDi device-open filter** in each binary
(not from strings — the XM2 8k v2 binary contains a misleading `"1982"` string, but the
real PID is `0x1980`).

| Device | Config tool | **VID** | **PID** | Family | Sensor era |
|---|---|---|---|---|---|
| OP1 8k | *OP1 8k Configuration Tool V1.12* | `0x3367` | **`0x1964`** | **V1** | earlier |
| XM2 8k | *XM2 8k Configuration Tool v1.12* | `0x3367` | **`0x1966`** | **V1** | earlier |
| OP1 8k Purple Frost LE | *…Purple Frost… Configuration Tool* | `0x3367` | **`0x1976`** | **V1** | PAW3950 (generic)³ |
| OP1 8k **v2** | *OP1 8k v2 Configuration Tool v1.04* | `0x3367` | **`0x1978`** | **V2** | PAW3950 (custom) |
| XM2 8k **v2** | *XM2 8k v2 Configuration Tool v1.04* | `0x3367` | **`0x1980`** | **V2** | PAW3950 (custom) |

Notes established from the binaries:

- **The internal codebase is shared.** All three V1 tools still contain the internal string
  `"AEGG OP1 8k Configuration Tool"` / `"Endgame Gear OP1 8K Gaming Mouse software"` — the
  XM2 8k and Purple Frost tools are rebrands of the OP1 8k tool. The two V2 tools are
  likewise one codebase (they reference the `"3950"` sensor).
- **Within a family the protocol is identical**; devices differ only by PID (and cosmetics).
  Confirmed by diffing the full setting-string sets: OP1 8k ≡ XM2 8k (V1), and
  OP1 8k v2 ≡ XM2 8k v2 (V2), with zero setting-level differences.
- **Purple Frost** is an *older build* of the V1 tool: its UI omits the **Motion Jitter
  Filter** toggle and the `8000Hz` label string that the newer OP1 8k V1.12 build shows.
  The device itself is a V1-family OP1 8k (PID `0x1976`); treat it as V1 for CPI
  granularity, button vocabulary and MCU-level extras (angle tuning / force-max-fps /
  LED lift-off).
- ³ **Purple Frost's sensor is a PAW3950** — the same chip family as the V2 mice, but
  the *generic* part rather than the custom one Endgame Gear put in the V2 mice. Its
  LOD/CPI granularity stays at V1's coarser values (no 0.1 mm LOD steps, no 10-CPI
  granularity below 10k), but it does support **Glass Mode**.
  **✅ Confirmed 2026-07-07 by decompiling the actual Purple Frost exe** (not inferred):
  the binary's own PDB path is literally
  `H:\...\K26_046_config_v1.11_8k_purple_glass_mode_1kHz\...` and its dialog resources
  contain the caption string `"Glass Mode"` (shorter than V2's `"Sensor Glass Mode"`,
  but the same control) — so Purple Frost's *own stock tool* already surfaces this,
  it isn't an enhancement this app is adding beyond the vendor tool. See §5.1/§5.2/§7
  for the full evidence trail, including what this build's binary does **not** contain
  (Sensor Angle Tuning, Force max Sensor fps).

---

## 2. The two families at a glance

```
                     ┌──────────────── COMMON CORE (identical on all 5) ───────────────┐
                     │ VID 0x3367 · vendor HID collection (usage page 0xFF01/usage 2)   │
                     │ Reports: 0xA0 (1041-B config) · 0xA1 (64-B command) · 0x03 (evt) │
                     │ Opcodes: 0x11A0 store · 0x12A1 load · 0x13A1 factory-reset · ver  │
                     │ Same 1024-byte config payload layout (offsets 16–125)            │
                     │ Same CPI/stage model · button records · button mapping · LED     │
                     │ Real-time input-report event channel (hidapi handle)             │
                     └─────────────────────────────────────────────────────────────────┘
        V1 family (0x1964 / 0x1966 / 0x1976)        V2 family (0x1978 / 0x1980)
        • LOD = 3 options (0.7 / 1 / 2 mm)          • LOD = 11 options (0.7–1.7 mm) +2.0 mm
        • CPI step 50 uniform                       • CPI step 10 (≤10k) then 50
        • CPI max: 26000 (OP1/XM2) · 30000 (Purple) • CPI 10–30000
        • No MCU-tuning extras                       • + Sensor Angle Tuning (−127…+127)
        • No "Disable LED on Lift-Off" in UI        • + Force max Sensor fps
        • (Purple: no Motion Jitter toggle)         • + Disable LED on Lift-Off
        • (Purple only: + Sensor Glass Mode¹)       • config offsets 126–130 populated
```

¹ Capability, not family: Purple Frost's generic PAW3950 supports Glass Mode (byte 127)
even though it's otherwise a V1-family device — see the ³ note above and §5.1/§7.

> **Per-device CPI range and LOD list are the settings that vary most** — see the verified
> tables in **§5.4 (CPI/DPI)** and **§5.5 (LOD)**. Both are taken from each binary's own
> clamp function and options table, not assumed.

---

## 3. Why the wire layout is shared (the key structural finding)

Each tool serializes its in-memory config struct (`CFG`) into the 1024-byte wire payload
with a hand-written **byte-permutation function** (V1: `FUN_00404d20`; V2: `FUN_004042c0`),
and deserializes with its exact inverse. Comparing the two permutations:

- For **every** wire offset present in both (≈105 bytes), the mapping is
  `wire[W] = CFG[src]`, and **`src_V1 = src_V2 − 2`** — a *constant* shift, with no
  reordering.
- The `−2` is purely an **internal struct** difference (the V2 `CFG` grew a 2-byte field
  near its front). The **wire byte at offset `W` therefore carries the same logical field in
  both families.**
- V2's permutation has **three extra tail entries** (wire ≈`0x70–0x72`, i.e. report
  offsets ~128–130) — these are the V2-only sensor settings. V1 simply does not emit them.

**Consequence for implementers:** the report offsets in
[`OP1_8k_v2_USB_Protocol.md` §3–§4](OP1_8k_v2_USB_Protocol.md) are the universal layout.
You do **not** need a separate byte map for V1 — you need only to (a) use the correct **LOD
option list and CPI range for the specific device** (§5.4–§5.5) and (b) not write the
V2-only bytes on V1 devices. Use **read-modify-write** (§4.6) and you never touch a byte you
don't understand.

---

## 4. Common core (identical on all five devices)

Everything in this section is verified identical across all binaries (same transport
functions, same opcodes, same report sizes, same serializer structure).

### 4.1 Interface selection
Open the **vendor HID collection**: match `VID == 0x3367 && PID == <device PID>` and select
the top-level collection with **usage page `0xFF01`, usage `0x02`** (the config surface;
the boot-mouse collection is ignored). All tools use the same `SetupDi…` +
`HidD_GetAttributes` enumeration (`FUN_004035d0(pid)` in the V2 binaries).

### 4.2 Reports
| Report ID | Dir | Size | Purpose |
|---|---|---|---|
| **`0xA0`** | feature (Set/Get) | **1041 bytes** | full configuration blob |
| **`0xA1`** | feature (Set/Get) | **64 bytes** | command / status (load, reset, version) |
| **`0x03`** | input (interrupt) | **8 bytes** | real-time events (see §4.5) |

The 1041-byte config report is `[0]=0xA0`, `[1]`=opcode-low, header bytes `2..15` zero, and
a **1024-byte payload at report offsets 16–1039** (only 16–125/130 are meaningful). All
multi-byte scalars are **little-endian**.

### 4.3 Opcodes (word at payload start of the 0xA1 / 0xA0 buffer)
| Op | Word | Meaning |
|---|---|---|
| Store config | **`0x11A0`** | `SetFeature(0xA0, …)` with the full 1024-B payload → commit ("Apply") |
| Load config | **`0x12A1`** | `SetFeature(0xA1)` then read a full config blob back. The stock path is `GetFeature(0xA0)`, but WebHID/firmware combinations have also returned the full blob from `GetFeature(0xA1)`; accept either only after structural validation. |
| Factory reset | **`0x13A1`** | `SetFeature(0xA1)` → instant defaults, no Apply |
| Firmware version | version op | OP1 8k v2 observed `patch,major` bytes (`07 01` => `V1.07`); keep `raw/100` only as a fallback |

### 4.4 Status byte
On any `GetFeature`, **response byte `[1]`** is the status/opcode field: `0x01` = OK,
`0x03` = busy/retry. Poll until `0x01`.

### 4.5 Real-time event channel (report `0x03`)  ✅
Independently of the feature-report config channel, every tool opens a **second handle via
statically-linked hidapi** (`hid_open(0x3367, PID, …)`) and runs a reader thread doing
`hid_read`. 8-byte input reports with `buf[0]==0x03` signal live events — most importantly
**active-DPI-stage changes** (from the mouse's physical DPI button), which the UI reflects
in <20 ms. See [`OP1_8k_v2_USB_Protocol.md` §2.4](OP1_8k_v2_USB_Protocol.md) for the event
byte formats; this channel is identical across families.

### 4.6 Golden rule: read-modify-write
To change any setting: `load (0x12A1)` → read the 1024-B payload → modify only the byte(s)
for that setting → `store (0x11A0)`. This keeps unknown/reserved and family-specific bytes
intact and is the safe path for a cross-device app.

### 4.7 Common settings (same report offset & encoding on all devices)
These are all documented in [`OP1_8k_v2_USB_Protocol.md` §4](OP1_8k_v2_USB_Protocol.md);
the offsets/encodings below are **universal** (V1 and V2):

| Report offset | Setting | Encoding (see V2 doc §) |
|---|---|---|
| **21** | Polling rate | divider; `Hz = 8000/divider`; options **1000/2000/4000/8000 Hz** (§4.1) |
| **22** | Filter bitfield | Slamclick bit `0x01` and **Motion Jitter** bit `0x10` (§4.4). Motion Sync, Angle Snapping and Ripple Control are separate bytes 28, 26 and 27. |
| **25** | Lift-off distance | combo-box **index** (range is family-specific — §5) (§4.2) |
| **29** | Active DPI stage | `0..3`; **instant write path**, no Apply (§4.3.1) |
| **30** | Number of CPI stages | 1–4, keeps the **lowest N** (§4.3) |
| **31–76** | Per-stage CPI records | CPI value + per-stage X/Y split + LED colour (§4.3) |
| **77–125** | 7 × 7-byte button records | multiclick filter, SPDT mode, action mapping (§4.5–4.6) |
| **31–50** | Stage color bytes | 4 x `{R,G,B,enable,stage#}`. Current WebHID hardware testing treats the real stage indicator colors as firmware-fixed and preserves these bytes on writes (§4.7). |

**Buttons (all devices):** 7 slots — Left, Right, Middle, Forward, Back, **Wheel Up**,
**Wheel Down**. The 5 physical buttons have a Multiclick filter; **Left/Right have the SPDT
mode** dropdown (Off / GX Speed / GX Safe); the wheel inputs have neither. **Left-handed
Mode** exists on all (derived from the button records — V2 doc §4.6.1). Mapping menu on all:
MOUSE / KEYBOARD KEY / CPI (Loop, Fixed X/Y) / MEDIA / DISABLE.

**Stage indicator colors:** bytes 31-50 exist in the shared blob, but the current
hardware-tested WebHID implementation treats the actual stage indicator colors as fixed in
firmware (CPI 1-4 = blue / green / yellow / red) and preserves the RGB/enable bytes
unchanged. The only LED-related control currently treated as app-managed is the V2-only
*Disable LED on Lift-Off* toggle (§5.2).

---

## 5. Per-family / per-device differences

### 5.1 Capability matrix

| Feature | OP1 8k | XM2 8k | OP1 8k Purple | OP1 8k v2 | XM2 8k v2 |
|---|:--:|:--:|:--:|:--:|:--:|
| PID | 0x1964 | 0x1966 | 0x1976 | 0x1978 | 0x1980 |
| Polling 1000/2000/4000/8000 Hz | ✅ | ✅ | ✅ | ✅ | ✅ |
| **CPI max** | **26000** | **26000** | **30000** | **30000** | **30000** |
| **CPI min / step** | 50 / 50 | 50 / 50 | 50 / 50 | 10 / 10→50 | 10 / 10→50 |
| **LOD options** | **3** | **3** | **3** | **11 (+2.0)** | **11 (+2.0)** |
| Motion Sync | ✅ | ✅ | ✅ | ✅ | ✅ |
| Angle Snapping | ✅ | ✅ | ✅ | ✅ | ✅ |
| Ripple Control | ✅ | ✅ | ✅ | ✅ | ✅ |
| Slamclick Filter | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Motion Jitter Filter** | ✅ | ✅ | **✗²** | ✅ | ✅ |
| Multiclick Filter (per-button) | ✅ | ✅ | ✅ | ✅ | ✅ |
| SPDT mode (L/R: GX Speed/Safe) | ✅ | ✅ | ✅ | ✅ | ✅ |
| CPI stages 1–4, per-stage X/Y | ✅ | ✅ | ✅ | ✅ | ✅ |
| LED (DPI/Logo/Scroll + effect) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Button mapping + Left-handed | ✅ | ✅ | ✅ | ✅ | ✅ |
| Factory Reset | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Sensor Glass Mode** | ✗ | ✗ | ✅³ | ✅ | ✅ |
| **Sensor Angle Tuning (−127…+127)** | ✗ | ✗ | ✗³ | ✅ | ✅ |
| **Force max Sensor fps** | ✗ | ✗ | ✗³ | ✅ | ✅ |
| **Disable LED on Lift-Off** | ✗ | ✗ | ✗ | ✅ | ✅ |

² Motion Jitter Filter toggle is absent from the Purple Frost UI build; the underlying
byte-22 bit still exists in the shared layout. (All five devices, Purple included, expose
the full 1000/2000/4000/8000 Hz polling list — verified from each binary's options table.)

³ Decompiled directly from the Purple Frost exe (2026-07-07 — see §5.2/§7): its dialog
resources contain `"Glass Mode"` but **no** `"Sensor Angle Tuning"` or `"Force max Sensor
fps"` string anywhere in the binary (checked byte-for-byte, both ASCII and UTF-16LE, all
casings). The shared V1 struct→wire permutation function (`FUN_00404d20`, same address in
all three V1 tools) tops out at output byte 111 - it structurally cannot reach offsets
127-129 either way. If a newer Purple Frost tool build exists with Angle Tuning / Force
Max FPS, it isn't the one checked here - flag it and it can be re-decompiled
(see [decompile/README.md](decompile/README.md)).

### 5.2 V1 family (OP1 8k · XM2 8k · Purple Frost) — specifics

- **LOD (report offset 25) has 3 entries: index `0 = 0.7 mm`, `1 = 1 mm`, `2 = 2 mm`.**
  These come from each tool's serialized options table (ASCII, length-prefixed:
  `"0.7mm" "1mm" "2mm"`) — not from UTF-16 literals, which is why a naïve string scan
  under-counts them. Encode the byte as the selected list index, same convention as V2.
  (In certain sensor modes the tool trims `0.7 mm` from the list via `CB_FINDSTRINGEXACT` /
  `CB_INSERTSTRING`, analogous to V2's glass-mode list swap.)
- **CPI:** OP1 8k and XM2 8k clamp to **50…26000** (PAW3395-class); **Purple Frost clamps to
  50…30000** — see §5.4. All V1 devices round to the nearest **50** (round-half-up).
- **No MCU-tuning extras.** None of the V1 tools (Purple Frost included) surface Sensor
  Angle Tuning or Force max Sensor fps. Report offsets 128–129 are **not written** by any
  V1 device (leave them as read) — these are MCU-level features tied to the V2 board, not
  the sensor.
- **No "Disable LED on Lift-Off" control.** Report offset 24 exists in the shared layout but
  the V1 UI doesn't expose it; leave it at its read-back value.
- **Purple Frost** = same protocol/family as OP1 8k (PID `0x1976`) but its clamp allows a
  **higher CPI max (30000 vs 26000)** and its (older) tool build hides the Motion Jitter
  Filter toggle. You can still expose Motion Jitter (the byte-22 bit is present).
- **Purple Frost + Glass Mode (byte 127).** Unlike OP1 8k/XM2 8k, Purple Frost's sensor
  is a PAW3950 (generic part, not the custom one in the V2 mice), and unlike them its
  *own stock tool does* have a Glass Mode toggle - decompiled confirmation 2026-07-07:
  the exe's dialog resources contain the caption `"Glass Mode"` (V2's is worded
  `"Sensor Glass Mode"` - same control, terser label), and the tool's own PDB path is
  `H:\...\K26_046_config_v1.11_8k_purple_glass_mode_1kHz\...`, i.e. this is literally a
  "glass mode" variant build of the V1 tool for this device. This app writes byte 127
  for Purple Frost gated on a `lodGlass` capability flag rather than on V1/V2 family,
  and swaps in the same 2-entry glass LOD list as the V2 mice (§5.5) while it's active.
  Purple Frost's LOD/CPI *granularity* otherwise stays V1-coarse (no 0.1 mm LOD steps,
  no 10-CPI-step below 10k) — the generic PAW3950 lacks the custom part's finer
  resolution.
  **Checked and ruled out for this same exe:** Sensor Angle Tuning and Force max Sensor
  fps. Neither caption string exists anywhere in the binary (exhaustive check, both
  encodings), and the shared V1 permutation function that would carry such fields onto
  the wire (`FUN_00404d20`) only ever writes output bytes 0-111 - it can't reach offsets
  128/129 even in principle. Whatever wrote Glass Mode's byte 127 for this build is a
  separate, Purple-Frost-specific addition outside that shared function; it wasn't fully
  traced (heavily optimized MSVC output - see
  [decompile/README.md](decompile/README.md) for what's been tried). Treat Angle
  Tuning/Force Max FPS as **absent** on Purple Frost unless a different tool build is
  found that says otherwise.

### 5.3 V2 family (OP1 8k v2 · XM2 8k v2) — specifics

- **LOD (report offset 25) has 11 entries: 0.7–1.7 mm in 0.1 mm steps** (index 0–10), plus a
  special 2-entry list used when Sensor Glass Mode is active (index `1 = 2.0 mm`). See
  [V2 doc §4.2](OP1_8k_v2_USB_Protocol.md).
- **Adds sensor-tuning bytes** at report offsets **127–129** — Sensor Glass Mode, Sensor
  Angle Tuning (signed, −127…+127), and Force max Sensor fps. Byte 130 is preserved.
  Exact offsets/encodings: [V2 doc §4.4 & §4.8](OP1_8k_v2_USB_Protocol.md).
- **Adds "Disable LED on Lift-Off"** at report offset **24**, stored **inverted**
  (`byte = NOT(checkbox)`). [V2 doc §4.7](OP1_8k_v2_USB_Protocol.md).
- **CPI** clamps to **10…30000**, rounding to the nearest **10** at ≤10000 and nearest **50**
  above 10000 (round-half-up) — see §5.4.

### 5.4 CPI / DPI range and quantization (verified from each binary's clamp function)

Every tool passes a typed CPI value through a clamp/rounding function before storing it.
These are the exact bounds and steps (from `FUN_00402910` in the V1 tools and `FUN_0040c9a0`
in the V2 tools):

| Device | Min | Max | Step (rounding) | Notes |
|---|---:|---:|---|---|
| OP1 8k | 50 | **26000** | 50 (uniform) | round-half-up at remainder ≥ 25 |
| XM2 8k | 50 | **26000** | 50 (uniform) | identical clamp to OP1 8k |
| OP1 8k Purple Frost | 50 | **30000** | 50 (uniform) | same stepping, higher ceiling |
| OP1 8k v2 | 10 | **30000** | **10** up to 10000, **50** above 10000 | round-half-up |
| XM2 8k v2 | 10 | **30000** | **10** up to 10000, **50** above 10000 | identical to OP1 8k v2 |

Both CPI-X and CPI-Y (when X/Y are split) go through the same clamp. The value is stored in
each per-stage CPI record (report offsets 31–76; see [V2 doc §4.3](OP1_8k_v2_USB_Protocol.md))
as a little-endian scalar — **not** a lookup index.

### 5.5 LOD (lift-off distance) option lists

| Device | LOD options (byte 25 = list index) |
|---|---|
| OP1 8k · XM2 8k · Purple Frost (normal) | **`0.7 mm` (0), `1 mm` (1), `2 mm` (2)** — 3 entries |
| OP1 8k v2 · XM2 8k v2 (normal) | `0.7, 0.8, … 1.7 mm` (0–10) — 11 entries |
| OP1 8k v2 · XM2 8k v2 · **Purple Frost (Glass Mode)** | `1.0 mm` (0), `2.0 mm` (1) — 2 entries |

So **every device can select a ~2 mm lift-off** — the V1 family exposes it directly as the
3rd normal option, and any Glass-Mode-capable device (V2, or Purple Frost per this app) also
exposes `2.0 mm` via the Glass Mode list. Byte 25 is always just the selected list index; the
firmware maps the index to the physical distance.

---

## 6. Implementing a unified app

1. **Enumerate** HID devices with VID `0x3367` and match PID against the table in §1;
   select usage page `0xFF01` / usage `0x02`.
2. **Pick a capability profile** from the PID (V1 vs V2). Suggested shape:

   ```c
   typedef struct {
       uint16_t pid;
       const char *name;
       enum { FAM_V1, FAM_V2 } family;
       uint16_t cpi_min, cpi_max; // clamp bounds (see §5.4)
       uint8_t  cpi_step_lo;      // step at/below 10000
       uint8_t  cpi_step_hi;      // step above 10000
       uint8_t  lod_count;        // V1: 3 (0.7/1/2mm)   V2: 11 (0.7-1.7) [+2.0 in glass]
       bool     has_sensor_glass; // sensor capability, NOT a family flag - true for
                                  // both V2 mice and Purple Frost (generic PAW3950)
       bool     has_angle_tuning; // V2 only (MCU-level)
       bool     has_force_max_fps;// V2 only (MCU-level)
       bool     has_led_liftoff;  // V2 only (MCU-level)
       bool     has_motion_jitter;// all except Purple's stock UI
   } device_profile;

   static const device_profile PROFILES[] = {
     //  pid    name                  family  cpimin cpimax  slo shi lod  glass angle fps  lift  jitter
     {0x1964,"OP1 8k",              FAM_V1,   50, 26000,  50, 50,  3, false,false,false,false, true },
     {0x1966,"XM2 8k",              FAM_V1,   50, 26000,  50, 50,  3, false,false,false,false, true },
     {0x1976,"OP1 8k Purple Frost", FAM_V1,   50, 30000,  50, 50,  3, true, false,false,false, true },
     {0x1978,"OP1 8k v2",           FAM_V2,   10, 30000,  10, 50, 11, true, true, true, true,  true },
     {0x1980,"XM2 8k v2",           FAM_V2,   10, 30000,  10, 50, 11, true, true, true, true,  true },
   };
   ```

3. **All read/write logic is shared** — use the common transport (§4) and the universal
   offset table (§4.7 + V2 doc §3–§4). Gate only the family-specific widgets/bytes on the
   profile flags. Always **read-modify-write** so unknown bytes survive.
4. The instant **active-DPI-stage** path (write only offset 29, no Apply) and the real-time
   `0x03` event channel work identically on every device — wire them once.

---

## 7. Verified vs. to-confirm

**Verified in the binaries (all 5):** VID/PIDs (from `hid_open`/device-open constants);
report IDs & sizes; opcodes; the shared serializer permutation (`−2` CFG shift proof);
**per-device CPI min/max/step from each clamp function** (`FUN_00402910` / `FUN_0040c9a0`);
**LOD option lists from each binary's ASCII options table** (V1 = 0.7/1/2 mm, V2 = 0.7–1.7 +
2.0 mm); polling options (1–8 kHz on all five, Purple included); LED zone model; button /
SPDT / mapping vocabulary; the V2-only feature set; and that XM2 8k v2's PID is **`0x1980`**
(not the `1982` string).

**Recommend confirming on hardware:**
- V1 LOD index→distance mapping (`0→0.7 mm, 1→1 mm, 2→2 mm`) — the option *labels* and index
  order are confirmed in the binary; the physical distance is the firmware's interpretation.
- ~~Whether V1-family hardware silently supports the V2-only sensor features even though the
  V1 tool hides them~~ — **resolved 2026-07-07 for Purple Frost by decompiling its exe**
  (`webapp/notes/decompile/out/purple_frost.c` - see
  [decompile/README.md](decompile/README.md) for how to reproduce):
  - **Glass Mode: present.** Dialog caption `"Glass Mode"` found in the binary; PDB path
    is literally `...K26_046_config_v1.11_8k_purple_glass_mode_1kHz...`. This is a real,
    shipped feature of Purple Frost's own tool, not something inferred from "it's the
    same sensor family" - flagged ✅³ in §5.1.
  - **Sensor Angle Tuning / Force max Sensor fps: absent.** Neither string exists
    anywhere in the binary (byte-level check, ASCII + UTF-16LE, all casings), and the
    shared V1 permutation function (`FUN_00404d20`, same address as in OP1 8k/XM2 8k)
    only ever writes output bytes 0-111, well short of offsets 128/129. Flagged ✗³ in
    §5.1. (A user expected these to be present on the latest Purple Frost tool - if a
    different/newer build turns up, re-run the decompile against it before trusting this
    row.)
  - LED lift-off (byte 24) was not re-checked this pass; still assumed absent per the
    original binary-verified V1 finding.
- ~~Left-handed Mode's exact byte-level swap~~ — resolved for the V2 family on 2026-07-05
  (see V2 doc §4.6.1): wire 71–76 = physical Left's mapping slot; right-handed ⇔ plain
  LEFT CLICK there. Still unconfirmed on V1-family hardware, but the shared layout makes
  the same encoding overwhelmingly likely.

> **Corrections from the first pass of this document** (now fixed above): V1 LOD is **3
> options including 2 mm**, not 2 — the option strings live in an ASCII length-prefixed table
> a UTF-16 scan misses. And **CPI max is device-specific** (OP1 8k / XM2 8k = 26000; Purple
> Frost = 30000; both V2 = 30000), with V1 using a uniform 50-CPI step vs V2's 10/50 step.
> Purple Frost does support 8000 Hz.

---

## 8. Methodology / evidence trail

- Ghidra headless decompilation of all five binaries (VID/PID from `hid_open` and the
  SetupDi device-open filter; transport from `HidD_Set/GetFeature` callers; serializers
  `FUN_00404d20` (V1) and `FUN_004042c0` (V2); CPI clamp `FUN_00402910` (V1) /
  `FUN_0040c9a0` (V2)).
- Programmatic diff of the two serializer permutations established the shared wire layout.
- Setting inventory cross-checked between binaries from **both** UTF-16 dialog/menu strings
  **and** the ASCII length-prefixed options table (LOD / polling / SPDT / LED-effect lists) —
  the latter is invisible to a UTF-16-only scan and is what corrected the V1 LOD count.
- Option lists and numeric ranges are taken from each device's own code/data, never assumed
  from a sibling model. No claim relies on the third-party *UnofficialEGGMouseConfig* source.
