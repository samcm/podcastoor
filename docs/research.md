# Research Notes

Checked on 2026-05-06.

## Pocket Casts

Pocket Casts does not currently expose a public API. Their support page says there is no API available yet, so this project should not depend on a hidden Pocket Casts endpoint for core behavior. Source: [Pocket Casts API](https://support.pocketcasts.com/knowledge-base/pocket-casts-api/).

Pocket Casts consumes normal podcast RSS and has a feed parser that regularly checks feeds for new episodes, metadata, artwork, and availability. It identifies as `PocketCasts/1.0 (Pocket Casts Feed Parser; +http://pocketcasts.com/)`. Source: [About Pocket Casts Feed Parser](https://support.pocketcasts.com/knowledge-base/about-pocket-casts-feed-parser/).

Pocket Casts transcript support is RSS-first. It supports the Podcasting 2.0 `podcast:transcript` tag, and the documented accepted formats are VTT, SRT, PodcastIndex JSON, and HTML. Since May 2025, Plus and Patron users may also see server-generated transcripts for select podcasts under two hours, but those are selective and not a public API contract. Source: [Episode Transcripts](https://support.pocketcasts.com/knowledge-base/episode-transcripts/).

Conclusion: the durable integration point is an RSS feed that exposes rewritten enclosures, Podcasting 2.0 transcripts, and Podcasting 2.0 chapters. The Pocket Casts transcript endpoint idea remains experimental only.

## Transcript and Chapter RSS Tags

`podcast:transcript` is an item-level tag with required `url` and `type` attributes. Multiple transcript tags are allowed. Source: [Podcasting 2.0 transcript tag](https://podcasting2.org/docs/podcast-namespace/tags/transcript).

`podcast:chapters` links an item to an external chapter file, usually `application/json+chapters`. The spec notes the benefit that chapters can be served as separate files without altering audio files. Source: [Podcasting 2.0 chapters tag](https://podcasting2.org/docs/podcast-namespace/tags/chapters).

Some podcast hosts and publishers include Podlove Simple Chapters (`psc:chapters`). V1 parses those and writes both remapped Podlove inline chapters and Podcasting 2.0 chapter JSON for completed processed episodes.

## Dynamic Ad Insertion

Acast documents dynamic ad insertion as using ad markers to deliver current ads and sponsorships to episodes, including back catalog episodes, with targeting to the right audience. Source: [Understanding Acast Ads](https://learn.acast.com/en/articles/3931652-understanding-acast-ads).

Acast also documents that marketplace ads are inserted dynamically at playback and may vary by listener location and available inventory. Source: [Monetizing with Acast Marketplace](https://learn.acast.com/en/articles/5503627-monetizing-with-acast-marketplace).

Omny Studio documents dynamic and targeted ad insertion for pre-roll, mid-roll, and post-roll ad slots using markers in its audio editor. Source: [Omny Studio monetization](https://omnystudio.com/features/monetize).

Triton/Omny help docs explicitly distinguish baked-in ads from Dynamic Ad Insertion and say inserted ads can vary by listener location via geo-targeting. Source: [Advertise on Podcasts in Omny Studio](https://help.tritondigital.com/docs/advertising-on-podcasts-in-omny-studio).

Conclusion: localized ads are likely coming from podcast hosting/ad infrastructure, not Pocket Casts itself. This project should treat host/provider-served ad insertion as a normal feed-level concern, independent of the listening app.

## Transcription Costs

OpenAI's pricing page lists:

- OpenRouter `openai/whisper-large-v3-turbo`: `$0.04 / hour`, roughly `$0.000667 / minute`, 12% WER. Source: [Whisper Large V3 Turbo on OpenRouter](https://openrouter.ai/openai/whisper-large-v3-turbo).
- OpenRouter `openai/whisper-large-v3`: `$0.111 / hour`, roughly `$0.00185 / minute`, 10.3% WER. Source: [Whisper Large V3 on OpenRouter](https://openrouter.ai/openai/whisper-large-v3).
- `gpt-4o-mini-transcribe`: estimated `$0.003 / minute`
- `gpt-4o-transcribe`: estimated `$0.006 / minute`
- `gpt-4o-transcribe-diarize`: estimated `$0.006 / minute`

Source: [OpenAI API pricing](https://platform.openai.com/docs/pricing/). OpenAI's model docs also list `gpt-4o-mini-transcribe` and `gpt-4o-transcribe` as speech-to-text models. Sources: [gpt-4o-mini-transcribe](https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe), [gpt-4o-transcribe](https://platform.openai.com/docs/models/gpt-4o-transcribe).

OpenAI's transcription API supports `timestamp_granularities` with `word` and `segment` when `response_format` is `verbose_json`, though the diarization model has separate response constraints. Source: [OpenAI create transcription API reference](https://platform.openai.com/docs/api-reference/audio/createTranscription).

Mistral's Voxtral Mini Transcribe V2 is a newer non-Whisper batch STT model with diarization, context biasing, word-level timestamps, and multilingual support. Mistral lists it at `$0.003/min` and claims about 4% WER on FLEURS plus better price/performance than GPT-4o mini Transcribe, Gemini 2.5 Flash, Assembly Universal, and Deepgram Nova in their launch benchmarks. Sources: [Mistral Voxtral Transcribe 2 announcement](https://mistral.ai/news/voxtral-transcribe-2), [Mistral audio transcription docs](https://docs.mistral.ai/capabilities/audio/speech_to_text).

Qwen3-ASR-Flash is another modern non-Whisper option. Alibaba documents support for 26 languages, emotion detection, and word-level timestamps. International pricing for Qwen3-ASR audio file recognition is listed at `$0.000035/second`, roughly `$0.0021/min` or `$0.126/hour`; Chinese Mainland pricing is lower. Sources: [Qwen-ASR API reference](https://www.alibabacloud.com/help/en/model-studio/qwen-asr-api-reference), [Alibaba Model Studio pricing](https://www.alibabacloud.com/help/en/model-studio/billing/).

NVIDIA Parakeet TDT 0.6B v2 is an English-focused ASR model with punctuation and word timestamps available via NVIDIA NIM/Riva. It is attractive for self-hosting or NVIDIA-backed deployment, but it is not immediately usable with the current environment because no NVIDIA API key or NIM deployment is configured. Sources: [NVIDIA Parakeet model card](https://build.nvidia.com/nvidia/parakeet-tdt-0_6b-v2), [NVIDIA Speech NIM ASR docs](https://docs.nvidia.com/nim/speech/latest/asr/index.html).

Deepgram's pricing page lists Nova-3 pre-recorded transcription at `$0.0077/min` for monolingual and `$0.0092/min` for multilingual pay-as-you-go, with lower annual growth pricing. It supports high-accuracy timestamps, but costs materially more than OpenRouter/Groq Whisper Turbo and Qwen3-ASR. Source: [Deepgram pricing](https://deepgram.com/pricing).

Deepgram utterance responses include utterance start/end timestamps and per-word start/end/confidence objects. Source: [Deepgram utterances docs](https://developers.deepgram.com/docs/utterances).

Groq's pricing page lists Whisper Large v3 Turbo at `$0.04/hour`, and Groq's STT docs support `verbose_json` plus segment/word timestamp granularities. This is the best cheap alignment option if a `GROQ_API_KEY` is available, because OpenRouter's STT wrapper currently returns text plus usage but not word timestamps. Sources: [Groq pricing](https://groq.com/pricing), [Groq speech-to-text docs](https://console.groq.com/docs/speech-to-text).

Self-hosted open-source ASR has no API cost but has machine time and setup cost. Faster CTranslate2-based runners exist for Whisper-family models, but this app no longer includes a self-hosted ASR provider.

Conclusion: with only `OPENROUTER_API_KEY` available, the best immediate default is OpenRouter `openai/whisper-large-v3-turbo` because it is cheap and already authenticated. If another provider key is added, the first upgrade target should be Groq direct for the same turbo model with word timestamps, or Mistral Voxtral Mini Transcribe V2 for better claimed WER and word timestamps at higher cost. Qwen3-ASR is credible and modern, but it is not cheaper than Whisper Turbo and needs Alibaba/DashScope integration.

## OpenRouter and DeepSeek

OpenRouter's DeepSeek V4 Flash page lists `deepseek/deepseek-v4-flash` at `$0.14/M input tokens` and `$0.28/M output tokens`, with a 1,048,576 token context. Source: [DeepSeek V4 Flash on OpenRouter](https://openrouter.ai/deepseek/deepseek-v4-flash).

OpenRouter's DeepSeek V4 Pro page lists `deepseek/deepseek-v4-pro` at `$0.435/M input tokens` and `$0.87/M output tokens`, also with a 1,048,576 token context. Source: [DeepSeek V4 Pro on OpenRouter](https://openrouter.ai/deepseek/deepseek-v4-pro).

OpenRouter's DeepSeek V3.1 page lists `deepseek/deepseek-chat-v3.1` at `$0.15/M input tokens` and `$0.75/M output tokens`, with 32,768 context. Source: [DeepSeek V3.1 on OpenRouter](https://openrouter.ai/deepseek/deepseek-chat-v3.1).

Conclusion: V4 Pro is the current default for chapter/category generation and transcript segment classification because the extra reasoning quality is useful for long, messy transcripts while still staying well below frontier closed-model pricing. DeepSeek V4 Pro is text-only on OpenRouter, so it is used after audio has been converted to timestamped text by Whisper. The default STT model is now `openai/whisper-large-v3-turbo`; it is materially cheaper and faster than large-v3, while the app improves cut precision with shorter chunks and model-estimated boundary offsets. OpenRouter responses include `usage.cost` for exact request accounting; the app records that value and uses published token prices only for budget estimates before a request is made.

OpenRouter's model API also reports audio-capable multimodal models such as Gemini Flash/Lite and OpenAI GPT audio models. Those can accept audio, but they are not a replacement for forced alignment in this service because the renderer still needs reliable start/end seconds for cuts. The current implementation therefore treats multimodal audio as an evaluation path, not the default production path.

## Deployment Feed Findings

Feed-specific findings, private podcast lists, and private subscription URLs should live in deployment configuration or private runbooks, not in this application repository.
