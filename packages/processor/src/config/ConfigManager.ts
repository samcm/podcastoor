import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { watch } from 'chokidar';
import { 
  PodcastConfig, 
  PodcastConfigSchema, 
  validateConfig 
} from '@podcastoor/shared';

export interface AppConfig {
  podcasts: PodcastConfig[];
  dataDir: string;
  processing: {
    concurrency: number;
    defaultRetentionDays: number;
    maxDuration: number;
    timeoutMinutes: number;
    minAdDuration: number;
  };
  llm: {
    geminiApiKey: string;
    models: {
      geminiAudio: string;
    };
  };
  storage: {
    publicUrl?: string;
  };
}

export class ConfigManager {
  private config: AppConfig;
  private configFilePath: string;
  private watcher?: any;
  private changeCallbacks: Set<(config: AppConfig) => void> = new Set();

  constructor(configPath: string) {
    // Support CONFIG_FILE env var for specifying a different config file
    const configFile = process.env.CONFIG_FILE || 'config.yaml';
    this.configFilePath = join(configPath, configFile);
    console.log(`📋 Loading configuration from: ${this.configFilePath}`);
    this.config = this.loadConfig();
  }

  static async fromFile(configPath: string): Promise<ConfigManager> {
    return new ConfigManager(configPath);
  }

  private loadConfig(): AppConfig {
    if (!existsSync(this.configFilePath)) {
      throw new Error(`Configuration file not found: ${this.configFilePath}`);
    }

    try {
      const content = readFileSync(this.configFilePath, 'utf8');
      const rawConfig = parse(content);

      // Validate podcast configs
      if (Array.isArray(rawConfig.podcasts)) {
        rawConfig.podcasts.forEach((podcast: unknown, index: number) => {
          try {
            validateConfig(PodcastConfigSchema, podcast);
          } catch (error) {
            throw new Error(`Invalid podcast configuration at index ${index}: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
      }

      // Expand environment variables
      this.expandEnvironmentVariables(rawConfig);

      return rawConfig as AppConfig;
    } catch (error) {
      throw new Error(`Failed to load configuration: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private expandEnvironmentVariables(obj: any): void {
    const requiredEnvVars = ['GEMINI_API_KEY'];
    
    for (const key in obj) {
      if (typeof obj[key] === 'string' && obj[key].startsWith('${') && obj[key].endsWith('}')) {
        const envVarName = obj[key].slice(2, -1);
        const [varName, defaultValue] = envVarName.split(':-');
        const envValue = process.env[varName];
        
        // Check if this is a required environment variable
        if (requiredEnvVars.includes(varName) && (!envValue || envValue.trim() === '')) {
          throw new Error(`Required environment variable ${varName} is not set or is empty. Please set this variable before starting the application.`);
        }
        
        obj[key] = envValue || defaultValue || '';
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        this.expandEnvironmentVariables(obj[key]);
      }
    }
  }

  async loadPodcasts(): Promise<PodcastConfig[]> {
    return this.config.podcasts.filter(p => p.enabled);
  }

  async getAllPodcasts(): Promise<PodcastConfig[]> {
    return this.config.podcasts;
  }

  async getPodcast(id: string): Promise<PodcastConfig | undefined> {
    return this.config.podcasts.find(p => p.id === id);
  }

  async updatePodcast(id: string, updates: Partial<PodcastConfig>): Promise<void> {
    const podcastIndex = this.config.podcasts.findIndex(p => p.id === id);
    if (podcastIndex === -1) {
      throw new Error(`Podcast with id '${id}' not found`);
    }

    this.config.podcasts[podcastIndex] = {
      ...this.config.podcasts[podcastIndex],
      ...updates
    };

    // Validate updated config
    validateConfig(PodcastConfigSchema, this.config.podcasts[podcastIndex]);
    
    this.notifyConfigChange();
  }

  getProcessingConfig() {
    return {
      ...this.config.processing,
      tempDirectory: this.getTempDirectory()
    };
  }

  getLLMConfig() {
    return this.config.llm;
  }

  getStorageConfig() {
    return {
      ...this.config.storage,
      baseDirectory: join(this.config.dataDir, 'storage')
    };
  }

  getDatabaseConfig() {
    return {
      path: join(this.config.dataDir, 'database', 'podcastoor.db')
    };
  }

  getTempDirectory(): string {
    return join(this.config.dataDir, 'temp');
  }

  getDataDirectory(): string {
    return this.config.dataDir;
  }


  onConfigChange(callback: (config: AppConfig) => void): void {
    this.changeCallbacks.add(callback);
  }

  offConfigChange(callback: (config: AppConfig) => void): void {
    this.changeCallbacks.delete(callback);
  }

  startWatching(): void {
    this.watcher = watch(this.configFilePath)
      .on('change', () => {
        try {
          this.config = this.loadConfig();
          this.notifyConfigChange();
          console.log('Configuration reloaded');
        } catch (error) {
          console.error('Failed to reload configuration:', error);
        }
      });

    console.log('Configuration file watching started');
  }

  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
    console.log('Configuration file watching stopped');
  }

  private notifyConfigChange(): void {
    this.changeCallbacks.forEach(callback => {
      try {
        callback(this.config);
      } catch (error) {
        console.error('Error in config change callback:', error);
      }
    });
  }

  validateConfig(config: unknown): AppConfig {
    // Basic structure validation
    if (!config || typeof config !== 'object') {
      throw new Error('Configuration must be an object');
    }

    const cfg = config as any;

    if (!Array.isArray(cfg.podcasts)) {
      throw new Error('Configuration must include podcasts array');
    }

    // Validate each podcast
    cfg.podcasts.forEach((podcast: unknown, index: number) => {
      try {
        validateConfig(PodcastConfigSchema, podcast);
      } catch (error) {
        throw new Error(`Invalid podcast configuration at index ${index}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    return cfg as AppConfig;
  }
}