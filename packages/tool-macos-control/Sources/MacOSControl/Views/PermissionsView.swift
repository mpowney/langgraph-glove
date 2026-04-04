import SwiftUI

struct PermissionsView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        GroupBox("Permissions") {
            VStack(spacing: 10) {
                PermissionRow(
                    icon: "cursorarrow.and.square.on.square.dashed",
                    title: "Accessibility",
                    description: "Required to read and control UI elements, click, type, and interact with apps.",
                    isGranted: appState.accessibilityGranted,
                    onRequest: { appState.requestAccessibilityPermission() },
                    onOpenSettings: { appState.openAccessibilitySettings() }
                )

                Divider()

                PermissionRow(
                    icon: "rectangle.dashed.and.paperclip",
                    title: "Screen Recording",
                    description: "Required to take screenshots of the screen.",
                    isGranted: appState.screenRecordingGranted,
                    onRequest: { appState.requestScreenRecordingPermission() },
                    onOpenSettings: { appState.openScreenRecordingSettings() }
                )
            }
            .padding(8)
        }
    }
}

// MARK: - Single permission row

struct PermissionRow: View {
    let icon: String
    let title: String
    let description: String
    let isGranted: Bool
    let onRequest: () -> Void
    let onOpenSettings: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            // Status indicator
            Image(systemName: isGranted ? "checkmark.circle.fill" : "xmark.circle.fill")
                .foregroundStyle(isGranted ? .green : .red)
                .font(.title3)
                .padding(.top, 2)

            // Text info
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .fontWeight(.medium)
                Text(description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 8)

            // Action buttons (only shown when not granted)
            if !isGranted {
                VStack(spacing: 6) {
                    Button("Request Access") {
                        onRequest()
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)

                    Button("Open Settings") {
                        onOpenSettings()
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
        }
    }
}

struct PermissionsView_Previews: PreviewProvider {
    static var previews: some View {
        PermissionsView()
            .environmentObject(AppState())
            .padding()
    }
}
