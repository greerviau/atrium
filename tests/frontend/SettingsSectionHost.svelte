<script lang="ts">
  import SettingsSection from "../../src/lib/settings/SettingsSection.svelte";

  let { title = "Example Section" }: { title?: string } = $props();
</script>

<SettingsSection {title} id="example-section">
  <p>Section body content</p>
</SettingsSection>
