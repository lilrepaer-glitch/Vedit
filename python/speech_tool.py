#!/usr/bin/env python3
"""Vedit speech sidecar — TTS (espeak-ng) + ASR (pocketsphinx).

Používá se z Node vrstvy (src/ai/speech.ts). Výstupy jsou JSON na stdout.

  probe                                     → {"espeak": true, "pocketsphinx": true, "sampleRate": 22050}
  tts --text ... --voice cs --out x.wav     → {"sampleRate", "duration", "path"}
  tts-script --script-file s.txt --outdir d → {"phrases": [{text,start,end}], "wav", "sampleRate", "totalDuration"}
  asr --audio a.wav [--max-words 8]         → {"text", "segments": [{text,start,end}]}
"""

import argparse
import ctypes
import json
import os
import re
import sys
import wave


# ---------------------------------------------------------------- espeak-ng

def _load_espeak():
    import espeakng_loader

    lib = ctypes.CDLL(espeakng_loader.get_library_path())
    lib.espeak_Initialize.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
    lib.espeak_Initialize.restype = ctypes.c_int
    lib.espeak_SetSynthCallback.argtypes = [ctypes.c_void_p]
    lib.espeak_SetVoiceByName.argtypes = [ctypes.c_char_p]
    lib.espeak_SetVoiceByName.restype = ctypes.c_int
    lib.espeak_SetParameter.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int]
    lib.espeak_Synth.argtypes = [
        ctypes.c_char_p, ctypes.c_size_t, ctypes.c_uint, ctypes.c_int,
        ctypes.c_uint, ctypes.c_uint, ctypes.POINTER(ctypes.c_uint), ctypes.c_void_p,
    ]
    return lib, espeakng_loader.get_data_path()


class Espeak:
    """Synchronní syntéza přes espeak-ng C API (callback sbírá PCM)."""

    RATE = None

    def __init__(self):
        self._lib, data_path = _load_espeak()
        self._buf = []
        self._cb_type = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p)

        def _cb(wav, numsamples, events):
            if wav and numsamples > 0:
                self._buf.append(ctypes.string_at(wav, numsamples * 2))
            return 0

        self._cb = self._cb_type(_cb)
        # AUDIO_OUTPUT_SYNCHRONOUS = 0x0002
        Espeak.RATE = self._lib.espeak_Initialize(0x0002, 0, data_path.encode(), 0)
        self._lib.espeak_SetSynthCallback(self._cb)

    @property
    def sample_rate(self):
        return Espeak.RATE or 22050

    def synth(self, text, voice="cs", rate=175, pitch=50):
        """Vrátí PCM 16-bit mono pro zadaný text."""
        if self._lib.espeak_SetVoiceByName(voice.encode()) != 0:
            self._lib.espeak_SetVoiceByName(b"en")
        self._lib.espeak_SetParameter(1, int(rate), 0)   # espeakRATE
        self._lib.espeak_SetParameter(3, int(pitch), 0)  # espeakPITCH
        self._buf = []
        raw = text.encode("utf-8")
        marker = ctypes.c_uint(0)
        # CHARS_UTF8 = 0x0010
        rc = self._lib.espeak_Synth(raw, len(raw) + 1, 0, 0, 0, 0x0002 | 0x0010, ctypes.byref(marker), None)
        if rc != 0:
            raise RuntimeError(f"espeak_Synth selhal ({rc})")
        return b"".join(self._buf)


_ESPEAK = None


def espeak():
    global _ESPEAK
    if _ESPEAK is None:
        _ESPEAK = Espeak()
    return _ESPEAK


def write_wav(path, pcm, sample_rate):
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)


# ---------------------------------------------------------------- příkazy

def cmd_probe(_args):
    espeak_ok = False
    ps_ok = False
    rate = 22050
    try:
        rate = espeak().sample_rate
        espeak_ok = True
    except Exception:
        pass
    try:
        import pocketsphinx  # noqa: F401
        ps_ok = True
    except Exception:
        pass
    print(json.dumps({"espeak": espeak_ok, "pocketsphinx": ps_ok, "sampleRate": rate}))


def cmd_tts(args):
    eng = espeak()
    pcm = eng.synth(args.text, voice=args.voice, rate=args.rate, pitch=args.pitch)
    write_wav(args.out, pcm, eng.sample_rate)
    dur = len(pcm) / 2 / eng.sample_rate
    print(json.dumps({"sampleRate": eng.sample_rate, "duration": round(dur, 3), "path": args.out}))


def split_phrases(script):
    """Věta = fráze pro titulek; dlouhé věty se dělí na čárkách."""
    phrases = []
    for line in script.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = re.split(r"(?<=[.!?…])\s+", line)
        for part in parts:
            part = part.strip()
            if not part:
                continue
            if len(part) <= 100:
                phrases.append(part)
            else:
                chunks = re.split(r"(?<=[,;:])\s+", part)
                buf = ""
                for c in chunks:
                    if buf and len(buf) + len(c) + 1 > 100:
                        phrases.append(buf)
                        buf = c
                    else:
                        buf = f"{buf} {c}".strip()
                if buf:
                    phrases.append(buf)
    return phrases


def cmd_tts_script(args):
    with open(args.script_file, encoding="utf-8") as f:
        script = f.read()
    phrases = split_phrases(script)
    if not phrases:
        raise SystemExit("skript neobsahuje žádný text")
    eng = espeak()
    rate = eng.sample_rate
    gap_pcm = b"\x00\x00" * int(rate * args.gap)
    outdir = args.outdir
    os.makedirs(outdir, exist_ok=True)
    combined = []
    meta = []
    t = 0.0
    for i, text in enumerate(phrases):
        pcm = eng.synth(text, voice=args.voice, rate=args.rate, pitch=args.pitch)
        dur = len(pcm) / 2 / rate
        chunk_path = os.path.join(outdir, f"chunk_{i:03d}.wav")
        write_wav(chunk_path, pcm, rate)
        meta.append({"index": i, "text": text, "start": round(t, 3), "end": round(t + dur, 3), "path": chunk_path})
        combined.append(pcm)
        combined.append(gap_pcm)
        t += dur + args.gap
    total = max(0.0, t - args.gap) if phrases else 0.0
    wav_path = os.path.join(outdir, "voiceover.wav")
    write_wav(wav_path, b"".join(combined), rate)
    print(json.dumps({
        "phrases": meta,
        "wav": wav_path,
        "sampleRate": rate,
        "totalDuration": round(total, 3),
        "voice": args.voice,
    }))


def cmd_asr(args):
    try:
        from pocketsphinx import AudioFile
    except Exception:
        print(json.dumps({"error": "pocketsphinx není nainstalovaný"}))
        raise SystemExit(2)
    audio = AudioFile(audio_file=args.audio)
    words = []  # (text, start_s, end_s)
    hyp = ""
    for utt in audio:
        hyp = utt.hypothesis() or ""
        for s in utt.seg():
            w = (s.word or "").strip()
            if not w or w in ("<s>", "</s>", "<sil>", "+SPN+", "+NSN+"):
                continue
            w = re.sub(r"\(\d+\)$", "", w)  # that(2) → that
            if not w:
                continue
            words.append((w, s.start_frame * 0.01, s.end_frame * 0.01))
    # seskupení slov do frází (titulků): hranice = ticho > 0.35s nebo max 8 slov
    segments = []
    cur = []
    for w, st, en in words:
        if cur and (st - cur[-1][2] > 0.35 or len(cur) >= args.max_words):
            segments.append(cur)
            cur = []
        cur.append((w, st, en))
    if cur:
        segments.append(cur)
    out = []
    for seg in segments:
        text = " ".join(w for w, _, _ in seg)
        out.append({"text": text, "start": round(seg[0][1], 2), "end": round(seg[-1][2], 2)})
    print(json.dumps({"text": hyp, "segments": out, "engine": "pocketsphinx", "language": args.language}))


def main():
    p = argparse.ArgumentParser(prog="vedit-speech")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("probe")

    t = sub.add_parser("tts")
    t.add_argument("--text", required=True)
    t.add_argument("--voice", default="cs")
    t.add_argument("--rate", type=int, default=175)
    t.add_argument("--pitch", type=int, default=50)
    t.add_argument("--out", required=True)

    ts = sub.add_parser("tts-script")
    ts.add_argument("--script-file", required=True)
    ts.add_argument("--voice", default="cs")
    ts.add_argument("--rate", type=int, default=175)
    ts.add_argument("--pitch", type=int, default=50)
    ts.add_argument("--gap", type=float, default=0.35)
    ts.add_argument("--outdir", required=True)

    a = sub.add_parser("asr")
    a.add_argument("--audio", required=True)
    a.add_argument("--language", default="en")
    a.add_argument("--max-words", type=int, default=8)

    args = p.parse_args()
    {"probe": cmd_probe, "tts": cmd_tts, "tts-script": cmd_tts_script, "asr": cmd_asr}[args.cmd](args)


if __name__ == "__main__":
    main()
