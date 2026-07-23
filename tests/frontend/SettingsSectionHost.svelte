<script lang="ts">
  import { untrack } from "svelte";
  import SettingsSection from "../../src/lib/settings/SettingsSection.svelte";

  let { title = "Example Section", initialExpanded = true }: { title?: string; initialExpanded?: boolean } =
    $props();
  let expanded = $state(untrack(() => initialExpanded));
</script>

<SettingsSection {title} {expanded} onToggle={() => (expanded = !expanded)}>
  <p>Section body content</p>
</SettingsSection>
