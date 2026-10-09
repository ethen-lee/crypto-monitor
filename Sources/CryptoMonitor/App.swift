import AppKit
import ServiceManagement
import WebKit

@main
struct CryptoMonitorMain {
    @MainActor static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.accessory)
        application.run()
    }
}

struct Preferences: Codable {
    var menuAssets: [String]
    var pinned: Bool
}

struct LoginItemState: Codable {
    let status: String
    var error: String? = nil
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, NSPopoverDelegate {
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private var webView: WKWebView!
    private let client = MarketClient()
    private let research = ResearchClient()
    private var lastInterestRefresh = Date.distantPast
    private var researchInterval = "4h"
    private var observing = false
    private var latest = Snapshot(quotes: [], errors: [:])
    private var preferences: Preferences
    private var timer: Timer?
    private var escapeMonitor: Any?
    private var refreshing = false
    private var pageReady = false
    private var chartAsset: Asset = .btc
    private var chartInterval = "1h"

    override init() {
        let assets = UserDefaults.standard.stringArray(forKey: "menuAssets") ?? ["btc", "eth"]
        preferences = Preferences(menuAssets: assets.filter { Asset(rawValue: $0) != nil }, pinned: false)
        if preferences.menuAssets.isEmpty { preferences.menuAssets = ["btc", "eth"] }
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let launchEvent = NSAppleEventManager.shared().currentAppleEvent
        let launchedAtLogin = launchEvent?.eventID == kAEOpenApplication &&
            launchEvent?.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "waveform.path", accessibilityDescription: "Crypto Monitor")
            button.image?.isTemplate = true
            button.imagePosition = .imageLeading
            button.font = .monospacedDigitSystemFont(ofSize: 12, weight: .medium)
            button.target = self
            button.action = #selector(statusClicked)
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        updateMenuBar()
        configureWebView()
        let controller = NSViewController()
        controller.view = webView
        popover.contentViewController = controller
        resizePopover()
        popover.behavior = .transient
        popover.animates = true
        popover.delegate = self
        popover.appearance = NSAppearance(named: .darkAqua)
        setupMenu()
        // Route Escape through the page before NSPopover handles its default dismissal.
        escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.keyCode == 53, let self, self.popover.isShown else { return event }
            self.send(["type": "escape"])
            return nil
        }
        Task {
            latest = await client.cachedSnapshot()
            updateMenuBar()
            await refreshQuotes()
        }
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in
                await self?.refreshQuotes()
                self?.accumulateInterest()
            }
        }
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(wake), name: NSWorkspace.didWakeNotification, object: nil)
        if !launchedAtLogin {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { self.showPopover() }
        }
    }

    private func configureWebView() { webView = makeWebView() }

    private func makeWebView() -> WKWebView {
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "native")
        let diagnostics = """
        window.addEventListener('error', function(event) {
            window.webkit.messageHandlers.native.postMessage({action: 'frontendError', message: event.message || 'Resource failed to load'});
        });
        window.addEventListener('unhandledrejection', function(event) {
            window.webkit.messageHandlers.native.postMessage({action: 'frontendError', message: String(event.reason)});
        });
        """
        config.userContentController.addUserScript(WKUserScript(source: diagnostics, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.websiteDataStore = .default()
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 960, height: 900), configuration: config)
        view.navigationDelegate = self
        view.setValue(false, forKey: "drawsBackground")
        if #available(macOS 13.3, *) { view.isInspectable = true }
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("Web"),
              FileManager.default.fileExists(atPath: root.appendingPathComponent("index.html").path) else {
            let alert = NSAlert()
            alert.messageText = "应用资源不完整"
            alert.informativeText = "请在项目目录运行 npm run build 后重新打开 CryptoMonitor.app。"
            alert.runModal()
            NSApp.terminate(nil)
            return view
        }
        view.loadFileURL(root.appendingPathComponent("index.html").absoluteURL, allowingReadAccessTo: root)
        return view
    }

    private func setupMenu() {
        let menu = NSMenu()
        let root = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "退出 Crypto Monitor", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        root.submenu = appMenu
        menu.addItem(root)
        NSApp.mainMenu = menu
    }

    @objc private func statusClicked() {
        if NSApp.currentEvent?.type == .rightMouseUp {
            let menu = NSMenu()
            let show = menu.addItem(withTitle: "打开行情", action: #selector(showPopover), keyEquivalent: "")
            show.target = self
            let refresh = menu.addItem(withTitle: "刷新报价", action: #selector(refreshFromMenu), keyEquivalent: "")
            refresh.target = self
            menu.addItem(.separator())
            menu.addItem(withTitle: "退出 Crypto Monitor", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
            statusItem.menu = menu
            statusItem.button?.performClick(nil)
            statusItem.menu = nil
        } else if popover.isShown {
            popover.performClose(nil)
        } else {
            showPopover()
        }
    }

    @objc private func showPopover() {
        guard let button = statusItem.button else { return }
        resizePopover()
        NSApp.activate(ignoringOtherApps: true)
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
        send(["type": "visibility", "visible": true])
        sendLoginItemState()
        Task { await refreshQuotes() }
    }

    private func resizePopover() {
        let screen = (statusItem.button?.window?.screen ?? NSScreen.main)?.visibleFrame.size ?? NSSize(width: 1440, height: 1000)
        popover.contentSize = NSSize(width: min(960, screen.width - 40), height: min(900, screen.height - 50))
    }

    func popoverDidClose(_ notification: Notification) {
        send(["type": "visibility", "visible": false])
    }

    @objc private func wake() {
        send(["type": "wake"])
        accumulateInterest()
        Task { await refreshQuotes(force: true) }
    }

    private func accumulateInterest() {
        guard Date().timeIntervalSince(lastInterestRefresh) >= 300 else { return }
        lastInterestRefresh = Date()
        Task { _ = try? await research.series(.interest, interval: "4h") }
    }
    @objc private func refreshFromMenu() { Task { await refreshQuotes(force: true) } }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showPopover()
        return false
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        sendLoginItemState()
    }

    private func loginItemState() -> LoginItemState {
        switch SMAppService.mainApp.status {
        case .enabled: return LoginItemState(status: "enabled")
        case .notRegistered: return LoginItemState(status: "notRegistered")
        case .requiresApproval: return LoginItemState(status: "requiresApproval")
        case .notFound: return LoginItemState(status: "notFound")
        @unknown default: return LoginItemState(status: "unavailable")
        }
    }

    private func sendLoginItemState() {
        send(["type": "loginItem", "payload": jsonObject(loginItemState())])
    }

    private func setLaunchAtLogin(_ enabled: Bool) -> LoginItemState {
        let service = SMAppService.mainApp
        do {
            if enabled {
                // System Settings owns approval; do not re-register a user-disabled item.
                if service.status != .enabled && service.status != .requiresApproval {
                    try service.register()
                }
            } else if service.status != .notRegistered {
                try service.unregister()
            }
            return loginItemState()
        } catch {
            let failure = error as NSError
            NSLog("Login item update failed: domain=%@ code=%ld reason=%@", failure.domain, failure.code, failure.localizedDescription)
            var state = loginItemState()
            state.error = "无法修改登录启动：\(error.localizedDescription)"
            return state
        }
    }

    private func refreshQuotes(force: Bool = false) async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        latest = await client.snapshot(force: force)
        updateMenuBar()
        send(["type": "quotes", "payload": jsonObject(latest)])
    }

    private func updateMenuBar() {
        let parts = preferences.menuAssets.compactMap { raw -> String? in
            guard let asset = Asset(rawValue: raw) else { return nil }
            guard let quote = latest.quotes.first(where: { $0.asset == asset }) else { return "\(asset.label) —" }
            let formatter = NumberFormatter()
            formatter.numberStyle = .decimal
            formatter.minimumFractionDigits = asset.isYield ? 2 : 0
            formatter.maximumFractionDigits = asset.isYield ? 2 : 0
            let value = formatter.string(from: NSNumber(value: quote.price)) ?? "—"
            return "\(asset.label) \(value)\(asset.isYield ? "%" : "")\(quote.cached ? " ◦" : "")"
        }
        statusItem.button?.title = " " + parts.joined(separator: "  ·  ")
        statusItem.button?.toolTip = "Crypto Monitor\n点击查看 K 线 · 右键打开菜单\n◦ 表示缓存报价"
        statusItem.button?.setAccessibilityLabel("Crypto Monitor，" + parts.joined(separator: "，"))
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.isFileURL == true,
              let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        let id = body["id"] as? String ?? ""
        switch action {
        case "frontendError":
            NSLog("Frontend error: %@", String((body["message"] as? String ?? "Unknown error").prefix(500)))
        case "ready":
            pageReady = true
            let symbols = Dictionary(uniqueKeysWithValues: Asset.allCases.map { ($0.rawValue, $0.tradingViewSymbol) })
            reply(id, payload: ["snapshot": jsonObject(latest), "preferences": jsonObject(preferences), "visible": popover.isShown, "tradingViewSymbols": symbols, "loginItem": jsonObject(loginItemState())])
        case "loginItemStatus":
            reply(id, payload: jsonObject(loginItemState()))
        case "setLaunchAtLogin":
            guard let enabled = body["enabled"] as? Bool else {
                reply(id, error: "无效的登录启动设置。")
                return
            }
            reply(id, payload: jsonObject(setLaunchAtLogin(enabled)))
        case "openLoginItemSettings":
            SMAppService.openSystemSettingsLoginItems()
            reply(id, payload: true)
        case "refresh":
            Task {
                await refreshQuotes(force: true)
                reply(id, payload: jsonObject(latest))
            }
        case "researchContext":
            observing = body["active"] as? Bool ?? false
            if let interval = body["interval"] as? String, ["1h", "4h", "1d"].contains(interval) {
                researchInterval = interval
            }
            reply(id, payload: true)
        case "research":
            guard let raw = body["dataset"] as? String, let dataset = ResearchDataset(rawValue: raw),
                  let interval = body["interval"] as? String else {
                reply(id, error: "无效的观察数据请求。")
                return
            }
            let force = body["force"] as? Bool ?? false
            Task {
                do { reply(id, payload: jsonObject(try await research.series(dataset, interval: interval, force: force))) }
                catch { reply(id, error: error.localizedDescription) }
            }
        case "openResearchLink":
            let destinations = [
                "liquidation": "https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=ETH",
                "positions": "https://app.hyblockcapital.com/",
                "cost": "https://studio.glassnode.com/",
            ]
            guard let key = body["destination"] as? String, let destination = destinations[key], let url = URL(string: destination) else {
                reply(id, error: "未知的外部数据入口。")
                return
            }
            reply(id, payload: NSWorkspace.shared.open(url))
        case "history":
            guard let raw = body["asset"] as? String, let asset = Asset(rawValue: raw), let interval = body["interval"] as? String else {
                reply(id, error: "无效的行情请求。")
                return
            }
            let force = body["force"] as? Bool ?? false
            chartAsset = asset
            chartInterval = interval
            Task {
                do { reply(id, payload: jsonObject(try await client.history(asset, interval: interval, force: force))) }
                catch { reply(id, error: error.localizedDescription) }
            }
        case "preferences":
            if let assets = body["menuAssets"] as? [String] {
                let valid = Asset.allCases.map(\.rawValue).filter { assets.contains($0) }
                if !valid.isEmpty {
                    preferences.menuAssets = valid
                    UserDefaults.standard.set(valid, forKey: "menuAssets")
                    updateMenuBar()
                }
            }
            if let pinned = body["pinned"] as? Bool {
                preferences.pinned = pinned
                popover.behavior = pinned ? .applicationDefined : .transient
            }
            reply(id, payload: jsonObject(preferences))
        case "close":
            popover.performClose(nil)
            reply(id, payload: true)
        case "quit": NSApp.terminate(nil)
        default: reply(id, error: "未知操作。")
        }
    }

    private func reply(_ id: String, payload: Any = NSNull(), error: String? = nil) {
        var value: [String: Any] = ["id": id, "payload": payload]
        if let error { value["error"] = error }
        send(value)
    }

    private func jsonObject<T: Encodable>(_ value: T) -> Any {
        guard let data = try? JSONEncoder().encode(value), let object = try? JSONSerialization.jsonObject(with: data) else { return NSNull() }
        return object
    }

    private func send(_ value: [String: Any]) {
        guard pageReady,
              let data = try? JSONSerialization.data(withJSONObject: value), let json = String(data: data, encoding: .utf8) else { return }
        webView.callAsyncJavaScript("window.receiveNative(message)", arguments: ["message": json], in: nil, in: .page) { result in
            if case .failure(let error) = result { NSLog("Web bridge: %@", error.localizedDescription) }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if url.isFileURL { decisionHandler(.allow); return }
        if url.scheme == "https", let host = url.host,
           host == "tradingview.com" || host.hasSuffix(".tradingview.com") {
            // The library attribution logo points to the homepage. Open the displayed market instead.
            if url.path == "/" || url.path.isEmpty {
                var destination = URLComponents(string: "https://www.tradingview.com/chart/")!
                let interval = ["1m": "1", "15m": "15", "1h": "60", "4h": "240", "6h": "360", "1d": "D", "1w": "W"][observing ? researchInterval : chartInterval] ?? "D"
                destination.queryItems = [URLQueryItem(name: "symbol", value: observing ? "BINANCE:ETHUSDT.P" : chartAsset.tradingViewSymbol), URLQueryItem(name: "interval", value: interval)]
                if let destination = destination.url { NSWorkspace.shared.open(destination) }
            } else {
                NSWorkspace.shared.open(url)
            }
        }
        decisionHandler(.cancel)
    }
}
