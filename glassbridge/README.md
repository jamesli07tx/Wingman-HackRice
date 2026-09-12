# GlassBridge (`glassbridge/`) — Mac-owned

Swift iOS app **Wingman**: the dumb pipe of DESIGN.md §5.1 — glasses camera → Cortex, `HudCard` → lens.
No product intelligence lives here; Cortex decides, Wingman samples and draws.

- Spec (normative wire contract): `../DESIGN.md` §4 (protocol), §5.1 (responsibilities), Appendix D (tuning).
- Mac scope + acceptance checks: `../DESIGN_MAC.md`.
- Build plan: `docs/plans/2026-09-12-glassbridge.md`. DAT API notes: `docs/dat-0.9.0-api-notes.md`.

Toolchain as built: **Xcode 26.6**, iOS deployment target 17.2, Simulator runtime **26.5** (device
`iPhone 17 Pro`), DAT `facebook/meta-wearables-dat-ios` pinned **0.9.0** (revision `9b1b83d`).

## 1. Human checklist — nobody but you can do these (DESIGN_MAC.md §1.1)

- [ ] iPhone Developer Mode on (one reboot)
- [ ] phone trusts the Mac
- [ ] Meta AI app v272+, signed into the same Meta account as the developer enrollment
- [ ] glasses firmware v125+, paired, Developer Mode toggled in the Meta AI app
- [ ] tester enrollment done
- [ ] Apple ID added in Xcode → Settings → Accounts (Personal Team). Free provisioning installs
      **expire in 7 days** — re-sign the demo morning (DESIGN.md §8); max 3 sideloaded apps; the
      device must be plugged in for install.

## 2. Build & run

```bash
cd glassbridge
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
cp Config.local.xcconfig.example Config.local.xcconfig   # gitignored; fill DEVELOPMENT_TEAM + URLs
xcodegen generate                                        # rewrites Wingman.xcodeproj from project.yml
open Wingman.xcodeproj                                   # scheme: Wingman
```

- **Re-run `xcodegen generate` whenever a Swift file is added or removed.** XcodeGen writes explicit
  file references — a new `.swift` is invisible to the target until the project is regenerated.
  Edit `project.yml`, never the `.xcodeproj`.
- **Signing:** set `DEVELOPMENT_TEAM` (10-char Personal Team ID from Xcode → Settings → Accounts) in
  `Config.local.xcconfig`. On a real phone DAT registration fails without it, exactly like the
  Simulator failure below.
- **URLs in xcconfig:** `//` starts a comment, so URLs are written `wss:/$()/host/...` — `$()` expands
  to nothing. Keep that spelling when you fill in real values. `Config.xcconfig` ships placeholders
  (`REPLACE-ME.fly.dev`) and `#include?`s `Config.local.xcconfig`, which wins.
- **Run to the phone:** Xcode Run button (device plugged in). First install → the phone asks for trust:
  Settings → General → VPN & Device Management → trust the developer, then Run again.
- **Device compile check, no signing:**

```bash
xcodebuild -project Wingman.xcodeproj -scheme Wingman \
  -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
```

- **Simulator-degraded:** DAT's `Wearables.configure()` fails in the Simulator (no team, no
  registration), so Connections shows a single red **Glasses** row reading `DAT unavailable: …` (there
  are no Stream/Display rows — there is no DAT session to report on) and the spike reports `SPIKE N/A`.
  Everything else still works: link, Cortex/DevHarness socket, Debug →
  "Send test frames (Simulator)" pushes synthetic JPEGs through the real `frame` path.
- **Background modes:** `UIBackgroundModes` carries `bluetooth-central`, `bluetooth-peripheral` and
  `processing` in addition to `audio` (the silent keepalive) because the DAT SDK needs exactly those
  three to keep the glasses' Bluetooth link alive in the background (`docs/dat-0.9.0-api-notes.md` §8)
  — so the capability sheet showing four background modes is expected, not a leftover.
- **Mock Device Kit:** `MWDATMockDevice` is linked but unused — the pre-hardware camera path is the
  synthetic Simulator frames above, not a mocked device (the mock has no display model anyway). The
  consequence: the DAT→FrameSampler seam (`cgImage(from:)` and the listener wiring) is first exercised
  on real glasses, at the spike.

## 3. Tests

```bash
cd glassbridge
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
swift test                                    # macOS, no phone, no glasses, no DAT (Package.swift slice)
xcodebuild test -project Wingman.xcodeproj -scheme Wingman \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO
```

`Package.swift` compiles only the platform-neutral files (it excludes `App/StatusView/BridgeController/
DATSessionManager`), which is why `swift test` needs no Apple hardware. The Xcode test run compiles
everything.

Known, harmless: the Simulator test run logs objc **duplicate class** warnings between
`MWDATMockDevice` and `MWDATCamera` — a DAT 0.9.0 packaging artifact, not our bug.

## 4. DevHarness — the fake Cortex

```bash
cd glassbridge/DevHarness
npm install                       # only dep: ws
node harness.mjs --burst --save   # ws://localhost:8787/ws/device + POST /api/devices/claim
```

Flags: `--port 8787` · `--interval 1750` (the `frameIntervalMs` pushed in `armed.config`) ·
`--end 90` (seconds until `session_end`) · `--burst` (5 renders in 200 ms, the coalescing probe) ·
`--save` (writes every frame/photo to `DevHarness/frames/`, gitignored).

Phone-side wiring: put the Mac's LAN IP in `Config.local.xcconfig`
(`DEV_HARNESS_URL = ws:/$()/192.168.1.23:8787/ws/device`), rebuild, and turn on Debug tools →
**"Use DevHarness"** (Debug-only, and **off by default** — the harness must never be what the demo falls
into by accident; the rows there print both the harness URL and the WS URL actually in use). Any 6-digit
code links; `000000` is reserved to return 404.

### Acceptance checks (DESIGN_MAC.md §2) — all self-contained, no Windows side

- [ ] **Cadence + size.** Harness logs `✓ hello`, `✓ session_start → armed`, then `✓ frame seq=N …KB
      …ms since last`. Gaps ≈ `frameIntervalMs` (1750 ms default, or whatever `--interval` set — the
      server value must win over the compiled default); every frame **≤ 120 KB** (the harness appends
      `(>120 KB target!)` if not) and starts `ff d8`, i.e. real JPEG.
- [ ] **Reconnect.** `kill` the harness, restart it. The socket reconnects with backoff and **re-sends
      `session_start`**; the harness logs `✓ session_start → armed` again and the card script restarts
      once (it is idempotent — no stacked second copy).
- [ ] **Every card kind renders.** The script walks `ack` → `company` → `pitch` → `capture_photo` →
      `scan` → `error` (`hint` comes from the `--burst` cards), plus rotations that reuse a `cardId`
      with a higher `seq`. Watch the lens (and "Last card" in StatusView) for each; rotations must
      replace in place, never stack.
- [ ] **Coalescing.** With `--burst`: five renders 40 ms apart at t≈30 s must produce **≤ 1 screen
      replace per 500 ms** (`renderMinGapMs`), and the last card (`Burst 5/5`) is the one left on screen.
- [ ] **Locked phone, 5 minutes.** Start a session, lock the phone, wait 5 min. Harness keeps logging
      `✓ frame` the whole time (AudioKeepalive's silent loop). This is the M2 screen-lock test, run early.
- [ ] **Link 404 is visible and recoverable.** Against the placeholder Cortex URL (or harness code
      `000000`), tap Link: the claim fails and the message shows in StatusView's **Last error** — then a
      correct code still links. A silent failure here is a defect.

## 5. Hour-zero hardware spike — gates everything

The moment the glasses are in hand: Debug → **"Run hour-zero spike (camera + display)"**. It opens ONE
`DeviceSession` with both camera stream and display, waits for a frame, and draws a hello-world card.

- Result appears under the button: `SPIKE OK: …` (then confirm the card is actually on the lens),
  `SPIKE FAIL: …`, or `SPIKE N/A` in the Simulator / when DAT is not registered.
- **Report OK or FAIL to the human immediately.** A FAIL triggers the DESIGN.md §6 cut line — not
  improvisation, not a workaround.

## 6. Integration handoff

Every cross-machine seam is greppable. Required sites (DESIGN_MAC.md §0.7), current output of

```bash
grep -rn "INTEGRATION(X-MACHINE)" glassbridge --include='*.swift' --include='*.xcconfig' --include='*.mjs' | cut -d: -f1,2
```

```
glassbridge/Config.xcconfig:5
glassbridge/DevHarness/harness.mjs:8
glassbridge/Wingman/FrameSampler.swift:4
glassbridge/Wingman/LinkClient.swift:3
glassbridge/Wingman/Config.swift:3
glassbridge/Wingman/CortexSocket.swift:4
glassbridge/Wingman/Protocol.swift:3
glassbridge/Wingman/StatusView.swift:4
glassbridge/Wingman/BridgeController.swift:4
glassbridge/Wingman/HudRenderer.swift:10
glassbridge/Wingman/AudioKeepalive.swift:6
```

Deferred actions — `grep -rn "INTEGRATION-DAY" glassbridge --include='*.swift' --include='*.xcconfig' --include='*.mjs'`:

```
Config.xcconfig:8: human copies Config.local.xcconfig.example → Config.local.xcconfig, fills CORTEX_URL
  and CORTEX_WS_URL with the real Fly URLs (keep the /ws/device path), sets DEVELOPMENT_TEAM, rebuilds
  onto the phone.
DevHarness/harness.mjs:11: nothing to change here — stop using it: turn off "Use DevHarness" in
  StatusView's Debug tools (it is off by default), or just paste a real Cortex URL in step 1.
Wingman/Config.swift:6: no rebuild needed — paste the Fly host into StatusView's "Cortex URL" field and
  tap Apply; the xcconfig stays the build-time default.
Wingman/CortexSocket.swift:7: swap DEV_HARNESS_URL for CORTEX_WS_URL — BridgeController does this as
  soon as a Cortex URL is applied in step 1 (the "Use DevHarness" toggle lives in Debug tools and is off
  by default). Then verify a `hello` with deviceType "glasses_bridge" arrives in Cortex logs after link.
```

Line numbers shift whenever a header changes — **re-run the greps** rather than trusting the numbers
above. Drop `--include` to also see the plan doc.

### Integration day (no rebuild)

Step 1 of StatusView reads top to bottom in the order you use it:

1. **Cortex URL** field + **Apply** (the prominent button until a URL is set). Paste the Fly host in any
   shape the clipboard hands you — `wingman-cortex.fly.dev`, `https://wingman-cortex.fly.dev/`,
   `wss://wingman-cortex.fly.dev/ws/device` — they all normalise to `https://<host>` +
   `wss://<host>/ws/device`. `http://`/`ws://` stay insecure, so a laptop Cortex
   (`http://192.168.1.5:8080`) works too; an empty field clears the override.
2. The caption under it — **`Cortex · wss://…/ws/device`** (or `DevHarness · …`) — is the target actually
   in use. Read it before linking.
3. **6-digit code** from the dashboard + **Link**. Link stays disabled, with the hint *"Set the Cortex URL
   first"*, until a URL is set: with no URL the app opens no socket at all rather than silently dialing a
   placeholder.
4. The **Linked · `<deviceId>`** pill (with Unlink), then the socket pill. Then **Start** in step 3.

Apply stores the value in `UserDefaults` (`cortexURLOverride`), turns DevHarness off and redials the
socket. If you were linked to the DevHarness (`dev_harness`), applying a Cortex URL **auto-unlinks** —
the harness token means nothing to Cortex — and says so: *"Harness link cleared — link with the dashboard
code"*. `Config.local.xcconfig` remains the **build-time default**; the pasted value just wins over it,
so a 7-day re-signing rebuild still comes up pointing at the right Cortex.

While streaming, the phone's Wi-Fi is the glasses' own hotspot, so Cortex traffic rides **cellular** —
venue Wi-Fi is never used (and never worth debugging on the day).

**Integration-day sequence (DESIGN_MAC.md §0.6, human-driven, ~15 min):** ① Windows side deploys Cortex
→ human gets the `wss://…fly.dev` URL. ② Human pastes it into the app's **Cortex URL** field → Apply (no
rebuild; `Config.local.xcconfig` is only the build-time default), and checks the caption reads
`Cortex · wss://…`. ③ Dashboard shows the 6-digit link code → typed into GlassBridge →
`/api/devices/claim`. ④ Start from either end → M2 checks (DESIGN.md §6).

Also needed from the Windows side (§3): the dashboard with the link code, and `/feed` as the window
into what Cortex thinks the glasses are seeing. Until then, DevHarness is Cortex.
