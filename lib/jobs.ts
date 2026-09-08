/**
 * In-memory job registry.
 *
 * One container, one process, jobs that live for about ten seconds - a
 * database here would be ceremony. Jobs are dropped once they age out, and a
 * restart losing them is fine: the videos are ephemeral by design too.
 *
 * Events are buffered as well as pushed, so a client that connects a moment
 * after the job starts still sees everything from the beginning rather than
 * joining mid-stream.
 */

import type { GenerateResult } from "./pipeline";
import type { Progress, Step } from "./types";

export type Job = {
  id: string;
  createdAt: number;
  status: Step;
  events: Progress[];
  result?: GenerateResult;
  error?: string;
  /** Live listeners, for SSE. */
  listeners: Set<(p: Progress) => void>;
  done: boolean;
};

const JOBS = new Map<string, Job>();
const TTL_MS = 15 * 60 * 1000;

function sweep(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, job] of JOBS) {
    if (job.createdAt < cutoff) JOBS.delete(id);
  }
}

export function createJob(id: string): Job {
  sweep();
  const job: Job = {
    id,
    createdAt: Date.now(),
    status: "understand",
    events: [],
    listeners: new Set(),
    done: false,
  };
  JOBS.set(id, job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return JOBS.get(id);
}

export function emit(job: Job, progress: Progress): void {
  job.status = progress.step;
  job.events.push(progress);
  for (const listen of job.listeners) {
    try {
      listen(progress);
    } catch {
      // A dead listener must not stop the job or the other listeners.
    }
  }
}

export function finish(job: Job, result: GenerateResult): void {
  job.result = result;
  job.status = "done";
  job.done = true;
  emit(job, { step: "done", detail: "Done." });
}

export function fail(job: Job, message: string): void {
  job.error = message;
  job.status = "error";
  job.done = true;
  emit(job, { step: "error", detail: message });
}
