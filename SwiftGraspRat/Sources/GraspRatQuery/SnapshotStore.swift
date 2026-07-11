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

    /// 邻近聚类（距离 ≤ radius；排除 10 万内；仅 ≥2 人）
    func clusters(radius: Int) -> [ProximityCluster] {
        SpatialAggregator.clusters(snapshot?.entities ?? [], radius: radius)
    }

    /// 按名字查找自己（忽略大小写精确匹配；多名时取 drop 最大）
    func findMe(name: String) -> Entity? {
        let key = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return nil }
        let hits = (snapshot?.entities ?? []).filter {
            $0.name.compare(key, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame
        }
        return hits.max { $0.deathDropCoins < $1.deathDropCoins }
    }

    /// 名字联想（包含匹配，最多 12 条）
    func nameSuggestions(query: String, limit: Int = 12) -> [String] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return [] }
        var seen = Set<String>()
        var out: [String] = []
        for e in snapshot?.entities ?? [] {
            guard e.name.range(of: q, options: [.caseInsensitive, .diacriticInsensitive]) != nil else { continue }
            if seen.insert(e.name).inserted {
                out.append(e.name)
                if out.count >= limit { break }
            }
        }
        return out
    }

    /// 我的周围：距 me 距离 ≤ radius，按掉落降序（不含自己）
    func nearby(around me: Entity, radius: Int) -> [(entity: Entity, distance: Double)] {
        guard radius > 0 else { return [] }
        let r = Double(radius)
        return (snapshot?.entities ?? [])
            .compactMap { e -> (Entity, Double)? in
                guard e.entityId != me.entityId else { return nil }
                let d = me.distance(to: e)
                return d <= r ? (e, d) : nil
            }
            .sorted {
                if $0.0.deathDropCoins != $1.0.deathDropCoins {
                    return $0.0.deathDropCoins > $1.0.deathDropCoins
                }
                return $0.1 < $1.1
            }
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
