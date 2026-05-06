import { writeFile } from "node:fs/promises";
import type { AppConfig, ParsedFeed } from "./types.js";
import { podcastAssetPaths } from "./storage.js";
import { ensureDir, pathExists, writeJson } from "./utils.js";

export interface ArtworkResult {
  status: "disabled" | "exists" | "skipped" | "generated";
  path?: string;
  sourceUrl?: string;
  model?: string;
}

export async function ensurePodcastArtwork(config: AppConfig, podcastSlug: string, feed: ParsedFeed): Promise<ArtworkResult> {
  if (!config.artwork.enabled) return { status: "disabled" };
  const paths = podcastAssetPaths(config, podcastSlug);
  if (await pathExists(paths.artwork)) {
    return { status: "exists", path: paths.artwork, sourceUrl: feed.imageUrl, model: config.artwork.model };
  }
  if (!feed.imageUrl) return { status: "skipped", model: config.artwork.model };
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required when artwork.enabled=true");

  const sourceImage = await fetchSourceImage(feed.imageUrl);
  const generated = await generateStampedArtwork({
    apiKey,
    model: config.artwork.model,
    imageSize: config.artwork.imageSize,
    stampText: config.artwork.stampText,
    sourceBase64: sourceImage.base64,
    sourceMimeType: sourceImage.mimeType,
    podcastTitle: feed.title
  });

  await ensureDir(paths.dir);
  await writeFile(paths.artwork, generated.bytes);
  await writeJson(paths.artworkMeta, {
    generatedAt: new Date().toISOString(),
    model: config.artwork.model,
    sourceUrl: feed.imageUrl,
    sourceMimeType: sourceImage.mimeType,
    outputMimeType: generated.mimeType,
    costUsd: generated.costUsd
  });
  return { status: "generated", path: paths.artwork, sourceUrl: feed.imageUrl, model: config.artwork.model };
}

async function fetchSourceImage(url: string): Promise<{ base64: string; mimeType: string }> {
  const response = await fetch(url, {
    headers: { "user-agent": "PodcastProxyV1/0.1 (+https://example.local/podcast-proxy)" }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch podcast artwork ${url}: ${response.status} ${response.statusText}`);
  }
  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || mimeFromUrl(url) || "image/jpeg";
  if (!mimeType.startsWith("image/")) {
    throw new Error(`Podcast artwork URL did not return an image: ${mimeType}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  return { base64: bytes.toString("base64"), mimeType };
}

async function generateStampedArtwork(params: {
  apiKey: string;
  model: string;
  imageSize: "1K" | "2K" | "4K";
  stampText: string;
  sourceBase64: string;
  sourceMimeType: string;
  podcastTitle: string;
}): Promise<{ bytes: Buffer; mimeType: string; costUsd?: number }> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      "content-type": "application/json",
      "HTTP-Referer": "http://localhost:3729",
      "X-OpenRouter-Title": "podcast-proxy-v1"
    },
    body: JSON.stringify({
      model: params.model,
      modalities: ["image", "text"],
      image_config: {
        aspect_ratio: "1:1",
        image_size: params.imageSize
      },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:${params.sourceMimeType};base64,${params.sourceBase64}`
              }
            },
            {
              type: "text",
              text: [
                `Edit this podcast cover artwork for "${params.podcastTitle}".`,
                "Preserve the original artwork, show title, logo, typography, composition, colors, and square podcast-cover layout.",
                `Add one bold legal-case style red rubber stamp that reads exactly "${params.stampText}" across the lower-right area.`,
                "The stamp should be obvious in a small podcast app list but must not fully obscure the title or face/logo.",
                "Do not invent new branding, do not rewrite existing cover text, and do not add any other words."
              ].join(" ")
            }
          ]
        }
      ]
    })
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`OpenRouter artwork generation failed: ${response.status} ${body}`);
  }
  const payload = JSON.parse(body) as {
    choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }>;
    usage?: { cost?: number };
  };
  const imageUrl = payload.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!imageUrl) {
    throw new Error(`OpenRouter artwork generation returned no image: ${body.slice(0, 500)}`);
  }
  const image = await imageBytesFromUrl(imageUrl);
  return { ...image, costUsd: numberOrUndefined(payload.usage?.cost) };
}

async function imageBytesFromUrl(url: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const dataUrl = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (dataUrl) {
    return { mimeType: dataUrl[1], bytes: Buffer.from(dataUrl[2], "base64") };
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch generated artwork: ${response.status} ${response.statusText}`);
  return {
    mimeType: response.headers.get("content-type")?.split(";")[0]?.trim() || mimeFromUrl(url) || "image/png",
    bytes: Buffer.from(await response.arrayBuffer())
  };
}

function mimeFromUrl(url: string): string | undefined {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith(".png")) return "image/png";
  if (pathname.endsWith(".webp")) return "image/webp";
  if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) return "image/jpeg";
  return undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
