import Foundation

// MARK: - 数据模型
// 仅声明用到的字段；JSONDecoder 会自动忽略快照里其余字段，
// 既保持模型简洁，也对服务端新增字段更健壮。

/// 顶层快照响应（/snapshot）
struct Snapshot: Codable {
    let type: String
    let tick: Int
    let totalEntities: Int
    let inGame: Int
    let entities: [Entity]

    enum CodingKeys: String, CodingKey {
        case type, tick
        case totalEntities = "total_entities"
        case inGame = "in_game"
        case entities
    }
}

/// 单个实体（玩家）
struct Entity: Codable, Identifiable {
    let entityId: Int
    let userId: Int
    let name: String
    let x: Int
    let y: Int
    let cell: [Int]
    /// 当前血量（旧缓存可能缺失，缺省 0）
    let hp: Int
    /// 最大血量（旧缓存可能缺失，缺省 0）
    let maxHp: Int
    /// 死亡掉落金币 —— 即“drop”
    let deathDropCoins: Int
    /// "Active" / "Passive"
    let currentJoinMode: String
    /// 以 Active 模式加入的 tick 列表（可能缺失，如观战快照）
    let activeJoinTicks: [Int]?
    /// 以 Passive 模式加入的 tick 列表
    let passiveJoinTicks: [Int]?

    var id: Int { entityId }

    enum CodingKeys: String, CodingKey {
        case entityId = "entity_id"
        case userId = "user_id"
        case name, x, y, cell, hp
        case maxHp = "max_hp"
        case deathDropCoins = "death_drop_coins"
        case currentJoinMode = "current_join_mode"
        case activeJoinTicks = "active_join_ticks"
        case passiveJoinTicks = "passive_join_ticks"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        entityId = try c.decode(Int.self, forKey: .entityId)
        userId = try c.decode(Int.self, forKey: .userId)
        name = try c.decode(String.self, forKey: .name)
        x = try c.decode(Int.self, forKey: .x)
        y = try c.decode(Int.self, forKey: .y)
        cell = try c.decode([Int].self, forKey: .cell)
        hp = try c.decodeIfPresent(Int.self, forKey: .hp) ?? 0
        maxHp = try c.decodeIfPresent(Int.self, forKey: .maxHp) ?? 0
        deathDropCoins = try c.decode(Int.self, forKey: .deathDropCoins)
        currentJoinMode = try c.decode(String.self, forKey: .currentJoinMode)
        activeJoinTicks = try c.decodeIfPresent([Int].self, forKey: .activeJoinTicks)
        passiveJoinTicks = try c.decodeIfPresent([Int].self, forKey: .passiveJoinTicks)
    }

    /// active 状态
    var isActive: Bool { currentJoinMode == "Active" }

    /// 坐标在原点 10 万以内（|x|、|y| 均 < 100_000）
    var isWithin100k: Bool {
        abs(x) < 100_000 && abs(y) < 100_000
    }

    /// 血量文本，如 "100/100"
    var hpText: String { "\(hp)/\(maxHp)" }

    /// 血量比例 0...1（maxHp 无效时为 0）
    var hpRatio: Double {
        guard maxHp > 0 else { return 0 }
        return min(1, max(0, Double(hp) / Double(maxHp)))
    }

    /// 最近一次加入的 tick（active/passive 两个列表里的最大值）。
    /// tick 越大越新；没有任何加入记录时返回 -1（排序时沉底）。
    var latestJoinTick: Int {
        ((activeJoinTicks ?? []) + (passiveJoinTicks ?? [])).max() ?? -1
    }

    /// 坐标文本，如 "(-123600, 557100)"
    var coordinateText: String { "(\(x), \(y))" }

    /// 网格坐标文本，如 "(-124, 557)"
    var cellText: String { cell.count == 2 ? "(\(cell[0]), \(cell[1]))" : "—" }

    /// 到另一实体的欧氏距离（坐标单位）
    func distance(to other: Entity) -> Double {
        let dx = Double(x - other.x), dy = Double(y - other.y)
        return (dx * dx + dy * dy).squareRoot()
    }
}

// MARK: - 聚合统计

/// 邻近聚类结果：距离 ≤ radius 的实体通过传递性连成一团。
struct ProximityCluster: Identifiable {
    let id: Int
    let radius: Int
    let count: Int
    let activeCount: Int
    let totalDrop: Int
    let maxDrop: Int
    /// 质心（成员坐标均值）
    let centerX: Int
    let centerY: Int
    let minX: Int, maxX: Int, minY: Int, maxY: Int
    /// 按 drop 降序的名字（最多 6 个，用于列表预览）
    let topNames: [String]

    var passiveCount: Int { count - activeCount }
    var centerText: String { "(\(centerX), \(centerY))" }
    var spanText: String {
        "x[\(minX), \(maxX)]  y[\(minY), \(maxY)]"
    }
}

/// 全量实体的概览统计
struct SnapshotSummary {
    let total: Int
    let activeCount: Int
    let withDropCount: Int      // death_drop_coins > 0 的实体数
    let totalDrop: Int
    let maxDrop: Int
    let minX: Int, maxX: Int, minY: Int, maxY: Int

    var passiveCount: Int { total - activeCount }
}

/// 空间聚合：纯函数，方便独立测试。
enum SpatialAggregator {
    /// 向下取整除法（Swift 整除朝零截断，负数需修正）
    static func floorDiv(_ a: Int, _ b: Int) -> Int {
        let q = a / b, r = a % b
        return (r != 0 && (r < 0) != (b < 0)) ? q - 1 : q
    }

    /// 邻近聚类：距离 ≤ radius 的两人连边，连通分量成团。
    /// 排除原点 10 万内（|x|、|y| 均 < 100_000）的实体——该区域过于拥挤，邻近统计无参考价值。
    /// 仅返回人数 ≥ 2 的团（单人无“聚集”意义）。
    /// 用 radius 边长网格做邻域剪枝，避免全量 O(n²) 在 n 很大时过慢。
    static func clusters(_ entities: [Entity], radius: Int) -> [ProximityCluster] {
        let entities = entities.filter { !$0.isWithin100k }
        guard radius > 0, entities.count >= 2 else { return [] }

        let n = entities.count
        var parent = Array(0..<n)
        var rank = [Int](repeating: 0, count: n)

        func find(_ i: Int) -> Int {
            var i = i
            while parent[i] != i {
                parent[i] = parent[parent[i]]
                i = parent[i]
            }
            return i
        }
        func union(_ a: Int, _ b: Int) {
            var ra = find(a), rb = find(b)
            if ra == rb { return }
            if rank[ra] < rank[rb] { swap(&ra, &rb) }
            parent[rb] = ra
            if rank[ra] == rank[rb] { rank[ra] += 1 }
        }

        // 网格索引：只检查自身格 + 相邻 8 格内的点
        var cells: [GridKey: [Int]] = [:]
        cells.reserveCapacity(n)
        for i in 0..<n {
            let key = GridKey(gx: floorDiv(entities[i].x, radius),
                              gy: floorDiv(entities[i].y, radius))
            cells[key, default: []].append(i)
        }

        let r2 = radius * radius
        for (key, idxs) in cells {
            for dgx in -1...1 {
                for dgy in -1...1 {
                    let other = cells[GridKey(gx: key.gx + dgx, gy: key.gy + dgy)] ?? []
                    // 同格：两两比；跨格：只比 idxs 与 other，避免重复（用 key 序约束）
                    if dgx == 0 && dgy == 0 {
                        for a in 0..<idxs.count {
                            let i = idxs[a]
                            let ei = entities[i]
                            for b in (a + 1)..<idxs.count {
                                let j = idxs[b]
                                let ej = entities[j]
                                let dx = ei.x - ej.x, dy = ei.y - ej.y
                                if dx * dx + dy * dy <= r2 { union(i, j) }
                            }
                        }
                    } else if dgx > 0 || (dgx == 0 && dgy > 0) {
                        for i in idxs {
                            let ei = entities[i]
                            for j in other {
                                let ej = entities[j]
                                let dx = ei.x - ej.x, dy = ei.y - ej.y
                                if dx * dx + dy * dy <= r2 { union(i, j) }
                            }
                        }
                    }
                }
            }
        }

        // 按根收集成员
        var groups: [Int: [Int]] = [:]
        for i in 0..<n {
            groups[find(i), default: []].append(i)
        }

        var result: [ProximityCluster] = []
        result.reserveCapacity(groups.count)
        for (root, members) in groups where members.count >= 2 {
            var active = 0, totalDrop = 0, maxDrop = 0
            var sumX = 0, sumY = 0
            var minX = Int.max, maxX = Int.min, minY = Int.max, maxY = Int.min
            var ranked: [(drop: Int, name: String)] = []
            ranked.reserveCapacity(members.count)
            for i in members {
                let e = entities[i]
                if e.isActive { active += 1 }
                totalDrop += e.deathDropCoins
                maxDrop = max(maxDrop, e.deathDropCoins)
                sumX += e.x; sumY += e.y
                minX = min(minX, e.x); maxX = max(maxX, e.x)
                minY = min(minY, e.y); maxY = max(maxY, e.y)
                ranked.append((e.deathDropCoins, e.name))
            }
            ranked.sort { $0.drop > $1.drop }
            let top = ranked.prefix(6).map(\.name)
            let c = members.count
            result.append(ProximityCluster(
                id: root,
                radius: radius,
                count: c,
                activeCount: active,
                totalDrop: totalDrop,
                maxDrop: maxDrop,
                centerX: sumX / c,
                centerY: sumY / c,
                minX: minX, maxX: maxX, minY: minY, maxY: maxY,
                topNames: top
            ))
        }
        return result
    }

    static func summary(_ entities: [Entity]) -> SnapshotSummary {
        guard let first = entities.first else {
            return SnapshotSummary(total: 0, activeCount: 0, withDropCount: 0,
                                   totalDrop: 0, maxDrop: 0, minX: 0, maxX: 0, minY: 0, maxY: 0)
        }
        var active = 0, withDrop = 0, totalDrop = 0, maxDrop = 0
        var minX = first.x, maxX = first.x, minY = first.y, maxY = first.y
        for e in entities {
            if e.isActive { active += 1 }
            if e.deathDropCoins > 0 { withDrop += 1 }
            totalDrop += e.deathDropCoins
            maxDrop = max(maxDrop, e.deathDropCoins)
            minX = min(minX, e.x); maxX = max(maxX, e.x)
            minY = min(minY, e.y); maxY = max(maxY, e.y)
        }
        return SnapshotSummary(total: entities.count, activeCount: active, withDropCount: withDrop,
                               totalDrop: totalDrop, maxDrop: maxDrop,
                               minX: minX, maxX: maxX, minY: minY, maxY: maxY)
    }
}

private struct GridKey: Hashable { let gx: Int; let gy: Int }
