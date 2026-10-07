const std = @import("std");
const runner = @import("runner");
const native_sdk = @import("native_sdk");

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);

/// Production UI is the root Vite build (../dist from the desktop package cwd).
const frontend_dist = "../dist";

/// Page allocator is fine for the small number of short-lived origin strings
/// we allocate at startup. The buffer is intentionally never torn down —
/// these strings live for the whole app lifetime.
const startup_allocator = std.heap.page_allocator;

const App = struct {
    env_map: *std.process.Environ.Map,
    /// Origin-allowlist strings (zero:// schemes plus dev origins). Grown
    /// at startup; bounded by a 14-entry dev-origin cap kept in code below.
    origins: std.ArrayList([]const u8) = .empty,
    /// Slice view over `origins` — handed to native_sdk security policy.
    allowed_origins: []const []const u8 = &.{},

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

    /// Build the runtime origin allowlist.
    ///
    /// Always-on schemes (internal webview navigation): `zero://app` and
    /// `zero://inline`. These ship in the binary.
    ///
    /// Dev origins (set by scripts/desktop-dev.mjs once Vite has bound to a
    /// port): one entry per `|`-separated value in `AGENSIS_DEV_ORIGINS`.
    /// When unset (production builds, ad-hoc runs), the allowlist is just
    /// the two `zero://` schemes.
    fn resolveAllowedOrigins(self: *@This()) !void {
        try self.origins.append(startup_allocator, "zero://app");
        try self.origins.append(startup_allocator, "zero://inline");

        if (self.env_map.get("AGENSIS_DEV_ORIGINS")) |raw| {
            // env_map pointers are not stable across runs; copy them into
            // page-allocated memory so the slice lives for app lifetime.
            var it = std.mem.splitScalar(u8, raw, '|');
            while (it.next()) |origin| {
                const trimmed = std.mem.trim(u8, origin, " \t\r\n");
                if (trimmed.len == 0) continue;
                const owned = try startup_allocator.dupe(u8, trimmed);
                try self.origins.append(startup_allocator, owned);
            }
        }

        self.allowed_origins = self.origins.items;
    }
};

/// Compile-time policy templates — origins are filled in per-instance at
/// startup so they point at App-owned memory (not at module-level constants).
const builtin_policy_templates = [_]struct { name: []const u8, permissions: []const []const u8 }{
    .{ .name = "native-sdk.dialog.openFile", .permissions = &[_][]const u8{native_sdk.security.permission_dialog} },
    .{ .name = "native-sdk.dialog.saveFile", .permissions = &[_][]const u8{native_sdk.security.permission_dialog} },
    .{ .name = "native-sdk.dialog.showMessage", .permissions = &[_][]const u8{native_sdk.security.permission_dialog} },
    .{ .name = "native-sdk.os.openUrl", .permissions = &[_][]const u8{native_sdk.security.permission_network} },
};

pub fn main(init: std.process.Init) !void {
    var app = App{ .env_map = init.environ_map };
    try app.resolveAllowedOrigins();

    // Per-instance policies: origins point at app.allowed_origins slice.
    var policies_buf: [builtin_policy_templates.len]native_sdk.BridgeCommandPolicy = undefined;
    for (&policies_buf, builtin_policy_templates) |*dst, template| {
        dst.* = .{
            .name = template.name,
            .permissions = template.permissions,
            .origins = app.allowed_origins,
        };
    }

    try runner.runWithOptions(app.app(), .{
        .app_name = "agensis",
        .window_title = "agensis",
        .bundle_id = "io.agensis.app",
        .icon_path = "assets/icon.png",
        .js_window_api = true,
        .builtin_bridge = .{ .enabled = true, .commands = &policies_buf },
        .security = .{
            .permissions = &[_][]const u8{
                native_sdk.security.permission_dialog,
                native_sdk.security.permission_network,
            },
            .navigation = .{
                .allowed_origins = app.allowed_origins,
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

test "resolveAllowedOrigins defaults to zero schemes only" {
    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    var app = App{ .env_map = &env };
    try app.resolveAllowedOrigins();
    try std.testing.expectEqual(@as(usize, 2), app.allowed_origins.len);
    try std.testing.expectEqualStrings("zero://app", app.allowed_origins[0]);
    try std.testing.expectEqualStrings("zero://inline", app.allowed_origins[1]);
}

test "resolveAllowedOrigins parses pipe-separated AGENSIS_DEV_ORIGINS" {
    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    try env.put("AGENSIS_DEV_ORIGINS", "http://127.0.0.1:5173|http://localhost:5174");
    var app = App{ .env_map = &env };
    try app.resolveAllowedOrigins();
    try std.testing.expectEqual(@as(usize, 4), app.allowed_origins.len);
    try std.testing.expectEqualStrings("zero://app", app.allowed_origins[0]);
    try std.testing.expectEqualStrings("zero://inline", app.allowed_origins[1]);
    try std.testing.expectEqualStrings("http://127.0.0.1:5173", app.allowed_origins[2]);
    try std.testing.expectEqualStrings("http://localhost:5174", app.allowed_origins[3]);
}

test "resolveAllowedOrigins skips blank entries" {
    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    try env.put("AGENSIS_DEV_ORIGINS", " http://127.0.0.1:7000 || ");
    var app = App{ .env_map = &env };
    try app.resolveAllowedOrigins();
    try std.testing.expectEqual(@as(usize, 3), app.allowed_origins.len);
    try std.testing.expectEqualStrings("http://127.0.0.1:7000", app.allowed_origins[2]);
}
