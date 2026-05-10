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
| Direct Gemini audio prompting | Token priced | Model-generated timestamps only | Works for audio input and timestamped JSON prompts, but the tested transcript still missed key Australian/podcast terms. |
| Direct full-episode audio ad detection | `$0.006-$0.052` observed for a 33.4 min episode depending model | Model-generated timestamps only | Rejected as the primary cutter for now. It is cheap and promising as an audit signal, but full-episode timestamp placement missed known ad blocks. |
| Groq `whisper-large-v3-turbo` direct | `$0.000667/min` published | Segment/word timestamps | Best cheap alignment upgrade once `GROQ_API_KEY` exists. |
| Mistral Voxtral Mini Transcribe V2 | Around `$0.003/min` published | Word timestamps + diarization | Strong hosted non-Whisper contender, needs `MISTRAL_API_KEY`. |
| Qwen3-ASR-Flash / Qwen3 ForcedAligner | About `$0.0021/min` international for hosted file transcription; local aligner has machine cost | Word timestamps / forced alignment | Strongest researched alignment direction; needs DashScope integration or local model deployment. |
| Deepgram Nova-3 | `$0.0048-$0.0077/min` listed for pre-recorded monolingual depending plan | Word timestamps + confidence + utterances | Strong hosted production option, higher cost, needs `DEEPGRAM_API_KEY`. |
| ElevenLabs Forced Alignment / Scribe v2 | `$0.22/hour` published for Scribe STT; forced alignment cost is estimated from this unless provider usage is exposed | Forced alignment returns word/character timestamps; Scribe returns word timestamps + diarization + audio tags | Implemented as the hosted forced-alignment provider when `ELEVENLABS_API_KEY` is set. |
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
| Direct Gemini `gemini-3.1-flash-lite-preview` | 11/16 | Gemini usage only | Audio works, including timestamped JSON prompts, but it still rendered `Four Pines` as `four Punts`/similar in the intro test. |

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

## Current Pipeline

The text classifier is separate from transcription. The service does not send podcast audio directly to the text classifier.

The running pipeline is:

1. Fetch RSS.
2. Download the real audio enclosure.
3. Probe the actual MP3 duration with ffprobe.
4. Split audio into bounded chunks and transcribe each chunk through OpenRouter audio chat into timestamped utterance JSON.
5. Send smaller timestamped transcript windows, episode description, and nearby publisher chapters to `qwen/qwen3.6-flash`.
6. Ask the model to return only ad/noise windows as absolute source-timeline `startTime`/`endTime` values.
7. Map those absolute decisions back to transcript segments for audit text.
8. Merge adjacent model-confirmed ad blocks across short non-editorial gaps, then pad removal windows.
9. Render with a one-pass ffmpeg filter graph using `atrim`/`concat`, encoding once at at least the configured/source bitrate, and insert the marker tone.
10. Rewrite RSS to local audio, chapter, and transcript URLs.

The default render policy now uses asymmetric padding: zero seconds before the detected ad start and a small tail after the detected ad end. This is a deliberate precision trade-off. With prompt-generated timestamps, over-cutting the start of a window is more damaging than leaving a short ad tail, so the renderer is biased toward preserving editorial audio until a word-level aligner is added.

## Deployment Evaluation

Real feed names, private subscription URLs, and per-episode run results belong in deployment notes or private observability data. The public project keeps methodology and tooling only.

Completed OpenRouter calls record the exact `usage.cost` returned in the response when available. Published token prices are used only for preflight budgeting. A UI row can therefore show nonzero transcript cost and zero text LLM calls when transcription succeeded but the text classifier failed or timed out before a billable generation was recorded.

## Alignment Finding

The bad cut precision is structural, not a keyword problem. OpenRouter's tested STT wrapper returns one transcript text result per audio chunk, while OpenRouter audio-chat models return prompt-shaped timestamp JSON rather than provider-guaranteed word timestamps. That can work for coarse removal and is better than whole-chunk cuts, but it is not a real forced-alignment layer.

The app now supports ElevenLabs hosted forced alignment. When `ELEVENLABS_API_KEY` is present and `alignment.provider` is `auto` or `elevenlabs-forced`, each source audio file plus transcript text is sent to `/v1/forced-alignment`; returned word timestamps are stored in transcript JSON, segment boundaries are remapped, and model ad decisions are snapped to forced-word boundaries where possible. Without the key, `auto` falls back to segment-boundary cleanup.

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

For this project, the current best available default with only `OPENROUTER_API_KEY` is OpenRouter `xiaomi/mimo-v2-omni` audio-chat transcription plus `qwen/qwen3.6-flash` for text classification. It is not the final alignment answer, but it gives better OpenRouter-only timing granularity than the dedicated STT wrapper while passing the full-episode ad-block smoke test that cheaper Gemini and DeepSeek Flash classifier passes missed or overreached. Edited audio is now rendered with a single accurate ffmpeg filter graph rather than MP3 stream-copy segment concatenation, because stream-copy cuts can introduce MP3 timestamp/seek drift.

For laser-focused cuts, the next implementation should add a real alignment provider. The preferred path is:

1. Use the best transcript model for text accuracy.
2. Align transcript words back to the waveform with provider word timestamps or forced alignment.
3. Let the ad model classify over aligned words/utterances.
4. Snap cut boundaries to word end/start and nearby silence boundaries.

Qwen3-ASR/Qwen3-ForcedAligner is the most interesting high-accuracy direction from the research pass. Deepgram Nova-3, ElevenLabs Scribe v2, and Mistral Voxtral Mini Transcribe V2 are the most straightforward hosted production-style alternatives because they expose structured timing metadata.
