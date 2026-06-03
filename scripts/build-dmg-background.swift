// Generates the macOS DMG installer background from scratch: brand gradient,
// subtle glow behind the app-icon slot, title text, a brand-yellow arrow, and
// frosted label pills so Finder's dark icon text stays readable on the dark
// canvas. Emits 540x400 (@1x) / 1080x800 (@2x) PNGs wired into electron-builder.yml.
// Run with the system Swift toolchain:
//   swift scripts/build-dmg-background.swift resources/dmg/background.png 1
//   swift scripts/build-dmg-background.swift resources/dmg/background@2x.png 2
import AppKit
import CoreGraphics

guard CommandLine.arguments.count == 3,
      let scale = Double(CommandLine.arguments[2]) else {
    FileHandle.standardError.write("usage: build-dmg-background.swift <out.png> <scale>\n".data(using: .utf8)!)
    exit(1)
}
let outPath = CommandLine.arguments[1]

let ptW = 540.0, ptH = 400.0
let w = Int(ptW * scale), h = Int(ptH * scale)

let cs = CGColorSpaceCreateDeviceRGB()
guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8,
                          bytesPerRow: 0, space: cs,
                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    exit(1)
}

// CoreGraphics origin is bottom-left; helper converts top-left pt coords.
func rectTL(_ xTL: Double, _ yTL: Double, _ wTL: Double, _ hTL: Double) -> CGRect {
    CGRect(x: xTL * scale,
           y: Double(h) - (yTL + hTL) * scale,
           width: wTL * scale,
           height: hTL * scale)
}

// Layout constants (all in @1x points, optically centered in 400pt window).
let iconCenterY = 195.0
let titleTopY = 78.0
let subtitleTopY = 105.0
let labelCenterY = iconCenterY + 58.0

// -- 1. Background gradient (top #211927 -> bottom #121017) --
let grad = CGGradient(colorsSpace: cs,
    colors: [CGColor(red: 0x21/255.0, green: 0x19/255.0, blue: 0x27/255.0, alpha: 1),
             CGColor(red: 0x12/255.0, green: 0x10/255.0, blue: 0x17/255.0, alpha: 1)] as CFArray,
    locations: [0, 1])!
ctx.drawLinearGradient(grad,
    start: CGPoint(x: 0, y: Double(h)),
    end: CGPoint(x: 0, y: 0),
    options: [])

// -- 2. Subtle radial glow behind app-icon position --
let glowCenterX = 135.0 * scale
let glowCenterY = Double(h) - iconCenterY * scale
let glow = CGGradient(colorsSpace: cs,
    colors: [CGColor(red: 0x2E/255.0, green: 0x24/255.0, blue: 0x38/255.0, alpha: 0.30),
             CGColor(red: 0x2E/255.0, green: 0x24/255.0, blue: 0x38/255.0, alpha: 0)] as CFArray,
    locations: [0, 1])!
ctx.drawRadialGradient(glow,
    startCenter: CGPoint(x: glowCenterX, y: glowCenterY), startRadius: 0,
    endCenter: CGPoint(x: glowCenterX, y: glowCenterY), endRadius: 120 * scale,
    options: [])

// -- 3. Title text --
func drawText(_ s: String, centerX: Double, topY: Double, size: Double,
              weight: NSFont.Weight, tracking: Double, alpha: Double) {
    let font = NSFont.systemFont(ofSize: size * scale, weight: weight)
    let style = NSMutableParagraphStyle(); style.alignment = .center
    let attrs: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: NSColor(red: 1, green: 1, blue: 1, alpha: alpha),
        .paragraphStyle: style,
        .kern: tracking * scale,
    ]
    let str = NSAttributedString(string: s, attributes: attrs)
    let bounds = str.size()
    let gctx = NSGraphicsContext(cgContext: ctx, flipped: false)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = gctx
    let drawX = (centerX * scale) - bounds.width / 2
    let drawY = Double(h) - (topY * scale) - bounds.height
    str.draw(at: CGPoint(x: drawX, y: drawY))
    NSGraphicsContext.restoreGraphicsState()
}

drawText("ComfyUI Desktop 2.0", centerX: 270, topY: titleTopY, size: 18, weight: .medium,
         tracking: 0.3, alpha: 0.85)
drawText("Drag to Applications to install", centerX: 270, topY: subtitleTopY, size: 11,
         weight: .regular, tracking: 0.5, alpha: 0.50)

// -- 4. Bold brand-yellow arrow centered between icons --
let arrowY = Double(h) - iconCenterY * scale
let arrowStartX = 210.0 * scale
let arrowEndX = 330.0 * scale
let chevronSize = 12.0 * scale

ctx.setStrokeColor(red: 0xF2/255.0, green: 0xFF/255.0, blue: 0x59/255.0, alpha: 0.85)
ctx.setLineWidth(2.5 * scale)
ctx.setLineCap(.round)
ctx.setLineJoin(.round)

ctx.move(to: CGPoint(x: arrowStartX, y: arrowY))
ctx.addLine(to: CGPoint(x: arrowEndX, y: arrowY))
ctx.strokePath()

ctx.move(to: CGPoint(x: arrowEndX - chevronSize, y: arrowY + chevronSize))
ctx.addLine(to: CGPoint(x: arrowEndX, y: arrowY))
ctx.addLine(to: CGPoint(x: arrowEndX - chevronSize, y: arrowY - chevronSize))
ctx.strokePath()

// -- 5. Glassy frosted label pills (Finder always renders dark labels over
//    background images; these give labels a readable, polished surface) --
func labelPill(centerX: Double, centerY: Double, width: Double) {
    let pillH = 20.0
    let cornerR = (pillH / 2) * scale
    let r = rectTL(centerX - width / 2, centerY - pillH / 2, width, pillH)
    let path = CGPath(roundedRect: r, cornerWidth: cornerR, cornerHeight: cornerR, transform: nil)

    // Frosted base fill
    ctx.saveGState()
    ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 0.75)
    ctx.addPath(path)
    ctx.fillPath()

    // Top-half highlight for glass depth
    ctx.addPath(path)
    ctx.clip()
    let topHalf = rectTL(centerX - width / 2, centerY - pillH / 2, width, pillH * 0.4)
    let hlPath = CGPath(roundedRect: topHalf, cornerWidth: cornerR, cornerHeight: cornerR, transform: nil)
    ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 0.18)
    ctx.addPath(hlPath)
    ctx.fillPath()
    ctx.restoreGState()

    // Thin border stroke
    ctx.setStrokeColor(red: 1, green: 1, blue: 1, alpha: 0.4)
    ctx.setLineWidth(0.5 * scale)
    ctx.addPath(path)
    ctx.strokePath()
}
labelPill(centerX: 135, centerY: labelCenterY, width: 148)
labelPill(centerX: 405, centerY: labelCenterY, width: 100)

// -- Write output --
guard let out = ctx.makeImage() else { exit(1) }
let outRep = NSBitmapImageRep(cgImage: out)
guard let png = outRep.representation(using: .png, properties: [:]) else { exit(1) }
try! png.write(to: URL(fileURLWithPath: outPath))
print("wrote \(outPath) (\(w)x\(h))")
