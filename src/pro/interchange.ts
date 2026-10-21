// F8: Professional Studio NLE Interchange — CMX 3600 EDL & Final Cut Pro / DaVinci Resolve FCPXML v1.10

import { sequenceDuration, type Project } from "../core/types.js";

function toSmpteTimecode(seconds: number, fps: number): string {
  const rate = Math.max(1, Math.round(fps || 30));
  const totalFrames = Math.max(0, Math.round(seconds * rate));
  const ff = totalFrames % rate;
  const totalSec = Math.floor(totalFrames / rate);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Exports active sequence as a standards-compliant CMX 3600 `.edl` file for DaVinci Resolve / Premiere / Avid. */
export function exportEdl(project: Project): string {
  const seq = project.sequences.find((s) => s.id === project.activeSequenceId) ?? project.sequences[0]!;
  const fps = seq.fps || 30;
  const lines: string[] = [
    `TITLE: ${project.name.toUpperCase().slice(0, 60)}`,
    "FCM: NON-DROP FRAME",
    "",
  ];

  let eventNum = 1;
  for (const track of seq.tracks) {
    if (track.muted) continue;
    const chan = track.kind === "audio" ? "AA  " : "V   ";
    for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) {
      const asset = project.assets.find((a) => a.id === clip.assetId);
      const reel = (asset?.name ?? "AX")
        .replace(/[^A-Za-z0-9]/g, "")
        .toUpperCase()
        .slice(0, 8)
        .padEnd(8, " ");
      const num = String(eventNum++).padStart(3, "0");
      const srcIn = toSmpteTimecode(clip.in, fps);
      const srcOut = toSmpteTimecode(clip.in + clip.duration, fps);
      const recIn = toSmpteTimecode(clip.start, fps);
      const recOut = toSmpteTimecode(clip.start + clip.duration, fps);
      lines.push(`${num}  ${reel} ${chan}  C        ${srcIn} ${srcOut} ${recIn} ${recOut}`);
      lines.push(`* FROM CLIP NAME: ${clip.name}`);
      if (asset?.path) lines.push(`* SOURCE FILE: ${asset.path}`);
      lines.push("");
    }
  }

  for (const m of project.markers ?? []) {
    lines.push(`* LOC: ${toSmpteTimecode(m.time, fps)} BLUE    ${m.label}`);
  }
  return `${lines.join("\n")}\n`;
}

function rationalSeconds(seconds: number, fps: number): string {
  const rate = Math.max(1, Math.round(fps || 30));
  const frames = Math.max(0, Math.round(seconds * rate));
  return `${frames * 100}/${rate * 100}s`;
}

/** Exports active sequence as Final Cut Pro / DaVinci Resolve FCPXML v1.10 (`.fcpxml`). */
export function exportFcpXml(project: Project): string {
  const seq = project.sequences.find((s) => s.id === project.activeSequenceId) ?? project.sequences[0]!;
  const fps = seq.fps || 30;
  const totalDur = rationalSeconds(Math.max(1, sequenceDuration(seq)), fps);

  const assetXml = project.assets
    .map((a, idx) => {
      const dur = rationalSeconds(a.duration ?? 10, fps);
      const fileUri = a.path.startsWith("/") ? `file://${escapeXml(a.path)}` : `file:///${escapeXml(a.path.replace(/\\/g, "/"))}`;
      return `    <asset id="r${idx + 2}" name="${escapeXml(a.name)}" start="0s" duration="${dur}" hasVideo="${a.kind !== "audio" ? 1 : 0}" hasAudio="${a.hasAudio !== false ? 1 : 0}">
      <media-rep kind="original-media" src="${fileUri}"/>
    </asset>`;
    })
    .join("\n");

  const assetRefMap = new Map(project.assets.map((a, idx) => [a.id, `r${idx + 2}`]));

  const clipItems: string[] = [];
  seq.tracks.forEach((track, tIdx) => {
    if (track.muted) return;
    for (const clip of [...track.clips].sort((a, b) => a.start - b.start)) {
      const ref = assetRefMap.get(clip.assetId);
      if (!ref) continue;
      const laneAttr = tIdx > 0 ? ` lane="${tIdx}"` : "";
      clipItems.push(
        `            <asset-clip name="${escapeXml(clip.name)}" ref="${ref}"${laneAttr} offset="${rationalSeconds(clip.start, fps)}" start="${rationalSeconds(clip.in, fps)}" duration="${rationalSeconds(clip.duration, fps)}"/>`,
      );
    }
  });

  for (const cap of seq.captions) {
    clipItems.push(
      `            <title name="${escapeXml(cap.text)}" offset="${rationalSeconds(cap.start, fps)}" duration="${rationalSeconds(Math.max(0.1, cap.end - cap.start), fps)}"/>`,
    );
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="r1" name="FFVideoFormat${seq.height}p${Math.round(fps)}" frameDuration="${rationalSeconds(1 / fps, fps)}" width="${seq.width}" height="${seq.height}"/>
${assetXml}
  </resources>
  <library>
    <event name="${escapeXml(project.name)}">
      <project name="${escapeXml(seq.name)}">
        <sequence format="r1" duration="${totalDur}" tcStart="0s" tcFormat="NDF">
          <spine>
${clipItems.join("\n")}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}
