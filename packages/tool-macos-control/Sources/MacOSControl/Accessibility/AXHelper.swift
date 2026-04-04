import AppKit
import ApplicationServices

/// Convenience wrappers around the macOS Accessibility (AX) API.
enum AXHelper {

    // MARK: - Attribute accessors

    static func string(_ element: AXUIElement, _ attribute: String) -> String {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let str = value as? String
        else { return "" }
        return str
    }

    static func bool(_ element: AXUIElement, _ attribute: String) -> Bool {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let num = value as? NSNumber
        else { return false }
        return num.boolValue
    }

    static func cfValue(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success
        else { return nil }
        return value
    }

    static func children(_ element: AXUIElement) -> [AXUIElement] {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success,
              let list = value as? [AXUIElement]
        else { return [] }
        return list
    }

    static func position(_ element: AXUIElement) -> CGPoint? {
        guard let raw = cfValue(element, kAXPositionAttribute as String),
              CFGetTypeID(raw) == AXValueGetTypeID()
        else { return nil }
        let axValue = raw as! AXValue
        var pt = CGPoint.zero
        guard AXValueGetValue(axValue, .cgPoint, &pt) else { return nil }
        return pt
    }

    static func size(_ element: AXUIElement) -> CGSize? {
        guard let raw = cfValue(element, kAXSizeAttribute as String),
              CFGetTypeID(raw) == AXValueGetTypeID()
        else { return nil }
        let axValue = raw as! AXValue
        var sz = CGSize.zero
        guard AXValueGetValue(axValue, .cgSize, &sz) else { return nil }
        return sz
    }

    // MARK: - Element → dictionary

    /// Recursively convert an AXUIElement to a plain dictionary suitable for JSON serialisation.
    static func elementDict(
        _ element: AXUIElement,
        maxDepth: Int = 4,
        depth: Int = 0
    ) -> [String: Any] {
        var dict: [String: Any] = [
            "role":        string(element, kAXRoleAttribute as String),
            "title":       string(element, kAXTitleAttribute as String),
            "value":       string(element, kAXValueAttribute as String),
            "description": string(element, kAXDescriptionAttribute as String),
            "isEnabled":   bool(element, kAXEnabledAttribute as String),
        ]

        if let pt = position(element) {
            dict["position"] = ["x": pt.x, "y": pt.y]
        }
        if let sz = size(element) {
            dict["size"] = ["width": sz.width, "height": sz.height]
        }

        if depth < maxDepth {
            let kids = children(element).map {
                elementDict($0, maxDepth: maxDepth, depth: depth + 1)
            }
            if !kids.isEmpty { dict["children"] = kids }
        }

        return dict
    }

    // MARK: - Element lookup

    /// Returns an AXUIElement for the given application (by bundle ID or PID),
    /// or the current frontmost app if neither is supplied.
    static func appElement(bundleId: String? = nil, pid: pid_t? = nil) -> AXUIElement? {
        var targetPid: pid_t

        if let pid {
            targetPid = pid
        } else if let bundleId,
                  let app = NSRunningApplication
                    .runningApplications(withBundleIdentifier: bundleId).first {
            targetPid = app.processIdentifier
        } else if let app = NSWorkspace.shared.frontmostApplication {
            targetPid = app.processIdentifier
        } else {
            return nil
        }

        return AXUIElementCreateApplication(targetPid)
    }

    /// Returns the element at the given screen coordinates (requires Accessibility permission).
    static func elementAtPoint(x: CGFloat, y: CGFloat) -> AXUIElement? {
        let systemWide = AXUIElementCreateSystemWide()
        var element: AXUIElement?
        let result = AXUIElementCopyElementAtPosition(systemWide, Float(x), Float(y), &element)
        guard result == .success else { return nil }
        return element
    }

    /// Depth-first search for elements matching the predicate.
    static func findElements(
        in root: AXUIElement,
        matching predicate: (AXUIElement) -> Bool,
        maxDepth: Int = 12,
        depth: Int = 0
    ) -> [AXUIElement] {
        var results: [AXUIElement] = []
        if predicate(root) { results.append(root) }
        guard depth < maxDepth else { return results }
        for child in children(root) {
            results += findElements(in: child, matching: predicate, maxDepth: maxDepth, depth: depth + 1)
        }
        return results
    }

    // MARK: - Focused element

    static func focusedElement() -> AXUIElement? {
        let systemWide = AXUIElementCreateSystemWide()
        var element: CFTypeRef?
        guard AXUIElementCopyAttributeValue(systemWide, kAXFocusedUIElementAttribute as CFString, &element) == .success,
              let raw = element,
              CFGetTypeID(raw) == AXUIElementGetTypeID()
        else { return nil }
        return (raw as! AXUIElement)
    }
}
