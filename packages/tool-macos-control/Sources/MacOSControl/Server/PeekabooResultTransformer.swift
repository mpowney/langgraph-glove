import Foundation

func splitPeekabooArguments(_ params: [String: Any]) -> (forwardedParams: [String: Any], uploadAuth: ContentUploadAuth?) {
    var forwarded = params
    let uploadAuthDict = forwarded.removeValue(forKey: "contentUploadAuth") as? [String: Any]
    let uploadAuth = uploadAuthDict.flatMap(ContentUploadAuth.init)
    return (forwarded, uploadAuth)
}

func transformPeekabooResult(_ result: Any, uploadAuth: ContentUploadAuth?, toolArguments: [String: Any] = [:]) async -> Any {
    guard let uploadAuth else {
        return result
    }

    guard uploadAuth.transport == "http" else {
        return appendDiagnostics(
            to: result,
            messages: ["Upload skipped: unsupported contentUploadAuth transport '\(uploadAuth.transport)' (HTTP required)."]
        )
    }

    guard var resultDict = result as? [String: Any] else {
        return result
    }
    guard var contentItems = resultDict["content"] as? [Any] else {
        return result
    }

    let uploader = GatewayContentUploadClient(auth: uploadAuth)
    var didTransform = false
    var uploadedPaths = Set<String>()
    var diagnostics: [String] = []

    // Upload explicit file path arguments first (for tools like peekaboo_image
    // that may only return text confirmations with local file paths).
    for path in extractCandidatePaths(fromArguments: toolArguments) {
        guard !uploadedPaths.contains(path) else {
            continue
        }
        uploadedPaths.insert(path)

        let fileUrl = URL(fileURLWithPath: path)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), !isDirectory.boolValue else {
            diagnostics.append("Upload skipped: path not found or is directory: \(path)")
            continue
        }

        do {
            let data = try Data(contentsOf: fileUrl)
            let mimeType = inferredMimeType(forPath: path)
            let fileName = fileUrl.lastPathComponent.isEmpty ? "peekaboo-artifact" : fileUrl.lastPathComponent
            let contentRef = try await uploader.upload(data: data, fileName: fileName, mimeType: mimeType)
            contentItems.append([
                "type": "content_ref",
                "contentRef": contentRef,
                "mimeType": mimeType,
                "fileName": fileName,
                "sourcePath": path,
            ])
            didTransform = true
        } catch {
            diagnostics.append("Upload failed for argument path \(path): \(error.localizedDescription)")
        }
    }

    for index in contentItems.indices {
        guard let contentItem = contentItems[index] as? [String: Any] else {
            continue
        }

        let contentType = (contentItem["type"] as? String)?.lowercased()

        if contentType == "image" {
            guard let base64Data = contentItem["data"] as? String else {
                continue
            }

            let normalizedBase64 = stripDataUriPrefix(base64Data)
            guard let imageBytes = Data(base64Encoded: normalizedBase64) else {
                diagnostics.append("Upload skipped: invalid base64 image payload in tool response")
                continue
            }

            let mimeType = (contentItem["mimeType"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let resolvedMimeType = (mimeType?.isEmpty == false ? mimeType : nil) ?? "image/png"
            let fileName = "peekaboo-image-\(UUID().uuidString).\(fileExtension(for: resolvedMimeType))"

            do {
                let contentRef = try await uploader.upload(data: imageBytes, fileName: fileName, mimeType: resolvedMimeType)
                contentItems[index] = [
                    "type": "content_ref",
                    "contentRef": contentRef,
                    "mimeType": resolvedMimeType,
                ]
                didTransform = true
            } catch {
                diagnostics.append("Upload failed for inline image payload: \(error.localizedDescription)")
            }
            continue
        }

        guard contentType == "text",
              let text = contentItem["text"] as? String else {
            continue
        }

        for path in extractAbsoluteFilePaths(from: text) {
            guard !uploadedPaths.contains(path) else {
                continue
            }
            uploadedPaths.insert(path)

            let fileUrl = URL(fileURLWithPath: path)
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), !isDirectory.boolValue else {
                diagnostics.append("Upload skipped: extracted text path not found or is directory: \(path)")
                continue
            }

            do {
                let data = try Data(contentsOf: fileUrl)
                let mimeType = inferredMimeType(forPath: path)
                let fileName = fileUrl.lastPathComponent.isEmpty ? "peekaboo-artifact" : fileUrl.lastPathComponent
                let contentRef = try await uploader.upload(data: data, fileName: fileName, mimeType: mimeType)
                contentItems.append([
                    "type": "content_ref",
                    "contentRef": contentRef,
                    "mimeType": mimeType,
                    "fileName": fileName,
                    "sourcePath": path,
                ])
                didTransform = true
            } catch {
                diagnostics.append("Upload failed for extracted text path \(path): \(error.localizedDescription)")
            }
        }
    }

    if !diagnostics.isEmpty {
        contentItems.append([
            "type": "text",
            "text": "[peekaboo_upload_diagnostics] \(diagnostics.joined(separator: " | "))",
        ])
    }

    if didTransform || !diagnostics.isEmpty {
        resultDict["content"] = contentItems
        return resultDict
    }

    return result
}

private func appendDiagnostics(to result: Any, messages: [String]) -> Any {
    guard !messages.isEmpty,
          var resultDict = result as? [String: Any],
          var content = resultDict["content"] as? [Any] else {
        return result
    }

    content.append([
        "type": "text",
        "text": "[peekaboo_upload_diagnostics] \(messages.joined(separator: " | "))",
    ])
    resultDict["content"] = content
    return resultDict
}

private func extractCandidatePaths(fromArguments arguments: [String: Any]) -> [String] {
    let keys = ["path", "filePath", "outputPath", "screenshotPath", "savePath"]
    var paths: [String] = []
    var seen = Set<String>()

    for key in keys {
        if let value = arguments[key] as? String {
            let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if normalized.hasPrefix("/"), !seen.contains(normalized) {
                seen.insert(normalized)
                paths.append(normalized)
            }
        }
    }

    return paths
}

private func extractAbsoluteFilePaths(from text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: #"(/[A-Za-z0-9._~\-/]+)"#) else {
        return []
    }

    let nsText = text as NSString
    let range = NSRange(location: 0, length: nsText.length)
    let matches = regex.matches(in: text, options: [], range: range)

    var paths: [String] = []
    var seen = Set<String>()
    for match in matches {
        guard match.numberOfRanges > 1 else { continue }
        var path = nsText.substring(with: match.range(at: 1))
        while let last = path.last, ",.;:)]}".contains(last) {
            path.removeLast()
        }
        guard path.hasPrefix("/") else { continue }
        guard !seen.contains(path) else { continue }
        seen.insert(path)
        paths.append(path)
    }

    return paths
}

private func inferredMimeType(forPath path: String) -> String {
    let ext = URL(fileURLWithPath: path).pathExtension.lowercased()
    switch ext {
    case "png": return "image/png"
    case "jpg", "jpeg": return "image/jpeg"
    case "gif": return "image/gif"
    case "webp": return "image/webp"
    case "bmp": return "image/bmp"
    case "svg": return "image/svg+xml"
    case "txt", "log", "md": return "text/plain"
    case "json": return "application/json"
    case "pdf": return "application/pdf"
    default: return "application/octet-stream"
    }
}

private func stripDataUriPrefix(_ value: String) -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.lowercased().hasPrefix("data:"),
          let commaIndex = trimmed.firstIndex(of: ",") else {
        return trimmed
    }
    return String(trimmed[trimmed.index(after: commaIndex)...])
}

private func fileExtension(for mimeType: String) -> String {
    switch mimeType.lowercased() {
    case "image/jpeg", "image/jpg":
        return "jpg"
    case "image/png":
        return "png"
    case "image/gif":
        return "gif"
    case "image/webp":
        return "webp"
    default:
        return "bin"
    }
}
