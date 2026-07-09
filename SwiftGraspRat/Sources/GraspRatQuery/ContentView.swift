import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: SnapshotStore

    var body: some View {
        NavigationStack {
            Group {
                if store.snapshot != nil {
                    scrollContent
                } else if store.isLoading {
                    ProgressView("加载中…")
                } else {
                    emptyState
                }
            }
            .navigationTitle("Grasp Rat 查询")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button(action: { Task { await store.refresh() } }) {
                        if store.isLoading {
                            ProgressView()
                        } else {
                            Label("刷新", systemImage: "arrow.clockwise")
                        }
                    }
                    .disabled(store.isLoading)
                }
            }
        }
    }

    // MARK: - 主内容

    private var scrollContent: some View {
        ScrollView {
            VStack(spacing: 16) {
                if let err = store.errorMessage { errorBanner(err) }
                summaryHeader
                if let top = store.topDropEntity { TopDropCard(entity: top) }
                rankingSection
            }
            .padding()
            .textSelection(.enabled)   // 允许选中/复制（名字、坐标等）
        }
    }

    private var summaryHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let s = store.snapshot {
                Text("tick \(s.tick)  ·  在场 \(s.inGame) / \(s.totalEntities)")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Text(store.lastUpdated.map { "缓存于 \(Self.timeFormatter.string(from: $0))" } ?? "尚未刷新")
                .font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var rankingSection: some View {
        let list = Array(store.entitiesByDrop.prefix(50).enumerated())
        return VStack(alignment: .leading, spacing: 0) {
            Text("掉落排行 Top \(list.count)")
                .font(.headline)
                .padding(.bottom, 8)
            ForEach(list, id: \.element.id) { index, entity in
                EntityRow(rank: index + 1, entity: entity)
                if index < list.count - 1 { Divider() }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "tray")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
            Text("暂无缓存数据").font(.headline)
            Text("点击下方按钮获取最新快照")
                .font(.subheadline).foregroundStyle(.secondary)
            Button(action: { Task { await store.refresh() } }) {
                Label("刷新", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.borderedProminent)
        }
        .padding()
    }

    private func errorBanner(_ message: String) -> some View {
        Text(message)
            .font(.callout)
            .foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
            .background(.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
    }

    static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MM-dd HH:mm:ss"
        return f
    }()
}

// MARK: - 最大掉落卡片

struct TopDropCard: View {
    let entity: Entity

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("最大掉落 (drop)", systemImage: "trophy.fill")
                    .font(.headline)
                    .foregroundStyle(.orange)
                Spacer()
                StatusBadge(active: entity.isActive)
            }

            Text(entity.name)
                .font(.title2.bold())
                .lineLimit(1)
                .textSelection(.enabled)
                .contextMenu { Button("复制名字") { Clipboard.copy(entity.name) } }

            HStack(alignment: .top, spacing: 24) {
                stat("掉落", "\(entity.deathDropCoins)")
                stat("坐标 (x, y)", entity.coordinateText)
                stat("Cell", entity.cellText)
            }

            Text("entity_id: \(entity.entityId)   ·   user_id: \(entity.userId)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(.orange.opacity(0.3)))
    }

    private func stat(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.body.weight(.semibold)).monospacedDigit()
        }
    }
}

// MARK: - 排行行

struct EntityRow: View {
    let rank: Int
    let entity: Entity

    var body: some View {
        HStack(spacing: 12) {
            Text("\(rank)")
                .font(.callout.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 28, alignment: .trailing)

            VStack(alignment: .leading, spacing: 2) {
                Text(entity.name).font(.body).lineLimit(1)
                    .textSelection(.enabled)
                    .contextMenu { Button("复制名字") { Clipboard.copy(entity.name) } }
                Text("\(entity.coordinateText)  ·  cell \(entity.cellText)")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)
            StatusBadge(active: entity.isActive)
            Text("\(entity.deathDropCoins)")
                .font(.body.bold().monospacedDigit())
                .foregroundStyle(.orange)
                .frame(minWidth: 32, alignment: .trailing)
        }
        .padding(.vertical, 6)
    }
}

// MARK: - active 状态徽章

struct StatusBadge: View {
    let active: Bool

    var body: some View {
        Text(active ? "Active" : "Passive")
            .font(.caption.bold())
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background((active ? Color.green : Color.gray).opacity(0.18), in: Capsule())
            .foregroundStyle(active ? Color.green : Color.gray)
    }
}

#Preview {
    ContentView().environmentObject(SnapshotStore())
}
