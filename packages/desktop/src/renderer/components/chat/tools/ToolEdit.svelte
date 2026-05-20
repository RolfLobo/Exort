<script lang="ts">
  import { Code } from "lucide-svelte";
  import type { AgentStep } from "../../../lib/types";
  import { resolveChatFilePath } from "../chatMarkdown";
  import { findToolTargetFilePath } from "../toolPathTarget";
  import BasicToolCard from "../parts/BasicToolCard.svelte";
  import ToolMarkdownBody from "./ToolMarkdownBody.svelte";
  import { inputValue, markdownBody, parseToolInput } from "./toolData";

  let {
    step,
    workspaceRoot = null,
    onOpenFile,
  } = $props<{
    step: AgentStep;
    workspaceRoot?: string | null;
    onOpenFile?: (filePath: string) => Promise<void> | void;
  }>();

  let input = $derived(parseToolInput(step.toolInput));
  let rawPath = $derived(
    inputValue(input, "filePath") ??
      inputValue(input, "path") ??
      findToolTargetFilePath(step),
  );
  let resolvedPath = $derived(
    rawPath ? resolveChatFilePath(rawPath, workspaceRoot) : null,
  );
  let subtitle = $derived.by(() => {
    if (!rawPath) return "file";
    const normalized = rawPath.replace(/\\/g, "/");
    const normalizedRoot = workspaceRoot
      ? workspaceRoot.replace(/\\/g, "/").replace(/\/$/, "")
      : "";
    if (!normalizedRoot) return normalized;
    if (normalized === normalizedRoot) return ".";
    const prefix = `${normalizedRoot}/`;
    return normalized.startsWith(prefix)
      ? normalized.slice(prefix.length)
      : normalized;
  });
  let subtitleClickable = $derived(Boolean(resolvedPath));
  let body = $derived(markdownBody(step));

  async function handleSubtitleClick(): Promise<void> {
    if (!resolvedPath) return;
    if (onOpenFile) {
      await onOpenFile(resolvedPath);
      return;
    }
    await window.electronAPI.revealPathInFileManager({ path: resolvedPath });
  }
</script>

<BasicToolCard
  icon={Code}
  title="Edit"
  {subtitle}
  {subtitleClickable}
  onSubtitleClick={subtitleClickable ? handleSubtitleClick : undefined}
  status={step.status}
>
  <ToolMarkdownBody {body} />
</BasicToolCard>
