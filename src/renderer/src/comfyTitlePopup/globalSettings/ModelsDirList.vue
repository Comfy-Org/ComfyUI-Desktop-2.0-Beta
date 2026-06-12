<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight, FileText, Folder, FolderLock, FolderOpen, MoreHorizontal, Plus } from 'lucide-vue-next'
import InfoTooltip from '../../components/InfoTooltip.vue'
import StorageItemIcon from '../../components/StorageItemIcon.vue'

interface ModelsDir {
  path: string
  isPrimary: boolean
  /** Locked rows (e.g. the install's own models dir) can't be removed or
   *  browsed/replaced; they show a lock icon. */
  locked?: boolean
  /** Set false to also forbid promoting the row to primary (e.g. the
   *  install's own models dir while shared models is on — the primary is a
   *  global shared dir there). Defaults to true. */
  promotable?: boolean
  /** Read-only row for the install's `extra_model_paths.yaml` file: opens a
   *  detail modal (via `details`), no browse/promote/remove. */
  kind?: 'extra'
  /** Globally-shared dir → shows the shared badge on its icon. */
  shared?: boolean
}

interface Props {
  dirs: ModelsDir[]
}

const props = defineProps<Props>()

const emit = defineEmits<{
  change: [index: number]
  remove: [index: number]
  'make-primary': [index: number]
  open: [index: number]
  /** Open the detail modal for a read-only `kind: 'extra'` row. */
  details: [index: number]
  add: []
}>()

const { t } = useI18n()
const openMenuIndex = ref<number | null>(null)
const menuToggleRefs = new Map<number, HTMLButtonElement>()
const menuRefs = new Map<number, HTMLDivElement>()

function setMenuToggleRef(index: number, el: Element | null): void {
  if (el instanceof HTMLButtonElement) menuToggleRefs.set(index, el)
  else menuToggleRefs.delete(index)
}

function setMenuRef(index: number, el: Element | null): void {
  if (el instanceof HTMLDivElement) menuRefs.set(index, el)
  else menuRefs.delete(index)
}

function canPromote(dir: ModelsDir): boolean {
  return dir.kind !== 'extra' && !dir.isPrimary && dir.promotable !== false
}

function canRemove(dir: ModelsDir): boolean {
  return dir.kind !== 'extra' && !dir.isPrimary && !dir.locked
}

function hasMenuActions(dir: ModelsDir): boolean {
  return canPromote(dir) || canRemove(dir)
}

async function toggleMenu(index: number): Promise<void> {
  const willOpen = openMenuIndex.value !== index
  openMenuIndex.value = willOpen ? index : null
  if (willOpen) {
    await nextTick()
    focusFirstMenuItem(index)
  }
}

function closeMenu(restoreFocus = false): void {
  const prev = openMenuIndex.value
  openMenuIndex.value = null
  if (restoreFocus && prev != null) menuToggleRefs.get(prev)?.focus()
}

function focusFirstMenuItem(index: number): void {
  menuItemsFor(index)[0]?.focus()
}

function menuItemsFor(index: number): HTMLButtonElement[] {
  const menu = menuRefs.get(index)
  if (!menu) return []
  return Array.from(menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'))
}

function handleMenuArrow(index: number, direction: 1 | -1, event: KeyboardEvent): void {
  event.preventDefault()
  const items = menuItemsFor(index)
  if (items.length === 0) return
  const current = items.indexOf(document.activeElement as HTMLButtonElement)
  const next = (current + direction + items.length) % items.length
  items[next]?.focus()
}

function handleChange(index: number): void {
  closeMenu()
  emit('change', index)
}

function handleRemove(index: number): void {
  closeMenu()
  emit('remove', index)
}

/** Path most recently promoted to primary, driving a brief highlight pulse.
 *  Keyed by `path` so the class rides the row as Vue reorders the list. */
const justPromotedPath = ref<string | null>(null)
const justPromotedTimer = ref<ReturnType<typeof setTimeout> | null>(null)

function handleMakePrimary(index: number): void {
  closeMenu()
  const promoted = props.dirs[index]?.path ?? null
  emit('make-primary', index)
  if (promoted) {
    justPromotedPath.value = promoted
    if (justPromotedTimer.value) clearTimeout(justPromotedTimer.value)
    justPromotedTimer.value = setTimeout(() => {
      justPromotedPath.value = null
      justPromotedTimer.value = null
    }, 1200)
  }
}

onBeforeUnmount(() => {
  if (justPromotedTimer.value) {
    clearTimeout(justPromotedTimer.value)
    justPromotedTimer.value = null
  }
})

const rows = computed(() =>
  props.dirs.map((dir, index) => ({
    ...dir,
    index,
    locked: dir.locked === true,
    isExtra: dir.kind === 'extra',
    showMenu: hasMenuActions(dir),
    canPromote: canPromote(dir),
    canRemove: canRemove(dir)
  }))
)
</script>

<template>
  <div class="models-dir-list" @click="closeMenu()">
    <div
      v-for="row in rows"
      :key="row.path"
      class="models-dir-row"
      :class="{ 'is-just-promoted': row.path === justPromotedPath }"
    >
      <StorageItemIcon
        :icon="row.isExtra ? FileText : row.locked ? FolderLock : Folder"
        :shared="row.shared"
        :title="row.locked ? t('models.lockedDir', 'This directory is always used and cannot be removed.') : undefined"
      />
      <div class="models-dir-main">
        <button
          type="button"
          class="models-dir-name"
          :title="row.isExtra ? t('comfyUISettings.viewCustomPathDetails', 'View custom path details') : t('models.openDir', 'Open folder')"
          @click.stop="row.isExtra ? emit('details', row.index) : emit('open', row.index)"
        >{{ row.path }}</button>
      </div>
      <span v-if="row.isPrimary" class="models-dir-tag tag-primary">
        {{ t('models.primary', 'Downloads') }}
        <InfoTooltip :text="t('tooltips.modelsPrimary')" />
      </span>
      <span v-if="row.locked || row.isExtra" class="models-dir-tag tag-local">
        {{ row.isExtra ? t('comfyUISettings.yamlTag', 'YAML') : t('models.instanceOnly', 'Instance') }}
        <InfoTooltip :text="row.isExtra ? t('tooltips.extraModelPathsInstance') : t('tooltips.instanceOwnModelsDir')" />
      </span>
      <div class="models-dir-actions">
        <button
          v-if="row.isExtra"
          type="button"
          class="models-dir-action"
          :aria-label="t('comfyUISettings.viewCustomPathDetails', 'View custom path details')"
          :title="t('comfyUISettings.viewCustomPathDetails', 'View custom path details')"
          @click.stop="emit('details', row.index)"
        >
          <ChevronRight :size="14" aria-hidden="true" />
        </button>
        <button
          v-if="!row.locked && !row.isExtra"
          type="button"
          class="models-dir-action"
          :aria-label="t('common.browse', 'Browse')"
          :title="t('common.browse', 'Browse')"
          @click.stop="handleChange(row.index)"
        >
          <FolderOpen :size="14" aria-hidden="true" />
        </button>
        <div v-if="row.showMenu" class="models-dir-menu-wrap">
          <button
            :ref="(el) => setMenuToggleRef(row.index, el as Element | null)"
            type="button"
            class="models-dir-action"
            :aria-label="t('models.moreActions', 'More actions')"
            :aria-expanded="openMenuIndex === row.index"
            aria-haspopup="menu"
            @click.stop="toggleMenu(row.index)"
            @keydown.esc.stop.prevent="closeMenu(true)"
          >
            <MoreHorizontal :size="14" aria-hidden="true" />
          </button>
          <div
            v-if="openMenuIndex === row.index"
            :ref="(el) => setMenuRef(row.index, el as Element | null)"
            class="models-dir-menu"
            role="menu"
            @click.stop
            @keydown.esc.stop.prevent="closeMenu(true)"
            @keydown.down.stop.prevent="handleMenuArrow(row.index, 1, $event)"
            @keydown.up.stop.prevent="handleMenuArrow(row.index, -1, $event)"
          >
            <button
              v-if="row.canPromote"
              type="button"
              role="menuitem"
              @click="handleMakePrimary(row.index)"
            >
              {{ t('models.makePrimary', 'Use for Model Downloads') }}
            </button>
            <button
              v-if="row.canRemove"
              type="button"
              role="menuitem"
              class="danger"
              @click="handleRemove(row.index)"
            >
              {{ t('models.removeDir', 'Remove') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <button type="button" class="models-dir-add" @click="emit('add')">
      <Plus :size="14" aria-hidden="true" />
      <span>{{ t('models.addDir', 'Add directory') }}</span>
    </button>
  </div>
</template>

<style scoped>
.models-dir-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--chooser-surface-border);
  border-radius: 8px;
  background: var(--brand-surface-bg);
}

.models-dir-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 8px 10px;
  border-top: 1px solid var(--border-hover);
}

.models-dir-row:first-child {
  border-top: none;
}

/* Make-primary feedback: brief yellow pulse on the just-promoted row. */
.models-dir-row.is-just-promoted {
  animation: models-dir-promote 1200ms ease-out;
}

@keyframes models-dir-promote {
  0% {
    background: transparent;
  }
  10% {
    background: color-mix(in srgb, var(--neutral-50) 22%, transparent);
  }
  30% {
    background: color-mix(in srgb, var(--neutral-50) 22%, transparent);
  }
  100% {
    background: transparent;
  }
}

.models-dir-main {
  display: flex;
  align-items: center;
  min-width: 0;
  flex: 1 1 auto;
}

.models-dir-name {
  font-size: 13px;
  line-height: 18px;
  color: var(--neutral-100);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  max-width: 100%;
  /* Reset button chrome — this is a clickable path that opens the folder. */
  padding: 0;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.models-dir-name:hover,
.models-dir-name:focus-visible {
  color: var(--accent);
  text-decoration: underline;
  outline: none;
}

.models-dir-tag {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 500;
  line-height: 14px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.models-dir-tag.tag-primary {
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}

/* Marks the install's own models dir: always used, never shared. */
.models-dir-tag.tag-local {
  color: var(--text-muted);
  border: 1px solid var(--chooser-surface-border);
  background: color-mix(in srgb, var(--text) 6%, transparent);
}

.models-dir-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.models-dir-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition:
    background-color 100ms ease,
    color 100ms ease;
}

.models-dir-action:hover,
.models-dir-action:focus-visible {
  background: var(--brand-surface-bg-hover);
  color: var(--neutral-100);
  outline: none;
}

.models-dir-menu-wrap {
  position: relative;
}

.models-dir-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 10;
  min-width: 140px;
  padding: 4px;
  border: 1px solid var(--chooser-surface-border);
  border-radius: 8px;
  background: var(--neutral-800);
  box-shadow: 0 8px 24px color-mix(in oklab, var(--neutral-950) 40%, transparent);
}

.models-dir-menu button {
  display: block;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--neutral-100);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.models-dir-menu button:hover,
.models-dir-menu button:focus-visible {
  background: var(--brand-surface-bg-hover);
  outline: none;
}

.models-dir-menu button.danger {
  color: var(--danger);
}

.models-dir-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  min-height: 36px;
  padding: 8px 10px;
  border: none;
  border-top: 1px solid var(--border-hover);
  background: transparent;
  color: var(--text-muted);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition:
    background-color 100ms ease,
    color 100ms ease;
}

.models-dir-add:hover,
.models-dir-add:focus-visible {
  background: var(--brand-surface-bg-hover);
  color: var(--neutral-100);
  outline: none;
}
</style>
