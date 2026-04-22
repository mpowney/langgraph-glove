import Foundation

struct ContentUploadAuth {
    let token: String
    let expiresAt: String
    let transport: String
    let gatewayBaseUrl: String?
    let socketName: String?

    init?(json: [String: Any]) {
        guard
            let token = json["token"] as? String,
            let expiresAt = json["expiresAt"] as? String,
            let transport = json["transport"] as? String
        else {
            return nil
        }

        self.token = token
        self.expiresAt = expiresAt
        self.transport = transport
        self.gatewayBaseUrl = json["gatewayBaseUrl"] as? String
        self.socketName = json["socketName"] as? String
    }
}

private enum GatewayContentUploadError: LocalizedError {
    case unsupportedTransport(String)
    case missingGatewayBaseUrl
    case invalidResponse(String)
    case rpcError(String)

    var errorDescription: String? {
        switch self {
        case .unsupportedTransport(let transport):
            return "Unsupported content upload transport: \(transport)"
        case .missingGatewayBaseUrl:
            return "Missing gatewayBaseUrl for HTTP content upload transport"
        case .invalidResponse(let message):
            return "Invalid content upload response: \(message)"
        case .rpcError(let message):
            return message
        }
    }
}

final class GatewayContentUploadClient {
    // Keep binary chunks modest because each chunk is base64-encoded inside JSON,
    // which expands payload size and can trigger gateway body limits.
    static let defaultChunkSize = 24_576

    private let auth: ContentUploadAuth
    private let session: URLSession

    init(auth: ContentUploadAuth, session: URLSession = .shared) {
        self.auth = auth
        self.session = session
    }

    func upload(data: Data, fileName: String, mimeType: String?) async throws -> String {
        let initResult = try await initUpload(
            fileName: fileName,
            mimeType: mimeType,
            expectedBytes: data.count
        )

        var chunkIndex = 0
        var offset = 0

        while offset < data.count {
            let end = min(offset + Self.defaultChunkSize, data.count)
            let chunk = data.subdata(in: offset..<end)
            _ = try await appendChunk(uploadId: initResult.uploadId, chunkIndex: chunkIndex, chunkData: chunk)
            chunkIndex += 1
            offset = end
        }

        let finalizeResult = try await finalizeUpload(uploadId: initResult.uploadId)
        return finalizeResult.contentRef
    }

    private func initUpload(fileName: String, mimeType: String?, expectedBytes: Int) async throws -> (uploadId: String, contentRef: String) {
        var params: [String: Any] = [
            "token": auth.token,
            "fileName": fileName,
            "expectedBytes": expectedBytes,
        ]
        if let mimeType {
            params["mimeType"] = mimeType
        }

        let result = try await call(method: "__content_upload_init__", params: params)

        guard
            let uploadId = result["uploadId"] as? String,
            let contentRef = result["contentRef"] as? String
        else {
            throw GatewayContentUploadError.invalidResponse("missing uploadId/contentRef in init response")
        }

        return (uploadId, contentRef)
    }

    private func appendChunk(uploadId: String, chunkIndex: Int, chunkData: Data) async throws -> Int {
        let result = try await call(
            method: "__content_upload_chunk__",
            params: [
                "token": auth.token,
                "uploadId": uploadId,
                "chunkIndex": chunkIndex,
                "dataBase64": chunkData.base64EncodedString(),
            ]
        )

        guard let receivedBytes = result["receivedBytes"] as? Int else {
            throw GatewayContentUploadError.invalidResponse("missing receivedBytes in chunk response")
        }

        return receivedBytes
    }

    private func finalizeUpload(uploadId: String) async throws -> (contentRef: String, byteLength: Int) {
        let result = try await call(
            method: "__content_upload_finalize__",
            params: [
                "token": auth.token,
                "uploadId": uploadId,
            ]
        )

        guard
            let contentRef = result["contentRef"] as? String,
            let byteLength = result["byteLength"] as? Int
        else {
            throw GatewayContentUploadError.invalidResponse("missing contentRef/byteLength in finalize response")
        }

        return (contentRef, byteLength)
    }

    private func call(method: String, params: [String: Any]) async throws -> [String: Any] {
        guard auth.transport == "http" else {
            throw GatewayContentUploadError.unsupportedTransport(auth.transport)
        }

        guard let baseUrl = auth.gatewayBaseUrl?.trimmingCharacters(in: .whitespacesAndNewlines), !baseUrl.isEmpty else {
            throw GatewayContentUploadError.missingGatewayBaseUrl
        }

        guard let url = URL(string: "\(baseUrl.replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression))/api/internal/content/rpc") else {
            throw GatewayContentUploadError.invalidResponse("invalid gatewayBaseUrl")
        }

        let body: [String: Any] = [
            "id": UUID().uuidString,
            "method": method,
            "params": params,
        ]

        let bodyData = try JSONSerialization.data(withJSONObject: body)

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = bodyData

        let (data, response) = try await session.data(for: request)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
        let bodyText = String(data: data, encoding: .utf8) ?? "<non-utf8-body length=\(data.count)>"

        guard let json = try? JSONSerialization.jsonObject(with: data),
              let object = json as? [String: Any] else {
            throw GatewayContentUploadError.invalidResponse(
                "status=\(statusCode), expected JSON object, body=\(bodyText.prefix(400))"
            )
        }

        if let error = object["error"] as? String {
            throw GatewayContentUploadError.rpcError(error)
        }

        guard let result = object["result"] as? [String: Any] else {
            throw GatewayContentUploadError.invalidResponse(
                "status=\(statusCode), missing object result, body=\(bodyText.prefix(400))"
            )
        }

        return result
    }
}
