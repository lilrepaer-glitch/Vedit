#!/usr/bin/env node
/**
 * Vedit Studio Native Android APK Builder (v0.7.0 — com.vedit.studio)
 *
 * Compiles a 100% standalone, zero-server Android APK using the official Google Android
 * toolchain (`aapt2`, `javac`, `d8.jar`, 4-byte `zipalign`, and `apksigner.jar` v1+v2+v3):
 *   1. Builds the production Vedit Studio frontend (`apps/desktop/dist`).
 *   2. Generates multi-density Android launcher icons (`mdpi`..`xxxhdpi`) from `icons-src/vedit.png`.
 *   3. Compiles Android resources & manifest against `android-34/android.jar` via `aapt2`.
 *   4. Compiles `MainActivity.java` + generated `R.java` via `javac` -> `d8.jar` -> `classes.dex`.
 *   5. Packs all entries into a strict 4-byte-aligned ZIP (`resources.arsc` uncompressed & 4-byte aligned,
 *      mandatory on Android 11–15 / API 30–35).
 *   6. Signs with RSA-2048 keystore via Google `apksigner.jar` (v1 + v2 + v3 schemes) and verifies
 *      cryptographic integrity with `apksigner verify --verbose`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const ANDROID_DIR = path.join(ROOT, "apps", "android");
const BUILD_DIR = path.join(ANDROID_DIR, "build");
const RES_DIR = path.join(ANDROID_DIR, "res");
const DIST_DIR = path.join(ROOT, "apps", "desktop", "dist");
const OUT_APK = path.join(ROOT, "releases", "Vedit.apk");
const KEYSTORE_PATH = path.join(ANDROID_DIR, "vedit-release.p12");
const KEY_ALIAS = "veditrelease";
const KEY_PASS = "vedit-studio-android-2026";

function resolveJavaHome() {
  if (process.env.JAVA_HOME && fs.existsSync(path.join(process.env.JAVA_HOME, "bin", "java"))) {
    return process.env.JAVA_HOME;
  }
  const pyJdk = "/tmp/apk-env/bin/python";
  if (fs.existsSync(pyJdk)) {
    const out = execFileSync(pyJdk, ["-c", "import jdk4py; print(jdk4py.JAVA_HOME)"], {
      encoding: "utf8",
    }).trim();
    if (fs.existsSync(path.join(out, "bin", "java"))) return out;
  }
  throw new Error("JAVA_HOME with java runtime not found.");
}

function findEcjJar() {
  const pluginsDir = "/tmp/apk-tools/node_modules/@vscjava/java-language-server/server/plugins";
  if (fs.existsSync(pluginsDir)) {
    const hit = fs
      .readdirSync(pluginsDir)
      .find((f) => f.startsWith("org.eclipse.jdt.core.compiler.batch_") && f.endsWith(".jar"));
    if (hit) return path.join(pluginsDir, hit);
  }
  return null;
}

function compileJavaSources(javaHome, args) {
  const javacBin = path.join(javaHome, "bin", "javac");
  if (fs.existsSync(javacBin)) {
    execFileSync(javacBin, args, { stdio: "inherit" });
    return;
  }
  const javaBin = path.join(javaHome, "bin", "java");
  const ecjJar = findEcjJar();
  if (ecjJar) {
    execFileSync(javaBin, ["-jar", ecjJar, ...args], { stdio: "inherit" });
    return;
  }
  const toolsJar = "/tmp/apk-tools/node_modules/dataslope-tools-jar/tools.jar";
  if (fs.existsSync(toolsJar)) {
    execFileSync(javaBin, ["-cp", toolsJar, "com.sun.tools.javac.Main", ...args], { stdio: "inherit" });
    return;
  }
  throw new Error("No Java compiler (javac or ecj) found.");
}

function resolveAndroidTools() {
  const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || "/tmp/apk-tools";
  const candidates = {
    aapt2: [
      process.env.AAPT2_BIN,
      "/tmp/apk-tools/node_modules/aaptjs3/bin/x64/linux/aapt2",
      path.join(sdkRoot, "build-tools", "34.0.0", "aapt2"),
    ],
    androidJar: [
      process.env.ANDROID_JAR,
      path.join(sdkRoot, "platforms", "android-34", "android.jar"),
      "/tmp/apk-tools/platforms/android-34/android.jar",
    ],
    d8Jar: [
      process.env.D8_JAR,
      "/tmp/apk-tools/h2apk/tools/d8.jar",
      "/tmp/apk-tools/node_modules/d8-termux/d8.jar",
      path.join(sdkRoot, "build-tools", "34.0.0", "lib", "d8.jar"),
    ],
    apksignerJar: [
      process.env.APKSIGNER_JAR,
      "/tmp/apk-tools/node_modules/@postar/apktool-node/lib/apksigner.jar",
      path.join(sdkRoot, "build-tools", "34.0.0", "lib", "apksigner.jar"),
    ],
  };
  const pick = (label, list) => {
    const hit = list.find((p) => p && fs.existsSync(p));
    if (!hit) throw new Error(`Missing required Android tool (${label}). Checked: ${list.filter(Boolean).join(", ")}`);
    return hit;
  };
  return {
    aapt2: pick("aapt2", candidates.aapt2),
    androidJar: pick("android.jar", candidates.androidJar),
    d8Jar: pick("d8.jar", candidates.d8Jar),
    apksignerJar: pick("apksigner.jar", candidates.apksignerJar),
  };
}

// CRC-32 lookup table for deterministic ZIP / APK packaging with exact 4-byte zipalign
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const UNCOMPRESSED_EXTS = new Set([
  ".arsc",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".mp4",
  ".webm",
  ".mp3",
  ".m4a",
  ".ogg",
  ".wav",
  ".woff2",
]);

/**
 * Extract entries from an uncompressed/deflated ZIP archive produced by `aapt2 link`.
 */
function readZipEntries(zipBuffer) {
  // Locate End of Central Directory (0x06054b50)
  let eocdOffset = -1;
  for (let i = zipBuffer.length - 22; i >= Math.max(0, zipBuffer.length - 65557); i--) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("Invalid base APK ZIP: EOCD not found");
  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  const entries = [];
  let ptr = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (zipBuffer.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error(`Invalid Central Directory header at ${ptr}`);
    }
    const method = zipBuffer.readUInt16LE(ptr + 10);
    const compSize = zipBuffer.readUInt32LE(ptr + 20);
    const nameLen = zipBuffer.readUInt16LE(ptr + 28);
    const extraLen = zipBuffer.readUInt16LE(ptr + 30);
    const commentLen = zipBuffer.readUInt16LE(ptr + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(ptr + 42);
    const name = zipBuffer.subarray(ptr + 46, ptr + 46 + nameLen).toString("utf8");

    const localNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const rawComp = zipBuffer.subarray(dataStart, dataStart + compSize);
    const rawData = method === 0 ? Buffer.from(rawComp) : zlib.inflateRawSync(rawComp);

    entries.push({ name, data: rawData });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Write a strict Android-compliant 4-byte-aligned ZIP archive (`zipalign -f 4` equivalent).
 * Every uncompressed entry (`resources.arsc`, `.png`, `.jpg`, media) starts at an exact
 * multiple of 4 bytes inside the output file!
 */
function writeAlignedApkZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const raw = entry.data;
    const crc = crc32(raw);
    const ext = path.extname(entry.name).toLowerCase();
    const storeUncompressed = entry.name === "resources.arsc" || UNCOMPRESSED_EXTS.has(ext);

    let payload = raw;
    let method = 0;
    if (!storeUncompressed) {
      const deflated = zlib.deflateRawSync(raw, { level: 9 });
      if (deflated.length < raw.length) {
        payload = deflated;
        method = 8;
      }
    }

    // Compute exact padding needed in local extra field so data starts on a 4-byte boundary!
    let extraBuf = Buffer.alloc(0);
    if (method === 0) {
      const unalignedDataOffset = offset + 30 + nameBuf.length;
      const align = entry.name === "resources.arsc" ? 4 : 4;
      const rem = unalignedDataOffset % align;
      if (rem !== 0) {
        const padBytes = align - rem;
        extraBuf = Buffer.alloc(padBytes, 0);
      }
    }

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // Local File Header signature
    lfh.writeUInt16LE(20, 4); // Version needed (2.0)
    lfh.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0x0000, 10); // Fixed DOS time (deterministic reproducible APK!)
    lfh.writeUInt16LE(0x554b, 12); // Fixed DOS date
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(payload.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(extraBuf.length, 28);

    const localOffset = offset;
    const dataOffset = localOffset + 30 + nameBuf.length + extraBuf.length;
    if (method === 0 && dataOffset % 4 !== 0) {
      throw new Error(`Alignment assertion failed for ${entry.name}: dataOffset=${dataOffset}`);
    }

    localChunks.push(lfh, nameBuf, extraBuf, payload);
    offset = dataOffset + payload.length;

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); // Central Directory signature
    cdh.writeUInt16LE(20, 4); // Version made by
    cdh.writeUInt16LE(20, 6); // Version needed
    cdh.writeUInt16LE(0x0800, 8); // UTF-8 flag
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0x0000, 12);
    cdh.writeUInt16LE(0x554b, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(payload.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(localOffset, 42);

    centralChunks.push(cdh, nameBuf);
  }

  const cdStart = offset;
  const cdBuf = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, cdBuf, eocd]);
}

function collectFilesRecursive(dir, prefix = "") {
  const out = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, item.name);
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) out.push(...collectFilesRecursive(full, rel));
    else out.push({ full, rel });
  }
  return out;
}

function generateLauncherIcons() {
  const androidIconsSrc = path.join(ROOT, "apps", "desktop", "src-tauri", "icons", "android");
  if (!fs.existsSync(androidIconsSrc)) {
    throw new Error(`Missing Android launcher icons directory: ${androidIconsSrc}`);
  }
  for (const folder of ["mipmap-mdpi", "mipmap-hdpi", "mipmap-xhdpi", "mipmap-xxhdpi", "mipmap-xxxhdpi"]) {
    const srcDir = path.join(androidIconsSrc, folder);
    const dstDir = path.join(RES_DIR, folder);
    fs.mkdirSync(dstDir, { recursive: true });
    for (const file of fs.readdirSync(srcDir)) {
      if (file.endsWith(".png")) {
        fs.copyFileSync(path.join(srcDir, file), path.join(dstDir, file));
      }
    }
  }
}

async function main() {
  const javaHome = resolveJavaHome();
  const javaBin = path.join(javaHome, "bin", "java");
  const keytoolBin = path.join(javaHome, "bin", "keytool");
  const tools = resolveAndroidTools();

  console.log("▶ [1/6] Building standalone Vedit Studio frontend bundle…");
  execFileSync("npm", ["--prefix", path.join(ROOT, "apps", "desktop"), "run", "build"], {
    cwd: ROOT,
    stdio: "inherit",
  });

  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  console.log("▶ [2/6] Copying multi-density Android launcher icons…");
  generateLauncherIcons();

  const compiledResZip = path.join(BUILD_DIR, "compiled-res.zip");
  const baseUnsignedApk = path.join(BUILD_DIR, "base-unsigned.apk");
  const genJavaDir = path.join(BUILD_DIR, "gen");
  const classesDir = path.join(BUILD_DIR, "classes");
  const dexDir = path.join(BUILD_DIR, "dex");
  const alignedUnsignedApk = path.join(BUILD_DIR, "aligned-unsigned.apk");
  for (const d of [genJavaDir, classesDir, dexDir, path.dirname(OUT_APK)]) {
    fs.mkdirSync(d, { recursive: true });
  }

  console.log("▶ [3/6] Compiling Android resources & binary AndroidManifest.xml with Google aapt2…");
  execFileSync(tools.aapt2, ["compile", "--dir", RES_DIR, "-o", compiledResZip], { stdio: "inherit" });
  execFileSync(
    tools.aapt2,
    [
      "link",
      "-I",
      tools.androidJar,
      "--manifest",
      path.join(ANDROID_DIR, "AndroidManifest.xml"),
      "-R",
      compiledResZip,
      "--java",
      genJavaDir,
      "--auto-add-overlay",
      "-o",
      baseUnsignedApk,
    ],
    { stdio: "inherit" },
  );

  console.log("▶ [4/6] Compiling Java native shell (MainActivity.java) → Dalvik/ART classes.dex…");
  const javaSources = [
    ...collectFilesRecursive(path.join(ANDROID_DIR, "src")).map((f) => f.full),
    ...collectFilesRecursive(genJavaDir).map((f) => f.full),
  ].filter((f) => f.endsWith(".java"));

  compileJavaSources(javaHome, [
    "-encoding",
    "UTF-8",
    "-source",
    "8",
    "-target",
    "8",
    "-bootclasspath",
    tools.androidJar,
    "-classpath",
    tools.androidJar,
    "-d",
    classesDir,
    ...javaSources,
  ]);

  const classFiles = collectFilesRecursive(classesDir)
    .map((f) => f.full)
    .filter((f) => f.endsWith(".class"));

  execFileSync(
    javaBin,
    [
      "-cp",
      tools.d8Jar,
      "com.android.tools.r8.D8",
      "--release",
      "--min-api",
      "26",
      "--lib",
      tools.androidJar,
      "--output",
      dexDir,
      ...classFiles,
    ],
    { stdio: "inherit" },
  );

  const classesDex = path.join(dexDir, "classes.dex");
  if (!fs.existsSync(classesDex)) throw new Error("D8 failed to emit classes.dex");

  console.log("▶ [5/6] Packing 4-byte-aligned APK with uncompressed resources.arsc & embedded Vedit Studio bundle…");
  const baseEntries = readZipEntries(fs.readFileSync(baseUnsignedApk));
  const distEntries = collectFilesRecursive(DIST_DIR).map((f) => ({
    name: `assets/public/${f.rel}`,
    data: fs.readFileSync(f.full),
  }));

  const allEntries = [
    ...baseEntries,
    { name: "classes.dex", data: fs.readFileSync(classesDex) },
    ...distEntries,
  ];
  const alignedBuf = writeAlignedApkZip(allEntries);
  fs.writeFileSync(alignedUnsignedApk, alignedBuf);

  console.log("▶ [6/6] Signing Vedit.apk (APK Signature Scheme v1 + v2 + v3) & running apksigner verification…");
  if (!fs.existsSync(KEYSTORE_PATH)) {
    execFileSync(
      keytoolBin,
      [
        "-genkeypair",
        "-keystore",
        KEYSTORE_PATH,
        "-storetype",
        "PKCS12",
        "-alias",
        KEY_ALIAS,
        "-keyalg",
        "RSA",
        "-keysize",
        "2048",
        "-validity",
        "10000",
        "-storepass",
        KEY_PASS,
        "-keypass",
        KEY_PASS,
        "-dname",
        "CN=Vedit Studio, OU=Mobile Engineering, O=Vedit, L=Prague, C=CZ",
      ],
      { stdio: "inherit" },
    );
  }

  execFileSync(
    javaBin,
    [
      "-jar",
      tools.apksignerJar,
      "sign",
      "--ks",
      KEYSTORE_PATH,
      "--ks-key-alias",
      KEY_ALIAS,
      "--ks-pass",
      `pass:${KEY_PASS}`,
      "--key-pass",
      `pass:${KEY_PASS}`,
      "--min-sdk-version",
      "21",
      "--v1-signing-enabled",
      "true",
      "--v2-signing-enabled",
      "true",
      "--v3-signing-enabled",
      "true",
      "--out",
      OUT_APK,
      alignedUnsignedApk,
    ],
    { stdio: "inherit" },
  );

  const verifyOut = execFileSync(
    javaBin,
    ["-jar", tools.apksignerJar, "verify", "--verbose", "--print-certs", OUT_APK],
    { encoding: "utf8" },
  );
  console.log(verifyOut.trim());

  const stat = fs.statSync(OUT_APK);
  console.log(`\n✅ Built & verified native Android APK: ${OUT_APK} (${(stat.size / (1024 * 1024)).toFixed(2)} MB)`);
}

main().catch((err) => {
  console.error("❌ APK build failed:", err);
  process.exit(1);
});
