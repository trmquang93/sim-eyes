// SimEyes Studio: the double-click launcher. It starts the bundled Node with Studio, opens the page in the browser and
// stops Studio when the app quits. No test logic lives here; Studio is the same code `npm run studio` runs.
import AppKit
import Security

let keychainService = "com.simeyes.studio"
let keychainAccount = "TYPESAFE_API_KEY"

func readKey() -> String? {
  let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService,
                              kSecAttrAccount as String: keychainAccount, kSecReturnData as String: true]
  var out: AnyObject?
  guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
  return String(data: data, encoding: .utf8)
}

/// The key build-app.sh ships inside the app, so testers configure nothing. A key saved in the Keychain overrides it.
func bundledKey() -> String? {
  guard let text = try? String(contentsOfFile: Bundle.main.resourcePath! + "/typesafe.key", encoding: .utf8) else { return nil }
  let key = text.trimmingCharacters(in: .whitespacesAndNewlines)
  return key.isEmpty ? nil : key
}

func activeKey() -> String? { readKey() ?? bundledKey() }

func saveKey(_ key: String) {
  let match: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService,
                              kSecAttrAccount as String: keychainAccount]
  SecItemDelete(match as CFDictionary)
  if key.isEmpty { return }
  var add = match
  add[kSecValueData as String] = key.data(using: .utf8)!
  SecItemAdd(add as CFDictionary, nil)
}

/// Studio's output and exit status, for a tester to send when something breaks: ~/Library/Logs/SimEyesStudio.log
func log(_ text: String) {
  let path = NSHomeDirectory() + "/Library/Logs/SimEyesStudio.log"
  guard let data = text.data(using: .utf8) else { return }
  if let h = FileHandle(forWritingAtPath: path) { h.seekToEndOfFile(); h.write(data); h.closeFile() } else { FileManager.default.createFile(atPath: path, contents: data) }
}

func alert(_ title: String, _ text: String, buttons: [String] = ["OK"]) -> Bool {
  let a = NSAlert()
  a.messageText = title
  a.informativeText = text
  buttons.forEach { a.addButton(withTitle: $0) }
  NSApp.activate(ignoringOtherApps: true)
  return a.runModal() == .alertFirstButtonReturn
}

@discardableResult
func run(_ path: String, _ args: [String], env: [String: String]? = nil) -> (status: Int32, out: String) {
  let p = Process()
  p.executableURL = URL(fileURLWithPath: path)
  p.arguments = args
  if let env { p.environment = env }
  let pipe = Pipe()
  p.standardOutput = pipe
  p.standardError = pipe
  do { try p.run() } catch { return (127, "\(error)") }
  let data = pipe.fileHandleForReading.readDataToEndOfFile()
  p.waitUntilExit()
  return (p.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}

final class Studio: NSObject, NSApplicationDelegate {
  let res = Bundle.main.resourcePath!
  var child: Process?
  var stdinPipe: Pipe?
  var url: URL?
  var window: NSWindow!
  var statusLabel: NSTextField!
  var openButton: NSButton!

  var node: String { "\(res)/node" }
  var home: String { "\(res)/sim-eyes" }
  var simPool: String { "\(res)/sim-pool" }

  func applicationDidFinishLaunching(_ note: Notification) {
    buildMenu()
    buildWindow()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    guard preflight() else { setStatus("Cannot start: see the message."); return }
    start()
  }

  // MARK: checks a tester can fix themselves

  func preflight() -> Bool {
    let sims = run("/usr/bin/xcrun", ["simctl", "list", "devices", "available"])
    if sims.status != 0 {
      if alert("Xcode is needed", "SimEyes Studio runs tests on the iOS Simulator, which comes with Xcode. Install Xcode from the App Store, open it once to finish setup, then open SimEyes Studio again.", buttons: ["Open App Store", "Close"]) {
        NSWorkspace.shared.open(URL(string: "macappstore://apps.apple.com/app/xcode/id497799835")!)
      }
      return false
    }
    // First run on this Mac: tell sim-pool which simulators it may lease (it never creates any).
    if !FileManager.default.fileExists(atPath: NSHomeDirectory() + "/.agent-sim-pool/config.json") {
      let r = run(simPool, ["init"])
      if r.status != 0 { return alert("Could not set up simulators", r.out) && false }
    }
    return true
  }

  // MARK: Studio process

  func childEnv() -> [String: String] {
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"
    env["SIM_POOL_BIN"] = simPool
    let ad = try! JSONSerialization.data(withJSONObject: [node, "\(home)/node_modules/agent-device/bin/agent-device.mjs"])
    env["SIM_EYES_AD"] = String(data: ad, encoding: .utf8)!
    if let key = activeKey() { env["TYPESAFE_API_KEY"] = key } else { env.removeValue(forKey: "TYPESAFE_API_KEY") }
    return env
  }

  func start(port: Int = 4777) {
    log("start port \(port)\n")
    setStatus("Starting…")
    let p = Process()
    p.executableURL = URL(fileURLWithPath: node)
    p.arguments = ["\(home)/studio/studio.mjs", "--no-open", "--exit-when-stdin-closes", "--port", String(port)]
    p.currentDirectoryURL = URL(fileURLWithPath: home)
    p.environment = childEnv()
    let input = Pipe(), output = Pipe()
    p.standardInput = input
    p.standardOutput = output
    p.standardError = output
    var seen = ""
    output.fileHandleForReading.readabilityHandler = { [weak self] h in
      let chunk = String(data: h.availableData, encoding: .utf8) ?? ""
      if chunk.isEmpty { h.readabilityHandler = nil; return }
      log(chunk)
      seen += chunk
      DispatchQueue.main.async { self?.onOutput(seen, port: port) }
    }
    p.terminationHandler = { [weak self] proc in
      DispatchQueue.main.async {
        log("studio exited: status \(proc.terminationStatus) reason \(proc.terminationReason.rawValue)\n")
        guard let self, self.child === proc else { return }
        self.child = nil
        self.url = nil
        self.openButton.isEnabled = false
        if seen.contains("EADDRINUSE") || seen.contains("is in use") {
          if port != 0 { return self.start(port: 0) }
        }
        self.setStatus("Studio stopped.")
        if proc.terminationStatus != 0 { _ = alert("Studio stopped", String(seen.suffix(600))) }
      }
    }
    do { try p.run() } catch { _ = alert("Could not start Studio", "\(error)"); return }
    child = p
    stdinPipe = input
  }

  func onOutput(_ text: String, port: Int) {
    guard url == nil, let r = text.range(of: #"http://127\.0\.0\.1:\d+"#, options: .regularExpression) else { return }
    url = URL(string: String(text[r]))
    openButton.isEnabled = true
    setStatus("Studio is running at \(url!.absoluteString)" + (activeKey() == nil ? "\nNo TypeSafe key set: lines that are not a fixed phrase run as goals." : ""))
    openStudio()
  }

  func stop() {
    log("stop() called by app\n")
    stdinPipe?.fileHandleForWriting.closeFile()
    child?.terminate()
    child?.waitUntilExit()
    child = nil
  }

  func activeRun() -> Bool {
    guard let url, let data = try? Data(contentsOf: url.appendingPathComponent("api/status")),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
    return !(json["activeRun"] is NSNull) && json["activeRun"] != nil
  }

  // MARK: actions

  @objc func openStudio() { if let url { NSWorkspace.shared.open(url) } }

  @objc func showTests() {
    let dir = URL(fileURLWithPath: NSHomeDirectory() + "/sim-eyes-tests")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    NSWorkspace.shared.open(dir)
  }

  @objc func setKey() {
    let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
    field.placeholderString = "TypeSafe API key"
    let a = NSAlert()
    a.messageText = "TypeSafe API key"
    a.informativeText = "Optional: the app already includes a key. Use your own instead; it is kept in your Keychain. Leave empty to go back to the included key."
    a.accessoryView = field
    a.addButton(withTitle: "Save")
    a.addButton(withTitle: "Cancel")
    NSApp.activate(ignoringOtherApps: true)
    guard a.runModal() == .alertFirstButtonReturn else { return }
    saveKey(field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines))
    if activeRun() && !alert("A test is running", "Applying the key restarts Studio and ends the run. Continue?", buttons: ["Restart", "Cancel"]) { return }
    stop()
    start()
  }

  func applicationShouldTerminate(_ app: NSApplication) -> NSApplication.TerminateReply {
    if activeRun() && !alert("A test is running", "Quitting now ends the run. Quit anyway?", buttons: ["Quit", "Cancel"]) { return .terminateCancel }
    stop()
    return .terminateNow
  }

  func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool {
    openStudio()
    return true
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }

  // MARK: UI

  func setStatus(_ text: String) { statusLabel?.stringValue = text }

  func buildWindow() {
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 190), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
    window.title = "SimEyes Studio"
    window.center()
    window.isReleasedWhenClosed = false
    statusLabel = NSTextField(wrappingLabelWithString: "")
    openButton = NSButton(title: "Open Studio in Browser", target: self, action: #selector(openStudio))
    openButton.isEnabled = false
    openButton.bezelStyle = .rounded
    openButton.keyEquivalent = "\r"
    let key = NSButton(title: "TypeSafe Key…", target: self, action: #selector(setKey))
    let tests = NSButton(title: "Show Tests Folder", target: self, action: #selector(showTests))
    let row = NSStackView(views: [openButton, key, tests])
    row.spacing = 8
    let stack = NSStackView(views: [statusLabel, row])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 16
    stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
    window.contentView = stack
  }

  func buildMenu() {
    let main = NSMenu()
    let appItem = NSMenuItem()
    main.addItem(appItem)
    let m = NSMenu()
    m.addItem(withTitle: "Open Studio in Browser", action: #selector(openStudio), keyEquivalent: "o").target = self
    m.addItem(withTitle: "TypeSafe Key…", action: #selector(setKey), keyEquivalent: ",").target = self
    m.addItem(withTitle: "Show Tests Folder", action: #selector(showTests), keyEquivalent: "").target = self
    m.addItem(.separator())
    m.addItem(withTitle: "Quit SimEyes Studio", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = m
    NSApp.mainMenu = main
  }
}

let app = NSApplication.shared
let delegate = Studio()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
