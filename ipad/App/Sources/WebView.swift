import SwiftUI
import WebKit

// The Tandem UI. Only the app's own local address may load in it; other links
// open in Safari. If iPadOS ends the web content (memory pressure), it reloads.
struct WebView: UIViewRepresentable {
    let url: URL
    let origin: String

    func makeCoordinator() -> Coordinator { Coordinator(origin: origin) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        let view = WKWebView(frame: .zero, configuration: config)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.scrollView.bounces = false
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

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var origin: String
        init(origin: String) { self.origin = origin }

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

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.reload()
        }
    }
}
