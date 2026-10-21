#!/usr/bin/env node
// prebuild.cjs — stages sidecar resources for Tauri bundle (called from beforeBuildCommand)
// Ensures: resources/server/dist, resources/bin/ffmpeg.exe+ffprobe.exe, resources/node/node.exe
// Works on both Linux (CI local) and Windows (GitHub Actions). No hard fail if optional bits missing.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..', '..'); // repo root
const srcTauri = __dirname;
const resources = path.join(srcTauri, 'resources');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
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
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
  console.log(`[prebuild] copied dir ${src} -> ${dst}`);
  return true;
}

console.log('[prebuild] staging resources for Tauri bundle...');

// 1) server/dist
copyDir(path.join(root, 'dist'), path.join(resources, 'server', 'dist'));
copyFile(path.join(root, 'package.json'), path.join(resources, 'server', 'package.json'));
copyFile(path.join(root, 'package-lock.json'), path.join(resources, 'server', 'package-lock.json'));

// Try to install prod deps inside staged server (for sidecar runtime) — non-fatal if fails
try {
  const serverDir = path.join(resources, 'server');
  if (fs.existsSync(path.join(serverDir, 'package.json'))) {
    console.log('[prebuild] npm ci --omit=dev in resources/server (best-effort)');
    execSync('npm ci --omit=dev --no-audit --no-fund', { cwd: serverDir, stdio: 'inherit', timeout: 120000 });
  }
} catch (e) { console.warn('[prebuild] npm ci in resources/server failed (non-fatal):', e.message); }

// 2) FFmpeg/ffprobe — try to copy from @ffmpeg-installer / @ffprobe-installer
try {
  const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
  const ffprobePath = require('@ffprobe-installer/ffprobe').path;
  const binDir = path.join(resources, 'bin');
  ensureDir(binDir);
  // On Windows runner, these are already .exe; on Linux they are linux binaries — we still copy,
  // but Tauri will bundle them. For Windows target, the runner will have win32 binaries if available.
  // Try to also handle win32-x64 variant explicitly:
  const tryCopy = (src, dstName) => {
    if (src && fs.existsSync(src)) {
      copyFile(src, path.join(binDir, dstName));
      return true;
    }
    return false;
  };
  if (!tryCopy(ffmpegPath, 'ffmpeg.exe')) {
    // Try win32 variant path
    const cand = path.join(path.dirname(ffmpegPath), '..', 'ffmpeg-win32-x64', 'ffmpeg.exe');
    if (fs.existsSync(cand)) copyFile(cand, path.join(binDir, 'ffmpeg.exe'));
  }
  if (!tryCopy(ffprobePath, 'ffprobe.exe')) {
    const cand = path.join(path.dirname(ffprobePath), '..', 'ffprobe-win32-x64', 'ffprobe.exe');
    if (fs.existsSync(cand)) copyFile(cand, path.join(binDir, 'ffprobe.exe'));
  }
} catch (e) { console.warn('[prebuild] FFmpeg staging skipped:', e.message); }

// 3) Node runtime for sidecar
try {
  const nodeSrc = process.execPath;
  if (nodeSrc && fs.existsSync(nodeSrc)) {
    const dst = path.join(resources, 'node', process.platform === 'win32' ? 'node.exe' : 'node');
    copyFile(nodeSrc, dst);
    // Also copy as node.exe for Windows target even when building on Linux
    if (process.platform !== 'win32') {
      copyFile(nodeSrc, path.join(resources, 'node', 'node.exe'));
    }
  }
} catch (e) { console.warn('[prebuild] node staging skipped:', e.message); }

console.log('[prebuild] done. resources:', fs.existsSync(resources) ? fs.readdirSync(resources) : 'none');
if (fs.existsSync(path.join(resources, 'bin'))) console.log('[prebuild] bin:', fs.readdirSync(path.join(resources, 'bin')));
if (fs.existsSync(path.join(resources, 'server', 'dist'))) console.log('[prebuild] server/dist exists');
