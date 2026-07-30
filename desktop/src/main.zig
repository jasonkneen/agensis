const std = @import("std");
const runner = @import("runner");
const native_sdk = @import("native_sdk");

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);

/// Production UI is the root Vite build (../dist from the desktop package cwd).
const frontend_dist = "../dist";

const App = struct {
    env_map: *std.process.Environ.Map,

    fn app(self: *@This()) native_sdk.App {
        return .{
            .context = self,
            .name = "agensis",
            .source = native_sdk.frontend.productionSource(.{ .dist = frontend_dist }),
            .source_fn = source,
        };
    }

    fn source(context: *anyopaque) anyerror!native_sdk.WebViewSource {
        const self: *@This() = @ptrCast(@alignCast(context));
        return native_sdk.frontend.sourceFromEnv(self.env_map, .{
            .dist = frontend_dist,
            .entry = "index.html",
        });
    }
};

// Dev Vite origin + production asset origins. Backend XHR/WS to Fly is not
// navigation and does not need to be listed here.
const allowed_origins = [_][]const u8{ "zero://app", "zero://inline", "http://127.0.0.1:5173" };

const app_permissions = [_][]const u8{
    native_sdk.security.permission_dialog,
    native_sdk.security.permission_network,
};

const dialog_permission = [_][]const u8{native_sdk.security.permission_dialog};
const network_permission = [_][]const u8{native_sdk.security.permission_network};

// Folder picker for Settings → project path (replaces Electron pick-folder IPC).
// openUrl is available if we later want an explicit bridge call; external_links
// already opens http(s) targets in the system browser.
const builtin_policies = [_]native_sdk.BridgeCommandPolicy{
    .{ .name = "native-sdk.dialog.openFile", .permissions = &dialog_permission, .origins = &allowed_origins },
    .{ .name = "native-sdk.dialog.saveFile", .permissions = &dialog_permission, .origins = &allowed_origins },
    .{ .name = "native-sdk.dialog.showMessage", .permissions = &dialog_permission, .origins = &allowed_origins },
    .{ .name = "native-sdk.os.openUrl", .permissions = &network_permission, .origins = &allowed_origins },
};

pub fn main(init: std.process.Init) !void {
    var app = App{ .env_map = init.environ_map };
    try runner.runWithOptions(app.app(), .{
        .app_name = "agensis",
        .window_title = "agensis",
        .bundle_id = "io.agensis.app",
        .icon_path = "assets/icon.png",
        .js_window_api = true,
        .builtin_bridge = .{ .enabled = true, .commands = &builtin_policies },
        .security = .{
            .permissions = &app_permissions,
            .navigation = .{
                .allowed_origins = &allowed_origins,
                .external_links = .{ .action = .open_system_browser },
            },
        },
    }, init);
}

test "production source points at root Vite dist" {
    const source = native_sdk.frontend.productionSource(.{ .dist = frontend_dist });
    try std.testing.expectEqual(native_sdk.WebViewSourceKind.assets, source.kind);
    try std.testing.expectEqualStrings(frontend_dist, source.asset_options.?.root_path);
}
