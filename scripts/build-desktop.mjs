#!/usr/bin/env node
// Cross-platform desktop bundler entrypoint (PLAN.md §1, §7 — F5):
//   Windows: NSIS installer (`Vedit_installer.exe`)
//   macOS:   `.dmg` + `.app` universal/native bundle
//   Linux:   `.deb` + `.AppImage` desktop packages

import { execSync } from "node:child_process";

const platformBundles = {
  win32: "nsis",
  darwin: "dmg,app",
  linux: "deb,appimage",
};

const bundles = process.env.VEDIT_BUNDLES ?? platformBundles[process.platform] ?? "all";
console.log(`[dist:desktop] Building Vedit Desktop for ${process.platform} (${bundles})…`);
execSync(`npx --prefix apps/desktop tauri build --bundles ${bundles}`, {
  stdio: "inherit",
});
