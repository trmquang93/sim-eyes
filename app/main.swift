// SimEyes Studio: the double-click launcher. It starts the bundled Node with Studio, shows the page in its own window
// (a web view on 127.0.0.1, never an external browser) and stops Studio when the app quits. No test logic lives here; Studio is the same code `npm run studio` runs.
// The code it runs is the newest signed bundle the hub has shipped (checked by updater.mjs, which lives in the app), or the
// copy built into the app. The TypeSafe key is not here: calls go through the hub with the tester's invite token.
import AppKit
import Security
import WebKit

/// HOME as the environment gives it (a check can point it at a throwaway folder); NSHomeDirectory() ignores it.
let homeDir = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()

let keychainService = "com.simeyes.studio"
let keychainAccount = "HUB_INVITE_TOKEN"

/// `interactive: false` (the MCP server): a Keychain approval prompt must not hang a client's start-up, so it fails and `goal` is simply off.
func readKey(interactive: Bool = true) -> String? {
  var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: keychainService,
                              kSecAttrAccount as String: keychainAccount, kSecReturnData as String: true]
  if !interactive { query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail }
  var out: AnyObject?
  guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
  return String(data: data, encoding: .utf8)
}

var keyIsInteractive = true
func activeKey() -> String? {
  if keyIsInteractive { return readKey() }
  // The old file Keychain asks "allow?" inside the read and ignores the no-UI flag, so a rebuilt (re-signed) app would hang the client's start-up
  // on a dialog. Wait a few seconds for the answer, then go on without a token: every step except `goal` works.
  var found: String?
  let done = DispatchSemaphore(value: 0)
  DispatchQueue.global().async { found = readKey(interactive: false); done.signal() }
  if done.wait(timeout: .now() + 3) == .timedOut { log("keychain read timed out: starting without the invite token\n"); return nil }
  return found
}

let supportDir = homeDir + "/Library/Application Support/SimEyesStudio"

/// The path of this executable with symlinks resolved: `~/.local/sim-eyes/bin/sim-eyes-mcp` points here, and the app can be moved.
let executablePath: String = {
  var size: UInt32 = 0
  _NSGetExecutablePath(nil, &size)
  var buffer = [CChar](repeating: 0, count: Int(size))
  _NSGetExecutablePath(&buffer, &size)
  return URL(fileURLWithPath: String(cString: buffer)).resolvingSymlinksInPath().path
}()

/// The app's Resources folder, found from the real executable (`Bundle.main` is not trusted when we were started through a symlink).
let resDir: String = {
  let candidate = URL(fileURLWithPath: executablePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Resources").path
  return FileManager.default.fileExists(atPath: candidate + "/node") ? candidate : Bundle.main.resourcePath!
}()

let nodePath = resDir + "/node"
let builtinHomePath = resDir + "/sim-eyes"
let simPoolPath = resDir + "/sim-pool"

/// What build-app.sh wrote next to the app's code: { hubUrl, appVersion, depsHash }.
func appConfig() -> [String: Any] {
  guard let data = try? Data(contentsOf: URL(fileURLWithPath: resDir + "/app.json")),
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
  return json
}

/// `defaults write com.simeyes.studio hubUrl http://127.0.0.1:8081` points the app at another hub (a local one for checks).
func hubURL() -> String { UserDefaults.standard.string(forKey: "hubUrl") ?? (appConfig()["hubUrl"] as? String ?? "") }

var appVersionString: String { appConfig()["appVersion"] as? String ?? "0.0.0" }

/// The last line a helper printed, as JSON.
func parseLine(_ out: String) -> [String: Any]? {
  guard let line = out.split(separator: "\n").last, let data = String(line).data(using: .utf8) else { return nil }
  return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
}

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
  let path = homeDir + "/Library/Logs/SimEyesStudio.log"
  try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
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
  p.standardInput = FileHandle.nullDevice
  let pipe = Pipe()
  p.standardOutput = pipe
  p.standardError = pipe
  do { try p.run() } catch { return (127, "\(error)") }
  let data = pipe.fileHandleForReading.readDataToEndOfFile()
  p.waitUntilExit()
  return (p.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}

/// What Studio and the MCP server both run with: a short PATH, our sim-pool and agent-device, the compiled helpers, and (with an invite token) TypeSafe through the hub.
func sharedChildEnv() -> [String: String] {
  var env = ProcessInfo.processInfo.environment
  env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"
  env["SIM_POOL_BIN"] = simPoolPath
  let ad = try! JSONSerialization.data(withJSONObject: [nodePath, "\(builtinHomePath)/node_modules/agent-device/bin/agent-device.mjs"])
  env["SIM_EYES_AD"] = String(data: ad, encoding: .utf8)!
  // The app ships ocr and pdf-facts compiled (no .swift source in it); ocr.mjs and studio/file-facts.mjs read these two.
  for (name, file) in [("SIM_EYES_OCR_BIN", "ocr"), ("SIM_EYES_PDF_FACTS_BIN", "pdf-facts")] where FileManager.default.isExecutableFile(atPath: "\(resDir)/bin/\(file)") {
    env[name] = "\(resDir)/bin/\(file)"
  }
  // The TypeSafe SDK reads these two: the invite token stands in for the key, and the hub swaps it for the real one.
  if let token = activeKey(), !hubURL().isEmpty {
    env["TYPESAFE_API_KEY"] = token
    env["TYPESAFE_BASE_URL"] = hubURL() + "/typesafe"
  } else {
    env.removeValue(forKey: "TYPESAFE_API_KEY")
    env.removeValue(forKey: "TYPESAFE_BASE_URL")
  }
  return env
}

/// The newest installed bundle that is not marked bad, or the built-in code.
func pickCode() -> (home: String, version: String, builtin: Bool) {
  let r = run(nodePath, ["\(resDir)/updater.mjs", "choose", "--dir", supportDir, "--builtin", builtinHomePath, "--builtin-version", appVersionString,
                         "--node-modules", "\(builtinHomePath)/node_modules"])
  if let j = parseLine(r.out), let path = j["path"] as? String, let version = j["version"] as? String {
    return (path, version, (j["builtin"] as? Bool) ?? true)
  }
  log("choose failed: \(r.out)\n")
  return (builtinHomePath, appVersionString, true)
}

/// A client's command line for the MCP server. Stays valid when the app moves or updates: the link is rewritten at each launch.
let stableMCPPath = homeDir + "/.local/sim-eyes/bin/sim-eyes-mcp"

/// Points the stable path at this executable: a new symlink renamed over the old one, so a client never sees a missing file.
func refreshStableLink() {
  let fm = FileManager.default
  try? fm.createDirectory(atPath: (stableMCPPath as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
  let tmp = stableMCPPath + ".tmp"
  unlink(tmp)
  guard symlink(executablePath, tmp) == 0, rename(tmp, stableMCPPath) == 0 else { log("could not write \(stableMCPPath): errno \(errno)\n"); return }
}

/// `SimEyesStudio --mcp`: no window, no Dock icon. Replaces this process with the app's Node running the MCP server, so stdin and stdout
/// belong to the server alone. The working directory is the client's: the server uses it as the lease's worktree. Logs go to the log file only.
func runMCP() -> Never {
  keyIsInteractive = false
  let code = pickCode()
  let env = sharedChildEnv()
  log("mcp start code \(code.version) \(code.home) node \(nodePath) typesafe=\(env["TYPESAFE_API_KEY"] == nil ? "none" : "hub")\n")
  var argv: [UnsafeMutablePointer<CChar>?] = [strdup(nodePath), strdup(code.home + "/cli.mjs"), nil]
  var envp: [UnsafeMutablePointer<CChar>?] = env.map { strdup("\($0.key)=\($0.value)") } + [nil]
  execve(nodePath, &argv, &envp)
  log("mcp exec failed: errno \(errno)\n")
  exit(127)
}

final class Studio: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate {
  let res = resDir
  var child: Process?
  var stdinPipe: Pipe?
  var url: URL?
  var window: NSWindow!
  var webView: WKWebView!
  var overlay: NSTextField!      // shown instead of the page while Studio starts, stops or cannot start
  var bar: NSStackView!          // a slim strip under the page: version, token and update hints
  var barLabel: NSTextField!
  var updateButton: NSButton!
  var tokenButton: NSButton!
  var updateTimer: Timer?
  var statusText = ""
  var updateReady = false

  var home = ""            // the code folder Studio runs from: a downloaded bundle, or the built-in copy
  var homeVersion = ""
  var homeIsBuiltin = true
  var startedAt = Date()
  var updateNote = ""      // what the last update check said, shown under the status

  var node: String { "\(res)/node" }
  var builtinHome: String { "\(res)/sim-eyes" }
  var appVersion: String { appConfig()["appVersion"] as? String ?? "0.0.0" }
  var simPool: String { "\(res)/sim-pool" }

  func applicationDidFinishLaunching(_ note: Notification) {
    buildMenu()
    buildWindow()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    refreshStableLink()
    guard preflight() else { setStatus("Cannot start: see the message."); return }
    start()
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.offerConnectOnce() }
    checkForUpdate(manual: false)
    updateTimer = Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { [weak self] _ in self?.checkForUpdate(manual: false) }
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
    if !FileManager.default.fileExists(atPath: homeDir + "/.agent-sim-pool/config.json") {
      let r = run(simPool, ["init"])
      if r.status != 0 { return alert("Could not set up simulators", r.out) && false }
    }
    return true
  }

  // MARK: Studio process

  func childEnv() -> [String: String] { sharedChildEnv() }

  /// The newest installed bundle that is not marked bad, or the built-in code. Never switches while Studio runs: only `start` calls it.
  func chooseCode() { (home, homeVersion, homeIsBuiltin) = pickCode() }

  func start(port: Int = 4777) {
    url = nil            // a restarted Studio gets a fresh page load, not the old one
    updateChrome()
    chooseCode()
    log("start port \(port) code \(homeVersion) \(home)\n")
    setStatus("Starting…")
    startedAt = Date()
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
        self.updateChrome()
        if seen.contains("EADDRINUSE") || seen.contains("is in use") {
          if port != 0 { return self.start(port: 0) }
        }
        // A downloaded bundle that dies at once is marked bad and skipped; the previous one, or the built-in code, starts instead.
        if proc.terminationStatus != 0 && !self.homeIsBuiltin && Date().timeIntervalSince(self.startedAt) < 10 {
          log("bundle \(self.homeVersion) failed to start: marking it bad\n")
          _ = run(self.node, ["\(self.res)/updater.mjs", "bad", "--dir", supportDir, "--version", self.homeVersion])
          return self.start()
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
    if let url { webView.load(URLRequest(url: url)) }
    refreshStatus()
    window.makeKeyAndOrderFront(nil)
  }

  /// The strip under the page: what a tester may need to act on, kept to one line.
  func refreshStatus() {
    var parts = ["Studio \(homeVersion)"]
    if activeKey() == nil { parts.append("No invite token: lines that are not a fixed phrase run as goals.") }
    if !updateNote.isEmpty { parts.append(updateNote) }
    barLabel?.stringValue = parts.joined(separator: " · ")
    updateChrome()
  }

  /// The page when Studio is up; otherwise the status text.
  func updateChrome() {
    let running = url != nil
    webView?.isHidden = !running
    overlay?.isHidden = running
    overlay?.stringValue = statusText
    bar?.isHidden = !running
    updateButton?.isHidden = !updateReady
    tokenButton?.isHidden = activeKey() != nil
  }

  // MARK: MCP (connect the app's MCP server to AI tools)

  /// connect-mcp.mjs prints one JSON value on its last line. It lives in Resources, outside any downloadable bundle.
  func connectRun(_ args: [String]) -> Any? {
    let r = run(node, ["\(res)/connect-mcp.mjs"] + args, env: childEnv())
    guard let line = r.out.split(separator: "\n").last, let data = String(line).data(using: .utf8) else { return nil }
    return try? JSONSerialization.jsonObject(with: data)
  }

  static let clientNames = ["claude-code": "Claude Code", "cursor": "Cursor", "claude-desktop": "Claude Desktop"]

  func installedClients() -> [(id: String, name: String, current: [String: Any]?)] {
    let all = connectRun(["detect"]) as? [[String: Any]] ?? []
    return all.filter { ($0["installed"] as? Bool) == true }.compactMap { c in
      guard let id = c["client"] as? String else { return nil }
      return (id, Studio.clientNames[id] ?? id, c["current"] as? [String: Any])
    }
  }

  func describe(_ entry: [String: Any]?) -> String {
    guard let entry else { return "none" }
    let command = entry["command"] as? String ?? "?"
    return ([command] + (entry["args"] as? [String] ?? [])).joined(separator: " ")
  }

  @objc func connectTools() {
    refreshStableLink()
    let clients = installedClients()
    if clients.isEmpty {
      _ = alert("No AI tools found", "Claude Code, Cursor and Claude Desktop were not found on this Mac. Choose Copy MCP Command and paste it into your tool's MCP settings.")
      return
    }
    var summary: [String] = []
    for c in clients {
      let plan = connectRun(["plan", "--client", c.id, "--command", stableMCPPath]) as? [String: Any] ?? [:]
      switch plan["action"] as? String ?? "" {
      case "unchanged": summary.append("\(c.name): already connected")
      case "replace": summary.append("\(c.name): replace \(describe(plan["before"] as? [String: Any]))")
      case "invalid-config": summary.append("\(c.name): its config file is not valid JSON, skipped")
      default: summary.append("\(c.name): add SimEyes")
      }
    }
    guard alert("Connect SimEyes to your AI tools", summary.joined(separator: "\n") + "\n\nCommand: \(stableMCPPath)", buttons: ["Connect", "Cancel"]) else { return }
    var results: [String] = []
    for c in clients {
      var r = connectRun(["apply", "--client", c.id, "--command", stableMCPPath]) as? [String: Any] ?? [:]
      if r["status"] as? String == "needs-replace" {
        let old = describe(r["before"] as? [String: Any])
        if alert("Replace the existing SimEyes entry?", "\(c.name) already has a \"sim-eyes\" server: \(old)", buttons: ["Replace", "Keep it"]) {
          r = connectRun(["apply", "--client", c.id, "--command", stableMCPPath, "--replace"]) as? [String: Any] ?? [:]
        } else { results.append("\(c.name): kept your existing entry"); continue }
      }
      switch r["status"] as? String ?? "error" {
      case "ok": results.append("\(c.name): connected")
      case "claude-not-found", "failed":
        let command = r["manualCommand"] as? String ?? "claude mcp add --scope user sim-eyes -- \(stableMCPPath)"
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(command, forType: .string)
        results.append("\(c.name): run this in a terminal (copied): \(command)")
      default: results.append("\(c.name): \(r["reason"] as? String ?? "not changed")")
      }
    }
    let ready = readinessNote()
    _ = alert("Done", results.joined(separator: "\n") + "\n\nRestart the tool so it picks up SimEyes.\n" + ready)
  }

  /// `doctor` with the same environment the MCP server gets: what is missing on this Mac, in plain words.
  func readinessNote() -> String {
    let r = run(node, ["\(pickCode().home)/cli.mjs", "doctor", "--json"], env: childEnv())
    guard let data = r.out.data(using: .utf8), let items = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return "Could not check this Mac: \(String(r.out.suffix(200)))" }
    let problems = items.filter { ($0["status"] as? String) != "pass" }.map { "\(($0["status"] as? String ?? "").uppercased()): \($0["detail"] as? String ?? "")" + (($0["fix"] as? String ?? "").isEmpty ? "" : " (\($0["fix"] as! String))") }
    return problems.isEmpty ? "This Mac is ready." : problems.joined(separator: "\n")
  }

  @objc func disconnectTools() {
    let connected = installedClients().filter { $0.current != nil }
    if connected.isEmpty { _ = alert("Nothing to disconnect", "SimEyes is not set up in any AI tool."); return }
    guard alert("Disconnect SimEyes", "Remove the \"sim-eyes\" server from: " + connected.map { $0.name }.joined(separator: ", "), buttons: ["Disconnect", "Cancel"]) else { return }
    var results: [String] = []
    for c in connected {
      let r = connectRun(["remove", "--client", c.id]) as? [String: Any] ?? [:]
      results.append("\(c.name): " + (r["status"] as? String == "ok" ? "removed" : (r["manualCommand"] as? String ?? r["reason"] as? String ?? "not changed")))
    }
    _ = alert("Done", results.joined(separator: "\n"))
  }

  @objc func copyMCPCommand() {
    refreshStableLink()
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(stableMCPPath, forType: .string)
    _ = alert("Copied", "\(stableMCPPath)\n\nAdd it as an MCP server's command in your AI tool (no arguments).")
  }

  /// Once, after the first successful start: offer to connect. The answer is kept, the menu item stays.
  func offerConnectOnce() {
    let file = supportDir + "/mcp-offer.json"
    if FileManager.default.fileExists(atPath: file) { return }
    try? FileManager.default.createDirectory(atPath: supportDir, withIntermediateDirectories: true)
    let yes = alert("Use SimEyes from your AI tools?", "This app includes the SimEyes MCP server. Connect it to Claude Code, Cursor or Claude Desktop now? You can do this later from the SimEyes Studio menu.", buttons: ["Connect…", "Not now"])
    let record = ["offered": true, "answeredAt": ISO8601DateFormatter().string(from: Date()), "connect": yes] as [String: Any]
    if let data = try? JSONSerialization.data(withJSONObject: record) { FileManager.default.createFile(atPath: file, contents: data) }
    if yes { connectTools() }
  }

  // MARK: updates

  /// Asks the hub for a newer bundle in the background. A staged bundle starts only when Studio next starts.
  func checkForUpdate(manual: Bool) {
    guard let token = activeKey() else {
      if manual { _ = alert("No invite token", "Choose Invite Token… and paste the token you were sent. It is needed to get updates.") }
      return
    }
    var env = ProcessInfo.processInfo.environment
    env["SIM_EYES_HUB_TOKEN"] = token
    let args = ["\(res)/updater.mjs", "check", "--hub", hubURL(), "--dir", supportDir, "--app", "\(res)/app.json", "--key", "\(res)/release-public.pem"]
    DispatchQueue.global().async {
      let r = run(self.node, args, env: env)
      let result = parseLine(r.out) ?? ["status": "error", "reason": r.out]
      log("update check: \(r.out)")
      DispatchQueue.main.async { self.onUpdateResult(result, manual: manual) }
    }
  }

  func onUpdateResult(_ result: [String: Any], manual: Bool) {
    let status = result["status"] as? String ?? "error"
    let reason = result["reason"] as? String ?? ""
    let version = result["version"] as? String ?? ""
    switch status {
    case "staged":
      updateNote = "Update \(version) is ready."
      updateReady = true
    case "up-to-date":
      updateNote = ""
      if manual { _ = alert("Up to date", "You have the newest version of Studio (\(homeVersion)).") }
    case "unauthorized", "needs-new-app", "rejected":
      updateNote = reason
      if manual || status == "unauthorized" { _ = alert("No update", reason) }
    default:
      updateNote = manual ? reason : ""
      if manual { _ = alert("Could not check for updates", reason) }
    }
    refreshStatus()
  }

  @objc func checkNow() { checkForUpdate(manual: true) }

  @objc func restartForUpdate() {
    if activeRun() && !alert("A test is running", "Updating restarts Studio and ends the run. Continue?", buttons: ["Restart", "Cancel"]) { return }
    stop()
    updateNote = ""
    updateReady = false
    start()
  }

  func stop() {
    log("stop() called by app\n")
    // Detach first: waitUntilExit runs the main queue, and the exit handler must not take our own SIGTERM for a crash
    // (no "Studio stopped" alert, no marking the bundle bad, no restart while quitting).
    let proc = child
    child = nil
    stdinPipe?.fileHandleForWriting.closeFile()
    stdinPipe = nil
    proc?.terminate()
    proc?.waitUntilExit()
  }

  func activeRun() -> Bool {
    guard let url, let data = try? Data(contentsOf: url.appendingPathComponent("api/status")),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
    return !(json["activeRun"] is NSNull) && json["activeRun"] != nil
  }

  // MARK: actions

  /// A fallback for anything the window cannot do: the same page in the default browser.
  @objc func openInBrowser() { if let url { NSWorkspace.shared.open(url) } }

  @objc func reloadPage() { webView.reload() }

  @objc func showTests() {
    let dir = URL(fileURLWithPath: homeDir + "/sim-eyes-tests")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    NSWorkspace.shared.open(dir)
  }

  @objc func setToken() {
    let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
    field.placeholderString = "Invite token"
    let a = NSAlert()
    a.messageText = "Invite token"
    a.informativeText = "Paste the token you were sent. It lets this app get updates and read test lines. It is kept in your Keychain. Leave empty to remove it."
    a.accessoryView = field
    a.addButton(withTitle: "Save")
    a.addButton(withTitle: "Cancel")
    NSApp.activate(ignoringOtherApps: true)
    guard a.runModal() == .alertFirstButtonReturn else { return }
    saveKey(field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines))
    if activeRun() && !alert("A test is running", "Applying the token restarts Studio and ends the run. Continue?", buttons: ["Restart", "Cancel"]) { return }
    stop()
    start()
    checkForUpdate(manual: true)
  }

  func applicationShouldTerminate(_ app: NSApplication) -> NSApplication.TerminateReply {
    if activeRun() && !alert("A test is running", "Quitting now ends the run. Quit anyway?", buttons: ["Quit", "Cancel"]) { return .terminateCancel }
    stop()
    return .terminateNow
  }

  func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool {
    window.makeKeyAndOrderFront(nil)
    return true
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }

  // MARK: UI

  func setStatus(_ text: String) {
    statusText = text
    updateChrome()
  }

  func buildWindow() {
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 860), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.title = "SimEyes Studio"
    window.minSize = NSSize(width: 900, height: 600)
    window.isReleasedWhenClosed = false
    window.center()
    window.setFrameAutosaveName("SimEyesStudioMain")

    let config = WKWebViewConfiguration()
    webView = WKWebView(frame: .zero, configuration: config)
    webView.uiDelegate = self
    webView.navigationDelegate = self
    webView.isHidden = true

    overlay = NSTextField(wrappingLabelWithString: "Starting…")
    overlay.alignment = .center
    overlay.font = .systemFont(ofSize: 15)
    overlay.textColor = .secondaryLabelColor

    barLabel = NSTextField(labelWithString: "")
    barLabel.textColor = .secondaryLabelColor
    barLabel.font = .systemFont(ofSize: 12)
    barLabel.lineBreakMode = .byTruncatingTail
    barLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
    barLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    tokenButton = NSButton(title: "Invite Token…", target: self, action: #selector(setToken))
    updateButton = NSButton(title: "Restart to Update", target: self, action: #selector(restartForUpdate))
    for b in [tokenButton!, updateButton!] { b.bezelStyle = .rounded; b.controlSize = .small }
    bar = NSStackView(views: [barLabel, tokenButton, updateButton])
    bar.orientation = .horizontal
    bar.spacing = 8
    bar.edgeInsets = NSEdgeInsets(top: 5, left: 12, bottom: 5, right: 12)
    bar.isHidden = true

    let content = NSView()
    for v in [webView!, overlay!, bar!] { v.translatesAutoresizingMaskIntoConstraints = false; content.addSubview(v) }
    NSLayoutConstraint.activate([
      bar.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      bar.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      bar.bottomAnchor.constraint(equalTo: content.bottomAnchor),
      webView.topAnchor.constraint(equalTo: content.topAnchor),
      webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      webView.bottomAnchor.constraint(equalTo: bar.topAnchor),
      overlay.centerXAnchor.constraint(equalTo: content.centerXAnchor),
      overlay.centerYAnchor.constraint(equalTo: content.centerYAnchor),
      overlay.widthAnchor.constraint(lessThanOrEqualToConstant: 520),
    ])
    window.contentView = content
    updateChrome()
  }

  // MARK: web view

  /// Studio's page picks files for builds ("Choose file…", "Choose .app folder…"); a web view needs the host to show the panel.
  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    let panel = NSOpenPanel()
    panel.canChooseFiles = !parameters.allowsDirectories
    panel.canChooseDirectories = parameters.allowsDirectories
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.begin { response in completionHandler(response == .OK ? panel.urls : nil) }
  }

  /// The page stays on Studio: a link to anywhere else opens in the default browser.
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let target = action.request.url, let studio = url else { return decisionHandler(.allow) }
    let local = target.scheme == "about" || (target.host == studio.host && target.port == studio.port)
    if !local && ["http", "https"].contains(target.scheme ?? "") {
      NSWorkspace.shared.open(target)
      return decisionHandler(.cancel)
    }
    decisionHandler(.allow)
  }

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let target = action.request.url { NSWorkspace.shared.open(target) }
    return nil
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    log("page failed to load: \(error.localizedDescription)\n")
    url = nil
    setStatus("Studio's page could not be loaded: \(error.localizedDescription)\nQuit SimEyes Studio and open it again.")
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    _ = alert("SimEyes Studio", message)
    completionHandler()
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    completionHandler(alert("SimEyes Studio", message, buttons: ["OK", "Cancel"]))
  }

  func buildMenu() {
    let main = NSMenu()
    func submenu(_ title: String) -> NSMenu {
      let item = NSMenuItem()
      main.addItem(item)
      let m = NSMenu(title: title)
      item.submenu = m
      return m
    }
    let app = submenu("SimEyes Studio")
    app.addItem(withTitle: "Invite Token…", action: #selector(setToken), keyEquivalent: ",").target = self
    app.addItem(withTitle: "Check for Updates", action: #selector(checkNow), keyEquivalent: "u").target = self
    app.addItem(withTitle: "Restart to Update", action: #selector(restartForUpdate), keyEquivalent: "").target = self
    app.addItem(.separator())
    app.addItem(withTitle: "Connect to AI Tools…", action: #selector(connectTools), keyEquivalent: "").target = self
    app.addItem(withTitle: "Disconnect from AI Tools…", action: #selector(disconnectTools), keyEquivalent: "").target = self
    app.addItem(withTitle: "Copy MCP Command", action: #selector(copyMCPCommand), keyEquivalent: "").target = self
    app.addItem(.separator())
    app.addItem(withTitle: "Show Tests Folder", action: #selector(showTests), keyEquivalent: "").target = self
    app.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "o").target = self
    app.addItem(.separator())
    app.addItem(withTitle: "Hide SimEyes Studio", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    app.addItem(withTitle: "Quit SimEyes Studio", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

    // Without these, copy and paste do not work in the page's text fields.
    let edit = submenu("Edit")
    edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
    redo.keyEquivalentModifierMask = [.command, .shift]
    edit.addItem(.separator())
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

    let view = submenu("View")
    view.addItem(withTitle: "Reload Page", action: #selector(reloadPage), keyEquivalent: "r").target = self

    let windowMenu = submenu("Window")
    windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    NSApp.windowsMenu = windowMenu
    NSApp.mainMenu = main
  }
}

// A symlink cannot carry arguments: a client that runs ~/.local/sim-eyes/bin/sim-eyes-mcp gets the MCP server because argv[0] has that name.
let launchedAsMCP = URL(fileURLWithPath: CommandLine.arguments[0]).lastPathComponent == "sim-eyes-mcp"
if launchedAsMCP || CommandLine.arguments.contains("--mcp") { runMCP() }
if CommandLine.arguments.contains("--refresh-link") { refreshStableLink(); exit(0) }

let app = NSApplication.shared
let delegate = Studio()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
