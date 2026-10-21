#!/usr/bin/env node
// prebuild.cjs — builds backend + frontend and stages sidecar runtime into apps/desktop/src-tauri/resources/
// Called automatically by Tauri beforeBuildCommand regardless of working directory.

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const { createRequire } = require('module');

const srcTauri = __dirname;
const desktopDir = path.resolve(srcTauri, '..');
const root = path.resolve(desktopDir, '..', '..');
const resources = path.join(srcTauri, 'resources');
const rootRequire = createRequire(path.join(root, 'package.json'));

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyFile(src, dst) {
  if (fs.existsSync(src)) {
    ensureDir(path.dirname(dst));
    fs.copyFileSync(src, dst);
    console.log(`[prebuild] copied ${src} -> ${dst}`);
    return true;
  }
  return false;
}

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return false;
  ensureDir(dst);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
  return true;
}

console.log('[prebuild] building Vedit backend & desktop UI...');
execSync('npm run build', { cwd: root, stdio: 'inherit' });
execSync('npm run build', { cwd: desktopDir, stdio: 'inherit' });

console.log('[prebuild] staging resources for Tauri NSIS bundle...');
ensureDir(resources);

// Ensure empty target/release/bundle/msi exists so workflow scripts checking bundle/msi/*.msi
// when building NSIS-only releases cleanly receive empty match instead of missing-directory error.
ensureDir(path.join(srcTauri, 'target', 'release', 'bundle', 'msi'));

// 1) Standalone sidecar server (no workspace symlinks, no duplicate 180 MB ffmpeg npm packages)
const serverDir = path.join(resources, 'server');
ensureDir(serverDir);
copyDir(path.join(root, 'dist'), path.join(serverDir, 'dist'));

const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const runtimeDeps = {};
for (const [k, v] of Object.entries(rootPkg.dependencies || {})) {
  if (k === '@ffmpeg-installer/ffmpeg' || k === '@ffprobe-installer/ffprobe') continue;
  runtimeDeps[k] = v;
}
fs.writeFileSync(
  path.join(serverDir, 'package.json'),
  JSON.stringify(
    {
      name: 'vedit-sidecar',
      version: rootPkg.version || '0.1.0',
      private: true,
      type: 'module',
      dependencies: runtimeDeps,
    },
    null,
    2,
  ),
);

execSync('npm install --omit=dev --no-audit --no-fund', {
  cwd: serverDir,
  stdio: 'inherit',
  timeout: 180000,
});

// 2) FFmpeg & ffprobe binaries
const binDir = path.join(resources, 'bin');
ensureDir(binDir);
try {
  const ffmpegPath = rootRequire('@ffmpeg-installer/ffmpeg').path;
  copyFile(ffmpegPath, path.join(binDir, 'ffmpeg.exe'));
} catch (e) {
  console.warn('[prebuild] ffmpeg staging warning:', e.message);
}
try {
  const ffprobePath = rootRequire('@ffprobe-installer/ffprobe').path;
  copyFile(ffprobePath, path.join(binDir, 'ffprobe.exe'));
} catch (e) {
  console.warn('[prebuild] ffprobe staging warning:', e.message);
}

// 3) Embedded Node.js runtime
const nodeDir = path.join(resources, 'node');
ensureDir(nodeDir);
const stagedNode = path.join(nodeDir, 'node.exe');
copyFile(process.execPath, stagedNode);

// 4) Smoke-verify packaged sidecar entry executes cleanly
execFileSync(stagedNode, [path.join(serverDir, 'dist', 'cli', 'index.js'), '--help'], {
  cwd: serverDir,
  stdio: 'pipe',
});
console.log('[prebuild] verified packaged sidecar CLI boots cleanly!');
