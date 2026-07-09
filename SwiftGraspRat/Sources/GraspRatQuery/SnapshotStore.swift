import Foundation

/// 负责拉取、缓存快照数据。
///
/// 缓存策略：
/// - 启动时只从磁盘读取上次缓存（`init` -> `loadCache`），**不发起网络请求**。
/// - 只有调用 `refresh()`（即用户点击刷新按钮）才会访问网络，
///   成功后更新内存数据并写回磁盘缓存。
@MainActor
final class SnapshotStore: ObservableObject {
    @Published private(set) var snapshot: Snapshot?
    @Published private(set) var lastUpdated: Date?
    @Published private(set) var isLoading = false
    @Published private(set) var errorMessage: String?

    private let endpoint = URL(string: "https://grasp-rat-game.h-e.top/snapshot")!

    /// 磁盘缓存文件
    private let cacheURL: URL = {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return dir.appendingPathComponent("snapshot_cache.json")
    }()
    private let lastUpdatedKey = "snapshot_cache_date"

    init() {
        loadCache()
    }

    // MARK: - 派生数据

    /// 死亡掉落（drop）最大的实体
    var topDropEntity: Entity? {
        snapshot?.entities.max { $0.deathDropCoins < $1.deathDropCoins }
    }

    /// 按掉落降序排序的实体
    var entitiesByDrop: [Entity] {
        snapshot?.entities.sorted { $0.deathDropCoins > $1.deathDropCoins } ?? []
    }

    /// 活人（current_join_mode == "Active"），按掉落降序
    var activeEntities: [Entity] {
        (snapshot?.entities ?? [])
            .filter { $0.isActive }
            .sorted { $0.deathDropCoins > $1.deathDropCoins }
    }

    /// 最新加入的人，按最近加入 tick 倒序（tick 越大越新）。
    /// 无任何加入记录（latestJoinTick == -1）的实体排在最后。
    var entitiesByJoinRecency: [Entity] {
        (snapshot?.entities ?? [])
            .sorted { $0.latestJoinTick > $1.latestJoinTick }
    }

    /// 概览统计（基于全部实体）
    var summary: SnapshotSummary? {
        snapshot.map { SpatialAggregator.summary($0.entities) }
    }

    /// 按 gridSize×gridSize 网格聚合
    func buckets(gridSize: Int) -> [GridBucket] {
        SpatialAggregator.buckets(snapshot?.entities ?? [], gridSize: gridSize)
    }

    // MARK: - 网络（仅刷新时调用）

    func refresh() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            var request = URLRequest(url: endpoint)
            request.cachePolicy = .reloadIgnoringLocalCacheData   // 刷新一定取最新
            request.timeoutInterval = 30

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, 200..<300 ~= http.statusCode else {
                throw URLError(.badServerResponse)
            }

            let decoded = try JSONDecoder().decode(Snapshot.self, from: data)
            let now = Date()
            snapshot = decoded
            lastUpdated = now
            saveCache(data: data, date: now)
        } catch {
            errorMessage = "刷新失败：\(error.localizedDescription)"
        }
    }

    // MARK: - 磁盘缓存

    private func loadCache() {
        guard let data = try? Data(contentsOf: cacheURL),
              let decoded = try? JSONDecoder().decode(Snapshot.self, from: data)
        else { return }

        snapshot = decoded
        let ts = UserDefaults.standard.double(forKey: lastUpdatedKey)
        if ts > 0 { lastUpdated = Date(timeIntervalSince1970: ts) }
    }

    private func saveCache(data: Data, date: Date) {
        try? data.write(to: cacheURL, options: .atomic)
        UserDefaults.standard.set(date.timeIntervalSince1970, forKey: lastUpdatedKey)
    }
}
