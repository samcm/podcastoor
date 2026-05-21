#!/usr/bin/env python3
"""Align existing transcript segments to source audio with WhisperX.

This script intentionally does not transcribe. Podcastoor already owns the STT
step; WhisperX is used here only to tighten timestamps against the waveform.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="WhisperX forced alignment for Podcastoor")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--transcript-json", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--language", default="en")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--align-model", default=None)
    parser.add_argument("--segment-padding", type=float, default=20.0)
    parser.add_argument("--block-seconds", type=float, default=180.0)
    return parser.parse_args()


def as_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if parsed != parsed:
        return None
    return parsed


def token_count(text: str) -> int:
    return max(1, len(re.findall(r"[A-Za-z0-9']+", text)))


def build_alignment_blocks(input_segments: list[dict[str, Any]], padding: float, block_seconds: float, audio_duration: float) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    current: list[dict[str, Any]] = []

    def flush() -> None:
        if not current:
            return
        start = max(0.0, float(current[0]["start"]) - padding)
        end = min(audio_duration, max(start + 0.05, float(current[-1]["end"]) + padding))
        blocks.append(
            {
                "start": start,
                "end": end,
                "text": " ".join(str(segment["text"]) for segment in current),
            }
        )
        current.clear()

    for segment in input_segments:
        if current and float(segment["end"]) - float(current[0]["start"]) > block_seconds:
            flush()
        current.append(segment)
    flush()
    return blocks


def assign_indexes_by_text_sequence(words: list[dict[str, Any]], input_segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not words:
        return []
    counts = [(int(segment["_podcastoor_index"]), token_count(str(segment["text"]))) for segment in input_segments]
    segment_cursor = 0
    words_in_segment = 0
    assigned = []
    for word in words:
        segment_index, expected_count = counts[min(segment_cursor, len(counts) - 1)]
        item = {**word, "segmentIndex": segment_index}
        assigned.append(item)
        words_in_segment += 1
        if words_in_segment >= expected_count and segment_cursor < len(counts) - 1:
            segment_cursor += 1
            words_in_segment = 0
    return assigned


def main() -> int:
    args = parse_args()
    try:
        import whisperx  # type: ignore[import-not-found]
    except Exception as exc:
        print(f"whisperx import failed: {exc}", file=sys.stderr)
        return 2

    transcript = json.loads(Path(args.transcript_json).read_text())
    input_segments = []
    for index, segment in enumerate(transcript.get("segments", [])):
        start = as_float(segment.get("start"))
        end = as_float(segment.get("end"))
        text = str(segment.get("text") or "").strip()
        if start is None or end is None or end <= start or not text:
            continue
        input_segments.append({"start": start, "end": end, "text": text, "_podcastoor_index": index})

    if not input_segments:
        Path(args.output).write_text(json.dumps({"provider": "whisperx-local", "model": args.align_model or "whisperx", "words": []}))
        return 0

    try:
        model, metadata = whisperx.load_align_model(language_code=args.language, device=args.device, model_name=args.align_model)
        audio = whisperx.load_audio(args.audio)
        audio_duration = float(len(audio)) / 16000.0
        alignment_blocks = build_alignment_blocks(input_segments, max(0.0, args.segment_padding), max(30.0, args.block_seconds), audio_duration)
        aligned = whisperx.align(alignment_blocks, model, metadata, audio, args.device, return_char_alignments=False, print_progress=False)
    except Exception as exc:
        print(f"whisperx alignment failed: {exc}", file=sys.stderr)
        return 3

    words = []
    for segment in aligned.get("segments", []):
        for word in segment.get("words", []):
            start = as_float(word.get("start"))
            end = as_float(word.get("end"))
            text = str(word.get("word") or word.get("text") or "").strip()
            if start is None or end is None or end <= start or not text:
                continue
            item = {
                "text": text,
                "start": start,
                "end": end,
            }
            score = as_float(word.get("score", word.get("confidence")))
            if score is not None:
                item["confidence"] = max(0.0, min(1.0, score))
            words.append(item)
    words = assign_indexes_by_text_sequence(sorted(words, key=lambda item: item["start"]), input_segments)
    words_by_segment: dict[int, list[dict[str, Any]]] = {}
    for item in words:
        words_by_segment.setdefault(int(item["segmentIndex"]), []).append(item)
    input_text_by_index = {int(segment["_podcastoor_index"]): str(segment["text"]) for segment in input_segments}
    aligned_segments = [
        {
            "start": segment_words[0]["start"],
            "end": segment_words[-1]["end"],
            "text": input_text_by_index.get(index, ""),
            "segmentIndex": index,
            "words": segment_words,
        }
        for index, segment_words in sorted(words_by_segment.items())
    ]

    model_name = args.align_model or str(metadata.get("language", args.language))
    Path(args.output).write_text(
        json.dumps(
            {
                "provider": "whisperx-local",
                "model": f"whisperx:{model_name}",
                "segments": aligned_segments,
                "words": words,
                "notes": [
                    f"WhisperX aligned {len(words)} words across {len(aligned_segments)} transcript segments on {args.device}.",
                    f"Alignment used {len(alignment_blocks)} padded transcript blocks.",
                ],
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
