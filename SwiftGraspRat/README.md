# Grasp Rat 查询

一个简易的 SwiftUI 程序：查询 `https://grasp-rat-game.h-e.top/snapshot`，
找出**死亡掉落（drop）最大的实体**，并显示它的**坐标**与 **active 状态**。

界面分两个 Tab，共用同一份缓存与刷新逻辑（任一页刷新，两页都更新）。

## 功能
- **缓存**：结果写入本地磁盘缓存。启动时只读取缓存、**不联网**。
- **刷新**：**只有点击右上角「刷新」按钮**才发起网络请求；成功后更新界面并回写缓存。
- **Tab 1 · 最大掉落**
  - 最大掉落卡片：名字、drop 值、坐标 `(x, y)`、cell、active 状态徽章（Active / Passive）。
  - 掉落排行 Top 50：每行显示坐标 + active 状态 + drop。
- **Tab 2 · 聚合统计**（按 1000×1000 等网格对坐标做空间聚合）
  - 网格边长可选：`1000`（游戏原生 cell）/ `10k` / `50k` / `100k`，调大可看到聚集热点。
  - 概览卡片：实体数、Active / Passive、有掉落数、掉落合计、最大掉落、坐标范围、占用网格数。
  - 热点网格 Top 50：每格的实体数（带密度条）、active 数、掉落合计、单体最大掉落、坐标范围；可按数量 / 按掉落排序。

## 运行

命令行（macOS）：
```sh
swift build
swift run
```

Xcode（含 iOS）：
- 用 Xcode 打开本目录的 `Package.swift`（File ▸ Open…），选 `GraspRatQuery` 运行；
- 或新建 iOS/macOS App 工程，把 `Sources/GraspRatQuery/*.swift` 拖进去
  （记得删掉模板自带的 `App` 文件，避免与 `@main` 冲突）。

## 网络权限
- **iOS**：无需额外配置（接口已是 https）。
- **macOS（App 沙盒）**：需在 Signing & Capabilities 勾选
  *Outgoing Connections (Client)*（`com.apple.security.network.client`），否则刷新会失败。

## 文件
| 文件 | 作用 |
| --- | --- |
| `Models.swift` | `Snapshot` / `Entity` 数据模型；`GridBucket` / `SnapshotSummary` / `SpatialAggregator`（空间聚合纯函数） |
| `SnapshotStore.swift` | 网络 + 磁盘缓存；派生数据（最大掉落、排行、概览、网格聚合）；**仅 `refresh()` 联网** |
| `RootView.swift` | 持有共享 store 的 TabView 根视图 |
| `ContentView.swift` | Tab 1：最大掉落卡片 + 排行榜 |
| `StatsView.swift` | Tab 2：聚合统计（网格选择、概览卡片、热点网格列表） |
| `GraspRatQueryApp.swift` | 程序入口（含 macOS 焦点修复） |

## 关于聚合（“1000 xy 坐标内”）
- 快照里每个实体的 `cell` 字段就是 `(floor(x/1000), floor(y/1000))`，即 **1000 单位的原生网格**。
- 实测在 1000 单位下分布很稀疏（约 850 个网格、多数仅 1 个实体、单格最多 5 个），所以提供更大的网格边长以观察聚集；坐标向原点 `(0,0)` 明显聚集（100k 网格下原点格约 61 个）。
- 聚合逻辑是纯函数 `SpatialAggregator`，已用真实快照校验：概览与各网格统计与离线分析完全一致。

## 关于 “drop”
快照里有两处都可理解为 drop：
1. 实体的 `death_drop_coins`（**本程序采用**）—— 同时具备坐标与 active 状态，契合“显示坐标和 active 状态”的需求。
2. 顶层 `coin_drops` 数组（地图上的金币掉落）—— 有坐标与 `amount`，但**没有** active 状态。

如需改用第 2 种，把模型换成 `coin_drops`、按 `amount` 取最大即可。
