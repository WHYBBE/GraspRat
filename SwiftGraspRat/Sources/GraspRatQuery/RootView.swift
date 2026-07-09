import SwiftUI

/// 根视图：持有共享的 `SnapshotStore`，用 TabView 承载两个功能页。
/// 两页共用同一份缓存与刷新逻辑（在任一页刷新，两页都会更新）。
struct RootView: View {
    @StateObject private var store = SnapshotStore()

    var body: some View {
        TabView {
            ContentView()
                .tabItem { Label("最大掉落", systemImage: "trophy") }
            StatsView()
                .tabItem { Label("聚合统计", systemImage: "square.grid.3x3") }
        }
        .environmentObject(store)
    }
}

#Preview {
    RootView()
}
