# Methodology Evaluation

Checked and exercised on 2026-05-06.

## Methods Considered

| Method | API Cost | Timestamp Quality | Result |
| --- | ---: | --- | --- |
| Metadata/description keywords | $0 | None | Useful as hints only; too lossy to cut audio. |
| Existing feed chapters | $0 | Good for topics, not ads | Preserve/remap when present; not enough for ad removal. |
| OpenRouter `openai/whisper-large-v3-turbo` STT | `$0.000667/min` published | Chunk-level timestamps from pre-splitting | Current default because only OpenRouter key is available. |
| Groq `whisper-large-v3-turbo` direct | `$0.000667/min` published | Segment/word timestamps | Better alignment path once `GROQ_API_KEY` exists. |
| Mistral Voxtral Mini Transcribe V2 | `$0.003/min` published | Word timestamps + diarization | Better claimed WER, higher cost, needs `MISTRAL_API_KEY`. |
| Qwen3-ASR-Flash | About `$0.0021/min` international | Word timestamps | Modern contender, needs Alibaba/DashScope integration. |
| OpenAI transcription | Paid per minute | Good transcript endpoint option | Kept as provider option, disabled while OpenRouter STT is preferred. |
| OpenRouter audio LMMs | Paid/varies | No stable forced-alignment contract | Useful for experiments, not default. |
| DeepSeek V4 Pro text classifier | Stronger long-context reasoning with still modest cost | Uses ASR segment IDs | Chosen classifier/chapter model. |

## Current Pipeline

DeepSeek V4 Pro is text-only on OpenRouter. The service therefore does not send podcast audio directly to DeepSeek.

The running pipeline is:

1. Fetch RSS.
2. Download the real audio enclosure.
3. Probe the actual MP3 duration with ffprobe.
4. Split audio into short chunks and transcribe each chunk through OpenRouter STT.
5. Send numbered timestamped chunks to `deepseek/deepseek-v4-pro`.
6. Ask the model to return segment index ranges plus optional start/end offsets inside boundary chunks.
7. Convert segment index ranges and offsets back to source-audio windows.
8. Merge/pad removal windows.
9. Render with ffmpeg, stream-copying source MP3 audio where possible, and insert the marker tone.
10. Rewrite RSS to local audio, chapter, and transcript URLs.

## Real Run Result

The last 3-day processing window on 2026-05-06 found:

- Hello Sport: 2 eligible episodes, both rendered.
- The Grade Cricketer: 1 eligible episode, rendered.
- The Circus: 0 eligible episodes inside the 3-day window.

The run completed with 3 processed, 0 failed.

Earlier OpenRouter text-only estimate from the cost ledger for the rendered recent episodes:

- `#876 - All Talk with Michael Chammas`: `$0.001680`
- `#875 - PNG with Levels Podcast`: `$0.002374`
- `Kyle Jamieson is "afraid" of an Indian kid`: `$0.002083`

Total recent render estimates now use DeepSeek V4 Pro's published rates for preflight budgeting. For completed OpenRouter text calls, the app records the exact `usage.cost` returned in the response.

## Dynamic Ad Duration Finding

The first Hello Sport episode showed why feed duration cannot be trusted:

- Feed duration: `1627s`
- Downloaded MP3 duration: about `2005s`

That difference is consistent with dynamically inserted audio. The renderer now probes source audio duration and uses the real file timeline for removal windows.

## Conclusion

For this project, the current price/performance tradeoff is OpenRouter `openai/whisper-large-v3-turbo` STT over short chunks plus DeepSeek V4 Pro for text classification. OpenRouter STT does not currently provide native segment timestamps through the tested endpoint, so chunking plus model-estimated boundary offsets is the alignment layer. Transcript keyword heuristics no longer create timed cuts; they are only metadata hints. If exact word timestamps become the priority, Groq direct STT is the cleaner cheap provider because its OpenAI-compatible endpoint documents `verbose_json` plus segment/word timestamp granularities at the same `$0.04/hour` turbo price. If accuracy matters more than cost, Mistral Voxtral Mini Transcribe V2 is the strongest researched candidate.
