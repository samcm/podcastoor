#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { defaultConfigPath, loadConfig } from "./config.js";
import { processFeeds } from "./processor.js";
import { startServer } from "./server.js";
import { benchmarkTranscripts, runSampleBenchmark } from "./benchmark.js";
import { parsePodcastIndexJson, parseVtt } from "./transcripts.js";
import { normalizeStoredManifestsFromConfig } from "./maintenance.js";

const program = new Command();

program
  .name("podcast-proxy-v1")
  .description("RSS podcast proxy for conservative ad filtering, transcripts, and chapters.")
  .option("-c, --config <path>", "config file", defaultConfigPath());

program
  .command("bootstrap")
  .description("Validate config and print subscription URLs.")
  .action(async () => {
    const config = await loadConfig(program.opts().config);
    console.log("Config OK");
    for (const slug of Object.keys(config.podcasts)) {
      console.log(`${config.podcasts[slug].name}: ${config.server.publicBaseUrl}/feeds/${slug}.xml`);
    }
  });

program
  .command("server")
  .description("Start the RSS and asset server.")
  .option("--host <host>", "override host")
  .option("--port <port>", "override port", parseInt)
  .action(async (opts) => {
    const configPath = program.opts().config;
    await startServer(configPath, { host: opts.host, port: opts.port });
  });

program
  .command("worker")
  .description("Run autonomous processing without serving HTTP.")
  .action(async () => {
    const configPath = program.opts().config;
    const config = await loadConfig(configPath);
    if (!config.automation.enabled) {
      console.log(JSON.stringify({ at: new Date().toISOString(), message: "automation disabled; worker exiting" }));
      return;
    }
    const intervalMs = Math.max(1, config.automation.intervalMinutes) * 60 * 1000;
    let firstRun = true;
    while (true) {
      if (!firstRun || config.automation.processOnStartup) {
        try {
          const summary = await processFeeds({
            configPath,
            dryRun: config.processing.dryRun,
            downloadAudio: config.processing.downloadAudio,
            force: false
          });
          console.log(JSON.stringify({ at: new Date().toISOString(), summary }, null, 2));
        } catch (error) {
          console.error(error);
        }
      }
      firstRun = false;
      await delay(intervalMs);
    }
  });

program
  .command("process")
  .description("Process recent episodes from configured feeds.")
  .option("--podcast <slug>", "only process one podcast")
  .option("--episode-key <key>", "only process one episode key")
  .option("--max-episodes <count>", "max episodes per podcast", (value) => Number(value))
  .option("--dry-run", "write manifests without downloading/rendering audio")
  .option("--no-dry-run", "render audio if download is also enabled")
  .option("--download-audio", "download and render audio")
  .option("--force", "reprocess even when manifest matches")
  .option("--full-reprocess", "reacquire transcript and rebuild artifacts instead of reusing cached transcript")
  .action(async (opts) => {
    const summary = await processFeeds({
      configPath: program.opts().config,
      podcastSlug: opts.podcast,
      episodeKey: opts.episodeKey,
      maxEpisodes: opts.maxEpisodes,
      dryRun: opts.dryRun,
      downloadAudio: opts.downloadAudio,
      force: opts.force,
      fullReprocess: opts.fullReprocess
    });
    console.log(JSON.stringify(summary, null, 2));
  });

program
  .command("benchmark")
  .description("Compare two transcript files, or run a small built-in benchmark.")
  .option("--reference <path>", "reference transcript (.vtt or PodcastIndex JSON)")
  .option("--candidate <path>", "candidate transcript (.vtt or PodcastIndex JSON)")
  .action(async (opts) => {
    if (!opts.reference || !opts.candidate) {
      console.log(JSON.stringify(runSampleBenchmark(), null, 2));
      return;
    }
    const reference = await readTranscriptFile(opts.reference);
    const candidate = await readTranscriptFile(opts.candidate);
    console.log(JSON.stringify(benchmarkTranscripts(reference, candidate), null, 2));
  });

program
  .command("normalize")
  .description("Normalize stored manifests after pipeline rule changes.")
  .action(async () => {
    console.log(JSON.stringify(await normalizeStoredManifestsFromConfig(program.opts().config), null, 2));
  });

async function readTranscriptFile(filePath: string) {
  const body = await readFile(filePath, "utf8");
  return body.trim().startsWith("{") ? parsePodcastIndexJson(body, filePath) : parseVtt(body, filePath);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

program.parseAsync().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
