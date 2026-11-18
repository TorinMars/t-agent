// Draws the T-Agent.app icon into an .iconset folder (the ten PNG files `iconutil -c icns` turns into AppIcon.icns). A build tool run by
// scripts/build-mac-app.js, not part of the app: no binary art is committed. See "Building and installing" in docs/design/mac-app.md.
//
//   make-icon <folder.iconset>
//
// The art, on a 1024 grid: a rounded square (824 x 824 at 100, the standard macOS margin, corner radius 185) with a dark vertical gradient
// (#232733 at the top to #14161c), a soft drop shadow and a faint light edge; a bold white "T" drawn from rounded rectangles (no font needed) and an
// accent dot (#5b8cff) at the foot of the stem, like "T.".
import AppKit
import ImageIO

let sizes: [(name: String, pixels: Int)] = [
    ("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64), ("icon_128x128", 128),
    ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512), ("icon_512x512", 512), ("icon_512x512@2x", 1024),
]

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
}

// Draws in the 1024 grid (y up). `scale` is pixels per grid unit: shadows are not scaled by the transform, so they take it by hand.
func draw(_ cg: CGContext, scale: CGFloat) {
    let shape = CGRect(x: 100, y: 100, width: 824, height: 824)
    let outline = CGPath(roundedRect: shape, cornerWidth: 185, cornerHeight: 185, transform: nil)

    // The body with its drop shadow (a little below the shape, as in the system icons).
    cg.saveGState()
    cg.setShadow(offset: CGSize(width: 0, height: -10 * scale), blur: 28 * scale, color: color(0x000000, 0.35))
    cg.addPath(outline)
    cg.setFillColor(color(0x14161c))
    cg.fillPath()
    cg.restoreGState()

    // The gradient, clipped to the shape.
    cg.saveGState()
    cg.addPath(outline)
    cg.clip()
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let gradient = CGGradient(colorsSpace: space, colors: [color(0x232733), color(0x14161c)] as CFArray, locations: [0, 1])!
    cg.drawLinearGradient(gradient, start: CGPoint(x: 512, y: shape.maxY), end: CGPoint(x: 512, y: shape.minY), options: [])
    cg.restoreGState()

    // A faint light edge just inside the outline.
    cg.saveGState()
    let inset = shape.insetBy(dx: 3, dy: 3)
    cg.addPath(CGPath(roundedRect: inset, cornerWidth: 182, cornerHeight: 182, transform: nil))
    cg.setStrokeColor(color(0xffffff, 0.08))
    cg.setLineWidth(6)
    cg.strokePath()
    cg.restoreGState()

    // The "T": a crossbar and a stem, slightly rounded, centred in the shape.
    let top: CGFloat = 782, bottom: CGFloat = 242
    let bar = CGRect(x: 252, y: top - 132, width: 520, height: 132)
    let stem = CGRect(x: 440, y: bottom, width: 144, height: top - bottom)
    cg.saveGState()
    cg.setShadow(offset: CGSize(width: 0, height: -4 * scale), blur: 12 * scale, color: color(0x000000, 0.25))
    cg.beginTransparencyLayer(auxiliaryInfo: nil)
    cg.setFillColor(color(0xffffff))
    cg.addPath(CGPath(roundedRect: bar, cornerWidth: 18, cornerHeight: 18, transform: nil))
    cg.addPath(CGPath(roundedRect: stem, cornerWidth: 18, cornerHeight: 18, transform: nil))
    cg.fillPath()
    cg.endTransparencyLayer()
    cg.restoreGState()

    // The accent dot at the foot of the stem, on its right.
    let radius: CGFloat = 50
    cg.setFillColor(color(0x5b8cff))
    cg.fillEllipse(in: CGRect(x: stem.maxX + 42, y: bottom, width: radius * 2, height: radius * 2))
}

func render(pixels: Int, to url: URL) -> Bool {
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    guard let cg = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                             bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
    let scale = CGFloat(pixels) / 1024
    cg.scaleBy(x: scale, y: scale)
    cg.interpolationQuality = .high
    cg.setShouldAntialias(true)
    draw(cg, scale: scale)
    guard let image = cg.makeImage(),
          let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else { return false }
    CGImageDestinationAddImage(destination, image, nil)
    return CGImageDestinationFinalize(destination)
}

let arguments = CommandLine.arguments
guard arguments.count == 2 else {
    FileHandle.standardError.write("usage: make-icon <folder.iconset>\n".data(using: .utf8)!)
    exit(2)
}
let folder = URL(fileURLWithPath: arguments[1], isDirectory: true)
do {
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
} catch {
    FileHandle.standardError.write("make-icon: cannot create \(folder.path): \(error.localizedDescription)\n".data(using: .utf8)!)
    exit(1)
}
for size in sizes {
    let file = folder.appendingPathComponent("\(size.name).png")
    if !render(pixels: size.pixels, to: file) {
        FileHandle.standardError.write("make-icon: cannot write \(file.path)\n".data(using: .utf8)!)
        exit(1)
    }
}
print("\(sizes.count) icon files written to \(folder.path)")
