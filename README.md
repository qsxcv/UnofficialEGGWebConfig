# Endgame Gear 8k - Web Config

A dependency-free WebHID configuration app for the Endgame Gear 8k mouse series,
built from the reverse-engineered protocol in
[`notes/Endgame_8k_Mice_MultiDevice_Protocol.md`](notes/Endgame_8k_Mice_MultiDevice_Protocol.md)
and [`notes/OP1_8k_v2_USB_Protocol.md`](notes/OP1_8k_v2_USB_Protocol.md).
Vanilla JS + CSS only - no build step, no frameworks, no network access.

## Supported devices (VID `0x3367`)

| Device | PID | Family | CPI range / step | LOD options |
|---|---|---|---|---|
| OP1 8k | `0x1964` | V1 | 50-26 000 / 50 | 0.7 / 1 / 2 mm |
| XM2 8k | `0x1966` | V1 | 50-26 000 / 50 | 0.7 / 1 / 2 mm |
| OP1 8k Purple Frost | `0x1976` | V1 | 50-30 000 / 50 | 0.7 / 1 / 2 mm |
| OP1 8k v2 | `0x1978` | V2 | 10-30 000 / 10 (<=10k) then 50 | 0.7-1.7 mm (+2.0 in Glass Mode) |
| XM2 8k v2 | `0x1980` | V2 | 10-30 000 / 10 (<=10k) then 50 | 0.7-1.7 mm (+2.0 in Glass Mode) |

V2-only controls (Sensor Glass Mode, Sensor Angle Tuning, Force max Sensor fps,
Disable LED on Lift-Off) appear only when a V2 mouse is connected; the
corresponding bytes are never written on V1 devices.

## Running it

WebHID needs a Chromium-based browser (Chrome, Edge, Brave, Opera - not
Firefox/Safari) and a secure context:

```sh
cd webapp
python -m http.server 8000
# open http://localhost:8000 in Chrome
```

**Linux:** the browser needs permission on the hidraw node first -

```sh
printf '%s\n' 'KERNEL=="hidraw*", ATTRS{idVendor}=="3367", MODE="0660", TAG+="uaccess"' | sudo tee /etc/udev/rules.d/60-endgamegear.rules >/dev/null
sudo udevadm control --reload
sudo udevadm trigger
```

**First use:** click *Connect mouse* and pick your device in the browser chooser.
That authorization is remembered - from then on the app **auto-connects** to every
known mouse on page load and whenever one is hot-plugged (via
`navigator.hid.getDevices()` + `connect` events). *Forget device* revokes it.

**Demo mode (no hardware):** open `?demo=v2` (or `v1`, `purple`, `xm2`, `xm2v2`)
to drive the full UI against a simulated mouse.

## What it implements

- **Transport:** opcodes `0x11A0` store / `0x12A1` load / `0x13A1` factory reset /
  `0x02A1` version. Writes go out as `sendFeatureReport(0xA0, ...)` (1040-byte payload,
  first byte `0x11`). Reads: after the `0x12` load command the config frame is
  probed on both `receiveFeatureReport(0xA1)` and `receiveFeatureReport(0xA0)`.
  Hardware/Chrome combinations have returned the 1040-byte response as `00 01 ...`,
  `a0 01 ...`, or `a1 01 ...`, always with every field at its documented offset. The
  normalizer stamps the requested report ID into byte 0 instead of prepending a
  byte, so nothing shifts. Polls keep the official tool's timings and accept a
  frame only when it is structurally a config (OK status, stage count, polling
  divider, stage-1 CPI all in range) - ack frames can never be mistaken for one.
  The firmware version comes back as patch/major bytes near offset 17
  (`07 01` -> V1.07), with a raw/100 fallback.
- **Read-modify-write everywhere:** every Apply re-reads the current blob, changes
  only the bytes belonging to controls you see, writes, then reads back and
  verifies. Reserved/unknown bytes (16-20, 23, 71-76, 126, 130, 131+ and the hidden
  button-mapping slot) always ride through untouched - as do the V2-only bytes on
  V1 mice.
- **DPI stages:** count (1-4), per-stage CPI with independent X/Y split, active
  stage. Clicking a stage radio uses the official tool's
  **instant path** (single-byte change, no Apply). CPI values are clamped and
  quantized exactly like each official tool's own clamp function. The stage
  indicator colours are **fixed in firmware** (blue/green/yellow/red for stages
  1-4); the app shows those fixed colours and never writes the LED colour/enable
  bytes.
- **Live events:** the app listens to input report `0x03` - pressing the physical
  DPI button (event `0x02`) or changing polling on-device (event `0x06`) updates
  the UI in real time.
- **Sensor / performance:** polling rate (125/250/500/1000/2000/4000/8000 Hz as
  divider byte - the 125/250/500 Hz entries are extrapolated from the divider
  formula and are **not** in the stock tool; unverified on hardware),
  LOD (per-family list), Motion Sync, Angle Snapping, Ripple Control, Slamclick,
  Motion Jitter (also exposed on Purple Frost, where the stock tool hides it but
  the config bit exists), plus the V2 sensor-tuning group.
- **Buttons:** 7 visible slots (Left, Right, Middle, Forward, Back, Wheel Up/Down).
  Left is fixed primary in right-handed mode and Right is fixed primary in
  left-handed mode. The mapping bytes for Right/Middle/Forward/Back are shifted one
  raw record earlier than their multiclick/SPDT control bytes, matching the stock
  right-handed layout; Left's remappable left-handed action lives in wire bytes
  71-76. The hidden CPI-loop mapping slot is preserved. Remapping supports mouse
  buttons, scroll, keyboard shortcuts, CPI Loop, Fixed CPI, media keys, Browser
  Home/Explorer, and Disable. Multiclick filter 0-25 is exposed on the five
  physical buttons, with SPDT (GX Speed `0xF1` / GX Safe `0xF0`) on Left/Right.
- **Extras:** firmware-version display, reload and factory reset in the header; a
  Debug panel (bottom of the page) housing the JSON export/import of settings
  (re-clamped per device), forget-device, a live hex dump of the config region
  (changed bytes flagged `*`) and the transaction log.

## Deliberately not implemented

- **Stage LED controls.** The per-stage colour/enable bytes exist in the blob, but
  hardware testing showed the visible stage colours are fixed in firmware - so the
  app displays the fixed stage colours and preserves those bytes verbatim.
- **Writing a divider while Glass Mode is active** - the control locks; the byte
  is left as-is because the divider the official tool forces there is not pinned
  down in the docs.
- If a button has a mapping this app cannot decode, it shows
  **Custom (preserved)** and its bytes are kept verbatim until you pick something
  else.

## First run against real hardware - recommended check

This protocol comes from static reverse-engineering; the docs recommend one
sanity pass on first contact: connect, open the bottom *Debug* panel, and eyeball
the hex dump (polling divider at offset 21, stage CPIs from offset 51, button
records from 77). Then change one harmless setting (e.g. Angle Snapping), Apply,
and confirm the read-back log reports no unexpected canonicalization. The
read-modify-write design keeps everything else intact even if a byte means
something unexpected.

## Troubleshooting

- **"Could not open ..."** -> permissions: run the Linux setup block. If it still
  fails, restart the browser or replug the mouse.
- **"config read failed - no valid blob frame"** -> the mouse never produced a
  structurally valid config frame after the load command. The app already re-sends
  the load command and polls with back-off (the official tool's behaviour); if it
  still fails, open **Debug**: at connect it logs every interface's collections and
  declared report IDs, the chosen primary, report payload sizes, and the first
  bytes of every failed `GET(0xa1)` / `GET(0xa0)` poll. Those bytes identify the
  problem precisely.
- The app never writes anything unless a read completed with status OK, so a
  failing read leaves the mouse untouched.

## Tests

```sh
node test/roundtrip.js        # codec/clamp/action unit tests (no browser needed)
# UI end-to-end (headless):
#   open http://localhost:8000/?demo=v2&selftest=1  -> document.title = SELFTEST-PASS
```

## Files

| File | Role |
|---|---|
| `index.html` / `style.css` | static shell + theme |
| `profiles.js` | per-device capability profiles, CPI clamps, LOD lists, action & HID-key tables |
| `protocol.js` | WebHID transport (`EggMouse`), status/retry logic, blob parse/serialize |
| `app.js` | UI, device manager, auto-connect, apply pipeline, demo mode |
| `test/roundtrip.js` | offline unit tests (`node`) |
| `test/selftest.js` | in-browser end-to-end test (`?demo=v2&selftest=1`) |
