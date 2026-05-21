import { expect, test } from "vitest";
import {
  alignTranscript,
  applyWordAlignment,
  expandDecisionsAcrossNonSpeechTransitions,
  extendEndingAdDecisions,
  guardDecisionsAgainstContentLoss,
  refineDecisionsWithAlignedWords,
  targetedAlignmentWindowsForDecisions
} from "../src/alignment.js";

test("segment-boundary alignment removes overlapping transcript timings", async () => {
  const result = await alignTranscript(
    { enabled: true, provider: "segment-boundary", model: "segment-boundary-v1", estimatedCostPerMinuteUsd: 0, requireProvider: false },
    {
      source: "fixture",
      format: "json",
      text: "hello world",
      segments: [
        { start: 0, end: 5, text: "hello" },
        { start: 4, end: 8, text: "world" }
      ]
    }
  );

  expect(result.transcript.segments[0].end).toBeLessThanOrEqual(result.transcript.segments[1].start);
  expect(result.metadata?.adjustedSegments).toBeGreaterThan(0);
  expect(result.metadata?.provider).toBe("segment-boundary");
});

test("auto alignment fails instead of falling back without source audio", async () => {
  await expect(
    alignTranscript(
      { enabled: true, provider: "auto", model: "whisperx", estimatedCostPerMinuteUsd: 0, requireProvider: true },
      {
        source: "fixture",
        format: "json",
        text: "hello world",
        segments: [{ start: 0, end: 5, text: "hello world" }]
      }
    )
  ).rejects.toThrow("WhisperX forced alignment requires source audio");
});

test("auto alignment fails when WhisperX is disabled", async () => {
  const previous = process.env.WHISPERX_ALIGN_ENABLED;
  process.env.WHISPERX_ALIGN_ENABLED = "false";
  try {
    await expect(
      alignTranscript(
        { enabled: true, provider: "auto", model: "whisperx", estimatedCostPerMinuteUsd: 0, requireProvider: true },
        {
          source: "fixture",
          format: "json",
          text: "hello world",
          segments: [{ start: 0, end: 5, text: "hello world" }]
        },
        { sourceAudioPath: "/tmp/source.mp3", durationSeconds: 5 }
      )
    ).rejects.toThrow("WHISPERX_ALIGN_ENABLED=false");
  } finally {
    if (previous == null) {
      delete process.env.WHISPERX_ALIGN_ENABLED;
    } else {
      process.env.WHISPERX_ALIGN_ENABLED = previous;
    }
  }
});

test("word alignment remaps segments and refines decision boundaries", () => {
  const config = { enabled: true, provider: "elevenlabs-forced", model: "elevenlabs-forced-alignment", estimatedCostPerMinuteUsd: 0.003667, requireProvider: false } as const;
  const transcript = {
    source: "fixture",
    format: "json",
    text: "real words sponsored offer",
    segments: [
      { start: 0, end: 5, text: "real words" },
      { start: 5, end: 10, text: "sponsored offer" }
    ]
  };
  const aligned = applyWordAlignment(config, transcript, [
    { text: "real", start: 0.2, end: 0.5 },
    { text: "words", start: 0.7, end: 1 },
    { text: "sponsored", start: 6.2, end: 6.8 },
    { text: "offer", start: 7, end: 7.4 }
  ]);

  expect(aligned.transcript.segments[1]).toMatchObject({ start: 6.2, end: 7.4 });
  expect(aligned.transcript.words).toHaveLength(4);

  const refined = refineDecisionsWithAlignedWords(
    [
      {
        start: 5,
        end: 10,
        action: "remove",
        confidence: 0.95,
        reason: "commercial read",
        source: "model",
        alignment: { startSegmentIndex: 1, endSegmentIndex: 1, method: "model-timestamp" }
      }
    ],
    aligned.transcript
  );

  expect(refined.adjustedDecisions).toBe(1);
  expect(refined.decisions[0]).toMatchObject({ start: 6.2, end: 7.4, alignment: { method: "forced-word" } });
});

test("word alignment respects provider segment indexes", () => {
  const config = { enabled: true, provider: "whisperx-local", model: "whisperx", estimatedCostPerMinuteUsd: 0, requireProvider: false } as const;
  const transcript = {
    source: "fixture",
    format: "json",
    text: "one two three sponsor starts",
    segments: [
      { start: 0, end: 10, text: "one two three" },
      { start: 10, end: 20, text: "sponsor starts" }
    ]
  };
  const aligned = applyWordAlignment(config, transcript, [
    { text: "sponsor", start: 12, end: 12.4, segmentIndex: 1 },
    { text: "starts", start: 12.5, end: 13, segmentIndex: 1 },
    { text: "one", start: 1, end: 1.2, segmentIndex: 0 },
    { text: "two", start: 1.3, end: 1.5, segmentIndex: 0 },
    { text: "three", start: 1.7, end: 2, segmentIndex: 0 }
  ], { provider: "whisperx-local", model: "whisperx" });

  expect(aligned.metadata?.provider).toBe("whisperx-local");
  expect(aligned.metadata?.costUsd).toBeUndefined();
  expect(aligned.transcript.segments[0]).toMatchObject({ start: 1, end: 2 });
  expect(aligned.transcript.segments[1]).toMatchObject({ start: 12, end: 13 });
  expect(aligned.transcript.words?.map((word) => word.segmentIndex)).toEqual([0, 0, 0, 1, 1]);
});

test("targeted ElevenLabs alignment windows cover only confident removal candidates", () => {
  const transcript = {
    source: "openrouter-audio-chat:mimo",
    format: "json",
    text: "intro ad one ad two show content outro",
    segments: [
      { start: 0, end: 10, text: "intro" },
      { start: 10, end: 20, text: "ad one" },
      { start: 20, end: 30, text: "ad two" },
      { start: 30, end: 50, text: "show content" },
      { start: 50, end: 60, text: "outro" }
    ]
  };

  const windows = targetedAlignmentWindowsForDecisions(
    transcript,
    [
      { start: 10, end: 18, action: "remove", confidence: 0.9, reason: "commercial", source: "model" },
      { start: 21, end: 28, action: "remove", confidence: 0.92, reason: "commercial", source: "model" },
      { start: 50, end: 55, action: "remove", confidence: 0.4, reason: "weak", source: "model" }
    ],
    {
      enabled: true,
      provider: "elevenlabs-targeted",
      model: "elevenlabs-forced-alignment",
      estimatedCostPerMinuteUsd: 0.003667,
      requireProvider: true,
      targetContextSeconds: 5,
      targetMaxWindows: 4,
      targetMaxClipSeconds: 60
    },
    { durationSeconds: 60, confidenceThreshold: 0.65 }
  );

  expect(windows).toHaveLength(1);
  expect(windows[0]).toMatchObject({ start: 5, end: 33, decisionIndexes: [0, 1] });
  expect(windows[0].text).toContain("ad one");
  expect(windows[0].text).toContain("show content");
});

test("targeted ElevenLabs alignment limits context before clipping candidate audio", () => {
  const transcript = {
    source: "fixture",
    format: "json",
    text: "long commercial",
    segments: [{ start: 0, end: 200, text: "long commercial" }]
  };

  const windows = targetedAlignmentWindowsForDecisions(
    transcript,
    [{ start: 50, end: 110, action: "remove", confidence: 0.95, reason: "commercial", source: "model" }],
    {
      enabled: true,
      provider: "elevenlabs-targeted",
      model: "elevenlabs-forced-alignment",
      estimatedCostPerMinuteUsd: 0.003667,
      requireProvider: true,
      targetContextSeconds: 30,
      targetMaxWindows: 4,
      targetMaxClipSeconds: 80
    },
    { durationSeconds: 200, confidenceThreshold: 0.65 }
  );

  expect(windows[0]).toMatchObject({ start: 40, end: 120 });
});

test("reuses an already forced-aligned transcript", async () => {
  const transcript = {
    source: "openrouter-audio-chat:test+alignment:whisperx-local",
    format: "json",
    text: "hello world",
    segments: [{ start: 1, end: 2, text: "hello world" }],
    words: [
      { text: "hello", start: 1, end: 1.4, confidence: 0.8, segmentIndex: 0 },
      { text: "world", start: 1.5, end: 2, confidence: 0.9, segmentIndex: 0 }
    ]
  };

  const result = await alignTranscript(
    { enabled: true, provider: "auto", model: "whisperx", estimatedCostPerMinuteUsd: 0, requireProvider: true },
    transcript,
    { durationSeconds: 2 }
  );

  expect(result.transcript).toBe(transcript);
  expect(result.metadata).toMatchObject({
    provider: "whisperx-local",
    confidence: 0.85,
    wordCount: 2,
    costUsd: 0
  });
});

test("word alignment fails hard when a required provider returns no words", () => {
  const config = { enabled: true, provider: "whisperx-local", model: "whisperx", estimatedCostPerMinuteUsd: 0, requireProvider: true } as const;
  expect(() =>
    applyWordAlignment(
      config,
      {
        source: "fixture",
        format: "json",
        text: "hello world",
        segments: [{ start: 0, end: 3, text: "hello world" }]
      },
      [],
      { provider: "whisperx-local", model: "whisperx" }
    )
  ).toThrow("returned no word timestamps");
});

test("word alignment uses model anchor text to split mixed boundary segments", () => {
  const config = { enabled: true, provider: "whisperx-local", model: "whisperx", estimatedCostPerMinuteUsd: 0, requireProvider: false } as const;
  const transcript = {
    source: "fixture",
    format: "json",
    text: "editorial words pause the listeners ad copy",
    segments: [{ start: 100, end: 110, text: "editorial words pause the listeners ad copy" }]
  };
  const aligned = applyWordAlignment(config, transcript, [
    { text: "editorial", start: 100.2, end: 100.7, segmentIndex: 0 },
    { text: "words", start: 100.9, end: 101.2, segmentIndex: 0 },
    { text: "pause", start: 102.1, end: 102.4, segmentIndex: 0 },
    { text: "the", start: 102.45, end: 102.55, segmentIndex: 0 },
    { text: "listeners", start: 102.6, end: 103.1, segmentIndex: 0 },
    { text: "ad", start: 103.3, end: 103.5, segmentIndex: 0 },
    { text: "copy", start: 103.6, end: 104, segmentIndex: 0 }
  ]);

  const refined = refineDecisionsWithAlignedWords(
    [
      {
        start: 100,
        end: 110,
        action: "remove",
        confidence: 0.95,
        reason: "commercial read",
        source: "model",
        alignment: {
          startSegmentIndex: 0,
          endSegmentIndex: 0,
          method: "model-timestamp",
          startAnchorText: "pause the listeners",
          endAnchorText: "ad copy"
        }
      }
    ],
    aligned.transcript
  );

  expect(refined.decisions[0]).toMatchObject({ start: 102.1, end: 104, alignment: { method: "forced-word" } });
});

test("word alignment uses anchors outside rough model timestamp bounds", () => {
  const config = { enabled: true, provider: "elevenlabs-targeted", model: "elevenlabs-forced-alignment", estimatedCostPerMinuteUsd: 0, requireProvider: true } as const;
  const transcript = {
    source: "fixture",
    format: "json",
    text: "show pause sponsor copy final call show resumes",
    segments: [
      { start: 1200, end: 1261, text: "show pause sponsor copy" },
      { start: 1261, end: 1330, text: "final call" },
      { start: 1330, end: 1340, text: "show resumes" }
    ]
  };
  const aligned = applyWordAlignment(config, transcript, [
    { text: "show", start: 1200, end: 1200.2, segmentIndex: 0 },
    { text: "pause", start: 1218, end: 1218.5, segmentIndex: 0 },
    { text: "sponsor", start: 1219, end: 1219.5, segmentIndex: 0 },
    { text: "copy", start: 1260.5, end: 1261, segmentIndex: 0 },
    { text: "final", start: 1261.1, end: 1261.5, segmentIndex: 1 },
    { text: "call", start: 1328, end: 1328.4, segmentIndex: 1 },
    { text: "show", start: 1330, end: 1330.2, segmentIndex: 2 },
    { text: "resumes", start: 1331, end: 1331.4, segmentIndex: 2 }
  ]);

  const refined = refineDecisionsWithAlignedWords(
    [
      {
        start: 1261,
        end: 1328,
        action: "remove",
        confidence: 0.95,
        reason: "commercial read",
        source: "model",
        alignment: {
          startSegmentIndex: 0,
          endSegmentIndex: 1,
          method: "model-timestamp",
          startAnchorText: "pause sponsor",
          endAnchorText: "final call"
        }
      }
    ],
    aligned.transcript
  );

  expect(refined.adjustedDecisions).toBe(1);
  expect(refined.decisions[0]).toMatchObject({
    start: 1218,
    end: 1328.4,
    alignment: { startSegmentIndex: 0, endSegmentIndex: 1, method: "forced-word" }
  });
});

test("word alignment trusts anchor text when model segment indexes are off", () => {
  const config = { enabled: true, provider: "elevenlabs-targeted", model: "elevenlabs-forced-alignment", estimatedCostPerMinuteUsd: 0, requireProvider: true } as const;
  const transcript = {
    source: "fixture",
    format: "json",
    text: "content sponsor starts ad body ad close content",
    segments: [
      { start: 1200, end: 1215, text: "content sponsor starts" },
      { start: 1215, end: 1261, text: "ad body" },
      { start: 1261, end: 1329, text: "ad close" },
      { start: 1329, end: 1340, text: "content" }
    ]
  };
  const aligned = applyWordAlignment(config, transcript, [
    { text: "content", start: 1200, end: 1200.4, segmentIndex: 0 },
    { text: "sponsor", start: 1210, end: 1210.5, segmentIndex: 0 },
    { text: "starts", start: 1210.6, end: 1211, segmentIndex: 0 },
    { text: "ad", start: 1215, end: 1215.2, segmentIndex: 1 },
    { text: "body", start: 1216, end: 1216.4, segmentIndex: 1 },
    { text: "ad", start: 1261, end: 1261.2, segmentIndex: 2 },
    { text: "close", start: 1328, end: 1328.4, segmentIndex: 2 },
    { text: "content", start: 1330, end: 1330.4, segmentIndex: 3 }
  ]);

  const refined = refineDecisionsWithAlignedWords(
    [
      {
        start: 1261,
        end: 1328,
        action: "remove",
        confidence: 0.95,
        reason: "commercial read",
        source: "model",
        alignment: {
          startSegmentIndex: 1,
          endSegmentIndex: 2,
          method: "model-timestamp",
          startAnchorText: "sponsor starts",
          endAnchorText: "ad close"
        }
      }
    ],
    aligned.transcript
  );

  expect(refined.adjustedDecisions).toBe(1);
  expect(refined.decisions[0]).toMatchObject({
    start: 1210,
    end: 1328.4,
    alignment: { startSegmentIndex: 0, endSegmentIndex: 2, method: "forced-word" }
  });
});

test("non-speech transition expansion pulls adjacent ad music into cuts", () => {
  const transcript = {
    source: "fixture",
    format: "json",
    text: "editorial music ad music editorial",
    segments: [
      { start: 0, end: 5, text: "editorial" },
      { start: 5, end: 10, text: "[Music]" },
      { start: 10, end: 20, text: "ad copy" },
      { start: 20, end: 25, text: "[Music]" },
      { start: 25, end: 30, text: "editorial resumes" }
    ]
  };

  const expanded = expandDecisionsAcrossNonSpeechTransitions(
    [
      {
        start: 10,
        end: 20,
        action: "remove",
        confidence: 0.95,
        reason: "commercial read",
        source: "model"
      }
    ],
    transcript
  );

  expect(expanded.expandedDecisions).toBe(1);
  expect(expanded.decisions[0]).toMatchObject({ start: 5, end: 25 });
});

test("content-loss guard moves unanchored mixed boundaries inward", () => {
  const transcript = {
    source: "fixture+alignment:whisperx-local",
    format: "json",
    text: "editorial into ad copy editorial resumes",
    segments: [
      { start: 0, end: 10, text: "editorial into ad copy" },
      { start: 10, end: 20, text: "middle ad copy" },
      { start: 20, end: 30, text: "ad tail editorial resumes" }
    ],
    words: [
      { text: "editorial", start: 0, end: 0.5, segmentIndex: 0 },
      { text: "into", start: 1, end: 1.2, segmentIndex: 0 },
      { text: "ad", start: 6, end: 6.2, segmentIndex: 0 },
      { text: "copy", start: 6.3, end: 6.7, segmentIndex: 0 },
      { text: "middle", start: 10.2, end: 10.5, segmentIndex: 1 },
      { text: "ad", start: 10.6, end: 10.8, segmentIndex: 1 },
      { text: "copy", start: 11, end: 11.3, segmentIndex: 1 },
      { text: "ad", start: 20.2, end: 20.4, segmentIndex: 2 },
      { text: "tail", start: 20.5, end: 20.8, segmentIndex: 2 },
      { text: "editorial", start: 25, end: 25.5, segmentIndex: 2 }
    ]
  };

  const guarded = guardDecisionsAgainstContentLoss(
    [
      {
        start: 6,
        end: 22,
        action: "remove",
        confidence: 0.95,
        reason: "commercial read",
        source: "model",
        alignment: { startSegmentIndex: 0, endSegmentIndex: 2, method: "forced-word" }
      }
    ],
    transcript
  );

  expect(guarded.guardedBoundaries).toBe(2);
  expect(guarded.decisions[0]).toMatchObject({ start: 10, end: 20, action: "remove" });
});

test("content-loss guard allows anchored mixed boundaries", () => {
  const transcript = {
    source: "fixture+alignment:whisperx-local",
    format: "json",
    text: "editorial pause the ad copy resumes",
    segments: [{ start: 0, end: 12, text: "editorial pause the ad copy resumes" }],
    words: [
      { text: "editorial", start: 0, end: 0.5, segmentIndex: 0 },
      { text: "pause", start: 3, end: 3.4, segmentIndex: 0 },
      { text: "the", start: 3.5, end: 3.6, segmentIndex: 0 },
      { text: "ad", start: 3.7, end: 4, segmentIndex: 0 },
      { text: "copy", start: 6, end: 6.3, segmentIndex: 0 },
      { text: "resumes", start: 8, end: 8.5, segmentIndex: 0 }
    ]
  };

  const guarded = guardDecisionsAgainstContentLoss(
    [
      {
        start: 3,
        end: 6.3,
        action: "remove",
        confidence: 0.95,
        reason: "commercial read",
        source: "model",
        alignment: {
          startSegmentIndex: 0,
          endSegmentIndex: 0,
          method: "forced-word",
          startAnchorText: "pause the ad",
          endAnchorText: "ad copy"
        }
      }
    ],
    transcript
  );

  expect(guarded.guardedBoundaries).toBe(0);
  expect(guarded.decisions[0]).toMatchObject({ start: 3, end: 6.3, action: "remove" });
});

test("approved final ad fragments are extended after alignment refinement", () => {
  const transcript = {
    source: "fixture+alignment:whisperx-local",
    format: "json",
    text: "thanks final ad disclaimer",
    segments: [
      { start: 0, end: 20, text: "thanks" },
      { start: 20, end: 22, text: "final ad" },
      { start: 22, end: 30, text: "disclaimer" }
    ],
    words: [
      { text: "thanks", start: 0, end: 1, segmentIndex: 0 },
      { text: "final", start: 20.2, end: 20.5, segmentIndex: 1 },
      { text: "ad", start: 21, end: 21.4, segmentIndex: 1 },
      { text: "disclaimer", start: 24, end: 25, segmentIndex: 2 }
    ]
  };

  const extended = extendEndingAdDecisions(
    [
      {
        start: 20.2,
        end: 21.4,
        action: "remove",
        confidence: 0.95,
        reason: "commercial block",
        source: "model",
        alignment: { startSegmentIndex: 1, endSegmentIndex: 1, method: "forced-word" }
      }
    ],
    transcript
  );

  expect(extended.extendedDecisions).toBe(1);
  expect(extended.decisions[0]).toMatchObject({ start: 20.2, end: 30, action: "remove", alignment: { endSegmentIndex: 2 } });
  expect(extended.decisions[0].reason).toContain("ending ad tail");
});
