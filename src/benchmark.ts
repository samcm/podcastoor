import type { Transcript } from "./types.js";
import { parseVtt } from "./transcripts.js";

export interface TranscriptBenchmarkResult {
  referenceWords: number;
  candidateWords: number;
  wordErrorRate: number;
  substitutions: number;
  insertions: number;
  deletions: number;
}

export function benchmarkTranscripts(reference: Transcript, candidate: Transcript): TranscriptBenchmarkResult {
  const referenceWords = tokenize(reference.text);
  const candidateWords = tokenize(candidate.text);
  const matrix = Array.from({ length: referenceWords.length + 1 }, () => Array(candidateWords.length + 1).fill(0) as number[]);
  for (let i = 0; i <= referenceWords.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= candidateWords.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= referenceWords.length; i += 1) {
    for (let j = 1; j <= candidateWords.length; j += 1) {
      const substitutionCost = referenceWords[i - 1] === candidateWords[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + substitutionCost
      );
    }
  }
  const distance = matrix[referenceWords.length][candidateWords.length];
  return {
    referenceWords: referenceWords.length,
    candidateWords: candidateWords.length,
    wordErrorRate: referenceWords.length === 0 ? 0 : Number((distance / referenceWords.length).toFixed(4)),
    substitutions: distance,
    insertions: Math.max(0, candidateWords.length - referenceWords.length),
    deletions: Math.max(0, referenceWords.length - candidateWords.length)
  };
}

export function runSampleBenchmark(): TranscriptBenchmarkResult {
  const reference = parseVtt(`WEBVTT

00:00:00.000 --> 00:00:04.000
Welcome back to the show. Today we are talking about rugby league.

00:00:04.000 --> 00:00:08.000
This episode is brought to you by a sponsor.
`);
  const candidate = parseVtt(`WEBVTT

00:00:00.000 --> 00:00:04.000
Welcome back to the show today we are talking about rugby league.

00:00:04.000 --> 00:00:08.000
This episode is brought to you by sponsor.
`);
  return benchmarkTranscripts(reference, candidate);
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}
