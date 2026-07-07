# OP1 8k v2 Configuration Tool — Coverage Audit

This summarizes how the reverse-engineered protocol doc
([OP1_8k_v2_USB_Protocol.md](OP1_8k_v2_USB_Protocol.md)) maps onto every control
exposed by *Endgame Gear OP1 8k v2 Configuration Tool v1.04*. The goal is not to
replicate the app's UI, but to guarantee no feature is left undocumented.

## Coverage audit

| App feature | Documented? | Where / encoding |
|---|---|---|
| Firmware Version `V1.07…` | ✅ | §2.3 — patch/major bytes near offset 17; raw/100 fallback |
| Software Version `V1.04` | ✅ (noted) | §5 — it's the *tool's* build string, not a device value |
| **Factory Reset** (instant, no Apply) | ✅ | §2.3 — `0x13A1` command |
| LOD 0.7–1.7 mm, 0.1 steps | ✅ | §4.2 — byte 25, index 0–10 |
| CPI Levels 1–4 (keeps lowest N) | ✅ | §4.3 — byte 30 |
| X/Y Settings (independent per stage) | ✅ | §4.3 — per-stage `xy_split` (no global flag) |
| Angle Snapping / Ripple Control | ✅ | bytes 26 / 27 |
| Disable LED on Lift-Off | ✅ | byte 24 (inverted) |
| Polling 1000/2000/4000/8000 | ✅ | §4.1 — byte 21 divider |
| Motion Sync / Force max Sensor fps / Slamclick / Glass Mode | ✅ | bytes 28 / 129 / 22.0 / 127 |
| **Motion Jitter Filter** | ✅ | byte 22 bit `0x10` — **not on user's list; it is present** |
| Sensor Angle Tuning −127…+127 | ✅ | byte 128 |
| Multiclick, 0–25 ×5 buttons | ✅ | records in §4.5; byte 130 is preserved only (no app control) |
| SPDT Off / GX Speed / GX Safe (L,R) | ✅ | §4.5 — `<0xF0` / `0xF1` / `0xF0` |
| **Left-handed Mode** | ✅ | §4.6.1 |
| Mappable: Right/Left, Middle, Fwd, Back, **Wheel Up/Down** | ✅ | §4.5 slot table (slots 5–6) |
| Mapping menu: MOUSE / KEYBOARD / CPI / MEDIA / DISABLE | ✅ | §4.6 (all types + params) |

## Gaps the feature list caught (now fixed)

1. **Wheel Up / Wheel Down** — button slots 5–6 were previously labeled "spare."
   They are the mappable **Wheel Up** and **Wheel Down** inputs (confirmed by the
   strings and the button dialog). Slot table fixed.
2. **Left-handed Mode** — promoted from a vague "handedness" note to §4.6.1. Key
   nuance: it is **not a standalone flag** — the tool derives it from the button
   records (which button holds `LEFT CLICK`), and the swapped-primary mapping lives
   in the wire-71–76 region. Flagged 🟧 with a "toggle it and diff the blob"
   instruction — the only field recommended for byte-for-byte verification.
3. **Motion Jitter Filter** — present in Advanced (byte 22, bit `0x10`); added a
   callout in §5 since it was absent from the user's list.
4. Tightened **Sensor Angle Tuning** to −127…+127; added the **CPI-levels "keeps
   lowest N"** and **X/Y-toggle-is-per-stage** clarifications.

## Two things worth confirming

- **Left-handed Mode byte encoding** (the 71–76 swap) — ✅ **resolved 2026-07-05** by a
  WebHID capture of the official tool's two states (OP1 8k v2, FW V1.07): 71–76 is
  physical Left's `{type, params[5]}` mapping slot; right-handed ⇔ it holds plain
  LEFT CLICK `00 01` (record 0 = Right's action), left-handed ⇔ record 0 holds the
  plain LEFT CLICK and 71–76 holds Left's action. All-zero 71–76 disables Left.
  Details in the V2 doc §4.6.1.
- Whether the specific app build actually surfaces **Motion Jitter Filter** in the
  Advanced tab. It exists in the binary's dialog resources; a build that hides it
  is a version difference worth noting.

## Bottom line

The doc covers every control in the enumeration plus several the list omitted
(Motion Jitter Filter, preserved per-stage color bytes, the active-DPI-stage radios, and
the real-time event channel). Nothing in the app's feature set is missing from
[OP1_8k_v2_USB_Protocol.md](OP1_8k_v2_USB_Protocol.md).
