// swift-tools-version: 6.0
import PackageDescription

// The dosya.dev File Provider for macOS. A library rather than an app
// extension target: SwiftPM cannot build an .appex, and keeping the whole
// provider here means every part of it is reachable from `swift test`. Phase 3
// wraps this in a signed extension bundle.
let package = Package(
  name: "DosyaFileProvider",
  // Matches the app's own LSMinimumSystemVersion. A higher floor here would
  // mean the extension silently never loads on a Mac where the app runs fine.
  platforms: [.macOS(.v12)],
  products: [
    .library(name: "DosyaFileProviderCore", targets: ["DosyaFileProviderCore"]),
  ],
  targets: [
    // Swift 5 language mode: this source is a copy of the iOS extension, which
    // builds that way, and the one construct Swift 6 rejects (a lock-guarded
    // static cache) is safe as written. Annotating it apart here would make the
    // two copies drift for no behaviour change.
    .target(name: "DosyaFileProviderCore", swiftSettings: [.swiftLanguageMode(.v5)]),
    .testTarget(
      name: "DosyaFileProviderCoreTests",
      dependencies: ["DosyaFileProviderCore"],
      swiftSettings: [.swiftLanguageMode(.v5)]
    ),
  ]
)
