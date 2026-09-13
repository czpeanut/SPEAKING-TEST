#!/usr/bin/env python3
"""Persistent local TTS service used by server.js.

Loads each Piper voice once and keeps it in memory, so requests only pay for
inference (not model/tokenizer load time). Talks plain HTTP on 127.0.0.1 only
— server.js is the only client, nothing external reaches this port.
"""
import io
import os
import sys
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

from piper import PiperVoice
from piper.config import SynthesisConfig

VOICES_DIR = Path(__file__).parent / "voices"
PORT = int(os.environ.get("PIPER_SERVICE_PORT", "5001"))

_voice_cache = {}


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def get_voice(name, warm_up=False):
    if name not in _voice_cache:
        model_path = VOICES_DIR / f"{name}.onnx"
        config_path = VOICES_DIR / f"{name}.onnx.json"
        if not model_path.exists():
            raise FileNotFoundError(name)
        log(f"Loading voice '{name}'...")
        voice = PiperVoice.load(str(model_path), str(config_path))
        _voice_cache[name] = voice
        if warm_up:
            # Some phonemizers (e.g. Chinese g2pW + its BERT tokenizer) lazy-init
            # on the first real synthesize() call, not on load() — that first-call
            # cost is exactly what preloading is meant to avoid, so pay it now.
            log(f"Warming up '{name}'...")
            for _ in voice.synthesize("测试", SynthesisConfig()):
                pass
        log(f"Loaded voice '{name}'")
    return _voice_cache[name]


def synthesize_wav(voice, text, length_scale):
    syn_config = SynthesisConfig(length_scale=length_scale)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav_file:
        first = True
        for chunk in voice.synthesize(text, syn_config):
            if first:
                wav_file.setframerate(chunk.sample_rate)
                wav_file.setsampwidth(chunk.sample_width)
                wav_file.setnchannels(chunk.sample_channels)
                first = False
            wav_file.writeframes(chunk.audio_int16_bytes)
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/health":
            self._send(200, b"ok", "text/plain")
            return

        if parsed.path == "/synthesize":
            params = parse_qs(parsed.query)
            text = (params.get("text") or [""])[0]
            voice_name = (params.get("voice") or [""])[0]
            try:
                length_scale = float((params.get("length_scale") or ["1.0"])[0])
            except ValueError:
                length_scale = 1.0

            if not text.strip():
                self._send(400, b"missing text", "text/plain")
                return

            try:
                voice = get_voice(voice_name)
            except FileNotFoundError:
                self._send(404, f"voice not found: {voice_name}".encode(), "text/plain")
                return

            try:
                data = synthesize_wav(voice, text, length_scale)
            except Exception as exc:  # noqa: BLE001
                log(f"synthesis error: {exc}")
                self._send(500, str(exc).encode(), "text/plain")
                return

            self._send(200, data, "audio/wav")
            return

        self._send(404, b"not found", "text/plain")

    def _send(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    preload = [v.strip() for v in os.environ.get("PIPER_PRELOAD_VOICES", "").split(",") if v.strip()]
    for name in preload:
        try:
            get_voice(name, warm_up=True)
        except FileNotFoundError:
            log(f"WARNING: preload voice not found: {name}")

    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log(f"READY 127.0.0.1:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
