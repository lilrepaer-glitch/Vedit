// Vedit Self-Updater (Windows NSIS In-Place `/P /UPDATE /R` + GitHub Releases Check)

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const VEDIT_VERSION = "0.6.2";
export const GITHUB_RELEASES_API = "https://api.github.com/repos/lilrepaer-glitch/Vedit/releases/latest";

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseName: string;
  releaseUrl: string;
  downloadUrl: string | null;
  sizeBytes: number | null;
  publishedAt: string | null;
  notes: string;
}

/** Compares two semver strings (`a` vs `b`): returns `1` if `a > b`, `-1` if `a < b`, `0` if equal. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const clean = (v: string) =>
    v
      .trim()
      .replace(/^v/i, "")
      .split("-")[0]!
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const pa = clean(a);
  const pb = clean(b);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  const preA = a.includes("-");
  const preB = b.includes("-");
  if (!preA && preB) return 1;
  if (preA && !preB) return -1;
  return 0;
}

/** Queries GitHub Releases for the latest published `Vedit_installer.exe`. */
export async function checkForUpdates(currentVersion = VEDIT_VERSION): Promise<UpdateCheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let res: Response;
  try {
    res = await fetch(GITHUB_RELEASES_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `Vedit-Desktop/${currentVersion}`,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`Update check failed (${res.status} ${res.statusText})`);
  }

  const data = (await res.json()) as {
    tag_name?: string;
    name?: string;
    html_url?: string;
    published_at?: string;
    body?: string;
    assets?: Array<{ name: string; browser_download_url: string; size: number }>;
  };

  const latestVersion = (data.tag_name ?? currentVersion).replace(/^v/i, "");
  const exeAsset =
    data.assets?.find((a) => a.name === "Vedit_installer.exe") ??
    data.assets?.find((a) => a.name.toLowerCase().endsWith(".exe"));

  return {
    currentVersion,
    latestVersion,
    updateAvailable: compareSemver(latestVersion, currentVersion) > 0,
    releaseName: data.name ?? `Vedit v${latestVersion}`,
    releaseUrl: data.html_url ?? "https://github.com/lilrepaer-glitch/Vedit/releases/latest",
    downloadUrl: exeAsset?.browser_download_url ?? null,
    sizeBytes: exeAsset?.size ?? null,
    publishedAt: data.published_at ?? null,
    notes: data.body ?? "",
  };
}

/**
 * Downloads `Vedit_installer.exe` to OS temp directory and (on Windows) launches it
 * in passive in-place update + auto-relaunch mode (`/P /UPDATE /R`).
 */
export async function downloadAndInstallUpdate(opts: {
  downloadUrl?: string;
  autoLaunch?: boolean;
} = {}): Promise<{
  installerPath: string;
  sizeBytes: number;
  launched: boolean;
  latestVersion: string;
}> {
  const info = await checkForUpdates();
  const url = opts.downloadUrl ?? info.downloadUrl;
  if (!url) {
    throw new Error("No Vedit_installer.exe asset found in latest GitHub Release.");
  }

  const installerPath = join(tmpdir(), `Vedit_installer_${info.latestVersion}.exe`);
  const res = await fetch(url, {
    headers: { "User-Agent": `Vedit-Desktop/${VEDIT_VERSION}` },
    redirect: "follow",
  });
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download update installer (${res.status} ${res.statusText})`);
  }

  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(installerPath));
  const st = await stat(installerPath);
  if (st.size < 1_000_000) {
    throw new Error(`Downloaded installer appears incomplete (${st.size} bytes)`);
  }

  let launched = false;
  if (opts.autoLaunch !== false && process.platform === "win32") {
    const child = spawn(installerPath, ["/P", "/UPDATE", "/R"], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    launched = true;
    // Allow HTTP response to flush back to UI before exiting sidecar so installer can overwrite `node.exe` cleanly
    setTimeout(() => {
      process.exit(0);
    }, 600);
  }

  return {
    installerPath,
    sizeBytes: st.size,
    launched,
    latestVersion: info.latestVersion,
  };
}
