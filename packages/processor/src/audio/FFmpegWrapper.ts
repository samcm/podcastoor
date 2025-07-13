import { spawn } from 'child_process';
import { promises as fs } from 'fs';

export interface FFmpegCommand {
  input: string;
  output: string;
  options: string[];
}

export class FFmpegWrapper {
  private ffmpegPath: string;
  private timeoutMs: number;

  constructor(ffmpegPath: string = 'ffmpeg', timeoutMs: number = 3600000) {
    this.ffmpegPath = ffmpegPath;
    this.timeoutMs = timeoutMs;
  }

  async execute(command: FFmpegCommand): Promise<string> {
    const args = ['-i', command.input, ...command.options, command.output];
    return this.run(args);
  }

  async probe(filePath: string): Promise<string> {
    const args = ['-i', filePath, '-f', 'null', '-'];
    return this.run(args);
  }

  async getInfo(filePath: string): Promise<string> {
    const args = ['-i', filePath, '-hide_banner'];
    return this.run(args);
  }

  private async run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const process = spawn(this.ffmpegPath, args, {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      process.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      process.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        process.kill('SIGKILL');
        reject(new Error(`FFmpeg process timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      process.on('close', (code: number | null) => {
        clearTimeout(timeout);
        
        if (code === 0 || (code === 1 && stderr.includes('Output file is empty'))) {
          resolve(stderr); // FFmpeg outputs info to stderr
        } else {
          reject(new Error(`FFmpeg process exited with code ${code}: ${stderr}`));
        }
      });

      process.on('error', (error: Error) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to start FFmpeg process: ${error.message}`));
      });
    });
  }

  async checkFFmpegAvailable(): Promise<boolean> {
    try {
      await this.run(['-version']);
      return true;
    } catch {
      return false;
    }
  }

  static async findFFmpegPath(): Promise<string> {
    const possiblePaths = [
      'ffmpeg',
      '/usr/bin/ffmpeg',
      '/usr/local/bin/ffmpeg',
      '/opt/homebrew/bin/ffmpeg'
    ];

    for (const path of possiblePaths) {
      try {
        const wrapper = new FFmpegWrapper(path);
        if (await wrapper.checkFFmpegAvailable()) {
          return path;
        }
      } catch {
        continue;
      }
    }

    throw new Error('FFmpeg not found in system PATH or common locations');
  }
}