<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  useDownloadThumbnail,
  type ThumbnailFetcher
} from '../composables/useDownloadThumbnail'

/**
 * Leading slot for a download row: shows a rounded preview thumbnail for a
 * completed image asset, otherwise renders the `#fallback` slot (the surface's
 * existing status icon). Fetching is lazy and injected so the same component
 * serves both the panel (`window.api`) and the title-bar popup (its bridge).
 */
const props = defineProps<{
  entry: { isImage?: boolean; status: string; savePath?: string; filename: string }
  fetcher: ThumbnailFetcher
}>()

const { t } = useI18n()

const thumbnail = useDownloadThumbnail(() => props.entry, props.fetcher)

// A broken image (file moved/deleted after the data URL was cached) falls back
// to the icon; reset when the underlying source changes.
const failed = ref(false)
watch(thumbnail, () => {
  failed.value = false
})
</script>

<template>
  <img
    v-if="thumbnail && !failed"
    :src="thumbnail"
    :alt="t('downloadsPopup.thumbnailAlt', { name: entry.filename })"
    class="download-thumb"
    loading="lazy"
    decoding="async"
    draggable="false"
    @error="failed = true"
  />
  <slot v-else name="fallback" />
</template>

<style scoped>
.download-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
</style>
