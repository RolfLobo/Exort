import { spawn } from 'node:child_process';
import path from 'node:path';

const PATH_START_MARKER = '__EXORT_PATH_START__';
const PATH_END_MARKER = '__EXORT_PATH_END__';

function getDefaultShell(): string {
  const fromEnv = process.env.SHELL?.trim();
  if (fromEnv) return fromEnv;
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

function getPathKey(env: NodeJS.ProcessEnv): string {
  if (process.platform !== 'win32') return 'PATH';
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'Path';
}

function splitPath(raw: string | undefined): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Resolve the PATH the user actually has in their login shell.
 *
 * GUI-launched apps (Finder/Dock on macOS) inherit launchd's minimal PATH and never see the
 * additions made in ~/.zshrc / ~/.zprofile etc. Spawning an interactive login shell and asking it
 * to echo $PATH recovers the environment the user expects in their terminal.
 *
 * Returns null on Windows (GUI apps already inherit user/system PATH from the registry) or on any
 * failure/timeout, in which case callers should keep their existing hardcoded fallback behavior.
 */
export function resolveLoginShellPath(timeoutMs = 3000): Promise<string | null> {
  if (process.platform === 'win32') return Promise.resolve(null);

  const shell = getDefaultShell();

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    let proc: ReturnType<typeof spawn>;
    try {
      // -i interactive, -l login: sources the user's profile + rc files so PATH matches the terminal.
      // ${PATH} must be braced — otherwise the shell parses the trailing marker as part of the
      // variable name (underscores/letters are valid identifier chars) and expands to nothing.
      proc = spawn(shell, ['-ilc', `echo ${PATH_START_MARKER}\${PATH}${PATH_END_MARKER}`], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch {
      settle(null);
      return;
    }

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      settle(null);
    }, timeoutMs);

    let stdout = '';
    proc.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.once('error', () => {
      settle(null);
    });

    proc.once('close', (exitCode) => {
      if (exitCode !== 0) {
        settle(null);
        return;
      }

      const startIndex = stdout.indexOf(PATH_START_MARKER);
      const endIndex = stdout.indexOf(PATH_END_MARKER);
      if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
        settle(null);
        return;
      }

      const value = stdout.slice(startIndex + PATH_START_MARKER.length, endIndex).trim();
      settle(value.length > 0 ? value : null);
    });
  });
}

/**
 * Resolve the login-shell PATH once and merge it into process.env.PATH so every downstream spawn
 * (main-process bridges, the OpenCode sidecar, and its custom tools) inherits the corrected PATH.
 * No-op on failure: the existing hardcoded fallback dirs still apply.
 */
export async function applyLoginShellPath(timeoutMs = 3000): Promise<void> {
  const pathKey = getPathKey(process.env);
  const beforeEntries = splitPath(process.env[pathKey]);

  const shellPath = await resolveLoginShellPath(timeoutMs);
  if (!shellPath) return;

  const shellEntries = splitPath(shellPath);
  // Shell-derived entries first so the user's environment wins, then existing entries, deduped.
  const merged = [...shellEntries, ...beforeEntries].filter(
    (entry, index, array) => array.indexOf(entry) === index
  );

  process.env[pathKey] = merged.join(path.delimiter);
}
