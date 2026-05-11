<script setup lang="ts">
// Live downloads tray view — wired up to receive `tray-state-changed`
// pushes from main and emit pause/resume/cancel/show-in-folder actions.
// Behaviour lands in the next track; this is the empty-state shell.
</script>

<template>
  <div class="downloads">
    <p class="empty">No downloads yet</p>
  </div>
</template>

<style scoped>
.downloads {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
  box-sizing: border-box;
  padding: 12px 14px;
}

.empty {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted, #9ca0a8);
  text-align: center;
}
</style>
