import type { AgentStep } from "../../lib/types";

const KNOWN_PATH_KEYS = [
  "filePath",
  "path",
  "file",
  "filepath",
  "file_path",
  "filename",
  "targetFile",
  "targetPath",
  "target_file",
  "target_path",
  "relativePath",
  "relative_path",
];

const FILE_TOKEN_REGEX =
  /([A-Za-z0-9._/-]+\.[A-Za-z][A-Za-z0-9_+-]{0,15})/g;

function parseRecord(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore malformed payloads.
  }
  return {};
}

function asNonBlankString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function findStringByKnownKeys(
  value: unknown,
  depth = 0,
): string | null {
  if (depth > 5 || typeof value !== "object" || value === null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findStringByKnownKeys(item, depth + 1);
      if (nested) return nested;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of KNOWN_PATH_KEYS) {
    const candidate = asNonBlankString(record[key]);
    if (candidate) return candidate;
  }

  for (const entry of Object.values(record)) {
    const nested = findStringByKnownKeys(entry, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function collectStringValues(value: unknown, out: string[], depth = 0): void {
  if (depth > 5) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) out.push(trimmed);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out, depth + 1);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      collectStringValues(entry, out, depth + 1);
    }
  }
}

function parseFirstFileFromPatchText(patchText: string): string | null {
  const normalized = patchText.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  for (const line of lines) {
    const updateMatch = line.match(/^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/);
    if (updateMatch?.[1]) return updateMatch[1].trim();
    const diffGitMatch = line.match(/^diff --git a\/(.+)\s+b\/(.+)$/);
    if (diffGitMatch?.[2]) return diffGitMatch[2].trim();
    const gitFileMatch = line.match(/^(?:\+\+\+\s+b\/|---\s+a\/)(.+)$/);
    if (gitFileMatch?.[1]) return gitFileMatch[1].trim();
  }
  return null;
}

function parseFileTokenFromText(value: string): string | null {
  FILE_TOKEN_REGEX.lastIndex = 0;
  const matches = [...value.matchAll(FILE_TOKEN_REGEX)];
  for (const match of matches) {
    const candidate = match[1]?.trim();
    if (!candidate) continue;
    if (candidate.includes("/")) return candidate;
    if (KNOWN_PATH_KEYS.some((key) => candidate.toLowerCase() === key.toLowerCase())) continue;
    return candidate;
  }
  return null;
}

export function findToolTargetFilePath(
  step: Pick<AgentStep, "toolInput" | "toolOutput">,
): string | null {
  const input = parseRecord(step.toolInput);
  const output = parseRecord(step.toolOutput);

  const directPath =
    findStringByKnownKeys(input) ??
    findStringByKnownKeys(output) ??
    null;
  if (directPath) return directPath;

  const candidates: string[] = [];
  collectStringValues(input, candidates);
  collectStringValues(output, candidates);
  if (step.toolInput) candidates.push(step.toolInput);
  if (step.toolOutput) candidates.push(step.toolOutput);

  for (const candidate of candidates) {
    const normalized =
      candidate.includes("\\n") && !candidate.includes("\n")
        ? candidate.replace(/\\n/g, "\n")
        : candidate;
    const patchPath = parseFirstFileFromPatchText(normalized);
    if (patchPath) return patchPath;
    const fileToken = parseFileTokenFromText(normalized);
    if (fileToken) return fileToken;
  }

  return null;
}
