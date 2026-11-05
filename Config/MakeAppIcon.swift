// Draws the app icon. Run: swift Config/MakeAppIcon.swift <output.png>
import AppKit

let size: CGFloat = 1024
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()

// A macOS icon sits inside its canvas with a margin, on a rounded square.
let tile = NSRect(x: 100, y: 100, width: 824, height: 824)
let shape = NSBezierPath(roundedRect: tile, xRadius: 185, yRadius: 185)
NSGradient(starting: NSColor(red: 0.12, green: 0.13, blue: 0.17, alpha: 1),
           ending: NSColor(red: 0.03, green: 0.03, blue: 0.05, alpha: 1))?.draw(in: shape, angle: -90)

// A route between two stops, with a stop along the way.
let start = NSPoint(x: 300, y: 300), middle = NSPoint(x: 512, y: 512), end = NSPoint(x: 724, y: 724)
let route = NSBezierPath()
route.move(to: start)
route.curve(to: middle, controlPoint1: NSPoint(x: 300, y: 470), controlPoint2: NSPoint(x: 400, y: 512))
route.curve(to: end, controlPoint1: NSPoint(x: 624, y: 512), controlPoint2: NSPoint(x: 724, y: 554))
route.lineWidth = 62
route.lineCapStyle = .round
NSColor(red: 1.0, green: 0.82, blue: 0.0, alpha: 1).setStroke()
route.stroke()

func stop(_ center: NSPoint, radius: CGFloat, fill: NSColor) {
    let rect = NSRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
    fill.setFill()
    NSBezierPath(ovalIn: rect).fill()
}
stop(start, radius: 78, fill: NSColor(red: 1.0, green: 0.82, blue: 0.0, alpha: 1))
stop(start, radius: 36, fill: NSColor(red: 0.07, green: 0.08, blue: 0.11, alpha: 1))
stop(middle, radius: 50, fill: .white)
stop(end, radius: 78, fill: NSColor(red: 0.89, green: 0.14, blue: 0.17, alpha: 1))
stop(end, radius: 36, fill: .white)
image.unlockFocus()

let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
try! bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
