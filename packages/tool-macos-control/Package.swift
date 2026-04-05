// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MacOSControl",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(
            name: "MacOSControl",
            targets: ["MacOSControl"]
        )
    ],
    targets: [
        .executableTarget(
            name: "MacOSControl",
            path: "Sources/MacOSControl"
        )
    ]
)
