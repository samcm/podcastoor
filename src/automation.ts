import pino from "pino";
import type { AppConfig } from "./types.js";
import { processFeeds } from "./processor.js";

export interface AutomationState {
  running: boolean;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastError?: string;
  lastSummary?: unknown;
}

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const state: AutomationState = { running: false };

export function getAutomationState(): AutomationState {
  return { ...state };
}

export function startAutomation(configPath: string, config: AppConfig): void {
  if (!config.automation.enabled) return;

  const run = async (reason: string) => {
    if (state.running) {
      logger.info({ reason }, "automation skipped because processing is already running");
      return;
    }
    state.running = true;
    state.lastStartedAt = new Date().toISOString();
    state.lastError = undefined;
    logger.info({ reason }, "automation processing started");
    try {
      state.lastSummary = await processFeeds({
        configPath,
        dryRun: config.processing.dryRun,
        downloadAudio: config.processing.downloadAudio,
        force: false
      });
      state.lastFinishedAt = new Date().toISOString();
      logger.info({ summary: state.lastSummary }, "automation processing finished");
    } catch (error) {
      state.lastError = String(error);
      state.lastFinishedAt = new Date().toISOString();
      logger.error({ error }, "automation processing failed");
    } finally {
      state.running = false;
    }
  };

  if (config.automation.processOnStartup) {
    setTimeout(() => void run("startup"), 250);
  }

  const intervalMs = Math.max(1, config.automation.intervalMinutes) * 60 * 1000;
  setInterval(() => void run("interval"), intervalMs).unref();
}
