// Screenshot helper for sim-eyes. Screenshots are 1x, so pixels are points.
//   ocr <image.png>
//     Reads text with Apple Vision (a dark screenshot is inverted first: Vision misreads light-on-dark
//     text as upside-down garbage on macOS 27). Prints a JSON array of { text, confidence, x, y, width, height }
//     in image pixels, origin top-left.
//   ocr --diff <before.png> <after.png> [y0 y1]
//     Prints { changed, bandChanged, x, y, width, height }: the count and bounding box of pixels
//     that differ, and how many of them lie in rows y0..<y1 (0 without a band). The status bar
//     (clock, battery) is ignored. `changed` is -1 when the sizes differ.
import AppKit
import CoreImage
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
      let loaded = loadImage(CommandLine.arguments[1])
else {
    FileHandle.standardError.write(Data("cannot read image\n".utf8))
    exit(1)
}

/// Mean brightness (0...1) of the image, from a 16x16 average.
func meanBrightness(_ image: CGImage) -> Double {
    var pixels = [UInt8](repeating: 0, count: 16 * 16 * 4)
    let context = CGContext(
        data: &pixels, width: 16, height: 16, bitsPerComponent: 8, bytesPerRow: 64,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.interpolationQuality = .medium
    context.draw(image, in: CGRect(x: 0, y: 0, width: 16, height: 16))
    var sum = 0
    for i in stride(from: 0, to: pixels.count, by: 4) { sum += Int(pixels[i]) + Int(pixels[i + 1]) + Int(pixels[i + 2]) }
    return Double(sum) / Double(16 * 16 * 3 * 255)
}

func inverted(_ image: CGImage) -> CGImage {
    let input = CIImage(cgImage: image)
    guard let filter = CIFilter(name: "CIColorInvert") else { return image }
    filter.setValue(input, forKey: kCIInputImageKey)
    guard let output = filter.outputImage else { return image }
    return CIContext().createCGImage(output, from: input.extent) ?? image
}

let cg = meanBrightness(loaded) < 0.4 ? inverted(loaded) : loaded

let width = Double(cg.width)
let height = Double(cg.height)
/// Reads with `level`; nil when that engine fails (the accurate model can fail to load on some macOS builds).
func read(_ level: VNRequestTextRecognitionLevel) -> (results: [VNRecognizedTextObservation], error: Error?) {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = level
    request.usesLanguageCorrection = false
    do {
        try VNImageRequestHandler(cgImage: cg, options: [:]).perform([request])
        return (request.results ?? [], nil)
    } catch {
        return ([], error)
    }
}

// The accurate engine can fail to load on a macOS build, and the failure takes ~25 s to surface.
// The failure is remembered per OS build in a marker file so later runs go straight to .fast.
let osBuild = ProcessInfo.processInfo.operatingSystemVersionString
let marker = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/sim-eyes/ocr-accurate-unavailable")
let accurateKnownBroken = (try? String(contentsOf: marker, encoding: .utf8)) == osBuild

var reading = accurateKnownBroken ? (results: [VNRecognizedTextObservation](), error: nil as Error?) : read(.accurate)
if accurateKnownBroken || reading.error != nil {
    let accurateError = reading.error
    reading = read(.fast)
    if let fastError = reading.error {
        FileHandle.standardError.write(Data("ocr failed: accurate: \(accurateError.map { "\($0)" } ?? "unavailable on \(osBuild)"); fast: \(fastError)\n".utf8))
        exit(1)
    }
    if let accurateError {
        try? osBuild.write(to: marker, atomically: true, encoding: .utf8)
        FileHandle.standardError.write(Data("ocr: accurate level failed (\(accurateError)); used fast level\n".utf8))
    }
}

var items: [[String: Any]] = []
for observation in reading.results {
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
