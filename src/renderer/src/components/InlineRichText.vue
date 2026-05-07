<script setup lang="ts">
/**
 * Renders a string with inline `**bold**` markers as alternating
 * plain text and `<strong>` spans. Avoids pulling in a markdown
 * library for the handful of inline-bolded phrases in the privacy
 * policy.
 */
interface Props {
  text: string
}
const props = defineProps<Props>()

interface Segment {
  text: string
  bold: boolean
}

function segments(text: string): Segment[] {
  const out: Segment[] = []
  for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
    if (!part) continue
    if (part.startsWith('**') && part.endsWith('**')) {
      out.push({ text: part.slice(2, -2), bold: true })
    } else {
      out.push({ text: part, bold: false })
    }
  }
  return out
}
</script>

<template>
  <template v-for="(seg, i) in segments(props.text)" :key="i">
    <strong v-if="seg.bold">{{ seg.text }}</strong>
    <template v-else>{{ seg.text }}</template>
  </template>
</template>
