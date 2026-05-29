import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, createServer } from 'node:net';

import type { Config } from '@opencode-ai/sdk';
import type { OpenCodeIsolationInfo } from './openCodeIsolation.js';

type OpenCodeLog = (line: string) => void;
const ANSI_GREEN = '\u001b[32m';
const ANSI_RESET = '\u001b[0m';

type StartOpenCodeSidecarOptions = {
  binaryPath: string;
  hostname?: string;
  port?: number;
  timeoutMs?: number;
  config?: Config;
  envOverrides?: NodeJS.ProcessEnv;
  isolationInfo?: OpenCodeIsolationInfo;
  log?: OpenCodeLog;
  onUnexpectedExit?: (info: { code: number | null; signal: NodeJS.Signals | null }) => void;
};

export type OpenCodeSidecar = {
  url: string;
  pid: number | undefined;
  close: () => Promise<void>;
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Unknown sidecar error';
}

function parseSidecarUrl(output: string): string | null {
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const normalized = line.replace(/\u001b\[[0-9;]*m/g, '').trim();
    const match = normalized.match(/opencode\s+server\s+listening\b.*?\bon\s+(https?:\/\/[^\s]+)/i);
    if (!match) continue;
    return match[1] ?? null;
  }

  return null;
}

function tailOutput(value: string, maxChars = 2000): string {
  if (value.length <= maxChars) return value.trim();
  return value.slice(-maxChars).trim();
}

function buildFallbackUrl(hostname: string, port: number): string {
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  return `http://${host}:${port}`;
}

async function probeHttp(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal
    });
    return response.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function probeTcp(hostname: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: hostname, port });
    let settled = false;

    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
    socket.once('close', () => settle(false));
  });
}

function parsePortFromUrl(url: string): number | null {
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    if (Number.isFinite(port) && port > 0) return port;
    if (parsed.protocol === 'https:') return 443;
    return 80;
  } catch {
    return null;
  }
}

async function pickAvailablePort(hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate sidecar port.')));
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

function waitForExit(proc: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    proc.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });
}

async function killProcessTreeWindows(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill', ['/PID', `${pid}`, '/T', '/F'], {
      stdio: 'ignore'
    });

    killer.once('error', () => resolve());
    killer.once('close', () => resolve());
  });
}

async function closeSidecarProcess(proc: ChildProcess): Promise<void> {
  if (proc.killed || proc.exitCode != null) {
    return;
  }

  const exitPromise = waitForExit(proc);

  try {
    proc.kill();
  } catch {
    // Ignore synchronous kill errors; fallback will handle unresolved exits.
  }

  const forceTimeoutMs = 4000;
  const forceKillPromise = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (proc.exitCode == null) {
        if (process.platform === 'win32' && typeof proc.pid === 'number') {
          void killProcessTreeWindows(proc.pid).finally(resolve);
          return;
        }

        try {
          proc.kill('SIGKILL');
        } catch {
          // Ignore kill escalation failures.
        }
      }
      resolve();
    }, forceTimeoutMs);
    timer.unref();
  });

  await Promise.race([exitPromise.then(() => undefined), forceKillPromise]);
  const postForceWait = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2000);
    timer.unref();
  });
  await Promise.race([exitPromise.then(() => undefined), postForceWait]);
}

export async function startOpenCodeSidecar(options: StartOpenCodeSidecarOptions): Promise<OpenCodeSidecar> {
  const hostname = options.hostname ?? '127.0.0.1';
  const timeoutMs = options.timeoutMs ?? 15_000;
  const port = typeof options.port === 'number' && options.port > 0 ? options.port : await pickAvailablePort(hostname);
  const fallbackUrl = buildFallbackUrl(hostname, port);

  if (options.isolationInfo) {
    options.log?.(`runtime:isolation:enabled root=${options.isolationInfo.root}`);
    options.log?.(
      `runtime:isolation:paths config=${options.isolationInfo.runtimeConfigRoot} data=${options.isolationInfo.runtimeDataRoot} state=${options.isolationInfo.runtimeStateRoot}`
    );
  }

  const args = [`serve`, `--hostname=${hostname}`, `--port=${port}`];
  if (options.config?.logLevel) {
    args.push(`--log-level=${options.config.logLevel}`);
  }

  options.log?.(`runtime:sidecar:spawn path=${options.binaryPath} args=${args.join(' ')}`);

  const proc = spawn(options.binaryPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(options.envOverrides ?? {}),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config ?? {})
    }
  });

  let output = '';
  let ready = false;
  let closing = false;

  proc.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });

  proc.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  const readyUrl = await new Promise<string>((resolve, reject) => {
    let settled = false;
    let probing = false;

    const timeout = setTimeout(() => {
      const parsed = parseSidecarUrl(output) ?? fallbackUrl;
      const detail = tailOutput(output);
      const suffix = detail.length > 0 ? `\nSidecar output (tail): ${detail}` : '';
      settle(
        'reject',
        new Error(`Timeout waiting for OpenCode sidecar startup after ${timeoutMs}ms (probe=${parsed}).${suffix}`)
      );
    }, timeoutMs);
    timeout.unref();

    const interval = setInterval(() => {
      void runActiveProbe();
    }, 250);
    interval.unref();

    const settle = (kind: 'resolve' | 'reject', value: string | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(interval);
      proc.off('error', onError);
      proc.off('exit', onExit);
      proc.stdout.off('data', onData);
      proc.stderr.off('data', onData);
      if (kind === 'resolve') {
        resolve(value as string);
      } else {
        reject(value as Error);
      }
    };

    const runActiveProbe = async () => {
      if (settled || probing) return;
      const parsed = parseSidecarUrl(output);
      if (parsed) {
        ready = true;
        settle('resolve', parsed);
        return;
      }

      probing = true;
      try {
        const httpReady = await probeHttp(fallbackUrl, 700);
        if (httpReady) {
          ready = true;
          settle('resolve', parseSidecarUrl(output) ?? fallbackUrl);
          return;
        }

        const tcpReady = await probeTcp(hostname, port, 700);
        if (tcpReady) {
          ready = true;
          settle('resolve', parseSidecarUrl(output) ?? fallbackUrl);
        }
      } finally {
        probing = false;
      }
    };

    const onData = () => {
      const parsed = parseSidecarUrl(output);
      if (parsed) {
        ready = true;
        settle('resolve', parsed);
        return;
      }

      void runActiveProbe();
    };

    const onError = (error: Error) => {
      settle('reject', error);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const detail = tailOutput(output);
      const suffix = detail ? `\nSidecar output (tail): ${detail}` : '';
      settle(
        'reject',
        new Error(`OpenCode sidecar exited before ready (code=${code ?? 'null'} signal=${signal ?? 'null'}).${suffix}`)
      );
    };

    proc.once('error', onError);
    proc.once('exit', onExit);
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    onData();
    void runActiveProbe();
  }).catch(async (error) => {
    options.log?.(`runtime:sidecar:error ${getErrorMessage(error)}`);
    if (proc.exitCode == null) {
      await closeSidecarProcess(proc);
    }
    throw error;
  });

  options.log?.(`runtime:sidecar:ready url=${readyUrl} pid=${proc.pid ?? 'unknown'}`);
  options.log?.(
    `${ANSI_GREEN}runtime:sidecar:info url=${readyUrl} port=${parsePortFromUrl(readyUrl) ?? port} pid=${
      proc.pid ?? 'unknown'
    } host=${hostname} binary=${options.binaryPath}${ANSI_RESET}`
  );

  proc.on('error', (error) => {
    options.log?.(`runtime:sidecar:error ${getErrorMessage(error)}`);
  });

  proc.on('exit', (code, signal) => {
    if (ready) {
      options.log?.(`runtime:sidecar:exit code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      if (!closing) {
        options.onUnexpectedExit?.({ code, signal });
      }
    }
  });

  return {
    url: readyUrl,
    pid: proc.pid,
    close: async () => {
      closing = true;
      await closeSidecarProcess(proc);
    }
  };
}
