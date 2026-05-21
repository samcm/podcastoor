import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, resolvePodcastConfig } from "../src/config.js";
import { classifyTranscriptWithTextLlm, generateChaptersWithTextLlm, parsedAdSegmentToDecision, reviewAlignedCutBoundariesWithTextLlm } from "../src/openrouter.js";
import type { AppConfig, ParsedEpisode, Transcript } from "../src/types.js";

const transcript: Transcript = {
  source: "openrouter-audio-chat:test",
  format: "json",
  text: "Commercial intro. Editorial resumes.",
  segments: [
    { start: 0, end: 10, text: "Commercial intro." },
    { start: 10, end: 20, text: "Still commercial." },
    { start: 20, end: 30, text: "Editorial resumes." }
  ]
};

describe("openrouter ad parsing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TEXT_LLM_API_KEY;
    delete process.env.TEXT_LLM_BASE_URL;
    delete process.env.TEXT_LLM_PROVIDER_LABEL;
  });

  it("prefers absolute model timestamps over segment boundaries", () => {
    const decision = parsedAdSegmentToDecision(
      {
        startTime: 2.25,
        endTime: 18.75,
        startSegment: 0,
        endSegment: 2,
        action: "remove",
        confidence: 0.93,
        reason: "commercial read",
        advertiser: "Example Brand"
      },
      transcript
    );

    expect(decision).toMatchObject({
      start: 2.25,
      end: 18.75,
      action: "remove",
      confidence: 0.93,
      advertiser: "Example Brand",
      alignment: {
        startSegmentIndex: 0,
        endSegmentIndex: 1,
        method: "model-timestamp"
      }
    });
  });

  it("accepts older segment offsets, including accidental absolute offset values", () => {
    const decision = parsedAdSegmentToDecision(
      {
        startSegment: 0,
        endSegment: 1,
        startOffsetSeconds: 0,
        endOffsetSeconds: 18.75,
        action: "remove",
        confidence: 0.9
      },
      transcript
    );

    expect(decision?.start).toBe(0);
    expect(decision?.end).toBe(18.75);
  });

  it("preserves model boundary anchor text for forced alignment", () => {
    const decision = parsedAdSegmentToDecision(
      {
        startTime: 10,
        endTime: 20,
        action: "remove",
        confidence: 0.9,
        startAnchorText: "Pause the listeners",
        endAnchorText: "have a chat"
      },
      transcript
    );

    expect(decision?.alignment).toMatchObject({
        startAnchorText: "Pause the listeners",
      endAnchorText: "have a chat"
    });
  });

  it("retries blank text LLM responses with the same provider", async () => {
    process.env.TEXT_LLM_API_KEY = "test-key";
    process.env.TEXT_LLM_BASE_URL = "https://llm.example/v1";
    process.env.TEXT_LLM_PROVIDER_LABEL = "Test LLM";

    const responses = [
      { choices: [{ message: { content: "" } }], usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } },
      { choices: [{ message: { content: "{\"adSegments\":[]}" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      { choices: [{ message: { content: "{\"adSegments\":[]}" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
    ];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const payload = responses.shift() ?? responses.at(-1);
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    });

    const config: AppConfig = {
      ...defaultConfig,
      llm: {
        ...defaultConfig.llm,
        provider: "openai-compatible",
        enabled: true,
        model: "test-model"
      },
      podcasts: {
        sample: {
          name: "Sample",
          feedUrl: "https://example.com/feed.xml"
        }
      }
    };
    const podcast = resolvePodcastConfig(config, "sample");
    const episode: ParsedEpisode = {
      raw: {},
      key: "episode",
      guid: "episode",
      title: "Episode",
      description: "",
      transcripts: [],
      chapters: [],
      sourceFingerprint: "fingerprint"
    };

    const result = await classifyTranscriptWithTextLlm(podcast, episode, transcript);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.decisions).toEqual([]);
    expect(result.llmUsage).toHaveLength(2);
  });

  it("splits a persistently blank classifier window into smaller same-model windows", async () => {
    process.env.TEXT_LLM_API_KEY = "test-key";
    process.env.TEXT_LLM_BASE_URL = "https://llm.example/v1";
    process.env.TEXT_LLM_PROVIDER_LABEL = "Test LLM";

    const longTranscript: Transcript = {
      source: "openrouter-audio-chat:test",
      format: "json",
      text: Array.from({ length: 40 }, (_, index) => `Segment ${index}`).join(" "),
      segments: Array.from({ length: 40 }, (_, index) => ({
        start: index * 2,
        end: index * 2 + 1.5,
        text: `Segment ${index}`
      }))
    };
    const responses = [
      { choices: [{ message: { content: "" } }] },
      { choices: [{ message: { content: "" } }] },
      { choices: [{ message: { content: "" } }] },
      { choices: [{ message: { content: "{\"adSegments\":[]}" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      { choices: [{ message: { content: "{\"adSegments\":[]}" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      { choices: [{ message: { content: "{\"adSegments\":[]}" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
    ];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const payload = responses.shift() ?? { choices: [{ message: { content: "{\"adSegments\":[]}" } }] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    });

    const config: AppConfig = {
      ...defaultConfig,
      llm: {
        ...defaultConfig.llm,
        provider: "openai-compatible",
        enabled: true,
        model: "test-model"
      },
      podcasts: {
        sample: {
          name: "Sample",
          feedUrl: "https://example.com/feed.xml"
        }
      }
    };
    const podcast = resolvePodcastConfig(config, "sample");
    const episode: ParsedEpisode = {
      raw: {},
      key: "episode",
      guid: "episode",
      title: "Episode",
      description: "",
      transcripts: [],
      chapters: [],
      sourceFingerprint: "fingerprint"
    };

    const result = await classifyTranscriptWithTextLlm(podcast, episode, longTranscript);

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(result.decisions).toEqual([]);
    expect(result.llmUsage).toHaveLength(3);
  });

  it("downgrades listener-submitted entertainment during cut safety review", async () => {
    process.env.TEXT_LLM_API_KEY = "test-key";
    process.env.TEXT_LLM_BASE_URL = "https://llm.example/v1";
    process.env.TEXT_LLM_PROVIDER_LABEL = "Test LLM";

    const listenerBitTranscript: Transcript = {
      source: "fixture",
      format: "json",
      text: "Should we have a listen? Hi Tom. I wrote a parody song. Atop the hill with a can in my hand. That's unbelievable. Back to footy.",
      segments: [
        { start: 0, end: 4, text: "Should we have a listen?" },
        { start: 4, end: 10, text: "Hi Tom. I wrote a parody song for the show." },
        { start: 10, end: 18, text: "Atop the hill with a can in my hand." },
        { start: 18, end: 28, text: "That's unbelievable. That's phenomenal." },
        { start: 28, end: 45, text: "Back to footy." }
      ]
    };
    const responses = [
      {
        choices: [
          {
            message: {
              content:
                "{\"adSegments\":[{\"startTime\":4,\"endTime\":28,\"action\":\"remove\",\"confidence\":0.95,\"reason\":\"commercial block\",\"advertiser\":\"Example Sponsor\"}]}"
            }
          }
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
      },
      { choices: [{ message: { content: "{\"adSegments\":[]}" } }], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } },
      {
        choices: [
          {
            message: {
              content: "{\"reviews\":[{\"id\":0,\"action\":\"keep\",\"confidence\":0.98,\"reason\":\"listener parody\"}]}"
            }
          }
        ],
        usage: { prompt_tokens: 60, completion_tokens: 10, total_tokens: 70 }
      }
    ];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const payload = responses.shift() ?? { choices: [{ message: { content: "{\"adSegments\":[]}" } }] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    });

    const config: AppConfig = {
      ...defaultConfig,
      llm: {
        ...defaultConfig.llm,
        provider: "openai-compatible",
        enabled: true,
        model: "test-model"
      },
      podcasts: {
        sample: {
          name: "Sample",
          feedUrl: "https://example.com/feed.xml"
        }
      }
    };
    const podcast = resolvePodcastConfig(config, "sample");
    const episode: ParsedEpisode = {
      raw: {},
      key: "episode",
      guid: "episode",
      title: "Episode",
      description: "",
      transcripts: [],
      chapters: [],
      sourceFingerprint: "fingerprint"
    };

    const result = await classifyTranscriptWithTextLlm(podcast, episode, listenerBitTranscript);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.decisions[0]).toMatchObject({
      action: "mark-only",
      confidence: 0.5
    });
    expect(result.decisions[0].reason).toContain("safety veto");
    expect(result.modelNotes?.[0]).toContain("Cut safety review downgraded 1 proposed cuts");
  });

  it("extends approved final ad fragments to the transcript end", async () => {
    process.env.TEXT_LLM_API_KEY = "test-key";
    process.env.TEXT_LLM_BASE_URL = "https://llm.example/v1";
    process.env.TEXT_LLM_PROVIDER_LABEL = "Test LLM";

    const endingTranscript: Transcript = {
      source: "fixture",
      format: "json",
      text: "Thanks for listening. Final sponsor sentence. Compliance disclaimer.",
      segments: [
        { start: 0, end: 20, text: "Thanks for listening." },
        { start: 20, end: 22, text: "Final sponsor sentence." },
        { start: 22, end: 30, text: "Compliance disclaimer." }
      ]
    };
    const responses = [
      {
        choices: [
          {
            message: {
              content:
                "{\"adSegments\":[{\"startTime\":20,\"endTime\":22,\"action\":\"remove\",\"confidence\":0.95,\"reason\":\"commercial block\",\"advertiser\":\"Example Sponsor\"}]}"
            }
          }
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
      },
      { choices: [{ message: { content: "{\"adSegments\":[]}" } }], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } },
      {
        choices: [
          {
            message: {
              content:
                "{\"reviews\":[{\"id\":0,\"action\":\"remove\",\"confidence\":0.95,\"reason\":\"commercial block\",\"startTime\":20,\"endTime\":22,\"advertiser\":\"Example Sponsor\"}]}"
            }
          }
        ],
        usage: { prompt_tokens: 60, completion_tokens: 10, total_tokens: 70 }
      }
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const payload = responses.shift() ?? { choices: [{ message: { content: "{\"adSegments\":[]}" } }] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    });

    const config: AppConfig = {
      ...defaultConfig,
      llm: {
        ...defaultConfig.llm,
        provider: "openai-compatible",
        enabled: true,
        model: "test-model"
      },
      podcasts: {
        sample: {
          name: "Sample",
          feedUrl: "https://example.com/feed.xml"
        }
      }
    };
    const podcast = resolvePodcastConfig(config, "sample");
    const episode: ParsedEpisode = {
      raw: {},
      key: "episode",
      guid: "episode",
      title: "Episode",
      description: "",
      transcripts: [],
      chapters: [],
      sourceFingerprint: "fingerprint"
    };

    const result = await classifyTranscriptWithTextLlm(podcast, episode, endingTranscript);

    expect(result.decisions[0]).toMatchObject({
      start: 20,
      end: 30,
      action: "remove"
    });
    expect(result.decisions[0].reason).toContain("ending ad tail");
    expect(result.modelNotes?.some((note) => note.includes("Extended 1 approved ending ad cuts"))).toBe(true);
  });

  it("uses word ids from aligned boundary review for final splice timing", async () => {
    process.env.TEXT_LLM_API_KEY = "test-key";
    process.env.TEXT_LLM_BASE_URL = "https://llm.example/v1";
    process.env.TEXT_LLM_PROVIDER_LABEL = "Test LLM";

    const alignedTranscript: Transcript = {
      source: "fixture+alignment:elevenlabs-targeted",
      format: "json",
      text: "Editorial setup. This episode is brought to you by Example. Visit example dot com. Editorial resumes.",
      segments: [
        { start: 100, end: 104, text: "Editorial setup." },
        { start: 104, end: 110, text: "This episode is brought to you by Example." },
        { start: 110, end: 116, text: "Visit example dot com." },
        { start: 116, end: 122, text: "Editorial resumes." }
      ],
      words: [
        { text: "Editorial", start: 100, end: 100.4, segmentIndex: 0 },
        { text: "setup.", start: 100.5, end: 101, segmentIndex: 0 },
        { text: "This", start: 104.1, end: 104.3, segmentIndex: 1 },
        { text: "episode", start: 104.4, end: 104.8, segmentIndex: 1 },
        { text: "is", start: 104.9, end: 105, segmentIndex: 1 },
        { text: "brought", start: 105.1, end: 105.5, segmentIndex: 1 },
        { text: "Visit", start: 110.1, end: 110.4, segmentIndex: 2 },
        { text: "example", start: 110.5, end: 111, segmentIndex: 2 },
        { text: "com.", start: 111.1, end: 111.4, segmentIndex: 2 },
        { text: "Editorial", start: 116, end: 116.5, segmentIndex: 3 },
        { text: "resumes.", start: 116.6, end: 117, segmentIndex: 3 }
      ]
    };
    let requestBody = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      requestBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  "{\"reviews\":[{\"id\":0,\"action\":\"remove\",\"confidence\":0.97,\"reason\":\"paid read\",\"advertiser\":\"Example\",\"startWord\":2,\"endWord\":8}]}"
              }
            }
          ],
          usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const config: AppConfig = {
      ...defaultConfig,
      llm: {
        ...defaultConfig.llm,
        provider: "openai-compatible",
        enabled: true,
        model: "test-model"
      },
      podcasts: {
        sample: {
          name: "Sample",
          feedUrl: "https://example.com/feed.xml"
        }
      }
    };
    const podcast = resolvePodcastConfig(config, "sample");
    const episode: ParsedEpisode = {
      raw: {},
      key: "episode",
      guid: "episode",
      title: "Episode",
      description: "",
      transcripts: [],
      chapters: [],
      sourceFingerprint: "fingerprint"
    };

    const result = await reviewAlignedCutBoundariesWithTextLlm(podcast, episode, alignedTranscript, [
      {
        start: 100,
        end: 120,
        action: "remove",
        confidence: 0.95,
        reason: "commercial block",
        advertiser: "Example",
        source: "model"
      }
    ]);

    const requestPayload = JSON.parse(requestBody) as { messages: Array<{ content: string }> };
    expect(requestPayload.messages[1].content).toContain("\"words\"");
    expect(result.decisions[0]).toMatchObject({
      start: 104.1,
      end: 111.4,
      action: "remove",
      advertiser: "Example",
      alignment: {
        startSegmentIndex: 1,
        endSegmentIndex: 2,
        method: "forced-word"
      }
    });
    expect(result.llmUsage[0]).toMatchObject({ purpose: "boundary-review", model: "test-model" });
    expect(result.notes[0]).toContain("Aligned boundary review checked 1 candidate cuts");
  });

  it("does not fail a whole episode when a supplemental edge audit returns blank content", async () => {
    process.env.TEXT_LLM_API_KEY = "test-key";
    process.env.TEXT_LLM_BASE_URL = "https://llm.example/v1";
    process.env.TEXT_LLM_PROVIDER_LABEL = "Test LLM";

    const responses = [
      { choices: [{ message: { content: "{\"adSegments\":[]}" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      { choices: [{ message: { content: "" } }] },
      { choices: [{ message: { content: "" } }] },
      { choices: [{ message: { content: "" } }] }
    ];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const payload = responses.shift() ?? { choices: [{ message: { content: "{\"adSegments\":[]}" } }] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    });

    const config: AppConfig = {
      ...defaultConfig,
      llm: {
        ...defaultConfig.llm,
        provider: "openai-compatible",
        enabled: true,
        model: "test-model"
      },
      podcasts: {
        sample: {
          name: "Sample",
          feedUrl: "https://example.com/feed.xml"
        }
      }
    };
    const podcast = resolvePodcastConfig(config, "sample");
    const episode: ParsedEpisode = {
      raw: {},
      key: "episode",
      guid: "episode",
      title: "Episode",
      description: "",
      transcripts: [],
      chapters: [],
      sourceFingerprint: "fingerprint"
    };

    const result = await classifyTranscriptWithTextLlm(podcast, episode, transcript);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.decisions).toEqual([]);
    expect(result.modelNotes?.[0]).toContain("opening edge audit skipped");
  });

  it("generates timestamped descriptive chapters and merges near-duplicates", async () => {
    process.env.TEXT_LLM_API_KEY = "test-key";
    process.env.TEXT_LLM_BASE_URL = "https://llm.example/v1";
    process.env.TEXT_LLM_PROVIDER_LABEL = "Test LLM";

    let requestBody = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      requestBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  "{\"chapters\":[{\"startTime\":0,\"title\":\"Intro\"},{\"startTime\":120,\"title\":\"NRL\"},{\"startTime\":240,\"title\":\"NRL Team News\"},{\"startTime\":300,\"title\":\"NRL Team News and Injuries\"},{\"startTime\":900,\"title\":\"Kohli Retirement Fallout\"},{\"startTime\":1200,\"title\":\"Sponsor Ad\"}]}"
              }
            }
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const config: AppConfig = {
      ...defaultConfig,
      llm: {
        ...defaultConfig.llm,
        provider: "openai-compatible",
        enabled: true,
        model: "test-model"
      },
      podcasts: {
        sample: {
          name: "Sample",
          feedUrl: "https://example.com/feed.xml"
        }
      }
    };
    const podcast = resolvePodcastConfig(config, "sample");
    const result = await generateChaptersWithTextLlm(podcast, {
      source: "fixture",
      format: "json",
      text: "first segment second segment",
      segments: [
        { start: 0, end: 10, text: "first segment" },
        { start: 10, end: 20, text: "second segment" }
      ]
    });

    expect(requestBody).toContain("[0:00-0:10] first segment");
    expect(result.chapters.map((chapter) => chapter.title)).toEqual(["NRL Team News", "Kohli Retirement Fallout"]);
  });
});
