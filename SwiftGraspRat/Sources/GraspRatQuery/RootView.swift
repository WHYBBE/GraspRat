import SwiftUI

/// 根视图：持有共享的 `SnapshotStore`，用 TabView 承载功能页。
/// 各页共用同一份缓存与刷新逻辑（在任一页刷新，各页都会更新）。
struct RootView: View {
    @StateObject private var store = SnapshotStore()

    var body: some View {
        TabView {
            ContentView()
                .tabItem { Label("最大掉落", systemImage: "trophy") }
            NearbyView()
                .tabItem { Label("我的周围", systemImage: "person.line.dotted.person") }
            StatsView()
                .tabItem { Label("邻近聚合", systemImage: "circle.grid.cross") }
        }
        .environmentObject(store)
    }
}

#Preview {
    RootView()
}
