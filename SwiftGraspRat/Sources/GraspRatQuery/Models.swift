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
    /// 死亡掉落金币 —— 即“drop”
    let deathDropCoins: Int
    /// "Active" / "Passive"
    let currentJoinMode: String

    var id: Int { entityId }

    enum CodingKeys: String, CodingKey {
        case entityId = "entity_id"
        case userId = "user_id"
        case name, x, y, cell
        case deathDropCoins = "death_drop_coins"
        case currentJoinMode = "current_join_mode"
    }

    /// active 状态
    var isActive: Bool { currentJoinMode == "Active" }

    /// 坐标文本，如 "(-123600, 557100)"
    var coordinateText: String { "(\(x), \(y))" }

    /// 网格坐标文本，如 "(-124, 557)"
    var cellText: String { cell.count == 2 ? "(\(cell[0]), \(cell[1]))" : "—" }
}

// MARK: - 聚合统计

/// 一个 gridSize×gridSize 网格的聚合结果
struct GridBucket: Identifiable {
    let gx: Int                 // floor(x / gridSize)
    let gy: Int                 // floor(y / gridSize)
    let gridSize: Int
    let count: Int              // 落在该网格的实体数
    let activeCount: Int
    let totalDrop: Int          // 掉落合计
    let maxDrop: Int            // 单体最大掉落

    var id: String { "\(gx),\(gy)" }
    var passiveCount: Int { count - activeCount }
    var cellText: String { "(\(gx), \(gy))" }

    /// 网格覆盖的坐标范围，如 "x[0, 1000)  y[0, 1000)"
    var rangeText: String {
        "x[\(gx * gridSize), \(gx * gridSize + gridSize))  y[\(gy * gridSize), \(gy * gridSize + gridSize))"
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

    /// 把实体按 gridSize×gridSize 网格聚合（仅返回非空网格，未排序）
    static func buckets(_ entities: [Entity], gridSize: Int) -> [GridBucket] {
        guard gridSize > 0 else { return [] }
        struct Acc { var count = 0; var active = 0; var drop = 0; var maxDrop = 0 }
        var map: [GridKey: Acc] = [:]
        for e in entities {
            let key = GridKey(gx: floorDiv(e.x, gridSize), gy: floorDiv(e.y, gridSize))
            var a = map[key] ?? Acc()
            a.count += 1
            if e.isActive { a.active += 1 }
            a.drop += e.deathDropCoins
            a.maxDrop = max(a.maxDrop, e.deathDropCoins)
            map[key] = a
        }
        return map.map { key, a in
            GridBucket(gx: key.gx, gy: key.gy, gridSize: gridSize,
                       count: a.count, activeCount: a.active,
                       totalDrop: a.drop, maxDrop: a.maxDrop)
        }
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
