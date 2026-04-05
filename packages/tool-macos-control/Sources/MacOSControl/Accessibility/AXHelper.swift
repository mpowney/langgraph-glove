import AppKit
import ApplicationServices

/// Convenience wrappers around the macOS Accessibility (AX) API.
enum AXHelper {

    struct TreeOptions {
        let attributes: Set<String>
        let interactiveOnly: Bool
        let includeDisabled: Bool
        let roleFilter: [String]

        init(
            attributes: Set<String> = ["role", "title", "value", "description", "isEnabled", "position", "size"],
            interactiveOnly: Bool = false,
            includeDisabled: Bool = true,
            roleFilter: [String] = []
        ) {
            self.attributes = attributes
            self.interactiveOnly = interactiveOnly
            self.includeDisabled = includeDisabled
            self.roleFilter = roleFilter
        }
    }

    final class TraversalBudget {
        private(set) var remaining: Int
        private(set) var visitedNodes: Int = 0
        private(set) var truncated: Bool = false

        init(maxNodes: Int?) {
            if let maxNodes {
                self.remaining = max(1, maxNodes)
            } else {
                self.remaining = Int.max
            }
        }

        func consume() -> Bool {
            guard remaining > 0 else {
                truncated = true
                return false
            }
            remaining -= 1
            visitedNodes += 1
            return true
        }
    }

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

    private static let interactiveRoles: Set<String> = [
        "AXButton",
        "AXCheckBox",
        "AXComboBox",
        "AXLink",
        "AXMenuButton",
        "AXMenuItem",
        "AXPopUpButton",
        "AXRadioButton",
        "AXScrollBar",
        "AXSearchField",
        "AXSecureTextField",
        "AXSlider",
        "AXStepper",
        "AXTab",
        "AXTextArea",
        "AXTextField",
    ]

    private static func includeNode(
        role: String,
        isEnabled: Bool,
        options: TreeOptions,
        depth: Int,
        hasIncludedChildren: Bool
    ) -> Bool {
        if depth == 0 {
            // Always keep the root so callers have app/window context.
            return true
        }

        if !options.includeDisabled && !isEnabled {
            return hasIncludedChildren
        }

        if options.interactiveOnly && !interactiveRoles.contains(role) {
            return hasIncludedChildren
        }

        if !options.roleFilter.isEmpty {
            let matched = options.roleFilter.contains { filter in
                role.localizedCaseInsensitiveContains(filter)
            }
            if !matched {
                return hasIncludedChildren
            }
        }

        return true
    }

    /// Recursively convert an AXUIElement to a plain dictionary suitable for JSON serialisation.
    static func elementDict(
        _ element: AXUIElement,
        maxDepth: Int = 4,
        depth: Int = 0,
        options: TreeOptions = TreeOptions(),
        budget: TraversalBudget? = nil
    ) -> [String: Any]? {
        if let budget, !budget.consume() {
            return nil
        }

        let role = string(element, kAXRoleAttribute as String)
        let title = string(element, kAXTitleAttribute as String)
        let value = string(element, kAXValueAttribute as String)
        let description = string(element, kAXDescriptionAttribute as String)
        let isEnabled = bool(element, kAXEnabledAttribute as String)

        var kids: [[String: Any]] = []
        if depth < maxDepth {
            for child in children(element) {
                if let childDict = elementDict(
                    child,
                    maxDepth: maxDepth,
                    depth: depth + 1,
                    options: options,
                    budget: budget
                ) {
                    kids.append(childDict)
                }
            }
        }

        guard includeNode(
            role: role,
            isEnabled: isEnabled,
            options: options,
            depth: depth,
            hasIncludedChildren: !kids.isEmpty
        ) else {
            return nil
        }

        var dict: [String: Any] = [:]
        if options.attributes.contains("role") {
            dict["role"] = role
        }
        if options.attributes.contains("title") {
            dict["title"] = title
        }
        if options.attributes.contains("value") {
            dict["value"] = value
        }
        if options.attributes.contains("description") {
            dict["description"] = description
        }
        if options.attributes.contains("isEnabled") {
            dict["isEnabled"] = isEnabled
        }

        if options.attributes.contains("position"), let pt = position(element) {
            dict["position"] = ["x": pt.x, "y": pt.y]
        }
        if options.attributes.contains("size"), let sz = size(element) {
            dict["size"] = ["width": sz.width, "height": sz.height]
        }
        if !kids.isEmpty {
            dict["children"] = kids
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

    /// Resolve an element by child-index path from a root element.
    /// Example: [0, 2, 1] means root.children[0].children[2].children[1].
    static func element(atPath path: [Int], from root: AXUIElement) -> AXUIElement? {
        var current = root
        for index in path {
            if index < 0 {
                return nil
            }
            let kids = children(current)
            guard index < kids.count else {
                return nil
            }
            current = kids[index]
        }
        return current
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
