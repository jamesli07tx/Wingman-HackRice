// swift-tools-version:5.9
// glassbridge/Package.swift — macOS-testable slice of the app. The Xcode app target (project.yml)
// compiles ALL of Wingman/; this package compiles only the platform-neutral files so
// `swift test` runs on the Mac with no phone, no glasses, no DAT. iOS-only files are excluded
// below AND guarded with #if os(iOS) / #if canImport(MWDATCore) in source.
import PackageDescription

let package = Package(
  name: "WingmanCore",
  platforms: [.macOS(.v14), .iOS(.v17)],
  targets: [
    .target(
      name: "WingmanCore",
      path: "Wingman",
      exclude: [
        "Info.plist",
        "Wingman.entitlements",
        "App.swift",
        "StatusView.swift",
        "BridgeController.swift",
        "DATSessionManager.swift",
      ]
    ),
    .testTarget(
      name: "WingmanCoreTests",
      dependencies: ["WingmanCore"],
      path: "WingmanTests"
    ),
  ],
  swiftLanguageVersions: [.v5]
)
