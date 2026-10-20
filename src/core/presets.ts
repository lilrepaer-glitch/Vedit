// Animation presets (PLAN.md §3.3) and caption export helpers

import type { Caption, Clip, Keyframe } from "./types.js";

export interface AnimationPreset {
  id: string;
  label: string;
  description: string;
  build: (clip: Clip) => Keyframe[];
}

const fade = (property: string, from: number, to: number, over: number): Keyframe[] => [
  { time: 0, property, value: from, easing: "ease-out" },
  { time: Math.min(over, 0.5), property, value: to, easing: "ease-out" },
];

export const ANIMATION_PRESETS: Record<string, AnimationPreset> = {
  "fade-in": {
    id: "fade-in",
    label: "Fade in",
    description: "Opacity 0 → 1 over 0.5s",
    build: () => fade("opacity", 0, 1, 0.5),
  },
  "fade-out": {
    id: "fade-out",
    label: "Fade out",
    description: "Opacity 1 → 0 in the last 0.5s",
    build: (clip) => {
      const t = Math.max(0, clip.duration - 0.5);
      return [
        { time: 0, property: "opacity", value: 1 },
        { time: t, property: "opacity", value: 1, easing: "ease-in" },
        { time: clip.duration, property: "opacity", value: 0, easing: "ease-in" },
      ];
    },
  },
  "slide-in-left": {
    id: "slide-in-left",
    label: "Slide in from left",
    description: "X -200 → 0 with fade",
    build: () => [
      { time: 0, property: "x", value: -200, easing: "ease-out" },
      { time: 0.5, property: "x", value: 0, easing: "ease-out" },
      { time: 0, property: "opacity", value: 0 },
      { time: 0.3, property: "opacity", value: 1 },
    ],
  },
  "slide-in-right": {
    id: "slide-in-right",
    label: "Slide in from right",
    description: "X 200 → 0 with fade",
    build: () => [
      { time: 0, property: "x", value: 200, easing: "ease-out" },
      { time: 0.5, property: "x", value: 0, easing: "ease-out" },
      { time: 0, property: "opacity", value: 0 },
      { time: 0.3, property: "opacity", value: 1 },
    ],
  },
  "slide-in-up": {
    id: "slide-in-up",
    label: "Slide in from bottom",
    description: "Y 120 → 0 with fade",
    build: () => [
      { time: 0, property: "y", value: 120, easing: "ease-out" },
      { time: 0.5, property: "y", value: 0, easing: "ease-out" },
      { time: 0, property: "opacity", value: 0 },
      { time: 0.3, property: "opacity", value: 1 },
    ],
  },
  "pop-in": {
    id: "pop-in",
    label: "Pop in",
    description: "Scale 0.5 → 1 with overshoot",
    build: () => [
      { time: 0, property: "scaleX", value: 0.5, easing: "ease-out" },
      { time: 0, property: "scaleY", value: 0.5, easing: "ease-out" },
      { time: 0.35, property: "scaleX", value: 1.08, easing: "ease-out" },
      { time: 0.35, property: "scaleY", value: 1.08, easing: "ease-out" },
      { time: 0.5, property: "scaleX", value: 1, easing: "ease-in-out" },
      { time: 0.5, property: "scaleY", value: 1, easing: "ease-in-out" },
      { time: 0, property: "opacity", value: 0 },
      { time: 0.2, property: "opacity", value: 1 },
    ],
  },
  "zoom-in": {
    id: "zoom-in",
    label: "Zoom in",
    description: "Slow scale 1 → 1.15",
    build: (clip) => [
      { time: 0, property: "scaleX", value: 1, easing: "linear" },
      { time: 0, property: "scaleY", value: 1, easing: "linear" },
      { time: clip.duration, property: "scaleX", value: 1.15, easing: "linear" },
      { time: clip.duration, property: "scaleY", value: 1.15, easing: "linear" },
    ],
  },
  "spin-in": {
    id: "spin-in",
    label: "Spin in",
    description: "Rotation -15° → 0 with fade",
    build: () => [
      { time: 0, property: "rotation", value: -15, easing: "ease-out" },
      { time: 0.5, property: "rotation", value: 0, easing: "ease-out" },
      { time: 0, property: "opacity", value: 0 },
      { time: 0.3, property: "opacity", value: 1 },
    ],
  },
};

export function listAnimationPresets(): Array<{ id: string; label: string; description: string }> {
  return Object.values(ANIMATION_PRESETS).map(({ id, label, description }) => ({
    id,
    label,
    description,
  }));
}

/** SRT export (PLAN.md §3.2) */
export function formatSrtTime(t: number): string {
  const clamped = Math.max(0, t);
  const ms = Math.round(clamped * 1000);
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

export function captionsToSrt(captions: Caption[]): string {
  const sorted = [...captions].sort((a, b) => a.start - b.start);
  return (
    sorted
      .map((c, i) => `${i + 1}\n${formatSrtTime(c.start)} --> ${formatSrtTime(c.end)}\n${c.text}\n`)
      .join("\n") + "\n"
  );
}
