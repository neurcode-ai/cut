import { spawn } from 'node:child_process';
import {
  SHARE_LIMITS,
  sanitizeEvidenceCwd,
} from '@neurcode-ai/share-format';

export interface EvidenceCapture {
  argv: string[];
  exit: number;
  stdout: Buffer;
  stderr: Buffer;
  startedAt: string;
  durationMs: number;
  cwd: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

class BoundedStream {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private full = Buffer.alloc(0);
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private total = 0;
  private truncated = false;

  constructor(private readonly limit: number) {
    this.headLimit = Math.floor(limit / 2);
    this.tailLimit = limit - this.headLimit;
  }

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (!this.truncated) {
      const combined = Buffer.concat([this.full, chunk]);
      if (combined.length <= this.limit) {
        this.full = combined;
        return;
      }
      this.truncated = true;
      this.head = combined.subarray(0, this.headLimit);
      this.tail = combined.subarray(combined.length - this.tailLimit);
      this.full = Buffer.alloc(0);
      return;
    }
    this.tail = Buffer.concat([this.tail, chunk]);
    if (this.tail.length > this.tailLimit) this.tail = this.tail.subarray(this.tail.length - this.tailLimit);
  }

  finish(): { content: Buffer; truncated: boolean } {
    if (!this.truncated) return { content: this.full, truncated: false };
    let marker = Buffer.from('\n… [Neurcode Share bounded output] …\n');
    for (let pass = 0; pass < 2; pass += 1) {
      const available = Math.max(0, this.limit - marker.length);
      const headLength = Math.min(this.head.length, Math.floor(available / 2));
      const tailLength = Math.min(this.tail.length, available - headLength);
      const omitted = Math.max(0, this.total - headLength - tailLength);
      marker = Buffer.from(`\n… [Neurcode Share omitted ${omitted} bytes from the middle] …\n`);
    }
    const available = Math.max(0, this.limit - marker.length);
    const headLength = Math.min(this.head.length, Math.floor(available / 2));
    const tailLength = Math.min(this.tail.length, available - headLength);
    return {
      content: Buffer.concat([
        this.head.subarray(0, headLength),
        marker,
        this.tail.subarray(this.tail.length - tailLength),
      ]).subarray(0, this.limit),
      truncated: true,
    };
  }
}

function terminate(child: ReturnType<typeof spawn>): void {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGTERM');
      return;
    } catch {
      // Fall through to the direct child.
    }
  }
  child.kill('SIGTERM');
}

function forceTerminate(child: ReturnType<typeof spawn>): void {
  if (child.pid && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // Fall through to the direct child.
    }
  }
  child.kill('SIGKILL');
}

export async function captureEvidence(input: {
  command: string;
  repoRoot: string;
  cwd?: string;
  timeoutMs?: number;
  maxBytes?: number;
  stream?: boolean;
}): Promise<EvidenceCapture> {
  const timeoutMs = input.timeoutMs ?? SHARE_LIMITS.defaultRunTimeoutMs;
  if (timeoutMs < 1 || timeoutMs > SHARE_LIMITS.maxRunTimeoutMs) {
    throw new Error(`Evidence timeout must be between 1 ms and ${SHARE_LIMITS.maxRunTimeoutMs} ms.`);
  }
  const maxBytes = input.maxBytes ?? SHARE_LIMITS.maxEvidenceStreamBytes;
  const cwd = input.cwd ?? input.repoRoot;
  const relativeCwd = sanitizeEvidenceCwd(input.repoRoot, cwd);
  const stdout = new BoundedStream(maxBytes);
  const stderr = new BoundedStream(maxBytes);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let timedOut = false;

  const child = spawn(input.command, {
    cwd,
    env: process.env,
    shell: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout.push(chunk);
    if (input.stream !== false) process.stdout.write(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr.push(chunk);
    if (input.stream !== false) process.stderr.write(chunk);
  });

  const exit = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
      setTimeout(() => {
        if (child.exitCode === null) forceTerminate(child);
      }, 1_000).unref();
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve(timedOut ? 124 : (code ?? (signal ? 128 : 1)));
    });
  });
  const stdoutResult = stdout.finish();
  const stderrResult = stderr.finish();
  return {
    argv: [input.command],
    exit,
    stdout: stdoutResult.content,
    stderr: stderrResult.content,
    startedAt,
    durationMs: Date.now() - started,
    cwd: relativeCwd,
    timedOut,
    stdoutTruncated: stdoutResult.truncated,
    stderrTruncated: stderrResult.truncated,
  };
}
