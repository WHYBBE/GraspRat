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
        VStack(spacing: 12) {
            VStack(spacing: 16) {
                if let err = store.errorMessage { errorBanner(err) }
                summaryHeader
                if let top = store.topDropEntity { TopDropCard(entity: top) }
            }
            .padding([.horizontal, .top])
            .textSelection(.enabled)   // 允许选中/复制（名字、坐标等）

            columnsSection
        }
    }

    /// 三列并排：掉落排行（当前列）/ 活人（active，含血量）/ 最新加入（join tick 倒序）。
    /// 每列各自独立滚动，列头常驻。
    private var columnsSection: some View {
        HStack(alignment: .top, spacing: 0) {
            EntityColumn(
                title: "掉落排行",
                systemImage: "trophy.fill",
                tint: .orange,
                entities: store.entitiesByDrop,
                detail: .drop
            )
            Divider()
            EntityColumn(
                title: "活人",
                systemImage: "bolt.fill",
                tint: .green,
                entities: store.activeEntities,
                detail: .hp
            )
            Divider()
            EntityColumn(
                title: "最新加入",
                systemImage: "clock.fill",
                tint: .blue,
                entities: store.entitiesByJoinRecency,
                detail: .joinTick
            )
        }
        .frame(maxWidth: .infinity)
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
                stat("血量", entity.hpText)
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

// MARK: - 实体列（可复用：掉落排行 / 活人 / 最新加入）

/// 行右侧要突出的指标。
enum RowDetail {
    case drop       // 掉落金币
    case hp         // 血量 hp/max_hp（活人列）
    case joinTick   // 最近一次 join 的 tick（越大越新）
}

/// 一列：列头 + 独立滚动的实体列表。
struct EntityColumn: View {
    let title: String
    let systemImage: String
    let tint: Color
    let entities: [Entity]
    let detail: RowDetail

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Label(title, systemImage: systemImage)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(tint)
                Spacer(minLength: 4)
                Text("\(entities.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)

            Divider()

            if entities.isEmpty {
                Text("无")
                    .font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        let shown = Array(entities.prefix(200).enumerated())
                        ForEach(shown, id: \.element.id) { index, entity in
                            EntityRow(rank: index + 1, entity: entity, detail: detail, tint: tint)
                            if index < shown.count - 1 { Divider() }
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

// MARK: - 排行行（紧凑，适配窄列）

struct EntityRow: View {
    let rank: Int
    let entity: Entity
    let detail: RowDetail
    let tint: Color

    var body: some View {
        HStack(spacing: 8) {
            Text("\(rank)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 22, alignment: .trailing)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(entity.name).font(.callout).lineLimit(1)
                        .textSelection(.enabled)
                        .contextMenu { Button("复制名字") { Clipboard.copy(entity.name) } }
                    if entity.isActive {
                        Circle().fill(Color.green).frame(width: 6, height: 6)
                    }
                }
                Text("cell \(entity.cellText)")
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }

            Spacer(minLength: 4)
            detailValue
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private var detailValue: some View {
        switch detail {
        case .drop:
            Text("\(entity.deathDropCoins)")
                .font(.callout.bold().monospacedDigit())
                .foregroundStyle(tint)
        case .hp:
            VStack(alignment: .trailing, spacing: 1) {
                Text(entity.hpText)
                    .font(.callout.bold().monospacedDigit())
                    .foregroundStyle(hpColor)
                Text("\(entity.deathDropCoins)")
                    .font(.caption.bold().monospacedDigit()).foregroundStyle(.orange)
            }
        case .joinTick:
            VStack(alignment: .trailing, spacing: 1) {
                Text(entity.latestJoinTick >= 0 ? "t\(entity.latestJoinTick)" : "—")
                    .font(.caption.monospacedDigit()).foregroundStyle(tint)
                Text("\(entity.deathDropCoins)")
                    .font(.caption.bold().monospacedDigit()).foregroundStyle(.orange)
            }
        }
    }

    /// 绿 → 黄 → 红，随血量比例变化
    private var hpColor: Color {
        let r = entity.hpRatio
        if r > 0.5 { return .green }
        if r > 0.25 { return .yellow }
        return .red
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
