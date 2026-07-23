<script lang="ts">
  import { errorToast, dismissErrorToast } from "../stores/errorToast";
</script>

{#if $errorToast}
  <div class="error-toast" role="alert">
    <span class="error-toast-message">{$errorToast}</span>
    <button class="error-toast-dismiss" onclick={dismissErrorToast} aria-label="Dismiss">×</button>
  </div>
{/if}

<style>
  .error-toast {
    position: fixed;
    left: 50%;
    bottom: 32px;
    transform: translateX(-50%);
    z-index: 5000;
    display: flex;
    align-items: center;
    gap: 12px;
    max-width: 70vw;
    background: var(--atrium-danger);
    color: var(--atrium-danger-text);
    border-radius: 6px;
    padding: 8px 12px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }
  .error-toast-message {
    line-height: 1.4;
  }
  .error-toast-dismiss {
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    font-size: 1.1em;
    line-height: 1;
    cursor: pointer;
    padding: 0 2px;
    opacity: 0.8;
  }
  .error-toast-dismiss:hover {
    opacity: 1;
  }
</style>
