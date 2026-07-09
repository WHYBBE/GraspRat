import SwiftUI

/// 按网格对实体坐标做空间聚合统计。
/// 网格边长可选；1000 = 游戏原生 cell（即“1000 xy 坐标内”），调大可看到聚集热点。
struct StatsView: View {
    @EnvironmentObject private var store: SnapshotStore

    private let gridOptions = [1000, 10000, 50000, 100000]
    @State private var gridSize = 1000
    @State private var sort: BucketSort = .count

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
            .navigationTitle("聚合统计")
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

    private var sortedBuckets: [GridBucket] {
        let b = store.buckets(gridSize: gridSize)
        switch sort {
        case .count: return b.sorted { ($0.count, $0.totalDrop) > ($1.count, $1.totalDrop) }
        case .drop:  return b.sorted { ($0.totalDrop, $0.count) > ($1.totalDrop, $1.count) }
        }
    }

    private var content: some View {
        let buckets = sortedBuckets
        let shown = Array(buckets.prefix(50).enumerated())
        let maxCount = buckets.map(\.count).max() ?? 1
        return ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let err = store.errorMessage { errorBanner(err) }
                gridPicker
                if let s = store.summary {
                    SummaryCard(summary: s, bucketCount: buckets.count, gridSize: gridSize)
                }
                sortPicker
                Text("热点网格 Top \(shown.count)").font(.headline)
                VStack(spacing: 0) {
                    ForEach(shown, id: \.element.id) { index, bucket in
                        BucketRow(rank: index + 1, bucket: bucket, maxCount: maxCount)
                        if index < shown.count - 1 { Divider() }
                    }
                }
            }
            .padding()
            .textSelection(.enabled)   // 坐标、范围等可选中复制
        }
    }

    private var gridPicker: some View {
        VStack(alignment: .leading, spacing: 4) {
            Picker("网格边长", selection: $gridSize) {
                ForEach(gridOptions, id: \.self) { Text(gridLabel($0)).tag($0) }
            }
            .pickerStyle(.segmented)
            Text("网格边长（坐标单位）。1000 = 游戏原生 cell；调大可看到聚集热点。")
                .font(.caption2).foregroundStyle(.secondary)
        }
    }

    private var sortPicker: some View {
        Picker("排序", selection: $sort) {
            ForEach(BucketSort.allCases) { Text($0.rawValue).tag($0) }
        }
        .pickerStyle(.segmented)
    }

    private func gridLabel(_ g: Int) -> String { g >= 1000 ? "\(g / 1000)k" : "\(g)" }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "square.grid.3x3")
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

enum BucketSort: String, CaseIterable, Identifiable {
    case count = "按数量"
    case drop = "按掉落"
    var id: String { rawValue }
}

// MARK: - 概览卡片

struct SummaryCard: View {
    let summary: SnapshotSummary
    let bucketCount: Int
    let gridSize: Int

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
            Text("占用网格：\(bucketCount)（边长 \(gridSize)）")
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

// MARK: - 网格行（含密度条）

struct BucketRow: View {
    let rank: Int
    let bucket: GridBucket
    let maxCount: Int

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(rank)")
                .font(.callout.monospacedDigit()).foregroundStyle(.secondary)
                .frame(width: 24, alignment: .trailing)

            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text("网格 \(bucket.cellText)").font(.subheadline.weight(.semibold))
                    Spacer()
                    Text("\(bucket.count) 个").font(.subheadline.monospacedDigit())
                }
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color.orange.opacity(0.15))
                        Capsule().fill(Color.orange.opacity(0.75))
                            .frame(width: max(2, geo.size.width * CGFloat(bucket.count) / CGFloat(max(maxCount, 1))))
                    }
                }
                .frame(height: 6)
                HStack(spacing: 14) {
                    Label("\(bucket.activeCount)", systemImage: "bolt.fill").foregroundStyle(.green)
                    Label("\(bucket.totalDrop)", systemImage: "bitcoinsign.circle").foregroundStyle(.orange)
                    Text("max \(bucket.maxDrop)").foregroundStyle(.secondary)
                    Spacer()
                    Text(bucket.rangeText).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle)
                }
                .font(.caption.monospacedDigit())
            }
        }
        .padding(.vertical, 7)
    }
}

#Preview {
    StatsView().environmentObject(SnapshotStore())
}
