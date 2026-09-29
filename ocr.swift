// Screenshot helper for sim-eyes. Screenshots are 1x, so pixels are points.
//   ocr <image.png>
//     Reads text with Apple Vision. Prints a JSON array of { text, confidence, x, y, width, height }
//     in image pixels, origin top-left.
//   ocr --diff <before.png> <after.png> [y0 y1]
//     Prints { changed, bandChanged, x, y, width, height }: the count and bounding box of pixels
//     that differ, and how many of them lie in rows y0..<y1 (0 without a band). The status bar
//     (clock, battery) is ignored. `changed` is -1 when the sizes differ.
import AppKit
import Foundation
import Vision

func loadImage(_ path: String) -> CGImage? {
    NSImage(contentsOfFile: path)?.cgImage(forProposedRect: nil, context: nil, hints: nil)
}

func rgba(_ image: CGImage) -> [UInt8] {
    var buffer = [UInt8](repeating: 0, count: image.width * image.height * 4)
    let context = CGContext(
        data: &buffer, width: image.width, height: image.height, bitsPerComponent: 8,
        bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    return buffer
}

if CommandLine.arguments.count > 3, CommandLine.arguments[1] == "--diff" {
    guard let a = loadImage(CommandLine.arguments[2]), let b = loadImage(CommandLine.arguments[3]) else {
        FileHandle.standardError.write(Data("cannot read image\n".utf8))
        exit(1)
    }
    let bandStart = CommandLine.arguments.count > 5 ? Int(CommandLine.arguments[4]) ?? 0 : 0
    let bandEnd = CommandLine.arguments.count > 5 ? Int(CommandLine.arguments[5]) ?? 0 : 0
    var result: [String: Int] = ["changed": -1, "bandChanged": -1, "x": 0, "y": 0, "width": a.width, "height": a.height]
    if a.width == b.width && a.height == b.height {
        let pa = rgba(a), pb = rgba(b)
        let statusBar = 54
        var count = 0, band = 0, minX = a.width, minY = a.height, maxX = -1, maxY = -1
        for y in statusBar..<a.height {
            for x in 0..<a.width {
                let i = (y * a.width + x) * 4
                let delta = abs(Int(pa[i]) - Int(pb[i])) + abs(Int(pa[i + 1]) - Int(pb[i + 1])) + abs(Int(pa[i + 2]) - Int(pb[i + 2]))
                if delta > 48 {
                    count += 1
                    if y >= bandStart && y < bandEnd { band += 1 }
                    minX = min(minX, x); maxX = max(maxX, x)
                    minY = min(minY, y); maxY = max(maxY, y)
                }
            }
        }
        result = count == 0
            ? ["changed": 0, "bandChanged": 0, "x": 0, "y": 0, "width": 0, "height": 0]
            : ["changed": count, "bandChanged": band, "x": minX, "y": minY, "width": maxX - minX + 1, "height": maxY - minY + 1]
    }
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result))
    exit(0)
}

guard CommandLine.arguments.count > 1,
      let cg = loadImage(CommandLine.arguments[1])
else {
    FileHandle.standardError.write(Data("cannot read image\n".utf8))
    exit(1)
}

let width = Double(cg.width)
let height = Double(cg.height)
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false

do {
    try VNImageRequestHandler(cgImage: cg, options: [:]).perform([request])
} catch {
    FileHandle.standardError.write(Data("ocr failed: \(error)\n".utf8))
    exit(1)
}

var items: [[String: Any]] = []
for observation in request.results ?? [] {
    guard let best = observation.topCandidates(1).first else { continue }
    let box = observation.boundingBox  // normalized, origin bottom-left
    items.append([
        "text": best.string,
        "confidence": Double(best.confidence),
        "x": (box.midX * width).rounded(),
        "y": ((1 - box.midY) * height).rounded(),
        "width": (box.width * width).rounded(),
        "height": (box.height * height).rounded(),
    ])
}

let data = try JSONSerialization.data(withJSONObject: items)
FileHandle.standardOutput.write(data)
