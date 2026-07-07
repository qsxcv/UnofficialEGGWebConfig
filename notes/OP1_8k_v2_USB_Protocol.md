# Endgame Gear OP1 8k v2 — USB / HID Configuration Protocol

Reverse-engineered from **`Endgame Gear OP1 8k v2 Configuration Tool v1.04.exe`** (32-bit
native MFC application) via static analysis (Ghidra). Cross-checked against the community
project *UnofficialEGGMouseConfig* (used only as a hypothesis source; every claim below was
re-verified against the official binary unless explicitly marked otherwise).

The goal of this document is to let you build a drop-in replacement front-end: it specifies
the exact USB transport, the exact bytes of every feature report, and the encoding of every
setting the tool exposes.

> **Confidence markers**
> - ✅ **Confirmed** — the byte's UI control was traced end-to-end: dialog resource caption → control ID → `DoDataExchange` member → the gather/populate handler that reads/writes that exact config byte.
> - 🟨 **High** — encoding and position confirmed; the human *label* is uncertain only because the control has **no caption** in the binary (icon/radio button).
> - 🟧 **Tentative** — byte position known, meaning inferred. Verify on hardware.
>
> Every setting that has a text label in the app is now ✅. The label→byte links were established by matching each dialog control (`DoDataExchange` binds control-ID → C++ member) to the handler that copies that control into a specific config byte. Note: MFC stores the live `HWND` at offset `+0x20` inside each bound `CWnd` member, so a handler reading `this+0xNNN` corresponds to the DDX member `0xNNN-0x20`.

---

## 1. Device identification & interface selection

| Property | Value |
|---|---|
| USB Vendor ID | `0x3367` (Endgame Gear) ✅ |
| USB Product ID | `0x1978` (OP1 8k v2) ✅ |
| Transport | USB HID **feature reports** (`HidD_SetFeature` / `HidD_GetFeature`) ✅ |

The mouse exposes several HID top-level collections (standard mouse, keyboard/consumer,
and a vendor collection). **You must talk to the vendor collection**, identified by its
HID caps:

| HID capability | Required value |
|---|---|
| Usage Page | `0xFF01` (vendor-defined) ✅ |
| Usage | `0x02` ✅ |

Selection logic used by the tool (`FUN_004035d0`):

1. Enumerate all HID interfaces (`SetupDiGetClassDevs` with `HidD_GetHidGuid`).
2. `CreateFile` each, call `HidD_GetAttributes`; keep the ones where
   `VendorID == 0x3367 && ProductID == 0x1978`.
3. `HidD_GetPreparsedData` + `HidP_GetCaps`; select the collection where
   `UsagePage == 0xFF01 && Usage == 0x02`.

On Linux/`hidapi` the equivalent is: open the `hidraw` node for VID `0x3367` / PID `0x1978`
whose report descriptor has usage-page `0xFF01`, usage `0x02`. (The unofficial tool just
`hid_open(0x3367, pid)` and relies on hidapi picking the right interface — acceptable but
less precise.)

The tool also registers for `WM_DEVICECHANGE` / `RegisterDeviceNotification` to detect
hot-plug (arrival `DBT_DEVICEARRIVAL 0x8000`, removal `0x8004`), matching device path
substrings `"3367"` and `"1978"`.

---

## 2. Transport layer — report IDs

Configuration uses two **feature** reports; the mouse also pushes an **input** report for
real-time events (§2.4):

| Report ID | Kind | Length (incl. report-ID byte) | Purpose |
|---|---|---|---|
| `0xA0` | Feature | **1041 bytes** (`0x411`) | The full configuration blob (read & write) ✅ |
| `0xA1` | Feature | **64 bytes** (`0x40`) | Short command / status / firmware channel ✅ |
| `0x03` | Input | **8 bytes** | Unsolicited event notifications (DPI stage / polling changed) ✅ (§2.4) |

### 2.1 Opcode framing

Every report begins with a little-endian 16-bit word = `(report_id) | (subcommand << 8)`.
Byte 0 is the HID report ID; byte 1 is the sub-command:

| Operation | Word (LE) | Bytes `[0],[1]` | Report used |
|---|---|---|---|
| Store config (write) | `0x11A0` | `A0 11` | `0xA0`, 1041 B |
| Load config (read request) | `0x12A1` | `A1 12` | `0xA1`, 64 B |
| Factory reset | `0x13A1` | `A1 13` | `0xA1`, 64 B |
| Get firmware version | `0x02A1` | `A1 02` | `0xA1`, 64 B |

All multi-byte scalars in the protocol are **little-endian**.

### 2.2 Status byte

On any GET (feature read), **response byte `[1]` is a status/opcode field**:
`0x01` = ready/complete, `0x03` = busy/pending (retry). ✅ (`FUN_00403900`)

### 2.3 Operation flows (with the tool's real timings)

**Read configuration** (`FUN_00403b00`):
1. `SetFeature(0xA1 …)` with a 64-byte buffer whose word = `0x12A1` (rest zero).
2. `Sleep(80 ms)`.
3. `GetFeature(0xA0 …)` into a 1041-byte buffer (pre-fill byte0 = `0xA0`).
   Hardware-tested WebHID clients should also tolerate the full config blob arriving from
   `GetFeature(0xA1)` or in a 1040-byte payload-only shape (`00 01 ...`, `A0 01 ...`, or
   `A1 01 ...`) as long as the documented field offsets are intact.
4. Success when response byte `[1] == 0x01` **and** the frame is structurally plausible
   (stage count, active stage, polling divider, and stage-1 CPI in range). The **1024-byte
   payload starts at report offset 16** (see §3).

**Write configuration** (`FUN_00404170`):
1. Build the 1041-byte buffer: word `0x11A0`, payload at offset 16 (§3), rest zero.
2. `SetFeature(0xA0 …)`.
3. `Sleep(N)` (the tool uses ~300 ms on apply, growing on retry).
4. `GetFeature(0xA1 …)` (64 B) to read back status.

**Factory reset** (`FUN_00404710`): `SetFeature(0xA1)` word `0x13A1`; `Sleep(1100 ms)`;
`GetFeature(0xA1)`; OK when byte `[1]==0x01`.

**Firmware version** (`FUN_004045d0`): `SetFeature(0xA1)` word `0x02A1`; `Sleep(50 ms)`;
`GetFeature(0xA1)` (64 B). Hardware read-back on OP1 8k v2 has been observed as a
patch/major byte pair around offsets 17/18: `07 01` displays as **`V1.07`**. Older notes
treated this as a little-endian fixed-point integer (`0x0107 / 100 = V2.63`), which is wrong
for that response shape. A robust client should prefer the patch/major pair and keep the
`raw/100` interpretation only as a fallback for other firmware responses.

**Retry semantics** (`FUN_00403830` write / `FUN_00403900` read): on failure with
`GetLastError()` ∈ {`0x15`, `0x17`, `0x1D`, `0x57`, `0x65B`} the tool retries up to 4×
with `Sleep(50 ms)`; on read, a `0x03` status is retried with an increasing back-off up
to ~1 s. A robust re-implementation should do the same.

### 2.4 Real-time event / notification input reports (report `0x03`)  ✅

Separately from the feature-report channel above, the mouse **pushes** unsolicited HID
**input reports** to notify the host of on-device changes (physical DPI-button presses,
etc.). This is how the app updates instantly (<20 ms) without polling.

Implementation in the tool: it statically links **hidapi**, calls
`hid_open(0x3367, 0x1978)` at startup (a second handle, independent of the feature-report
`CreateFile` handle), and spins up a background thread (`__beginthreadex`, `FUN_004128f0`)
that loops `hid_read(handle, buf, 8)` (blocking with a timeout, then `Sleep(80 ms)`).
Because `hid_read` blocks until a report arrives, the reaction to a physical press is
immediate; the sleep only throttles the idle loop.

**Event report format** — 8 bytes, **report ID `0x03`**:

| Byte | Meaning |
|---|---|
| `[0]` | report ID = `0x03` |
| `[1]` | **event type** |
| `[2]` | **value** |
| `[3..7]` | unused |

The tool acts on three event types (`FUN_004135c0`); others are ignored:

| `[1]` event | Meaning | `[2]` value |
|---|---|---|
| `0x02` | **Active DPI stage changed** | new stage `0–3` (0=CPI 1 … 3=CPI 4) → updates byte 29 & the radio (`FUN_0040db80`) |
| `0x06` | **Polling rate changed** | divider ∈ {`1`,`2`,`4`,`8`} = `8000/div` Hz → updates the polling combo |
| `0xB4` | numeric value (shown as `%d`) | value — telemetry/live read-out; not persisted |

This channel is **read-only** (notifications). To change the active stage *from software*
you still write the config blob (§4.3.1); the mouse then also emits a `0x02` event
reflecting the new state. A re-implementation that wants a live indicator should open the
device and read input reports rather than poll.

> **Correction to earlier revisions of this doc:** I initially reported “no input-report
> reader / the app re-reads on device-change.” That was wrong — the read path was hidden
> because the binary statically links hidapi (so the calls are `hid_read`→`ReadFile`, not a
> bare `ReadFile`) and runs on a worker thread. The `<20 ms` latency you can observe is the
> tell-tale of exactly this push channel.

---

## 3. The configuration blob (report `0xA0`)

The 1041-byte report is: `[0]=0xA0`, `[1]=0x11` (on write) / echoed on read, bytes `2..15`
reserved (zero), then a **1024-byte payload from offset 16 to 1039**. In practice only
**offsets 16–130 carry meaningful data**; everything from 131 onward is zero padding.

Offsets below are **absolute offsets into the feature report** (i.e. byte 0 = report ID).
This is the single most important table in the document.

| Off (dec) | Off (hex) | Size | Field | Enc / notes |
|---:|---|---|---|---|
| 0 | 00 | 1 | Report ID | `0xA0` |
| 1 | 01 | 1 | Sub-op | `0x11` write / echoed on read |
| 2–15 | 02–0F | 14 | reserved | zero |
| 16 | 10 | 1 | reserved | zero (internal byte, always 0) 🟧 |
| 17–20 | 11–14 | 4 | reserved | zero |
| **21** | 15 | 1 | **Polling-rate divider** | `Hz = 8000 / divider` ✅ (§4.1) |
| **22** | 16 | 1 | **Filter flags** | bit0 `0x01`=Slamclick, bit4 `0x10`=Motion-Jitter ✅ (§4.4) |
| 23 | 17 | 1 | reserved/unknown | no UI control writes it 🟧 |
| **24** | 18 | 1 | **Disable LED on Lift-Off** | stored **inverted**: `byte = NOT(checkbox)` ✅ (dialog-135 IDC 1066; §4.7) |
| **25** | 19 | 1 | **LOD (lift-off distance)** | index 0–10 ✅ (IDC 1024; §4.2) |
| **26** | 1A | 1 | **Angle Snapping** | 0/1 ✅ (IDC 1064) |
| **27** | 1B | 1 | **Ripple Control** | 0/1 ✅ (IDC 1065) |
| **28** | 1C | 1 | **Motion Sync** | 0/1 ✅ (IDC 1028) |
| **29** | 1D | 1 | **Active DPI stage** | 0–3 (0=CPI 1 … 3=CPI 4); app default = CPI 2 → `1` ✅ (§4.3.1) |
| **30** | 1E | 1 | **CPI stage count** | 1–4 ✅ (IDC 1019; §4.3) |
| **31–50** | 1F–32 | 20 | **Per-stage LED colors** | 4 × `{R,G,B,enable,stage#}` ✅ (§4.7) |
| **51–70** | 33–46 | 20 | **CPI stages 1–4** | 4 × `{split, X_u16, Y_u16}` ✅ (§4.3) |
| **71–76** | 47–4C | 6 | **Physical Left button mapping** `{type, params[5]}` | right-handed = `00 01` (plain LEFT CLICK); left-handed = Left's user action. **All-zero disables Left** (observed on hardware — the earlier "zero on normal use" note was wrong). ✅ (§4.6.1, WebHID capture 2026-07-05, FW V1.07) |
| **77–125** | 4D–7D | 49 | **Button configs 0–6** | 7 × 7-byte record ✅ (§4.5–4.6) |
| 126 | 7E | 1 | reserved | zero 🟧 |
| **127** | 7F | 1 | **Sensor Glass Mode** | 0/1 ✅ (IDC 1031; locks polling — §4.8) |
| **128** | 80 | 1 | **Sensor Angle Tuning** | signed 8-bit, range −127…+127 (0 = neutral) ✅ (IDC 1038; §4.8) |
| **129** | 81 | 1 | **Force max Sensor fps** | 0/1 ✅ (IDC 1032; §4.8) |
| **130** | 82 | 1 | preserved / UI acknowledgement byte | The stock UI has an “I understand…” checkbox near Multiclick, but WebHID testing has not shown this byte is needed for normal config writes. Preserve it. |
| 131–1039 | 83–40F | 909 | zero padding | |

> **How this table was derived.** The tool keeps an internal working copy of the config and
> a serializer (`FUN_004042c0`) that maps every internal byte to its wire offset; the
> deserializer (`FUN_00403c30`) is the exact inverse. The offsets above come from parsing
> that serializer. The **field meanings** come from the UI gather/populate handlers
> (`FUN_004107b0`, `FUN_0040d1c0`, `FUN_004109f0`, `FUN_0040d640`) combined with the dialog
> resource captions. Where all three sources agree, the row is ✅.

---

## 4. Setting encodings

### 4.1 Polling rate  ✅

Byte **21** = *divider*; `polling_rate_Hz = 8000 / divider`.

The dropdown offers four values:

| Dropdown index | divider (byte 21) | Rate |
|---:|---:|---|
| 0 | 8 | 1000 Hz |
| 1 | 4 | 2000 Hz |
| 2 | 2 | 4000 Hz |
| 3 | 1 | 8000 Hz |

The divider is a raw byte, so other values are physically possible (`16→500 Hz`,
`32→250 Hz`, `64→125 Hz`), but the stock UI only exposes the four above. **When Sensor Glass
Mode (byte 127) is enabled the tool locks the polling selector** and writes a fixed divider
(see §4.8) — glass tracking constrains the rate.

> Earlier drafts of this document guessed a “custom polling divider” feature here; that was
> a mis-read borrowed from the older community tool. The OP1 8k v2 has no such control — the
> polling combo is the only polling UI, and Glass Mode is what locks it.

### 4.2 Lift-off distance (LOD)  ✅

Byte **25** = a **combo-box index**, not a millimetre value. Normal list (11 entries,
index 0–10):

| Index | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| LOD | 0.7 | 0.8 | 0.9 | 1.0 | 1.1 | 1.2 | 1.3 | 1.4 | 1.5 | 1.6 | 1.7 mm |

When **Sensor Glass Mode** is active the tool swaps in a **2-entry** list: index `0 = 1.0 mm`,
index `1 = 2.0 mm` (`FUN_0040d640`). The raw byte is always just the selected list index, so
its millimetre meaning depends on whether Glass Mode is on.

### 4.3 CPI / DPI stages  ✅

- Byte **30** = number of active stages, 1–4. Selecting *N* keeps the **lowest N** stages
  (CPI 1…N); the higher stages are ignored.
- Bytes **51–70** = 4 stage records of 5 bytes each:

  | +0 | +1..+2 | +3..+4 |
  |---|---|---|
  | `xy_split` (1 if X≠Y else 0) | `X` (u16 LE) | `Y` (u16 LE) |

  Stage 1 @51, stage 2 @56, stage 3 @61, stage 4 @66.

- **CPI value = the actual counts-per-inch number** stored directly as u16. The tool
  quantizes each value before sending (`FUN_0040c9a0`): clamp to `[10, 30000]`; round to the
  nearest **10** for values ≤ 10000, nearest **50** for values > 10000.
- If `xy_split==0`, X and Y are equal (single CPI); if `1`, they differ (independent X/Y).
  The **"X/Y Settings"** toggle in the app just enables independent X/Y editing; on the wire
  it is stored **per stage** in each record's `xy_split` byte (there is no global flag).

#### 4.3.1 Active DPI stage & the two write paths  ✅

Byte **29** is the **currently-active DPI stage**: `0`=CPI 1, `1`=CPI 2, `2`=CPI 3, `3`=CPI 4
(the app defaults to CPI 2). In the UI it is the column of four radio buttons next to the
CPI 1–4 rows; the coloured rectangle under each row is that stage's LED colour (§4.7).

There is **one write report** (`0xA0` / `0x11A0`, 1041 bytes) but the tool triggers it from
**two different places**, which is the "two paths" behaviour you can observe:

| Path | Trigger | What it does | Feels |
|---|---|---|---|
| **Apply** (`FUN_004139e0`) | *Apply* button | Re-reads **every** control (DPI values, filters, button maps, colours…) into the config, then writes the whole blob. | deliberate / "slow" |
| **Stage switch** (`FUN_00413b40`) | clicking a DPI radio | Writes the **same** blob immediately **without** re-reading the UI — only byte 29 (and internal stage ordering) changes. | instant, no Apply needed |

Both are the identical 1041-byte feature report; the stage-switch path just doesn't gather
the rest of the UI first, so it commits only the stage change and takes effect in ~0.5 s.
The setting is persistent because it is part of the stored config.

**Reading the active stage / hardware sync.** When you press the mouse's **physical** DPI
button, the mouse advances its own active stage on-device, lights the corresponding colour,
**and pushes a `0x03`/`0x02` event input report** carrying the new stage. That event channel
(§2.4) is what updates the app's radio in <20 ms — the mouse notifies the host; the host does
not poll. You can also recover the current stage at any time from **byte 29 of a config read**
(`0x12A1`→`0xA0`). For a live indicator, subscribe to the input-report stream (§2.4);
byte 29 of the config is the equivalent on-demand snapshot.

### 4.4 Debounce / motion filters  ✅

Byte **22** is a bitfield:

| Bit | Mask | Setting |
|---|---|---|
| 0 | `0x01` | Slamclick Filter |
| 4 | `0x10` | Motion Jitter Filter |

(Other bits unused/zero.) These are independent toggles.

Note the tool's own warning text: *“the Multiclick Filter is not a traditional debounce
slider; lower values don't affect click latency.”* The per-button multiclick counts live in
the button records (§4.5), not here.

### 4.5 Per-button records: multiclick filter & SPDT mode  ✅

Bytes **77–125** hold **seven** 7-byte button records:

| Record | Offset | +0 control byte belongs to | Mapping bytes normally hold | Multiclick filter? | SPDT? |
|---|---|---|---|---|---|
| 0 | 77 | **Left** | **Right** action in right-handed mode; fixed LEFT CLICK in left-handed mode | ✅ (0-25) | ✅ |
| 1 | 84 | **Right** | **Middle** action | ✅ (0-25) | ✅ |
| 2 | 91 | **Middle** | **Forward** action | ✅ (0-25) | - |
| 3 | 98 | **Forward** | **Back** action | ✅ (0-25) | - |
| 4 | 105 | **Back** | hidden/preserved mapping slot, often CPI Loop | ✅ (0-25) | - |
| 5 | 112 | - | **Wheel Up** action | - | - |
| 6 | 119 | - | **Wheel Down** action | - | - |

So the **5 physical buttons** (Left/Right/Middle/Forward/Back) have a multiclick filter;
**Left & Right** additionally have the SPDT selector; **Wheel Up/Down** are mappable inputs
with neither. The control byte and the visible remap action are intentionally not the same
physical slot for the main right-handed mappings; preserve record 4's mapping unless the
user is deliberately editing raw bytes.

Each record:

| Rec byte | Meaning |
|---|---|
| +0 | **SPDT mode / Multiclick count** |
| +1 | **Mapping type** (§4.6) |
| +2 | Mapping param 0 |
| +3 | Mapping param 1 |
| +4 | Mapping param 2 |
| +5 | Mapping param 3 |
| +6 | Mapping param 4 |

**Byte +0 (SPDT / multiclick):**
- `0x00–0x19` (0–25) → **multiclick filter count** (default `8`).
- `0xF0` → **GX Safe Mode** SPDT (Left/Right buttons only).
- `0xF1` → **GX Speed Mode** SPDT (Left/Right buttons only).
- SPDT dropdown default is **Off** (byte `< 0xF0`), meaning the multiclick filter is used.

(When SPDT is Safe/Speed the multiclick number is not applicable; the tool forces `8`
internally.) ✅ (`FUN_004107b0`, `FUN_004109f0`).

**Right-handed mapping alignment correction:** the `+0` control byte follows the physical
button table above, but the action mapping bytes are shifted for the visible right-handed
button-mapping UI because Left is fixed primary. In observed default reads, Right/Middle/
Forward/Back actions are stored in records 0/1/2/3 respectively, while their multiclick/SPDT
control bytes remain in records 1/2/3/4. Record 4's mapping can contain the preserved
CPI-loop assignment; do not overwrite it when editing Back. Wheel Up/Down mappings remain
in records 5/6. Byte 130 should be preserved rather than used as an app-managed master
switch.

### 4.6 Button mapping (action assignment)  ✅

The action for a button is encoded by **byte +1 = type** and **bytes +2… = params**
(decoded by `FUN_00407c20`). `param0` = record byte +2, `param1` = +3, etc.

| type (+1) | Meaning | param0 (+2) | extra |
|---:|---|---|---|
| `0x00` | **Mouse button** | `1`=Left, `2`=Right, `4`=Middle, `8`=Back, `0x10`=Forward | — |
| `0x01` | **Scroll wheel** | `0x01`=Up, `0xFF`=Down | — |
| `0x02` | **Keyboard** | modifier mask (see below) | `param1(+3)` = HID keycode |
| `0x09` | **CPI Loop** (cycle stages) | `0xF1` | — |
| `0x0C` | **Fixed CPI** | *(unused)* | `+3..+4` = X (u16 LE), `+5..+6` = Y (u16 LE) |
| `0x18` | **Browser / Explorer** | `0x96`=Browser, `0x94`=Explorer | — |
| `0x20` | **Media key** | see media table | — |
| `0xFF` | **Disabled** | — | — |

**Keyboard modifier mask** (type `0x02`, param0):

| Bit | Mask | Modifier |
|---|---|---|
| 0 | `0x01` | Ctrl |
| 1 | `0x02` | Shift |
| 2 | `0x04` | Alt |
| 3 | `0x08` | Win |

The key itself (param1) is a standard USB HID Usage-ID keycode.

**Media keys** (type `0x20`, param0) — USB HID Consumer usage IDs:

| Value | Action |
|---|---|
| `0xCD` | Play / Pause |
| `0xB5` | Next Track |
| `0xB6` | Previous Track |
| `0xE2` | Mute |
| `0xE9` | Volume Up |
| `0xEA` | Volume Down |

*(Browser/Explorer under type `0x18`: `0x96` = Browser Home, `0x94` = File Explorer.)*

For **Fixed CPI** (type `0x0C`) the display shows `CPI: n` when X==Y, else `X: x, Y: y`.
The Fixed-CPI popup has its own independent-X/Y checkbox; X and Y are stored as the two
`u16`s above.

The app groups these in a nested menu (**MOUSE** → left/right/middle/forward/back/scroll-up/
scroll-down; **KEYBOARD KEY** → key + Shift/Ctrl/Win/Alt; **CPI** → CPI Loop / Fixed CPI;
**MEDIA** → play-pause/next/prev/mute/vol±/browser/explorer; **DISABLE**), but every one of
those maps onto a `(type, params)` pair in the table above.

#### 4.6.1 Left-handed Mode  ✅ (hardware-verified 2026-07-05, OP1 8k v2 FW V1.07)

The Button-Mapping tab has a **Left-handed Mode** checkbox that swaps the role of the two
main buttons:

- **Right-handed (default):** physical **Left** = the primary click (fixed); the user may
  remap **Right, Middle, Forward, Back, Wheel Up, Wheel Down** (6 dropdowns).
- **Left-handed:** physical **Right** = the primary click; the user may remap **Left,
  Middle, Forward, Back, Wheel Up, Wheel Down**.

**Verified byte encoding** (WebHID capture of the official tool's states; earlier 🟧 note
"zero on normal use" was wrong):

- **Bytes 71–76 are physical Left's mapping slot** — a 6-byte `{type, params[5]}` record
  (no ctl byte) sitting immediately before record 0. Record 0's mapping bytes are physical
  Right's, records 1–3 Middle/Forward/Back, as in §4.5.
- **Right-handed (factory):** 71–76 = `00 01 00 00 00 00` (plain LEFT CLICK), record 0 =
  Right's user action (factory `00 02`).
- **Left-handed:** 71–76 = Left's user action (factory-lefty `00 02`), record 0 =
  `00 01 00 00 00 00` (plain LEFT CLICK).
- Handedness is derived, not flagged: **right-handed ⇔ 71–76 holds the plain LEFT CLICK**
  (this is `FUN_00408070`'s "slot 0/Left is a plain LEFT CLICK" — slot 0 = the 71-based
  slot). Multiclick/SPDT ctl bytes are untouched by handedness (they follow the physical
  buttons, §4.5).
- ⚠️ Writing **all-zero** to 71–76 maps Left to "Mouse, no button" — the Left button goes
  **dead** (confirmed on hardware). Never zero this slot; right-handed restores `00 01`.

### 4.7 LED / lighting

The tool has a dedicated LED tab (LED On/Off, an **LED effect** dropdown, per-zone
selectors *DPI led / Logo led / Scroll led*, and R/G/B inputs). The OP1 8k v2 physically has
a DPI-stage indicator LED; the *Logo/Scroll* selectors appear to be carried over from a
shared UI template.

- **Bytes 31–50 — per-CPI-stage color records** ✅, 4 records of 5 bytes:

  | +0 | +1 | +2 | +3 | +4 |
  |---|---|---|---|---|
  | R | G | B | enable (0/1) | stage index (1–4) |

  The current hardware-tested WebHID app preserves these bytes unchanged. On tested OP1 8k
  v2 hardware, the visible stage indicator colors are fixed by firmware and do **not** track
  these blob RGB bytes: CPI 1-4 display blue / green / yellow / red. Treat these bytes as
  device-owned unless you have a separate hardware capture proving the target model honors
  writes to them.
- **Byte 24 — “Disable LED on Lift-Off”** ✅ (dialog-135 IDC 1066). Stored **inverted**
  (`byte = NOT(checkbox)`): the byte means *LED stays on during lift-off*.
- **Which stage's colour shows** = the active DPI stage, byte 29 (§4.3.1).

> LED master on/off: earlier static-analysis notes tied the LED tab to these bytes. The
> current JS does not manage them because hardware testing showed the real stage colors are
> firmware-fixed; read-modify-write clients should preserve them.

### 4.8 Sensor tuning (OP1 8k v2 extras)  ✅

Exposed on the performance tab (dialog 140); each traced to its captioned control:

| Offset | Setting | IDC | Encoding |
|---|---|---|---|
| 127 | **Sensor Glass Mode** | 1031 | 0/1. When **on**, the tool disables the polling-rate dropdown and forces a fixed divider (§4.1). |
| 128 | **Sensor Angle Tuning** | 1038 | **signed** 8-bit trim (slider with a numeric buddy edit); `0` = neutral. |
| 129 | **Force max Sensor fps** | 1032 | 0/1. |

All three are confirmed by tracing control-ID → `DoDataExchange` member → the gather handler
`FUN_004107b0` that writes each config byte.

---

## 5. Reference: complete UI inventory (from dialog resources)

The tool's setting tabs and every control, extracted from the PE's `RT_DIALOG`
resources (definitive captions):

**Top bar (always visible):** Firmware Version (patch/major bytes from the device — §2.3),
Software Version (the tool's own build string, e.g. `V1.04`; cosmetic, not a device value),
and **Factory Reset** (issues `0x13A1` — applies instantly, no “Apply” needed — §2.3).

**Basic / Sensor-CPI tab (dialog 135):** LOD, CPI Levels, per-stage CPI values + colours,
active-DPI-stage radios (§4.3.1), X/Y split (“X/Y Settings”), Angle Snapping, Ripple Control,
Surface Calibration, Disable LED on Lift-Off, “Apply CPI settings”.

**LED tab (dialog 137):** LED On / Off, LED effect (dropdown), Scroll led, Logo led,
DPI led, Red / Green / Blue inputs, “Apply led settings”.

**Advanced / Performance tab (dialog 140):** Motion Sync, Polling Rate, Left/Right/Middle/
Forward/Back Button Multiclick Filter (5), two SPDT selectors (Off / GX Speed Mode /
GX Safe Mode), Slamclick Filter, **Motion Jitter Filter**, Sensor Glass Mode,
Force max Sensor fps, and Sensor Angle Tuning. The stock UI also shows a
multiclick-filter “I understand…” acknowledgement checkbox; preserve the backing
byte, but it is not needed as an app control.

**Button-mapping tab (dialog for buttons):** **Left-handed Mode** checkbox (§4.6.1) and six
remap dropdowns — the swappable primary (Right, or Left in left-handed mode), Middle,
Forward, Back, Wheel Up, Wheel Down — each assignable to any action in §4.6.

> **Note on your feature list:** the Advanced tab also contains **Motion Jitter Filter**
> (byte 22, bit `0x10`) — easy to miss next to Slamclick Filter, but it is present and
> documented. Everything else in your list matches the sections above.

---

## 6. Worked examples

### 6.1 Reading the current config (pseudo-code, hidapi-style)

```c
dev = open_vendor_collection(0x3367, 0x1978, /*usage_page*/0xFF01, /*usage*/0x02);

// request load
uint8_t cmd[64] = {0};
cmd[0] = 0xA1;          // report id
cmd[1] = 0x12;          // loadConfig
hid_send_feature_report(dev, cmd, 64);
sleep_ms(80);

// read blob
uint8_t cfg[1041] = {0};
cfg[0] = 0xA0;          // report id to read
hid_get_feature_report(dev, cfg, 1041);
assert(cfg[1] == 0x01); // status OK

int polling_hz   = 8000 / cfg[21];
int slamclick    = cfg[22] & 0x01;
int jitter       = (cfg[22] >> 4) & 1;
int lod_index    = cfg[25];
int angle_snap   = cfg[26];
int ripple       = cfg[27];
int motion_sync  = cfg[28];
int cpi_stages   = cfg[30];
for (int s = 0; s < 4; ++s) {
    uint8_t *st = &cfg[51 + s*5];
    int split = st[0];
    int x = st[1] | (st[2] << 8);
    int y = st[3] | (st[4] << 8);
    uint8_t *col = &cfg[31 + s*5];   // R,G,B,enable,index
}
for (int b = 0; b < 7; ++b) {
    uint8_t *rec = &cfg[77 + b*7];
    int spdt_or_multiclick = rec[0]; // 0xF0/0xF1 = SPDT, else count
    int map_type = rec[1];
    // params rec[2..6]
}
```

### 6.2 Writing a config

```c
uint8_t cfg[1041] = {0};
cfg[0] = 0xA0; cfg[1] = 0x11;     // storeConfig
// ... fill offsets 21..130 per §3/§4 ...
hid_send_feature_report(dev, cfg, 1041);
sleep_ms(300);
uint8_t status[64] = {0}; status[0] = 0xA1;
hid_get_feature_report(dev, status, 64);   // optional read-back
```

Set unused payload bytes to zero only when constructing a factory-like blob from scratch.
For normal tooling, the safest write path is **read-modify-write**: load the current blob,
change only the fields you touch, and store it back. Preserve reserved bytes, bytes 31-50,
the handedness slot 71-76 unless intentionally changing handedness, record 4's hidden
mapping, byte 130, and all unknown padding.

### 6.3 Example: map the Back button (slot 4) to Ctrl+C

```
cfg[105+0] = 0x08;   // Back multiclick count 8 (SPDT n/a on Back)
cfg[98+1]  = 0x02;   // Back mapping type = Keyboard (right-handed mapping is shifted)
cfg[98+2]  = 0x01;   // modifiers = Ctrl
cfg[98+3]  = 0x06;   // HID keycode for 'c'
cfg[98+4] = cfg[98+5] = cfg[98+6] = 0;
```

### 6.4 Example: set stage 1 to 1600 CPI, single X/Y

```
cfg[51] = 0;                       // xy_split = 0
cfg[52] = 1600 & 0xFF;             // X low
cfg[53] = (1600 >> 8) & 0xFF;      // X high
cfg[54] = 1600 & 0xFF;             // Y low
cfg[55] = (1600 >> 8) & 0xFF;      // Y high
cfg[30] = 1;                       // (or however many stages you enable)
```

### 6.5 Example: switch the active DPI stage (instant, no “Apply”)

```c
// read current blob, change only byte 29, write it back
load_config(dev, cfg);             // 0x12A1 -> 0xA0  (see 6.1)
cfg[0] = 0xA0; cfg[1] = 0x11;      // storeConfig
cfg[29] = 2;                       // -> CPI 3 becomes active
hid_send_feature_report(dev, cfg, 1041);
// mouse switches stage in ~0.5 s and shows CPI 3's colour on lift-off.

// to reflect a *physical* DPI-button press in your UI, DON'T poll — read the event stream:
//   uint8_t ev[8];
//   while (hid_read(dev, ev, 8) > 0)          // blocks until the mouse pushes a report
//       if (ev[0]==0x03 && ev[1]==0x02)
//           active_stage = ev[2];             // 0..3, arrives <20 ms after the press
// (ev[0]==0x03 && ev[1]==0x06 -> polling changed, ev[2] = divider 1/2/4/8)
```

---

## 7. What to verify on real hardware

Every setting that has a text label in the app is now ✅ and safe to implement directly.
Almost nothing remains open:

1. **Byte 23** and **byte 126** — no UI control writes them; treat as reserved/zero
   (preserve on write).
2. Event type **`0xB4`** on the input channel (§2.4) is shown by the tool as a bare number;
   its exact meaning (live CPI read-out vs. other telemetry) is cosmetic — you can ignore it.

The decisive check for anything you want to confirm is the single-setting diff: read the
blob, change one control in the official tool, hit Apply, capture the outgoing `0xA0` report
(USBPcap/Wireshark), and diff against the previous blob. For the event channel, capture the
**IN** reports while pressing the physical DPI/polling buttons. A read-modify-write client
rarely needs any of this, since it preserves untouched bytes.

---

## 8. Appendix — methodology & provenance

- **Tooling:** Ghidra headless (`analyzeHeadless`) for disassembly/decompilation; a custom
  Java `GhidraScript` to (a) find every caller of `HidD_SetFeature`/`HidD_GetFeature`,
  (b) decompile the serializer/deserializer and all UI gather/populate handlers, and
  (c) dump `DoDataExchange` (DDX) control-ID↔member maps. A Python `RT_DIALOG` parser
  extracted the dialog templates (control IDs + captions).
- **Key functions:** transport wrappers `FUN_00403830` (SetFeature) / `FUN_00403900`
  (GetFeature); `FUN_00404170` write, `FUN_00403b00` read, `FUN_00404710` reset,
  `FUN_004045d0` version, `FUN_004035d0` device-open; serializer `FUN_004042c0` /
  deserializer `FUN_00403c30`; UI handlers `FUN_004107b0`/`FUN_004109f0` (performance),
  `FUN_0040d1c0`/`FUN_0040d640` (sensor/CPI), `FUN_00408070`/`FUN_00407c20` (button
  mapping), `FUN_0040c9a0` (CPI quantization). Event channel: `FUN_00412990` (opens hidapi
  handle + spawns reader thread), `FUN_004128f0` (reader loop), `FUN_004135c0` /
  `FUN_0040db80` (event dispatch → DPI-stage radio).
- **Two HID access layers:** the config blob uses direct `HidD_Set/GetFeature` on a handle
  opened by `FUN_004035d0` (vendor collection, usage page `0xFF01`/usage `0x02`); the
  real-time event channel uses a **statically-linked hidapi** (`hid_open`/`hid_read`) on a
  second handle. Recognising the hidapi symbols was the key to finding the push channel.
- **Independent corroboration:** the wire layout (polling@21, filters@22, LOD@25,
  angle@26, ripple@27, motion-sync@28, CPI-count@30, CPI stages@51, button records@77) was
  independently reproduced by the community *UnofficialEGGMouseConfig* struct — a useful
  sanity check, though the OP1 8k v2 adds fields that project does not model (finer LOD
  index, preserved stage color bytes, glass mode, force-max-fps, sensor angle tuning, richer
  button-mapping types). Those were recovered directly from this binary.
