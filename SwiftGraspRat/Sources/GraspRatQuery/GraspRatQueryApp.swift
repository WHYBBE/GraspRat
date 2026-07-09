import SwiftUI
#if canImport(AppKit)
import AppKit

/// 通过 `swift run` 启动的 SPM 可执行文件默认是后台/附件进程：
/// 窗口不会成为活跃应用，因此拿不到键盘焦点、也不会浮到最前。
/// 这里显式把进程提升为常规 GUI 应用并激活到前台。
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)        // 关键：从 accessory 提升为常规应用
        activateApp()
        NSApp.windows.first?.makeKeyAndOrderFront(nil)
    }

    /// 退出策略：关掉窗口即退出，符合单窗口工具的预期。
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    private func activateApp() {
        if #available(macOS 14.0, *) {
            NSApp.activate()                        // 新 API，避免弃用告警
        } else {
            NSApp.activate(ignoringOtherApps: true)
        }
    }
}
#endif

@main
struct GraspRatQueryApp: App {
    #if canImport(AppKit)
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    #endif

    var body: some Scene {
        WindowGroup {
            RootView()
                .frame(minWidth: 720, minHeight: 520)
        }
    }
}
