import SwiftUI

/// 「我的周围」：设定自己的名字与扫描半径，列出半径内其它实体（按掉落降序）。
struct NearbyView: View {
    @EnvironmentObject private var store: SnapshotStore

    @AppStorage("me_player_name") private var meName = ""
    @AppStorage("nearby_scan_radius") private var radius = 5000

    private let radiusOptions = [1000, 5000, 10000, 50000, 100000]
    @State private var nameDraft = ""
    @FocusState private var nameFocused: Bool

    var body: some View {
        NavigationStack {
            Group {
                if store.snapshot != nil {
                    content
                } else if store.isLoading {
                    ProgressView("加载中…")
                } else {
                    emptyState
                }
            }
            .navigationTitle("我的周围")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button(action: { Task { await store.refresh() } }) {
                        if store.isLoading { ProgressView() }
                        else { Label("刷新", systemImage: "arrow.clockwise") }
                    }
                    .disabled(store.isLoading)
                }
            }
            .onAppear {
                if nameDraft.isEmpty { nameDraft = meName }
            }
        }
    }

    private var me: Entity? { store.findMe(name: meName) }

    private var neighbors: [(entity: Entity, distance: Double)] {
        guard let me else { return [] }
        return store.nearby(around: me, radius: radius)
    }

    private var content: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                if let err = store.errorMessage { errorBanner(err) }
                identitySection
                radiusPicker
                meStatus
            }
            .padding([.horizontal, .top])
            .textSelection(.enabled)

            Divider().padding(.top, 12)

            neighborList
        }
    }

    // MARK: - 身份

    private var identitySection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("我是谁").font(.subheadline.weight(.semibold))
            HStack(spacing: 8) {
                TextField("输入游戏内名字", text: $nameDraft)
                    .textFieldStyle(.roundedBorder)
                    .focused($nameFocused)
                    .onSubmit { commitName() }
                Button("确定") { commitName() }
                    .buttonStyle(.borderedProminent)
                    .disabled(nameDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if nameFocused {
                let tips = store.nameSuggestions(query: nameDraft)
                if !tips.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(tips, id: \.self) { name in
                                Button(name) {
                                    nameDraft = name
                                    commitName()
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                            }
                        }
                    }
                }
            }
            if !meName.isEmpty, me == nil {
                Text("快照中未找到「\(meName)」（忽略大小写精确匹配）")
                    .font(.caption).foregroundStyle(.orange)
            }
        }
    }

    private func commitName() {
        meName = nameDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        nameFocused = false
    }

    // MARK: - 半径

    private var radiusPicker: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("扫描范围").font(.subheadline.weight(.semibold))
            Picker("扫描范围", selection: $radius) {
                ForEach(radiusOptions, id: \.self) { Text(radiusLabel($0)).tag($0) }
            }
            .pickerStyle(.segmented)
            Text("列出距你 ≤ 半径的其它实体，按掉落降序。")
                .font(.caption2).foregroundStyle(.secondary)
        }
    }

    private func radiusLabel(_ r: Int) -> String {
        if r >= 1000 { return "\(r / 1000)k" }
        return "\(r)"
    }

    // MARK: - 自己状态

    @ViewBuilder
    private var meStatus: some View {
        if let me {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(me.name).font(.headline)
                        StatusBadge(active: me.isActive)
                        if me.isWithin100k { NearOriginBadge() }
                    }
                    Text("\(me.coordinateText)  ·  cell \(me.cellText)")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text("drop \(me.deathDropCoins)")
                        .font(.callout.bold().monospacedDigit())
                        .foregroundStyle(.orange)
                    Text("HP \(me.hpText)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(hpColor(me))
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
            Text("周围 \(neighbors.count) 人 · 半径 \(radius)")
                .font(.caption).foregroundStyle(.secondary)
        } else if meName.isEmpty {
            Text("先填写你的游戏名字，再查看周围。")
                .font(.callout).foregroundStyle(.secondary)
        }
    }

    // MARK: - 列表

    private var neighborList: some View {
        Group {
            if me == nil {
                Spacer()
            } else if neighbors.isEmpty {
                VStack(spacing: 8) {
                    Spacer()
                    Text("半径内暂无其它实体").foregroundStyle(.secondary)
                    Spacer()
                }
                .frame(maxWidth: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        let shown = Array(neighbors.prefix(200).enumerated())
                        ForEach(shown, id: \.element.entity.id) { index, item in
                            NearbyRow(
                                rank: index + 1,
                                entity: item.entity,
                                distance: item.distance
                            )
                            if index < shown.count - 1 { Divider() }
                        }
                    }
                    .textSelection(.enabled)
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "person.line.dotted.person")
                .font(.system(size: 48)).foregroundStyle(.secondary)
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
        Text(message).font(.callout).foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
            .background(.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
    }

    private func hpColor(_ e: Entity) -> Color {
        let r = e.hpRatio
        if r > 0.5 { return .green }
        if r > 0.25 { return .yellow }
        return .red
    }
}

// MARK: - 周围行

struct NearbyRow: View {
    let rank: Int
    let entity: Entity
    let distance: Double

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Text("\(rank)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: 24, alignment: .trailing)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 5) {
                    Text(entity.name).font(.callout).lineLimit(1)
                        .textSelection(.enabled)
                        .contextMenu { Button("复制名字") { Clipboard.copy(entity.name) } }
                    if entity.isActive {
                        Circle().fill(Color.green).frame(width: 6, height: 6)
                    }
                    StatusBadge(active: entity.isActive)
                    if entity.isWithin100k {
                        Text("10万内")
                            .font(.system(size: 9, weight: .semibold))
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(Color.nearOrigin.opacity(0.18), in: Capsule())
                            .foregroundStyle(Color.nearOrigin)
                    }
                }
                HStack(spacing: 10) {
                    Text("cell \(entity.cellText)")
                    Text(String(format: "距 %.0f", distance))
                    Text("HP \(entity.hpText)")
                        .foregroundStyle(hpColor)
                }
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.secondary)
                .lineLimit(1)
            }

            Spacer(minLength: 4)

            Text("\(entity.deathDropCoins)")
                .font(.callout.bold().monospacedDigit())
                .foregroundStyle(.orange)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(entity.isActive ? Color.green.opacity(0.04) : Color.clear)
    }

    private var hpColor: Color {
        let r = entity.hpRatio
        if r > 0.5 { return .green }
        if r > 0.25 { return .yellow }
        return .red
    }
}

#Preview {
    NearbyView().environmentObject(SnapshotStore())
}
