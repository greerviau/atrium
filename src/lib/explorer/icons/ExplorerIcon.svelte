<script lang="ts">
  import type { DirEntry } from "../../ipc/commands";
  import { iconKindFor, type IconKind } from "./iconKind";

  let { entry, expanded = false }: { entry: DirEntry; expanded?: boolean } = $props();

  let kind = $derived(iconKindFor(entry, expanded));

  /** One- or two-character (or simple glyph) mark drawn on the file-page shape; omitted kinds render a bare page. */
  const TEXT_MARKS: Partial<Record<IconKind, string>> = {
    markdown: "M",
    javascript: "JS",
    typescript: "TS",
    python: "PY",
    rust: "RS",
    go: "GO",
    json: "{}",
    yaml: "YM",
    css: "#",
    html: "<>",
    shell: ">_",
    toml: "TM",
  };
</script>

{#snippet folderClosed()}
  <path d="M1.5 3.5H6.3L7.6 5.1H14.5V13H1.5Z" />
{/snippet}

{#snippet folderOpen()}
  <path d="M1.5 4H6.3L7.6 5.6H14.5V7H1.5Z" />
  <path d="M1 7H14.9L13.1 13.5H2.7Z" />
{/snippet}

{#snippet filePage()}
  <path d="M3 1H9.5L13 4.5V15H3Z" />
  <path d="M9.5 1V4.5H13" />
{/snippet}

<span class="explorer-icon icon-{kind}" aria-hidden="true">
  <svg
    viewBox="0 0 16 16"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.2"
    stroke-linejoin="round"
  >
    {#if kind === "folder-closed"}
      {@render folderClosed()}
    {:else if kind === "folder-open"}
      {@render folderOpen()}
    {:else if kind === "image"}
      {@render filePage()}
      <circle cx="6.3" cy="8.5" r="1" fill="currentColor" stroke="none" />
      <path
        d="M4.2 12.6L7.2 9.3L9 11.2L10.5 9L12 11.7"
        stroke="currentColor"
        stroke-width="1"
        fill="none"
      />
    {:else}
      {@render filePage()}
      {#if TEXT_MARKS[kind]}
        <text
          x="8"
          y="12.2"
          text-anchor="middle"
          font-size="4.6"
          font-family="ui-monospace, SFMono-Regular, Menlo, monospace"
          font-weight="600"
          fill="currentColor"
          stroke="none">{TEXT_MARKS[kind]}</text
        >
      {/if}
    {/if}
  </svg>
</span>

<style>
  .explorer-icon {
    width: 16px;
    height: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .icon-folder-closed,
  .icon-folder-open {
    color: var(--atrium-icon-folder);
  }
  .icon-markdown {
    color: var(--atrium-icon-markdown);
  }
  .icon-javascript {
    color: var(--atrium-icon-javascript);
  }
  .icon-typescript {
    color: var(--atrium-icon-typescript);
  }
  .icon-python {
    color: var(--atrium-icon-python);
  }
  .icon-rust {
    color: var(--atrium-icon-rust);
  }
  .icon-go {
    color: var(--atrium-icon-go);
  }
  .icon-json {
    color: var(--atrium-icon-json);
  }
  .icon-yaml {
    color: var(--atrium-icon-yaml);
  }
  .icon-css {
    color: var(--atrium-icon-css);
  }
  .icon-html {
    color: var(--atrium-icon-html);
  }
  .icon-shell {
    color: var(--atrium-icon-shell);
  }
  .icon-toml {
    color: var(--atrium-icon-toml);
  }
  .icon-image {
    color: var(--atrium-icon-image);
  }
  .icon-generic {
    color: var(--atrium-icon-generic);
  }
</style>
