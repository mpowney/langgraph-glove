# Upload-Capable Tool Identification Plan

## Purpose
Establish a consistent process to identify tools that can (or should) push generated content to the gateway content store, and mark them with `supportsContentUpload` so runtime-only upload auth is injected only when needed.

## Identification Rules
- Mark as **direct upload-capable** when a tool itself creates files (images, PDFs, docs, archives, audio/video) and should upload them to gateway content storage.
- Mark as **indirect upload-capable** when a tool can create artifacts that are expected to be uploaded by a companion step in the same workflow.
- Do **not** mark tools that are purely read/query/text and have no artifact generation path.

## Initial Tool Inventory

### Docker
- `docker_upload_tmp_file` ([packages/tool-docker/src/tools/UploadTmpFileTool.ts](../packages/tool-docker/src/tools/UploadTmpFileTool.ts))
  - Classification: direct upload-capable
  - Status: already marked with `supportsContentUpload: true`
- `docker_exec` ([packages/tool-docker/src/tools/ExecContainerTool.ts](../packages/tool-docker/src/tools/ExecContainerTool.ts))
  - Classification: indirect upload-capable
  - Rationale: frequently used to generate files under `/tmp` in tool host/container workflows before upload
  - Status: marked with `supportsContentUpload: true`

### macOS Control
- `macos_take_screenshot` ([packages/tool-macos-control/Sources/MacOSControl/Tools/TakeScreenshotTool.swift](../packages/tool-macos-control/Sources/MacOSControl/Tools/TakeScreenshotTool.swift))
  - Classification: direct upload-capable
  - Rationale: generates screenshot image payloads that should be storable as content items
  - Status: marked with `supportsContentUpload: true`
- Swift metadata model update ([packages/tool-macos-control/Sources/MacOSControl/Server/RpcTypes.swift](../packages/tool-macos-control/Sources/MacOSControl/Server/RpcTypes.swift))
  - Added optional `supportsContentUpload` so gateway introspection can identify these tools

### Browse/Web
- `web_screenshot` ([packages/tool-browse/src/tools/ScreenshotTool.ts](../packages/tool-browse/src/tools/ScreenshotTool.ts))
  - Classification: direct upload-capable
  - Rationale: produces screenshot image content suitable for content store references
  - Status: marked with `supportsContentUpload: true`

## Ongoing Process
1. During tool design review, ask: "Can this tool produce content that users may need to preview/download/share later?"
2. If yes, set `supportsContentUpload: true` in metadata.
3. Ensure handler supports `contentUploadAuth` usage directly or has a documented companion uploader flow.
4. Add/update tests validating:
   - Upload auth is injected only for marked tools.
   - Tool can produce or route to a content reference (`contentRef`).
5. Update this document when adding/removing upload-capable tools.

## Near-Term Follow-ups
- Add explicit upload mode to screenshot tools so they can return `contentRef` directly instead of large inline base64 payloads.
- Add capability registry UI filter for `supportsContentUpload` to simplify operations visibility.
- Add policy checks for max upload size by tool category (screenshots, docs, archives, video).
