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
| Groq `whisper-large-v3-turbo` direct | `$0.000667/min` published | Segment/word timestamps | Best cheap alignment upgrade once `GROQ_API_KEY` exists. |
| Mistral Voxtral Mini Transcribe V2 | Around `$0.003/min` published | Word timestamps + diarization | Strong hosted non-Whisper contender, needs `MISTRAL_API_KEY`. |
| Qwen3-ASR-Flash / Qwen3 ForcedAligner | About `$0.0021/min` international for hosted file transcription; local aligner has machine cost | Word timestamps / forced alignment | Strongest researched alignment direction; needs DashScope integration or local model deployment. |
| Deepgram Nova-3 | `$0.0048-$0.0077/min` listed for pre-recorded monolingual depending plan | Word timestamps + confidence + utterances | Strong hosted production option, higher cost, needs `DEEPGRAM_API_KEY`. |
| ElevenLabs Scribe v2 | Paid by audio duration | Word timestamps + diarization + audio tags | Strong hosted production option, needs `ELEVENLABS_API_KEY`. |
| OpenAI transcription | Paid per minute | Good transcript endpoint option | Kept as provider option, disabled while OpenRouter audio transcription is preferred. |
| DeepSeek V4 Pro text classifier | Stronger long-context reasoning with still modest cost | Uses ASR segment IDs | Chosen classifier/chapter model. |

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

## Current Pipeline

DeepSeek V4 Pro is text-only on OpenRouter. The service therefore does not send podcast audio directly to DeepSeek.

The running pipeline is:

1. Fetch RSS.
2. Download the real audio enclosure.
3. Probe the actual MP3 duration with ffprobe.
4. Split audio into bounded chunks and transcribe each chunk through OpenRouter audio chat into timestamped utterance JSON.
5. Send smaller numbered timestamped transcript windows, episode description, and nearby publisher chapters to `deepseek/deepseek-v4-pro`.
6. Ask the model to return segment index ranges plus optional start/end offsets inside boundary chunks.
7. Convert segment index ranges and offsets back to source-audio windows.
8. Merge/pad removal windows.
9. Render with ffmpeg, stream-copying source MP3 audio where possible, and insert the marker tone.
10. Rewrite RSS to local audio, chapter, and transcript URLs.

## Deployment Evaluation

Real feed names, private subscription URLs, and per-episode run results belong in deployment notes or private observability data. The public project keeps methodology and tooling only.

Completed OpenRouter calls record the exact `usage.cost` returned in the response when available. Published token prices are used only for preflight budgeting. A UI row can therefore show nonzero transcript cost and zero text LLM calls when transcription succeeded but the text classifier failed or timed out before a billable generation was recorded.

## Alignment Finding

The bad cut precision is structural, not a keyword problem. OpenRouter's tested STT wrapper returns one transcript text result per audio chunk, while OpenRouter audio-chat models return prompt-shaped timestamp JSON rather than provider-guaranteed word timestamps. That can work for coarse removal and is better than whole-chunk cuts, but it is not a real forced-alignment layer.

The better pipeline is:

1. Transcribe with a provider that returns word-level timestamps.
2. Let the text model classify candidate ad spans using transcript text, episode description, and publisher chapters.
3. Snap the model's start/end decision to the nearest word boundary or silence boundary.
4. Render cuts from those snapped boundaries, with minimal or zero padding.

Groq direct is a practical cheap upgrade because its speech-to-text docs expose `verbose_json` with `timestamp_granularities` including `word` and `segment`, and its pricing page lists Whisper Large v3 Turbo at `$0.04/hour`. It may not fix transcript quality by itself, because the OpenRouter Whisper Turbo bake-off had clear Australian show/brand errors.

The stronger accuracy/alignment direction is Qwen3-ASR plus Qwen3-ForcedAligner, or a hosted provider with word timestamps such as Mistral Voxtral Mini Transcribe V2, Deepgram Nova-3, or ElevenLabs Scribe v2. Qwen is especially relevant because its published ASR paper includes a separate non-autoregressive forced aligner, and Alibaba's hosted API documents word-level timestamps for Qwen3-ASR file transcription.

Gemini and MiMo audio models can be prompted to return timestamped transcript JSON. In the focused test, `gemini-3.1-flash-lite-preview` returned plausible 2-10 second segment timestamps and consumed real audio tokens, but it still made brand/name errors. `xiaomi/mimo-v2-omni` performed better on the same phrase check. These timestamps should be treated as model-estimated labels, not as a forced-alignment contract for destructive audio cuts.

## Dynamic Ad Duration Finding

Feed duration cannot be trusted as the render timeline. Dynamic ad insertion can make the downloaded MP3 materially longer or shorter than the RSS `itunes:duration`, depending on location and inventory. The renderer therefore probes source audio duration with ffprobe and maps removal windows against the real downloaded file.

## Conclusion

For this project, the current best available default with only `OPENROUTER_API_KEY` is OpenRouter `xiaomi/mimo-v2-omni` audio-chat transcription plus DeepSeek V4 Pro for text classification. It is not the final alignment answer, but it gives better OpenRouter-only timing granularity than the dedicated STT wrapper while preserving the best phrase accuracy from the bounded sweep.

For laser-focused cuts, the next implementation should add a real alignment provider. The preferred path is:

1. Use the best transcript model for text accuracy.
2. Align transcript words back to the waveform with provider word timestamps or forced alignment.
3. Let the ad model classify over aligned words/utterances.
4. Snap cut boundaries to word end/start and nearby silence boundaries.

Qwen3-ASR/Qwen3-ForcedAligner is the most interesting high-accuracy direction from the research pass. Deepgram Nova-3, ElevenLabs Scribe v2, and Mistral Voxtral Mini Transcribe V2 are the most straightforward hosted production-style alternatives because they expose structured timing metadata.
