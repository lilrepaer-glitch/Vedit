#!/usr/bin/env node
// prebuild.cjs — builds backend + frontend and stages sidecar runtime into apps/desktop/src-tauri/resources/
// Cross-platform (Windows NSIS, macOS DMG/App, Linux AppImage/DEB).

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const { createRequire } = require('module');

const srcTauri = __dirname;
const desktopDir = path.resolve(srcTauri, '..');
const root = path.resolve(desktopDir, '..', '..');
const resources = path.join(srcTauri, 'resources');
const rootRequire = createRequire(path.join(root, 'package.json'));
const isWin = process.platform === 'win32';
const exeSuffix = isWin ? '.exe' : '';

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyExecutable(src, dst) {
  if (fs.existsSync(src)) {
    ensureDir(path.dirname(dst));
    fs.copyFileSync(src, dst);
    if (!isWin) {
      try {
        fs.chmodSync(dst, 0o755);
      } catch {}
    }
    console.log(`[prebuild] staged executable ${src} -> ${dst}`);
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

console.log(`[prebuild] building Vedit backend & desktop UI (${process.platform}/${process.arch})...`);
execSync('npm run build', { cwd: root, stdio: 'inherit' });
execSync('npm run build', { cwd: desktopDir, stdio: 'inherit' });

console.log('[prebuild] staging resources for Tauri bundle...');
ensureDir(resources);

// Ensure empty target/release/bundle/msi exists so Windows release scripts checking bundle/msi/*.msi
// when building NSIS-only releases cleanly receive empty match instead of missing-directory error.
ensureDir(path.join(srcTauri, 'target', 'release', 'bundle', 'msi'));

// 1) Standalone sidecar server (no workspace symlinks, no duplicate ffmpeg npm packages)
const serverDir = path.join(resources, 'server');
ensureDir(serverDir);
copyDir(path.join(root, 'dist'), path.join(serverDir, 'dist'));
copyDir(path.join(root, 'python'), path.join(serverDir, 'python'));
copyDir(path.join(desktopDir, 'dist'), path.join(serverDir, 'ui'));

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

// 2) FFmpeg & ffprobe binaries (native name on macOS/Linux, .exe on Windows)
const binDir = path.join(resources, 'bin');
ensureDir(binDir);
try {
  const ffmpegPath = rootRequire('@ffmpeg-installer/ffmpeg').path;
  copyExecutable(ffmpegPath, path.join(binDir, `ffmpeg${exeSuffix}`));
} catch (e) {
  console.warn('[prebuild] ffmpeg staging warning:', e.message);
}
try {
  const ffprobePath = rootRequire('@ffprobe-installer/ffprobe').path;
  copyExecutable(ffprobePath, path.join(binDir, `ffprobe${exeSuffix}`));
} catch (e) {
  console.warn('[prebuild] ffprobe staging warning:', e.message);
}

// 3) Embedded Node.js runtime
const nodeDir = path.join(resources, 'node');
ensureDir(nodeDir);
const stagedNode = path.join(nodeDir, `node${exeSuffix}`);
copyExecutable(process.execPath, stagedNode);

// 4) Smoke-verify packaged sidecar CLI + real HTTP server boot & UI serving on current OS (including Windows CI!)
execFileSync(stagedNode, [path.join(serverDir, 'dist', 'cli', 'index.js'), '--help'], {
  cwd: serverDir,
  stdio: 'pipe',
});

(async () => {
  const { spawn } = require('child_process');
  const os = require('os');
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'vedit-prebuild-smoke-'));
  const child = spawn(
    stagedNode,
    [path.join(serverDir, 'dist', 'cli', 'index.js'), 'serve', '--host', '127.0.0.1', '--port', '47988', '--token', 'dev', '--no-sample'],
    {
      cwd: serverDir,
      env: { ...process.env, VEDIT_DATA: tmpData, VEDIT_PYTHON: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let errBuf = '';
  child.stderr.on('data', (c) => (errBuf += c.toString()));
  try {
    let ok = false;
    for (let i = 0; i < 60; i++) {
      try {
        const h = await fetch('http://127.0.0.1:47988/api/v1/projects', {
          headers: { Authorization: 'Bearer dev' },
        });
        const ui = await fetch('http://127.0.0.1:47988/');
        if (h.status === 200 && ui.status === 200) {
          ok = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!ok) {
      throw new Error(`Packaged sidecar HTTP smoke check failed! stderr=${errBuf}`);
    }
    console.log('[prebuild] verified packaged sidecar HTTP API + UI bundle serves cleanly!');
  } finally {
    child.kill();
    try {
      fs.rmSync(tmpData, { recursive: true, force: true });
    } catch {}
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
