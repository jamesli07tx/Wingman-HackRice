# GlassBridge (`glassbridge/`) — Mac-owned

Swift iOS app **Wingman**: the dumb pipe of DESIGN.md §5.1 (glasses camera → Cortex, HudCard → lens).
Build plan: `docs/plans/2026-09-12-glassbridge.md`. DAT API notes: `docs/dat-0.9.0-api-notes.md`.

## Build
- Xcode: `xcodegen generate` (after editing `project.yml`, and after ADDING or removing any source file — XcodeGen writes explicit file references, so a new `.swift` file is invisible to the target until the project is regenerated), open `Wingman.xcodeproj`, scheme `Wingman`.
- CLI compile check: `xcodebuild -scheme Wingman -destination 'generic/platform=iOS' build`
- Unit tests, no phone: `export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer; swift test`
- Config: copy `Config.local.xcconfig.example` → `Config.local.xcconfig` (gitignored), fill URLs + team.

(Expanded in Task 10: human checklist, DevHarness, integration handoff.)
