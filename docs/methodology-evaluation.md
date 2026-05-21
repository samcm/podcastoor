# Methodology Evaluation

Checked and exercised on 2026-05-06.

## Methods Considered

| Method | API Cost | Timestamp Quality | Result |
| --- | ---: | --- | --- |
| Metadata/description keywords | $0 | None | Rejected. The app no longer emits keyword-derived signals or cuts. |
| Existing feed chapters | $0 | Good for topics, not ads | Preserve/remap when present; not enough for ad removal. |
| OpenRouter `openai/whisper-large-v3-turbo` STT | `$0.000667/min` published | Chunk-level timestamps from pre-splitting | Rejected as default after the Australian podcast bake-off; it missed show, sponsor, and location terms that matter for classification. |
| OpenRouter `openai/gpt-4o-mini-transcribe` STT | Observed about `$0.002/min` in the clip bake-off | Chunk-level timestamps from pre-splitting | Good transcript accuracy, but no native timing arrays from OpenRouter's STT wrapper in the current bake-off. |
| OpenRouter `xiaomi/mimo-v2-omni` audio chat | Observed about `$0.00066/min` in the clip bake-off | Model-generated utterance timestamps | Current OpenRouter-only default; tied the best transcript phrase score at lower cost and returned usable timestamped JSON. |
| Other OpenRouter audio chat models | Varies by model; often slower or more expensive | Model-generated timestamps only | Useful for audio reasoning experiments, but not a substitute for forced alignment. |
| WhisperX local alignment | $0 hosted API cost | Forced word timestamps from existing transcript/audio | Current default alignment layer; costs local CPU/GPU time and model cache storage. |
| Direct Gemini audio prompting | Token priced | Model-generated timestamps only | Works for audio input and timestamped JSON prompts, but the tested transcript still missed key Australian/podcast terms. |
| Direct full-episode audio ad detection | `$0.006-$0.052` observed for a 33.4 min episode depending model | Model-generated timestamps only | Rejected as the primary cutter for now. It is cheap and promising as an audit signal, but full-episode timestamp placement missed known ad blocks. |
| Groq `whisper-large-v3-turbo` direct | `$0.000667/min` published | Segment/word timestamps | Best cheap alignment upgrade once `GROQ_API_KEY` exists. |
| Mistral Voxtral Mini Transcribe V2 | Around `$0.003/min` published | Word timestamps + diarization | Strong hosted non-Whisper contender, needs `MISTRAL_API_KEY`. |
| Qwen3-ASR-Flash / Qwen3 ForcedAligner | About `$0.0021/min` international for hosted file transcription; local aligner has machine cost | Word timestamps / forced alignment | Strongest researched alignment direction; needs DashScope integration or local model deployment. |
| Deepgram Nova-3 | `$0.0048-$0.0077/min` listed for pre-recorded monolingual depending plan | Word timestamps + confidence + utterances | Strong hosted production option, higher cost, needs `DEEPGRAM_API_KEY`. |
| ElevenLabs Forced Alignment / Scribe v2 | `$0.22/hour` published for Scribe STT; forced alignment cost is estimated from this unless provider usage is exposed | Forced alignment returns word/character timestamps; Scribe returns word timestamps + diarization + audio tags | Only used for hosted alignment in this app. It is not a full-episode STT fallback. |
| OpenAI transcription | Paid per minute | Good transcript endpoint option | Kept as provider option, disabled while OpenRouter audio transcription is preferred. |
| Qwen 3.6 Flash text classifier | About `$0.0246` observed for a 33.4 min full-episode 7-window ad classification smoke test | Returns absolute source timestamps | Current default classifier after full-episode smoke test. |
| DeepSeek V4 Pro text classifier | Stronger long-context reasoning with still modest cost | Uses ASR segment IDs or absolute timestamps | Configurable alternative, but not the current default after the latest full-episode smoke test. |
| OpenRouter Nano Banana 2 `google/gemini-3.1-flash-image-preview` | One-off image generation cost | N/A | Current artwork stamp model only; it does not participate in STT or ad detection. |

## Bounded STT Bake-Off

The test clips were extracted from a configured Australian podcast episode and covered three hard areas: intro sponsor/show language, a mid-roll ad cluster, and a post-roll inserted ad. The scoring was a simple phrase-presence check over 16 expected phrases, not a full WER benchmark.

| Model path | Hits | Cost for 5.67 min clips | Notes |
| --- | ---: | ---: | --- |
| OpenRouter STT `openai/gpt-4o-mini-transcribe` | 14/16 | `$0.010509` | Strong transcript text, but OpenRouter's STT wrapper did not return word or segment timestamp arrays. |
| OpenRouter audio chat `xiaomi/mimo-v2-omni` | 14/16 | `$0.003726` | Current default; cheap, strong transcript text, and returned the most usable prompt-shaped timestamped JSON in the OpenRouter-only sweep. |
| OpenRouter audio chat `google/gemini-3-flash-preview` | 13/16 | `$0.012501` | Better than Whisper on this sample, but slower and more expensive than GPT-4o mini transcribe. |
| OpenRouter STT `openai/whisper-large-v3-turbo` | 12/16 | `$0.003775` | Fast and cheap, but it produced the exact kind of bad brand/show errors seen in the UI. |
| Direct Gemini `gemini-3.1-flash-lite-preview` | 11/16 | Gemini usage only | Audio works, including timestamped JSON prompts, but it still made sample-specific brand/name errors in the intro test. |

OpenRouter's dedicated STT endpoint returned `text` plus `usage` for every tested STT model, but no native `words` or `segments` arrays. That means OpenRouter STT still needs pre-splitting to create coarse source-time windows. The current default moves to OpenRouter audio chat because `xiaomi/mimo-v2-omni` produced strict JSON segments with start/end seconds when prompted, although those seconds remain model-estimated.

## Direct Audio Ad Detection Smoke Test

The same configured full episode and four bounded ad-region clips were also tested by sending audio directly to OpenRouter audio-capable chat models and asking for removable `startTime`/`endTime` windows.

| Model path | Clip result | Full-episode result | Observed cost | Verdict |
| --- | --- | --- | ---: | --- |
| `xiaomi/mimo-v2.5` | Best direct-audio clip result: strong pre-roll and mid-show, weaker inserted/post-roll boundaries | Cheap full-episode run found pre-roll and inserted mid-roll but missed the known mid-show block and under-covered post-roll | `$0.0034` clips, `$0.0062` full episode | Keep as future audit/refinement candidate, not primary cutter. |
| `google/gemini-3-flash-preview` | Good pre-roll, under-cut mid-show, inserted, and post-roll | Missed the known mid-show block and post-roll; under-covered pre-roll | `$0.0171` clips, `$0.0516` full episode | Rejected as primary cutter. |
| `google/gemini-3.1-flash-lite-preview` | Good pre-roll and content recognition, but under-cut mid/post boundaries | Found only pre-roll and one later partial block in the full episode | `$0.0086` clips, `$0.0260` full episode | Rejected as primary cutter. |
| `xiaomi/mimo-v2-omni` | Strong pre-roll, but shifted/under-cut inserted and post-roll blocks | Not promoted over v2.5 for direct ad detection | `$0.0037` clips | Kept as transcript provider, not direct cutter. |
| `mistralai/voxtral-small-24b-2507` | Poor timestamp placement on these clips | Not tested full episode after clip failure | `$0.0594` clips | Rejected. |

The direct-audio path is attractive because it can be cheaper than STT plus text classification, but the timestamp quality was not stable enough for destructive edits. The current safer path remains transcript acquisition plus text classification, with direct audio reserved for a possible second-pass audit around candidate regions.

## Boundary Precision Benchmark

Rechecked on 2026-05-14 against one bounded one-hour production episode. The benchmark used only five candidate ad regions, not the full episode, to stay well below a `$10` OpenRouter cap. Specific podcast/feed details are intentionally kept out of this public repo; benchmark case specs belong in private deploy/operator notes.

| Model | Candidate windows | Within 1s before repair | Observed cost | Notes |
| --- | ---: | ---: | ---: | --- |
| `xiaomi/mimo-v2.5` | 5 | 2/5 | `$0.005688` | Cheapest useful auditor; good at identifying sponsor blocks, but still copied coarse transcript boundaries on mixed segments. |
| `google/gemini-3.1-flash-lite` | 5 | 2/5 | `$0.009362` | Good semantic grouping, but split continuous breaks and missed ad music edges. |
| `mistralai/voxtral-small-24b-2507` | 5 | 0/5 | `$0.050665` | More expensive and worse timestamp placement on this sample. |

The hard cases were not "which model knows this is an ad"; they were boundary mechanics:

- A mixed segment contained editorial text followed by ad copy: `Let alone what anyone else is doing. Pause the listeners...`
- A dynamically inserted ad had `[Music]` before and after the spoken ad copy.
- The pre-roll contained multiple ads separated by a normal show intro, so a single `0s -> first topic` cut deletes useful signal.

Follow-up prompts that asked audio models for exact boundary phrases improved some cases, but the outputs were still inconsistent and sometimes returned clip-relative timestamps despite explicit absolute-time instructions. This rules out audio-only OpenRouter prompting as the final destructive cutter for now.

Implemented methodology:

1. Keep the text model responsible for semantic ad decisions.
2. Ask it for `startAnchorText`/`endAnchorText` when an ad boundary falls inside a mixed transcript segment.
3. Use WhisperX or another word-level alignment provider to map those anchor phrases to actual source-audio timestamps.
4. Expand cuts over adjacent non-speech transition segments so ad music beds do not leak through.
5. Treat OpenRouter audio models as optional bounded auditors around candidate windows, not as the primary timeline authority.

The generic benchmark helper lives at `scripts/openrouter-boundary-benchmark.mjs`; it reads a local JSON case spec plus local audio/transcript artifacts and writes detailed run JSON to the configured output directory.

## Current Pipeline

The text classifier is separate from transcription. The service does not send podcast audio directly to the text classifier.

The running pipeline is:

1. Fetch RSS.
2. Download the real audio enclosure.
3. Probe the actual MP3 duration with ffprobe.
4. Split audio into bounded chunks and transcribe each chunk through OpenRouter audio chat into timestamped utterance JSON.
5. Send smaller timestamped transcript windows, episode description, and nearby publisher chapters to the configured OpenAI-compatible text model.
6. Ask the model to return only ad/noise windows as absolute source-timeline `startTime`/`endTime` values.
7. Map those absolute decisions back to transcript segments for audit text.
8. Run local WhisperX forced alignment against the source audio and transcript segments when available.
9. Snap removal windows to aligned word boundaries, using model-provided boundary anchor phrases when present, then expand across adjacent non-speech transition audio.
10. Render with a one-pass ffmpeg filter graph using `atrim`/`concat`, encoding once at at least the configured/source bitrate, and insert the marker tone.
11. Rewrite RSS to local audio, chapter, and transcript URLs.

The default render policy now uses zero padding before and after detected ads. This is a deliberate precision trade-off. With prompt-generated timestamps, over-cutting either side of a window is more damaging than leaving a short ad remnant. When local word alignment succeeds, the renderer snaps to aligned word boundaries and then runs a content-loss guard before applying destructive cuts.

## Deployment Evaluation

Real feed names, private subscription URLs, and per-episode run results belong in deployment notes or private observability data. The public project keeps methodology and tooling only.

Completed OpenRouter calls record the exact `usage.cost` returned in the response when available. Published token prices are used only for preflight budgeting. A UI row can therefore show nonzero transcript cost and zero text LLM calls when transcription succeeded but the text classifier failed or timed out before a billable generation was recorded.

## Alignment Finding

The bad cut precision is structural, not a keyword problem. OpenRouter's tested STT wrapper returns one transcript text result per audio chunk, while OpenRouter audio-chat models return prompt-shaped timestamp JSON rather than provider-guaranteed word timestamps. That can work for coarse removal and is better than whole-chunk cuts, but it is not a real forced-alignment layer.

The app now supports local WhisperX forced alignment. With `alignment.provider: auto` or `whisperx-local`, each source audio file plus transcript segment list is aligned locally; returned word timestamps are stored in transcript JSON, segment boundaries are remapped, and model ad decisions are snapped to forced-word boundaries where possible. Without a working local WhisperX runtime, provider word timestamps, or anchorable boundaries, the episode fails or marks the unsafe window only; the service does not silently fall back to coarse segment-boundary cuts.

ElevenLabs remains available as an explicit hosted alignment option. `alignment.provider: elevenlabs-forced` aligns the whole episode transcript. `alignment.provider: elevenlabs-targeted` is the cheaper hybrid path: Mimo creates the full transcript, the text model finds candidate ad windows, then ElevenLabs aligns only those windows plus configurable context. ElevenLabs is deliberately not used as a bulky full-episode transcript fallback when the OpenRouter audio key is capped.

The better pipeline is:

1. Transcribe with a provider that returns word-level timestamps.
2. Let the text model classify candidate ad spans using transcript text, episode description, and publisher chapters.
3. Snap the model's start/end decision to the nearest word boundary or silence boundary.
4. Render cuts from those snapped boundaries, with minimal or zero padding.

Groq direct is a practical cheap upgrade because its speech-to-text docs expose `verbose_json` with `timestamp_granularities` including `word` and `segment`, and its pricing page lists Whisper Large v3 Turbo at `$0.04/hour`. It may not fix transcript quality by itself, because the OpenRouter Whisper Turbo bake-off had clear Australian show/brand errors.

The next stronger accuracy/alignment direction is Qwen3-ASR plus Qwen3-ForcedAligner, or another hosted provider with word timestamps such as Mistral Voxtral Mini Transcribe V2 or Deepgram Nova-3. Qwen is especially relevant because its published ASR paper includes a separate non-autoregressive forced aligner, and Alibaba's hosted API documents word-level timestamps for Qwen3-ASR file transcription.

Gemini and MiMo audio models can be prompted to return timestamped transcript JSON. In the focused test, `gemini-3.1-flash-lite-preview` returned plausible 2-10 second segment timestamps and consumed real audio tokens, but it still made brand/name errors. `xiaomi/mimo-v2-omni` performed better on the same phrase check. These timestamps should be treated as model-estimated labels, not as a forced-alignment contract for destructive audio cuts.

## Dynamic Ad Duration Finding

Feed duration cannot be trusted as the render timeline. Dynamic ad insertion can make the downloaded MP3 materially longer or shorter than the RSS `itunes:duration`, depending on location and inventory. The renderer therefore probes source audio duration with ffprobe and maps removal windows against the real downloaded file.

## Conclusion

For this project, the current best available default with only `OPENROUTER_API_KEY` is OpenRouter `xiaomi/mimo-v2-omni` audio-chat transcription plus local WhisperX alignment for word-level cut boundaries. Text classification now uses an OpenAI-compatible endpoint selected by env vars, so deployment can point it at OpenCode Go or OpenRouter without changing code. Edited audio is rendered with a single accurate ffmpeg filter graph rather than MP3 stream-copy segment concatenation, because stream-copy cuts can introduce MP3 timestamp/seek drift.

For laser-focused hosted cuts, the implemented hybrid path is:

1. Use Mimo/OpenRouter audio chat for a cheap high-recall full-episode transcript.
2. Let the text model classify candidate ad spans from transcript text, episode description, and publisher chapters.
3. Extract only candidate ad windows plus context.
4. Run ElevenLabs targeted forced alignment on those short clips.
5. Snap destructive cut boundaries to aligned words and run the content-loss guard.

Qwen3-ASR/Qwen3-ForcedAligner is the most interesting high-accuracy direction from the research pass. Deepgram Nova-3, ElevenLabs Scribe v2, and Mistral Voxtral Mini Transcribe V2 are the most straightforward hosted production-style alternatives because they expose structured timing metadata.
