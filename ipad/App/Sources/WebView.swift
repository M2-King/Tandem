import SwiftUI
import WebKit

// The Tandem UI. Only the app's own local address may load in it; other links
// open in Safari. If iPadOS ends the web content (memory pressure), it reloads.
//
// iPadOS never shows the Home Screen wallpaper behind an app. To get the same
// look anyway, the person picks their wallpaper photo and the page draws it
// lined up with the screen; for that the page needs to know where this window
// is on the screen, which TandemWebView reports (window.__tandemScreen).
struct WebView: UIViewRepresentable {
    let url: URL
    let origin: String
    var onSeeThrough: (Bool) -> Void = { _ in }

    func makeCoordinator() -> Coordinator { Coordinator(origin: origin, onSeeThrough: onSeeThrough) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        // The page asks for the see-through window with
        // webkit.messageHandlers.tandem.postMessage({ seeThrough: true }).
        config.userContentController.add(context.coordinator, name: "tandem")
        let view = TandemWebView(frame: .zero, configuration: config)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.scrollView.bounces = false
        view.scrollView.isScrollEnabled = false
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        if #available(iOS 16.4, *) { view.isInspectable = true }
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.origin = origin
        if view.url == nil || !(view.url!.absoluteString.hasPrefix(origin)) {
            view.load(URLRequest(url: url))
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var origin: String
        let onSeeThrough: (Bool) -> Void
        init(origin: String, onSeeThrough: @escaping (Bool) -> Void) {
            self.origin = origin
            self.onSeeThrough = onSeeThrough
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let body = message.body as? [String: Any], let on = body["seeThrough"] as? Bool,
                  let webView = message.webView else { return }
            let supported = SeeThrough.apply(on, below: webView)
            onSeeThrough(on && supported)
            let detail = "{on:\(on && supported),supported:\(supported)}"
            webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('tandem-see-through',{detail:\(detail)}))", completionHandler: nil)
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { return decisionHandler(.cancel) }
            if url.absoluteString.hasPrefix(origin + "/") || url.absoluteString == origin || url.scheme == "blob" || url.scheme == "data" || url.scheme == "about" {
                decisionHandler(.allow)
            } else {
                if url.scheme == "http" || url.scheme == "https" { UIApplication.shared.open(url) }
                decisionHandler(.cancel)
            }
        }

        // window.open → Safari.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = action.request.url, url.scheme == "http" || url.scheme == "https" { UIApplication.shared.open(url) }
            return nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            (webView as? TandemWebView)?.sendGeometry(force: true)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload()
        }
    }
}

// Reports the window's place on the screen to the page whenever it changes
// (rotation, resizing, moving the window), in points, which are CSS pixels here.
final class TandemWebView: WKWebView {
    private var lastGeometry = ""
    private var timer: Timer?
    private var pinned: NSKeyValueObservation?

    override func didMoveToWindow() {
        super.didMoveToWindow()
        timer?.invalidate()
        timer = nil
        guard window != nil else { return }
        // The page fits itself to the window (and above the keyboard), so the
        // web view never scrolls it out of place.
        if pinned == nil {
            pinned = scrollView.observe(\.contentOffset, options: [.new]) { view, _ in
                if view.contentOffset != .zero { view.contentOffset = .zero }
            }
        }
        // Moving a window doesn't lay out its content, so also check twice a second.
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.sendGeometry() }
        sendGeometry(force: true)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        sendGeometry()
    }

    func sendGeometry(force: Bool = false) {
        guard let scene = window?.windowScene else { return }
        let screen = scene.screen
        let frame = convert(bounds, to: screen.coordinateSpace)
        let size = screen.bounds.size
        let g = String(format: "{\"sw\":%.1f,\"sh\":%.1f,\"x\":%.1f,\"y\":%.1f,\"w\":%.1f,\"h\":%.1f}",
                       size.width, size.height, frame.minX, frame.minY, frame.width, frame.height)
        if g == lastGeometry && !force { return }
        lastGeometry = g
        evaluateJavaScript("window.__tandemScreen=\(g);window.dispatchEvent(new Event('tandem-screen'))", completionHandler: nil)
    }
}
