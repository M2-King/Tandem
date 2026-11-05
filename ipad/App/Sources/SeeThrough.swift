import UIKit

// Experimental: a see-through app window that shows the real Home Screen
// wallpaper behind Tandem.
//
// iPadOS has no public way for an app to do this. UIKit has a private switch,
// UIApplication._setBackgroundStyle:, that asks the system to draw the
// wallpaper behind the app (styles: 0 default, 1 transparent). App Store apps
// can't use it; a self-signed app can. Whether a given iPadOS version still
// honours it is up to the system, so it is opt-in and easy to switch off.
enum SeeThrough {
    private static let selector = NSSelectorFromString("_setBackgroundStyle:")

    /// Whether this iPadOS still has the switch at all.
    static var available: Bool { UIApplication.shared.responds(to: selector) }

    /// Turns the transparent background on or off. Returns false if iPadOS
    /// doesn't have the switch.
    @discardableResult
    static func apply(_ on: Bool, below view: UIView?) -> Bool {
        let app = UIApplication.shared
        guard app.responds(to: selector), let method = app.method(for: selector) else { return false }
        typealias SetStyle = @convention(c) (AnyObject, Selector, Int) -> Void
        unsafeBitCast(method, to: SetStyle.self)(app, selector, on ? 1 : 0)
        // Everything from the web view down to the window must let it show through.
        var current = view
        while let v = current {
            v.backgroundColor = on ? .clear : v.backgroundColor
            v.isOpaque = !on && v.isOpaque
            current = v.superview
        }
        view?.window?.backgroundColor = on ? .clear : UIColor(red: 0.067, green: 0.078, blue: 0.102, alpha: 1)
        return true
    }
}
