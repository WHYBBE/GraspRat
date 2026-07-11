import SwiftUI

/// 按距离对实体做邻近聚类：距离 ≤ 半径的人连成一团（传递性），只展示 ≥2 人的聚集。
struct StatsView: View {
    @EnvironmentObject private var store: SnapshotStore

    /// 邻近半径（坐标单位，约等于游戏内米）。默认 1000。
    private let radiusOptions = [500, 1000, 5000, 10000]
    @State private var radius = 1000
    @State private var sort: ClusterSort = .drop

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
            .navigationTitle("邻近聚合")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button(action: { Task { await store.refresh() } }) {
                        if store.isLoading { ProgressView() }
                        else { Label("刷新", systemImage: "arrow.clockwise") }
                    }
                    .disabled(store.isLoading)
                }
            }
        }
    }

    private var sortedClusters: [ProximityCluster] {
        let c = store.clusters(radius: radius)
        switch sort {
        case .count: return c.sorted { ($0.count, $0.totalDrop) > ($1.count, $1.totalDrop) }
        case .drop:  return c.sorted { ($0.totalDrop, $0.count) > ($1.totalDrop, $1.count) }
        }
    }

    private var content: some View {
        let clusters = sortedClusters
        let shown = Array(clusters.prefix(50).enumerated())
        let maxCount = clusters.map(\.count).max() ?? 1
        let clusteredPeople = clusters.reduce(0) { $0 + $1.count }
        return ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let err = store.errorMessage { errorBanner(err) }
                radiusPicker
                if let s = store.summary {
                    SummaryCard(
                        summary: s,
                        clusterCount: clusters.count,
                        clusteredPeople: clusteredPeople,
                        radius: radius
                    )
                }
                sortPicker
                Text(clusters.isEmpty
                     ? "暂无 ≥2 人聚集"
                     : "邻近团 Top \(shown.count)")
                    .font(.headline)
                VStack(spacing: 0) {
                    ForEach(shown, id: \.element.id) { index, cluster in
                        ClusterRow(rank: index + 1, cluster: cluster, maxCount: maxCount)
                        if index < shown.count - 1 { Divider() }
                    }
                }
            }
            .padding()
            .textSelection(.enabled)
        }
    }

    private var radiusPicker: some View {
        VStack(alignment: .leading, spacing: 4) {
            Picker("邻近半径", selection: $radius) {
                ForEach(radiusOptions, id: \.self) { Text(radiusLabel($0)).tag($0) }
            }
            .pickerStyle(.segmented)
            Text("距离 ≤ 半径连成一团（可传递）；排除原点 10 万内实体；只显示 ≥2 人的团。")
                .font(.caption2).foregroundStyle(.secondary)
        }
    }

    private var sortPicker: some View {
        Picker("排序", selection: $sort) {
            ForEach(ClusterSort.allCases) { Text($0.rawValue).tag($0) }
        }
        .pickerStyle(.segmented)
    }

    private func radiusLabel(_ r: Int) -> String {
        if r >= 1000 { return "\(r / 1000)k" }
        return "\(r)"
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "circle.grid.cross")
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
}

enum ClusterSort: String, CaseIterable, Identifiable {
    case count = "按人数"
    case drop = "按掉落"
    var id: String { rawValue }
}

// MARK: - 概览卡片

struct SummaryCard: View {
    let summary: SnapshotSummary
    let clusterCount: Int
    let clusteredPeople: Int
    let radius: Int

    private let columns = [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("概览").font(.headline)
            LazyVGrid(columns: columns, alignment: .leading, spacing: 10) {
                stat("实体", "\(summary.total)")
                stat("Active", "\(summary.activeCount)")
                stat("Passive", "\(summary.passiveCount)")
                stat("有掉落", "\(summary.withDropCount)")
                stat("掉落合计", "\(summary.totalDrop)")
                stat("最大掉落", "\(summary.maxDrop)")
            }
            Divider()
            Text("邻近团：\(clusterCount)（半径 \(radius)，已排除 10 万内）· 入团 \(clusteredPeople) 人")
                .font(.caption).foregroundStyle(.secondary)
            Text("x ∈ [\(summary.minX), \(summary.maxX)]   y ∈ [\(summary.minY), \(summary.maxY)]")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.blue.opacity(0.07), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(.blue.opacity(0.25)))
    }

    private func stat(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title3.weight(.semibold)).monospacedDigit()
        }
    }
}

// MARK: - 邻近团行

struct ClusterRow: View {
    let rank: Int
    let cluster: ProximityCluster
    let maxCount: Int

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(rank)")
                .font(.callout.monospacedDigit()).foregroundStyle(.secondary)
                .frame(width: 24, alignment: .trailing)

            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text("中心 \(cluster.centerText)")
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                    Spacer()
                    Text("\(cluster.count) 人")
                        .font(.subheadline.monospacedDigit())
                }
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.orange.opacity(0.15))
                        Capsule().fill(Color.orange.opacity(0.75))
                            .frame(width: max(2, geo.size.width * CGFloat(cluster.count) / CGFloat(max(maxCount, 1))))
                    }
                }
                .frame(height: 6)
                HStack(spacing: 14) {
                    Label("\(cluster.activeCount)", systemImage: "bolt.fill").foregroundStyle(.green)
                    Label("\(cluster.totalDrop)", systemImage: "bitcoinsign.circle").foregroundStyle(.orange)
                    Text("max \(cluster.maxDrop)").foregroundStyle(.secondary)
                    Spacer()
                }
                .font(.caption.monospacedDigit())
                Text(cluster.topNames.joined(separator: " · "))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Text(cluster.spanText)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .padding(.vertical, 7)
    }
}

#Preview {
    StatsView().environmentObject(SnapshotStore())
}
