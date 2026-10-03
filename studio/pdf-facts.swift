// PDF helper for sim-eyes Studio: facts about a PDF that code can check, and its pages as pictures for the judge.
//   pdf-facts <file.pdf>
//     Prints { pages, locked, bytes, sizes: [{ width, height }], grayscale: [bool] } as JSON. Sizes are page boxes in
//     points with the page's rotation applied (A4 portrait is 595 x 842). A locked PDF reports only locked, bytes.
//   pdf-facts --render <file.pdf> <outdir> [maxPages] [maxSide]
//     Writes page-1.jpg, page-2.jpg ... (long side at most maxSide, default 1280) and prints their paths as JSON.
import AppKit
import Foundation
import PDFKit

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

func printJSON(_ object: Any) {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
}

/// A page drawn to RGBA, long side at most `maxSide` pixels.
func render(_ page: PDFPage, maxSide: CGFloat) -> CGImage? {
    let box = page.bounds(for: .mediaBox)
    let rotated = page.rotation % 180 != 0
    let width = rotated ? box.height : box.width
    let height = rotated ? box.width : box.height
    let scale = min(1, maxSide / max(width, height))
    let size = CGSize(width: max(1, (width * scale).rounded()), height: max(1, (height * scale).rounded()))
    guard let context = CGContext(
        data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return nil }
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(CGRect(origin: .zero, size: size))
    context.scaleBy(x: scale, y: scale)
    // PDFPage.draw draws the page upright for its rotation, in a context whose origin is the media box origin.
    let transform = page.transform(for: .mediaBox)
    context.concatenate(transform)
    page.draw(with: .mediaBox, to: context)
    return context.makeImage()
}

func isGray(_ image: CGImage) -> Bool {
    let width = image.width, height = image.height
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    let context = CGContext(
        data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    // Anti-aliasing and JPEG-free rendering keep gray pages exactly gray; a few counts of slack cover color management.
    for i in stride(from: 0, to: pixels.count, by: 4) {
        let r = Int(pixels[i]), g = Int(pixels[i + 1]), b = Int(pixels[i + 2])
        if abs(r - g) > 6 || abs(g - b) > 6 || abs(r - b) > 6 { return false }
    }
    return true
}

let args = CommandLine.arguments
if args.count >= 4, args[1] == "--render" {
    guard let document = PDFDocument(url: URL(fileURLWithPath: args[2])) else { fail("Cannot open \(args[2])") }
    if document.isLocked { fail("The PDF is locked") }
    let out = URL(fileURLWithPath: args[3])
    try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    let maxPages = args.count > 4 ? Int(args[4]) ?? 20 : 20
    let maxSide = args.count > 5 ? CGFloat(Double(args[5]) ?? 1280) : 1280
    var paths: [String] = []
    for index in 0..<min(document.pageCount, maxPages) {
        guard let page = document.page(at: index), let image = render(page, maxSide: maxSide) else { continue }
        let rep = NSBitmapImageRep(cgImage: image)
        guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.7]) else { continue }
        let file = out.appendingPathComponent("page-\(index + 1).jpg")
        try? jpeg.write(to: file)
        paths.append(file.path)
    }
    printJSON(paths)
} else if args.count == 2 {
    let url = URL(fileURLWithPath: args[1])
    let bytes = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
    guard let document = PDFDocument(url: url) else { fail("Cannot open \(args[1])") }
    if document.isLocked {
        printJSON(["pages": 0, "locked": true, "bytes": bytes, "sizes": [], "grayscale": []] as [String: Any])
    } else {
        var sizes: [[String: Double]] = []
        var gray: [Bool] = []
        for index in 0..<document.pageCount {
            guard let page = document.page(at: index) else { continue }
            let box = page.bounds(for: .mediaBox)
            let rotated = page.rotation % 180 != 0
            sizes.append(["width": Double(rotated ? box.height : box.width).rounded(), "height": Double(rotated ? box.width : box.height).rounded()])
            gray.append(render(page, maxSide: 300).map(isGray) ?? false)
        }
        printJSON(["pages": document.pageCount, "locked": false, "bytes": bytes, "sizes": sizes, "grayscale": gray] as [String: Any])
    }
} else {
    fail("usage: pdf-facts <file.pdf> | pdf-facts --render <file.pdf> <outdir> [maxPages] [maxSide]")
}
