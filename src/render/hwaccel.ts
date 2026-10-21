// F6: Hardware GPU Encoder Discovery & Selection (PLAN.md §1, §6, §8)
// Supports NVIDIA NVENC, AMD AMF, Intel QuickSync (QSV), Apple VideoToolbox, Linux VAAPI, and CPU fallback.

import { ffmpegPath, run } from "../core/media.js";
import type { VideoCodecId } from "./export.js";

export type HwAccelBackend = "auto" | "cpu" | "nvenc" | "amf" | "qsv" | "videotoolbox" | "vaapi";

export interface HardwareEncoderCandidate {
  encoder: string;
  codec: "h264" | "h265";
  backend: Exclude<HwAccelBackend, "auto" | "cpu">;
  label: string;
  compiled: boolean;
  usable: boolean;
}

const GPU_CANDIDATES: Array<{
  encoder: string;
  codec: "h264" | "h265";
  backend: Exclude<HwAccelBackend, "auto" | "cpu">;
  label: string;
}> = [
  { encoder: "h264_nvenc", codec: "h264", backend: "nvenc", label: "NVIDIA NVENC H.264" },
  { encoder: "hevc_nvenc", codec: "h265", backend: "nvenc", label: "NVIDIA NVENC H.265/HEVC" },
  { encoder: "h264_amf", codec: "h264", backend: "amf", label: "AMD AMF H.264" },
  { encoder: "hevc_amf", codec: "h265", backend: "amf", label: "AMD AMF H.265/HEVC" },
  { encoder: "h264_qsv", codec: "h264", backend: "qsv", label: "Intel QuickSync H.264" },
  { encoder: "hevc_qsv", codec: "h265", backend: "qsv", label: "Intel QuickSync H.265/HEVC" },
  { encoder: "h264_videotoolbox", codec: "h264", backend: "videotoolbox", label: "Apple VideoToolbox H.264" },
  { encoder: "hevc_videotoolbox", codec: "h265", backend: "videotoolbox", label: "Apple VideoToolbox H.265" },
  { encoder: "h264_vaapi", codec: "h264", backend: "vaapi", label: "VA-API H.264" },
  { encoder: "hevc_vaapi", codec: "h265", backend: "vaapi", label: "VA-API H.265" },
];

let cachedProbe: HardwareEncoderCandidate[] | null = null;

async function smokeTestEncoder(encoder: string): Promise<boolean> {
  const res = await run(ffmpegPath(), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=128x128:r=24",
    "-frames:v",
    "1",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    encoder,
    "-f",
    "null",
    "-",
  ]);
  return res.code === 0;
}

/**
 * Probes FFmpeg encoders compiled into the binary and verifies real GPU driver usability via a 1-frame encode test.
 */
export async function probeHardwareEncoders(forceRefresh = false): Promise<HardwareEncoderInfoReport> {
  if (!cachedProbe || forceRefresh) {
    const listRes = await run(ffmpegPath(), ["-hide_banner", "-encoders"]);
    const text = listRes.stdout.toString("utf-8");
    const results: HardwareEncoderCandidate[] = [];
    for (const c of GPU_CANDIDATES) {
      const compiled = new RegExp(`\\b${c.encoder}\\b`).test(text);
      const usable = compiled ? await smokeTestEncoder(c.encoder) : false;
      results.push({ ...c, compiled, usable });
    }
    cachedProbe = results;
  }

  const usableBackends = [...new Set(cachedProbe.filter((c) => c.usable).map((c) => c.backend))];
  return {
    recommendedBackend: usableBackends[0] ?? "cpu",
    usableBackends: ["cpu", ...usableBackends],
    encoders: cachedProbe,
  };
}

export interface HardwareEncoderInfoReport {
  recommendedBackend: Exclude<HwAccelBackend, "auto">;
  usableBackends: Array<Exclude<HwAccelBackend, "auto">>;
  encoders: HardwareEncoderCandidate[];
}

export interface ResolvedEncoderArgs {
  encoder: string;
  backend: Exclude<HwAccelBackend, "auto">;
  args: string[];
  fallbackReason?: string;
}

export async function resolveVideoEncoder(
  codec: VideoCodecId,
  hwAccel: HwAccelBackend = "cpu",
  fps: number,
  crf?: number,
  audioBitrate = "160k",
): Promise<ResolvedEncoderArgs> {
  if (codec === "gif") {
    return {
      encoder: "gif",
      backend: "cpu",
      args: ["-r", String(fps), "-loop", "0"],
    };
  }
  if (codec === "prores") {
    return {
      encoder: "prores_ks",
      backend: "cpu",
      args: [
        "-c:v", "prores_ks",
        "-profile:v", "2",
        "-pix_fmt", "yuv422p10le",
        "-r", String(fps),
        "-c:a", "pcm_s16le",
        "-ar", "48000",
      ],
    };
  }
  if (codec === "vp9") {
    return {
      encoder: "libvpx-vp9",
      backend: "cpu",
      args: [
        "-c:v", "libvpx-vp9",
        "-b:v", "0",
        "-crf", String(crf ?? 30),
        "-deadline", "realtime",
        "-cpu-used", "5",
        "-pix_fmt", "yuv420p",
        "-r", String(fps),
        "-ar", "48000",
        "-c:a", "libopus",
        "-b:a", audioBitrate,
      ],
    };
  }

  let fallbackReason: string | undefined;
  if (hwAccel !== "cpu") {
    const report = await probeHardwareEncoders();
    const match =
      hwAccel === "auto"
        ? report.encoders.find((e) => e.codec === codec && e.usable)
        : report.encoders.find((e) => e.codec === codec && e.backend === hwAccel && e.usable);
    if (match) {
      const tagArgs = codec === "h265" ? ["-tag:v", "hvc1"] : [];
      return {
        encoder: match.encoder,
        backend: match.backend,
        args: [
          "-c:v", match.encoder,
          ...tagArgs,
          "-pix_fmt", "yuv420p",
          "-r", String(fps),
          "-c:a", "aac",
          "-b:a", audioBitrate,
          "-movflags", "+faststart",
        ],
      };
    }
    if (hwAccel !== "auto") {
      fallbackReason = `Hardware encoder '${hwAccel}' for ${codec} is unavailable on this device — fell back to CPU software encoder`;
    }
  }

  if (codec === "h265") {
    return {
      encoder: "libx265",
      backend: "cpu",
      fallbackReason,
      args: [
        "-c:v", "libx265",
        "-preset", "veryfast",
        "-crf", String(crf ?? 22),
        "-tag:v", "hvc1",
        "-pix_fmt", "yuv420p",
        "-r", String(fps),
        "-c:a", "aac",
        "-b:a", audioBitrate,
        "-movflags", "+faststart",
      ],
    };
  }

  return {
    encoder: "libx264",
    backend: "cpu",
    fallbackReason,
    args: [
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", String(crf ?? 20),
      "-pix_fmt", "yuv420p",
      "-r", String(fps),
      "-c:a", "aac",
      "-b:a", audioBitrate,
      "-movflags", "+faststart",
    ],
  };
}
