import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const specPath = process.argv[2];
if (!specPath) {
  console.error("usage: node scripts/openrouter-boundary-benchmark.mjs /path/to/boundary-case.json");
  process.exit(1);
}

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("OPENROUTER_API_KEY is required");
  process.exit(1);
}

const spec = JSON.parse(await readFile(specPath, "utf8"));
const root = spec.root ? path.resolve(spec.root) : path.dirname(path.resolve(specPath));
const models = (process.env.BOUNDARY_MODELS ? process.env.BOUNDARY_MODELS.split(",") : spec.models ?? [])
  .map((value) => String(value).trim())
  .filter(Boolean);
if (models.length === 0) {
  console.error("case spec must define models, or set BOUNDARY_MODELS");
  process.exit(1);
}

const transcript = spec.transcriptPath ? JSON.parse(await readFile(resolveCasePath(spec.transcriptPath), "utf8")) : { segments: [] };
const manifest = spec.manifestPath ? JSON.parse(await readFile(resolveCasePath(spec.manifestPath), "utf8")) : {};
const candidates = spec.candidates ?? [];
if (candidates.length === 0) {
  console.error("case spec must define candidates");
  process.exit(1);
}

const outputDir = resolveCasePath(spec.outputDir ?? "benchmark");
await mkdir(outputDir, { recursive: true });

const priorDecisions = Object.fromEntries(
  (manifest.decisions ?? []).map((decision) => [
    nearestCandidateId(decision.start, candidates),
    {
      start: decision.start,
      end: decision.end,
      action: decision.action,
      confidence: decision.confidence,
      reason: decision.reason,
      advertiser: decision.advertiser
    }
  ])
);

const runStarted = new Date().toISOString();
const results = [];
for (const model of models) {
  for (const candidate of candidates) {
    const result = await evaluateCandidate(model, candidate).catch((error) => ({
      model,
      candidate: candidate.id,
      elapsedMs: 0,
      usage: undefined,
      prompt: "",
      rawContent: "",
      refined: { cutSegments: [], error: String(error) },
      score: { ok: false, reason: "request failed", error: String(error) }
    }));
    results.push(result);
    console.log(
      JSON.stringify({
        model,
        candidate: candidate.id,
        costUsd: result.usage?.costUsd,
        score: result.score,
        refined: result.refined
      })
    );
  }
}

const summary = summarize(results);
const out = { runStarted, root, models, candidates, summary, results };
const outputPath = path.join(outputDir, `boundary-${Date.now()}.json`);
await writeFile(outputPath, JSON.stringify(out, null, 2), "utf8");
console.log(`wrote ${outputPath}`);
console.log(JSON.stringify(summary, null, 2));

async function evaluateCandidate(model, candidate) {
  const audioPath = resolveCasePath(candidate.clip);
  const audioBase64 = (await readFile(audioPath)).toString("base64");
  const nearbyTranscript = (transcript.segments ?? [])
    .map((segment, index) => ({ index, start: segment.start, end: segment.end, text: segment.text }))
    .filter((segment) => segment.end >= candidate.sourceStart - 8 && segment.start <= candidate.sourceEnd + 8);
  const prompt = buildPrompt(candidate, nearbyTranscript, candidate.existingDecision ?? priorDecisions[candidate.id]);
  const started = Date.now();
  const response = await postAudio(model, prompt, audioBase64);
  const elapsedMs = Date.now() - started;
  const refined = normalizeRefinedResponse(parseJsonObject(response.content));
  const score = scoreCandidate(candidate.expected ?? [], refined.cutSegments ?? []);
  return {
    model,
    candidate: candidate.id,
    elapsedMs,
    usage: response.usage,
    prompt,
    rawContent: response.content,
    refined,
    score
  };
}

function buildPrompt(candidate, nearbyTranscript, existingDecision) {
  return [
    "You refine podcast ad-removal boundaries from audio plus transcript context.",
    "Return strict JSON only with this shape:",
    "{\"cutSegments\":[{\"start\":number,\"end\":number,\"action\":\"remove\"|\"mark-only\"|\"keep\",\"confidence\":number,\"advertiser\":\"short name\",\"reason\":\"2-6 words\",\"boundaryEvidence\":\"brief\"}],\"notes\":[\"brief\"]}",
    "Rules:",
    "- Times are absolute seconds on the original source episode timeline, not clip-relative.",
    "- Use the audio to place boundaries to the nearest 0.1 seconds when possible.",
    "- Remove paid ads, promo reads, commercial calls to action, inserted ad blocks, ad music beds, disclaimers, and post-roll ads.",
    "- Preserve editorial banter and do not cut normal content just because it mentions a brand, team, venue, or person.",
    "- If a transcript segment mixes editorial and ad copy, split inside the segment using audio timing.",
    "- Return final renderable cut windows, not a list of individual sponsors.",
    "- If there is no editorial content between adjacent ads, merge them into one continuous cut.",
    "- Include intro/outro/interstitial ad music or stingers when they are part of an ad break.",
    "- Prefer a slightly late start and slightly early end over deleting real editorial speech.",
    `Clip source range: ${Number(candidate.sourceStart).toFixed(3)}-${Number(candidate.sourceEnd).toFixed(3)} seconds.`,
    candidate.instructions ? `Case instructions: ${candidate.instructions}` : undefined,
    `Existing broad decision: ${existingDecision ? JSON.stringify(existingDecision) : "none"}`,
    "Transcript near clip:",
    JSON.stringify(nearbyTranscript)
  ]
    .filter(Boolean)
    .join("\n");
}

async function postAudio(model, prompt, audioBase64) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 240_000);
  let payload;
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "http-referer": "http://localhost:3729",
        "x-title": "podcastoor-boundary-benchmark"
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "input_audio",
                input_audio: {
                  data: audioBase64,
                  format: "mp3"
                }
              }
            ]
          }
        ],
        temperature: 0,
        max_tokens: 900,
        response_format: { type: "json_object" },
        reasoning: { enabled: false },
        reasoning_effort: "none"
      }),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${model} failed: ${response.status} ${text}`);
    payload = JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
  const content = extractText(payload.choices?.[0]?.message?.content);
  const directUsage = usageFromPayload(payload, model);
  const generationUsage = directUsage.costUsd == null && payload.id ? await fetchGenerationUsage(payload.id, model) : undefined;
  return {
    content,
    usage: {
      ...directUsage,
      ...Object.fromEntries(Object.entries(generationUsage ?? {}).filter(([, value]) => value != null))
    }
  };
}

async function fetchGenerationUsage(id, model) {
  try {
    const response = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${apiKey}` }
    });
    if (!response.ok) return undefined;
    const payload = await response.json();
    const data = payload.data ?? {};
    return {
      model: data.model ?? model,
      generationId: id,
      promptTokens: numberOrUndefined(data.native_tokens_prompt ?? data.tokens_prompt),
      completionTokens: numberOrUndefined(data.native_tokens_completion ?? data.tokens_completion),
      costUsd: numberOrUndefined(data.total_cost ?? data.usage)
    };
  } catch {
    return undefined;
  }
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "")).join("");
  }
  return "";
}

function parseJsonObject(content) {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return { cutSegments: [], parseError: content.slice(0, 500) };
    try {
      return JSON.parse(match[0]);
    } catch {
      return { cutSegments: [], parseError: content.slice(0, 500) };
    }
  }
}

function normalizeRefinedResponse(value) {
  if (Array.isArray(value) && value.length === 1 && value[0]?.cutSegments) return value[0];
  if (Array.isArray(value) && value.every((entry) => entry?.start != null && entry?.end != null)) return { cutSegments: value };
  return value && typeof value === "object" ? value : { cutSegments: [] };
}

function usageFromPayload(payload, fallbackModel) {
  const usage = payload.usage ?? {};
  return {
    model: payload.model ?? fallbackModel,
    generationId: payload.id,
    promptTokens: numberOrUndefined(usage.prompt_tokens),
    completionTokens: numberOrUndefined(usage.completion_tokens),
    totalTokens: numberOrUndefined(usage.total_tokens),
    costUsd: numberOrUndefined(usage.cost)
  };
}

function scoreCandidate(expected, actual) {
  const expectedRemove = expected.filter((entry) => entry.action === "remove");
  const actualRemove = mergeCutSegments(actual.filter((entry) => entry.action === "remove"));
  if (expectedRemove.length !== actualRemove.length) {
    return { ok: false, reason: "count mismatch", expected: expectedRemove.length, actual: actualRemove.length };
  }
  const pairs = expectedRemove.map((target, index) => {
    const found = actualRemove[index];
    const startError = Math.abs(Number(found.start) - target.start);
    const endError = Math.abs(Number(found.end) - target.end);
    return {
      startError: Number(startError.toFixed(3)),
      endError: Number(endError.toFixed(3)),
      maxError: Number(Math.max(startError, endError).toFixed(3))
    };
  });
  const maxError = Math.max(...pairs.map((pair) => pair.maxError), 0);
  return {
    ok: maxError <= 1,
    maxError,
    pairs
  };
}

function mergeCutSegments(segments) {
  const sorted = segments
    .map((segment) => ({ ...segment, start: Number(segment.start), end: Number(segment.end) }))
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const segment of sorted) {
    const previous = merged.at(-1);
    if (previous && segment.start <= previous.end + 0.35) {
      previous.end = Math.max(previous.end, segment.end);
      continue;
    }
    merged.push(segment);
  }
  return merged;
}

function summarize(results) {
  const byModel = {};
  for (const result of results) {
    const entry =
      byModel[result.model] ??
      (byModel[result.model] = {
        candidates: 0,
        withinOneSecond: 0,
        maxBoundaryError: 0,
        costUsd: 0,
        elapsedMs: 0
      });
    entry.candidates += 1;
    if (result.score.ok) entry.withinOneSecond += 1;
    if (typeof result.score.maxError === "number") entry.maxBoundaryError = Math.max(entry.maxBoundaryError, result.score.maxError);
    entry.costUsd += result.usage?.costUsd ?? 0;
    entry.elapsedMs += result.elapsedMs;
  }
  for (const entry of Object.values(byModel)) {
    entry.costUsd = Number(entry.costUsd.toFixed(6));
    entry.avgElapsedMs = Math.round(entry.elapsedMs / Math.max(1, entry.candidates));
    delete entry.elapsedMs;
  }
  return { byModel };
}

function nearestCandidateId(time, candidates) {
  let best = candidates[0]?.id;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance =
      time >= candidate.sourceStart && time <= candidate.sourceEnd ? 0 : Math.min(Math.abs(time - candidate.sourceStart), Math.abs(time - candidate.sourceEnd));
    if (distance < bestDistance) {
      best = candidate.id;
      bestDistance = distance;
    }
  }
  return best;
}

function resolveCasePath(value) {
  return path.isAbsolute(value) ? value : path.join(root, value);
}

function numberOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
