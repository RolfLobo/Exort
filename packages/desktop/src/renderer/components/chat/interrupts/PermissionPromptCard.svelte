<script lang="ts">
  import { ChevronDown, ChevronUp } from "lucide-svelte";
  import type { AgentPermissionReply } from "../../../lib/types";

  let { requestId, title, command, reply, busy = false, onReply } = $props<{
    requestId: string;
    title: string;
    command?: string;
    reply?: AgentPermissionReply;
    busy?: boolean;
    onReply: (requestId: string, reply: AgentPermissionReply) => Promise<void> | void;
  }>();

  let submitting = $state<AgentPermissionReply | null>(null);
  let commandExpanded = $state(false);

  let isResolved = $derived(Boolean(reply));
  let isBusy = $derived(busy || submitting !== null);
  let permissionTarget = $derived.by(() => {
    const normalized = title.trim();
    if (!normalized) return "this action";
    if (/^permission(?:\s+request)?$/i.test(normalized)) {
      return "this action";
    }
    return normalized;
  });
  let commandText = $derived.by(() => command?.trim() || permissionTarget);
  let firstCommandLine = $derived.by(() => {
    const firstLine = commandText.split(/\r?\n/, 1)[0]?.trim();
    return firstLine || commandText;
  });
  let hasFullCommand = $derived.by(() => {
    if (!command?.trim()) return false;
    return commandText.includes("\n") || commandText.length > 180;
  });
  let visibleCommand = $derived(
    hasFullCommand && !commandExpanded ? firstCommandLine : commandText,
  );
  let statusText = $derived.by(() => {
    if (!reply) return null;
    if (reply === "once") return "Allowed once";
    if (reply === "always") return "Always allowed";
    return "Rejected";
  });

  async function submit(nextReply: AgentPermissionReply): Promise<void> {
    if (isBusy || isResolved) return;
    submitting = nextReply;

    try {
      await Promise.resolve(onReply(requestId, nextReply));
    } finally {
      submitting = null;
    }
  }
</script>

<div class="mt-2 rounded-md border border-dark-yellow/40 bg-dark-yellow/10 p-2.5">
  <p class="text-xs text-dark-fg2">Command requiring permission</p>
  <div class="mt-1 rounded border border-dark-border bg-dark-bg px-2 py-1.5">
    <pre
      class={`font-mono text-[11px] leading-4 text-dark-fg1 ${hasFullCommand && !commandExpanded ? "truncate whitespace-nowrap" : "max-h-56 overflow-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]"}`}
    >{visibleCommand}</pre>
  </div>
  {#if hasFullCommand}
    <button
      type="button"
      class="mt-1.5 inline-flex items-center gap-1 text-[11px] text-dark-fg3 hover:text-primary-300"
      onclick={() => (commandExpanded = !commandExpanded)}
      aria-expanded={commandExpanded}
    >
      {#if commandExpanded}
        <ChevronUp class="h-3 w-3" />
        Hide full command
      {:else}
        <ChevronDown class="h-3 w-3" />
        Show full command
      {/if}
    </button>
  {/if}

  {#if statusText}
    <div class="mt-2 inline-flex rounded border border-dark-border bg-dark-bg px-2 py-1 text-[11px] text-dark-fg2">
      {statusText}
    </div>
  {:else}
    <div class="mt-2 flex flex-wrap gap-1.5">
      <button
        class="rounded border border-dark-red/50 px-2 py-1 text-xs text-dark-red2 hover:border-dark-red2 disabled:opacity-60"
        disabled={isBusy}
        onclick={() => submit("reject")}
      >
        {submitting === "reject" ? "Rejecting..." : "Reject"}
      </button>
      <button
        class="rounded border border-dark-border px-2 py-1 text-xs text-dark-fg2 hover:border-primary-500 hover:text-primary-300 disabled:opacity-60"
        disabled={isBusy}
        onclick={() => submit("always")}
      >
        {submitting === "always" ? "Saving..." : "Always allow"}
      </button>
      <button
        class="rounded border border-dark-aqua/50 bg-dark-aqua/10 px-2 py-1 text-xs text-dark-aqua hover:border-dark-aqua disabled:opacity-60"
        disabled={isBusy}
        onclick={() => submit("once")}
      >
        {submitting === "once" ? "Allowing..." : "Allow once"}
      </button>
    </div>
  {/if}
</div>
