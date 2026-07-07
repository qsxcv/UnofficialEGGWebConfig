"use strict";
/*
 * In-browser UI selftest - runs only in demo mode with ?demo=v2&selftest=1.
 * Drives the real DOM handlers against the FakeMouse and asserts the bytes that
 * end up in the written config blob. Result: document.title = SELFTEST-PASS/FAIL
 * plus a #selftestOut <pre> with details.
 */
(async () => {
  const D = window.__EGG_DEBUG;
  const $ = s => document.querySelector(s);
  const fire = (el, type) => el.dispatchEvent(new Event(type));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const results = [];
  const ok = (cond, what) => results.push((cond ? "ok   " : "FAIL ") + what);

  try {
    // pristine state after connect
    ok(getComputedStyle($("#hero")).display === "none", "hero hidden once connected");
    ok(getComputedStyle($("#applyBar")).display === "none", "apply bar hidden when not dirty");
    ok($("#fwChip").textContent === "FW V1.07", "v2 demo shows firmware V1.07, not tool version V1.04");
    ok(document.querySelector("header #btnReset") && !document.querySelector("#dbgWrap #btnReset"),
      "factory reset is a header action, not a Debug action");
    ok(!document.querySelector("#cpiHint"), "CPI range hint is not rendered");
    ok(!document.querySelector("#v2Box h3"), "Sensor tuning v2 heading is not rendered");
    ok($("#tglMotionSync").checked === true, "initial Motion Sync reflects blob byte 28");
    const swatches = Array.from(document.querySelectorAll("#stageRows .swatch"))
      .map(el => getComputedStyle(el).backgroundColor);
    ok(JSON.stringify(swatches) === JSON.stringify([
      "rgb(0, 0, 255)", "rgb(0, 255, 0)", "rgb(255, 255, 0)", "rgb(255, 0, 0)",
    ]), "stage swatches are blue, green, yellow, red");
    ok(getComputedStyle(document.querySelector("#remapRows .fixed-wrap")).display === "none",
      "fixed-CPI inputs hidden for non-fixed mappings");
    ok(document.querySelectorAll("#remapRows .remap-row").length === 7 &&
       document.querySelectorAll("#settingsRows .settings-row").length === 5,
      "7 remapping rows, 5 settings rows (wheels have no settings)");

    // edits through the real controls
    document.querySelector('input[name="polling"][value="4"]').click(); // 2000 Hz
    $("#tglAngleSnap").click();
    const x0 = document.querySelector("#stageRows .stage-row input.cpi");
    x0.value = "1234"; fire(x0, "change");                              // clamps to 1230 (v2)
    const rows = document.querySelectorAll("#remapRows .remap-row");     // L,R,M,F,B,WUp,WDn
    const setRows = document.querySelectorAll("#settingsRows .settings-row"); // L,R,M,F,B
    const backSel = rows[4].querySelector(".map-select");
    backSel.value = "md_mute"; fire(backSel, "change");
    const rightMc = setRows[1].querySelector('input[type="range"]');
    rightMc.value = "3"; fire(rightMc, "input");
    const rightSpdt = setRows[1].querySelector(".spdt-select");
    rightSpdt.value = "speed"; fire(rightSpdt, "change");

    ok(!$("#applyBar").hidden, "apply bar visible after edits");
    $("#btnApply").click();
    for (let i = 0; i < 100 && !$("#applyBar").hidden; i++) await sleep(50);
    ok($("#applyBar").hidden, "apply bar cleared after apply");

    const b = D.state.active.lastBlob;
    ok(b[21] === 4, "polling divider 4 (2000 Hz) @21");
    ok(b[26] === 1, "angle snapping on @26");
    ok(b[52] === (1230 & 0xFF) && b[53] === (1230 >> 8), "stage-1 X 1234->1230 @52..53");
    ok(b[54] === (1230 & 0xFF) && b[51] === 0, "stage-1 Y follows X, split=0");
    ok(b[105] === 8, "Back multiclick ctl remains @105");
    ok(b[99] === 0x20 && b[100] === 0xE2, "Back -> Media Mute mapping @99..100");
    ok(b[84] === 0xF1, "Right SPDT GX Speed -> 0xF1 @84");
    ok(b[39] === 1, "stage-2 LED enable byte preserved @39");
    ok(b[36] === 0 && b[37] === 255 && b[38] === 0, "stage-2 RGB (green) preserved @36..38");
    ok(b[106] === 0x09 && b[107] === 0xF1, "preserved hidden CPI-loop mapping @106..107");
    ok(D.state.applied.buttons[3].type === 0x20, "read-back re-decoded the Mute mapping");

    // instant active-stage path (no Apply)
    document.querySelectorAll('input[name="activeStage"]')[2].click();
    for (let i = 0; i < 40 && D.state.active.lastBlob[29] !== 2; i++) await sleep(50);
    ok(D.state.active.lastBlob[29] === 2, "instant stage switch wrote byte 29");
    ok($("#applyBar").hidden, "stage switch did not mark the UI dirty");

    // left-hand mode (section 4.6.1, hardware-verified): 71-76 = Left's slot,
    // record 0 = Right's slot; handedness = who holds the plain LEFT CLICK
    ok(D.state.pending.leftHanded === false, "factory demo (71-76 = 00 01) decodes right-handed");
    $("#tglLefty").click();
    ok(!$("#applyBar").hidden, "left-hand toggle marks dirty");
    ok(getComputedStyle(rows[0].querySelector(".map-select")).display !== "none",
      "Left row gains a mapping select in left-hand mode");
    ok(getComputedStyle(rows[1].querySelector(".map-select")).display === "none",
      "Right row mapping select hidden in left-hand mode");
    const leftSel = rows[0].querySelector(".map-select");
    leftSel.value = "m_middle"; fire(leftSel, "change");   // remap Left -> Middle Click
    $("#btnApply").click();
    for (let i = 0; i < 100 && !$("#applyBar").hidden; i++) await sleep(50);
    const bl = D.state.active.lastBlob;
    ok(bl[71] === 0x00 && bl[72] === 0x04 && !(bl[73] | bl[74] | bl[75] | bl[76]),
      "left-handed: 71-76 carry Left's action (Middle Click)");
    ok(bl[78] === 0x00 && bl[79] === 0x01, "left-handed: record 0 = plain LEFT CLICK marker");
    ok(bl[84] === 0xF1, "left-handed switch left Right's SPDT ctl byte untouched");
    ok(D.state.pending.leftHanded === true, "read-back decodes as left-handed");
    ok(leftSel.value === "m_middle", "read-back re-decodes Left's action from 71-76");

    $("#tglLefty").click();                                 // and back to right-handed
    $("#btnApply").click();
    for (let i = 0; i < 100 && !$("#applyBar").hidden; i++) await sleep(50);
    const br = D.state.active.lastBlob;
    ok(br[71] === 0x00 && br[72] === 0x01 && !(br[73] | br[74] | br[75] | br[76]),
      "right-handed: 71-76 restored to plain LEFT CLICK (never zeros)");
    ok(br[78] === 0x00 && br[79] === 0x02, "right-handed: record 0 back to Right Click default");
    ok(D.state.pending.leftHanded === false, "read-back decodes as right-handed");
  } catch (e) {
    results.push("FAIL exception: " + (e && e.stack || e));
  }

  const failed = results.filter(r => r.startsWith("FAIL"));
  document.title = failed.length ? "SELFTEST-FAIL" : "SELFTEST-PASS";
  const pre = document.createElement("pre");
  pre.id = "selftestOut";
  pre.textContent = results.join("\n");
  document.body.append(pre);
})();
