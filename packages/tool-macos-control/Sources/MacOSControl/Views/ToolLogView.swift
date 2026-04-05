import SwiftUI

// ---------------------------------------------------------------------------
// Individual accordion row
// ---------------------------------------------------------------------------

private struct ToolLogRow: View {
    let entry: ToolLogEntry
    let dateFormatter: DateFormatter
    @State private var isExpanded: Bool = false

    // ~7 lines of .caption monospaced ≈ 7 × 16 pt
    private let detailMaxHeight: CGFloat = 112

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // ── Header (always visible, acts as tap target) ──────────────────
            Button {
                withAnimation(.easeInOut(duration: 0.18)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 12)

                    Text(entry.headerText)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(color(for: entry.kind))
                        .lineLimit(1)
                        .truncationMode(.tail)

                    Spacer()

                    Text(dateFormatter.string(from: entry.timestamp))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            // ── Detail pane (collapsible) ────────────────────────────────────
            if isExpanded {
                ScrollView(.vertical) {
                    Text(entry.detail)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 10)
                        .padding(.bottom, 10)
                }
                .frame(maxHeight: detailMaxHeight)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(backgroundColor(for: entry.kind))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(color(for: entry.kind).opacity(0.35), lineWidth: 1)
        )
    }

    private func color(for kind: ToolLogKind) -> Color {
        switch kind {
        case .toolCall:   return .yellow
        case .toolResult: return .green
        case .error:      return .red
        }
    }

    private func backgroundColor(for kind: ToolLogKind) -> Color {
        switch kind {
        case .toolCall:   return Color.yellow.opacity(0.14)
        case .toolResult: return Color.green.opacity(0.14)
        case .error:      return Color.red.opacity(0.14)
        }
    }
}

// ---------------------------------------------------------------------------
// Log window
// ---------------------------------------------------------------------------

struct ToolLogView: View {
    @EnvironmentObject var appState: AppState
    @State private var maxVisibleEntries: Int = 200

    private let entryOptions: [Int] = [50, 100, 200, 500, 1000]
    private let bottomAnchorId = "log-bottom-anchor"

    private let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .medium
        return formatter
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Tool Request Log")
                        .font(.headline)
                    Text(appState.toolLogFilePath.isEmpty ? "Log file path unavailable" : appState.toolLogFilePath)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer()
                Button("Reveal in Finder") {
                    appState.revealToolLogFileInFinder()
                }
                .disabled(appState.toolLogFilePath.isEmpty)
            }

            HStack {
                Spacer()
                Picker("Entries", selection: $maxVisibleEntries) {
                    ForEach(entryOptions, id: \.self) { option in
                        Text("\(option)").tag(option)
                    }
                }
                .pickerStyle(.menu)
                .frame(width: 120)
            }

            Divider()

            if appState.toolLogEntries.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "tray")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                    Text("No tool requests yet")
                        .font(.headline)
                    Text("Tool calls and results will appear here as they are processed.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 6) {
                            ForEach(visibleEntries) { entry in
                                ToolLogRow(entry: entry, dateFormatter: dateFormatter)
                            }
                            Color.clear
                                .frame(height: 1)
                                .id(bottomAnchorId)
                        }
                        .padding(.vertical, 2)
                    }
                    .onAppear {
                        scrollToBottom(proxy)
                    }
                    .onChange(of: appState.toolLogEntries.count) { _ in
                        scrollToBottom(proxy)
                    }
                    .onChange(of: maxVisibleEntries) { _ in
                        scrollToBottom(proxy)
                    }
                }
            }
        }
        .padding(14)
        .frame(minWidth: 700, minHeight: 460)
    }

    private var visibleEntries: [ToolLogEntry] {
        Array(appState.toolLogEntries.suffix(maxVisibleEntries))
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        DispatchQueue.main.async {
            withAnimation(.easeOut(duration: 0.12)) {
                proxy.scrollTo(bottomAnchorId, anchor: .bottom)
            }
        }
    }
}

struct ToolLogView_Previews: PreviewProvider {
    static var previews: some View {
        ToolLogView()
            .environmentObject(AppState())
    }
}
