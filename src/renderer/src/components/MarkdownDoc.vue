<script setup lang="ts">
/**
 * Renders a markdown string as Vue-template-driven structured blocks.
 *
 * Used by the first-use consent screen to display the EULA, Privacy
 * Policy, and Third-Party Notices inline. The parser lives in
 * `lib/markdown.ts`; this component only renders the parsed blocks.
 *
 * No `v-html` is used anywhere — every node goes through Vue's text
 * interpolation. The source markdown is build-time bundled from
 * `docs/legal/`, but even so, structured rendering keeps us safe if a
 * future caller passes user-derived markdown.
 */
import { computed } from 'vue'
import { parseMarkdown } from '../lib/markdown'

const props = defineProps<{ markdown: string }>()
const blocks = computed(() => parseMarkdown(props.markdown))

function openLink(url: string): void {
  // External links open in the user's default browser via the main
  // process. Consent screen is binding, so there's no in-app nav anyway.
  void window.api?.openExternal?.(url)
}
</script>

<template>
  <div class="md-doc">
    <template v-for="(block, i) in blocks" :key="i">
      <h1 v-if="block.kind === 'h1'" class="md-h1">{{ block.text }}</h1>
      <h2 v-else-if="block.kind === 'h2'" class="md-h2">{{ block.text }}</h2>
      <h3 v-else-if="block.kind === 'h3'" class="md-h3">{{ block.text }}</h3>
      <h4 v-else-if="block.kind === 'h4'" class="md-h4">{{ block.text }}</h4>
      <hr v-else-if="block.kind === 'hr'" class="md-hr" />
      <pre v-else-if="block.kind === 'code'" class="md-code">{{ block.text }}</pre>

      <p v-else-if="block.kind === 'p'" class="md-p">
        <template v-for="(seg, j) in block.segs" :key="j">
          <strong v-if="seg.kind === 'bold'">{{ seg.text }}</strong>
          <em v-else-if="seg.kind === 'italic'">{{ seg.text }}</em>
          <code v-else-if="seg.kind === 'code'" class="md-inline-code">{{ seg.text }}</code>
          <a
            v-else-if="seg.kind === 'link'"
            :href="seg.url"
            class="md-link"
            @click.prevent="openLink(seg.url)"
            >{{ seg.text }}</a
          >
          <template v-else>{{ seg.text }}</template>
        </template>
      </p>

      <ul v-else-if="block.kind === 'ul'" class="md-ul">
        <li v-for="(item, k) in block.items" :key="k">
          <template v-for="(seg, j) in item" :key="j">
            <strong v-if="seg.kind === 'bold'">{{ seg.text }}</strong>
            <em v-else-if="seg.kind === 'italic'">{{ seg.text }}</em>
            <code v-else-if="seg.kind === 'code'" class="md-inline-code">{{ seg.text }}</code>
            <a
              v-else-if="seg.kind === 'link'"
              :href="seg.url"
              class="md-link"
              @click.prevent="openLink(seg.url)"
              >{{ seg.text }}</a
            >
            <template v-else>{{ seg.text }}</template>
          </template>
        </li>
      </ul>

      <ol v-else-if="block.kind === 'ol'" class="md-ol">
        <li v-for="(item, k) in block.items" :key="k">
          <template v-for="(seg, j) in item" :key="j">
            <strong v-if="seg.kind === 'bold'">{{ seg.text }}</strong>
            <em v-else-if="seg.kind === 'italic'">{{ seg.text }}</em>
            <code v-else-if="seg.kind === 'code'" class="md-inline-code">{{ seg.text }}</code>
            <a
              v-else-if="seg.kind === 'link'"
              :href="seg.url"
              class="md-link"
              @click.prevent="openLink(seg.url)"
              >{{ seg.text }}</a
            >
            <template v-else>{{ seg.text }}</template>
          </template>
        </li>
      </ol>

      <blockquote v-else-if="block.kind === 'blockquote'" class="md-blockquote">
        <template v-for="(seg, j) in block.segs" :key="j">
          <strong v-if="seg.kind === 'bold'">{{ seg.text }}</strong>
          <em v-else-if="seg.kind === 'italic'">{{ seg.text }}</em>
          <code v-else-if="seg.kind === 'code'" class="md-inline-code">{{ seg.text }}</code>
          <a
            v-else-if="seg.kind === 'link'"
            :href="seg.url"
            class="md-link"
            @click.prevent="openLink(seg.url)"
            >{{ seg.text }}</a
          >
          <template v-else>{{ seg.text }}</template>
        </template>
      </blockquote>

      <table v-else-if="block.kind === 'table'" class="md-table">
        <thead>
          <tr>
            <th v-for="(headerSegs, k) in block.headers" :key="k">
              <template v-for="(seg, j) in headerSegs" :key="j">
                <strong v-if="seg.kind === 'bold'">{{ seg.text }}</strong>
                <em v-else-if="seg.kind === 'italic'">{{ seg.text }}</em>
                <code v-else-if="seg.kind === 'code'" class="md-inline-code">{{ seg.text }}</code>
                <template v-else>{{ seg.text }}</template>
              </template>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, k) in block.rows" :key="k">
            <td v-for="(cellSegs, l) in row" :key="l">
              <template v-for="(seg, j) in cellSegs" :key="j">
                <strong v-if="seg.kind === 'bold'">{{ seg.text }}</strong>
                <em v-else-if="seg.kind === 'italic'">{{ seg.text }}</em>
                <code v-else-if="seg.kind === 'code'" class="md-inline-code">{{ seg.text }}</code>
                <a
                  v-else-if="seg.kind === 'link'"
                  :href="seg.url"
                  class="md-link"
                  @click.prevent="openLink(seg.url)"
                  >{{ seg.text }}</a
                >
                <template v-else>{{ seg.text }}</template>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </template>
  </div>
</template>

<style scoped>
.md-doc {
  color: var(--text);
  font-size: 13px;
  line-height: 1.6;
}

/* Top-of-doc title — the tab already labels the document so we keep
 * the H1 small and unobtrusive. It still helps readers confirm what
 * they're reading and shows the parenthetical (e.g. "EULA"). */
.md-h1 {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 8px 0;
  color: var(--text);
}

.md-h1 + .md-p {
  /* First paragraph after the H1 is typically the meta block (Effective
   * date / Applies to / Publisher). Render it as muted, smaller, with a
   * subtle separator below to mark the end of the doc header. */
  font-size: 12px;
  color: var(--text-muted);
  margin: 0 0 4px 0;
}

.md-h2 {
  font-size: 14px;
  font-weight: 600;
  margin: 18px 0 6px 0;
  color: var(--text);
}

.md-h3 {
  font-size: 13px;
  font-weight: 600;
  margin: 14px 0 4px 0;
  color: var(--text);
}

.md-h4 {
  font-size: 13px;
  font-weight: 600;
  font-style: italic;
  margin: 10px 0 4px 0;
  color: var(--text);
}

.md-hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 16px 0;
}

.md-p {
  margin: 0 0 8px 0;
  color: var(--text-muted);
}

.md-ul,
.md-ol {
  margin: 0 0 8px 0;
  padding-left: 22px;
  color: var(--text-muted);
}

/* Re-assert list markers — the app sets default list-style to none on
 * <ul> in some surfaces, so be explicit here. */
.md-ul {
  list-style: disc outside;
}

.md-ol {
  list-style: decimal outside;
}

.md-ul li,
.md-ol li {
  margin-bottom: 6px;
  padding-left: 2px;
}

.md-ul li::marker,
.md-ol li::marker {
  color: var(--text-faint);
}

.md-blockquote {
  margin: 8px 0;
  padding: 8px 12px;
  border-left: 3px solid var(--border);
  background: color-mix(in srgb, var(--border) 20%, transparent);
  color: var(--text-muted);
  font-style: italic;
}

.md-code {
  margin: 8px 0;
  padding: 10px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text);
  white-space: pre;
  overflow-x: auto;
}

.md-inline-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  padding: 1px 4px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text);
}

.md-table {
  margin: 8px 0;
  border-collapse: collapse;
  font-size: 12px;
  width: 100%;
}

.md-table th,
.md-table td {
  padding: 6px 10px;
  border: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
  color: var(--text-muted);
}

.md-table th {
  background: var(--bg);
  color: var(--text);
  font-weight: 600;
}

.md-doc strong {
  color: var(--text);
  font-weight: 600;
}

.md-link {
  color: var(--accent);
  text-decoration: underline;
  cursor: pointer;
}

.md-link:hover {
  color: var(--accent-hover);
}
</style>
