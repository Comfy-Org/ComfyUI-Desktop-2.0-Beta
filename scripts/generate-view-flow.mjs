/**
 * View Flow Graph Generator — Phase 2 of Issue #226
 *
 * Parses App.vue to extract the view→modal→view navigation graph
 * and outputs a Mermaid diagram to docs/view-flow.md.
 *
 * Run: node scripts/generate-view-flow.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const APP_VUE = resolve(ROOT, 'src/renderer/src/App.vue')
const VIEWS_DIR = resolve(ROOT, 'src/renderer/src/views')
const OUTPUT = resolve(ROOT, 'docs/view-flow.md')

const VIEW_COMPONENTS = [
  'DashboardView', 'InstallationList', 'RunningView',
  'SettingsView', 'ModelsView', 'MediaView',
  'DetailModal', 'ConsoleModal', 'ProgressModal',
  'NewInstallModal', 'QuickInstallModal', 'TrackModal',
  'LoadSnapshotModal',
]

const TAB_VIEWS = ['DashboardView', 'InstallationList', 'RunningView', 'ModelsView', 'MediaView', 'SettingsView']

const VIEW_TO_FILE = {
  DashboardView: 'DashboardView.vue',
  InstallationList: 'InstallationList.vue',
  RunningView: 'RunningView.vue',
  ModelsView: 'ModelsView.vue',
  MediaView: 'MediaView.vue',
  SettingsView: 'SettingsView.vue',
  DetailModal: 'DetailModal.vue',
  ConsoleModal: 'ConsoleModal.vue',
  ProgressModal: 'ProgressModal.vue',
  NewInstallModal: 'NewInstallModal.vue',
  QuickInstallModal: 'QuickInstallModal.vue',
  TrackModal: 'TrackModal.vue',
  LoadSnapshotModal: 'LoadSnapshotModal.vue',
}

const NODE_LABELS = {
  Sidebar: '🧭 Sidebar',
  DashboardView: '📊 Dashboard',
  InstallationList: '📦 Installs',
  RunningView: '▶️ Running',
  ModelsView: '📁 Models',
  MediaView: '🖼️ Media',
  SettingsView: '⚙️ Settings',
  DetailModal: '🔍 Detail Modal',
  ConsoleModal: '💻 Console Modal',
  ProgressModal: '⏳ Progress Modal',
  NewInstallModal: '➕ New Install Modal',
  QuickInstallModal: '⚡ Quick Install Modal',
  TrackModal: '📂 Track Existing Modal',
  LoadSnapshotModal: '📸 Load Snapshot Modal',
}

const SWITCH_VIEW_MAP = {
  dashboard: 'DashboardView',
  list: 'InstallationList',
  running: 'RunningView',
  models: 'ModelsView',
  media: 'MediaView',
  settings: 'SettingsView',
}

// ── Helpers ──────────────────────────────────────────────────

function extractTemplate(vue) {
  const match = vue.match(/<template>([\s\S]*)<\/template>/)
  return match?.[1] ?? ''
}

function nodeId(name) {
  return name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
}

function isModal(name) {
  return name.endsWith('Modal')
}

// ── Parse App.vue template for @event bindings ───────────────

function parseComponentBindings(template) {
  const bindings = []
  const componentPattern = /<([A-Z][A-Za-z]+)[\s\S]*?(?:\/>|<\/\1>)/g
  let match

  while ((match = componentPattern.exec(template)) !== null) {
    const [block, component] = match
    if (!VIEW_COMPONENTS.includes(component)) continue

    const events = []
    const eventPattern = /@([\w-]+)="([^"]+)"/g
    let eventMatch
    while ((eventMatch = eventPattern.exec(block)) !== null) {
      events.push({ event: eventMatch[1], handler: eventMatch[2] })
    }

    bindings.push({ component, events })
  }

  return bindings
}

// ── Resolve handler string → target component ────────────────

function resolveHandler(handler) {
  if (handler.includes('openDetail')) return 'DetailModal'
  if (handler.includes('openConsole')) return 'ConsoleModal'
  if (handler.includes('openNewInstall')) return 'NewInstallModal'
  if (handler.includes('openQuickInstall')) return 'QuickInstallModal'
  if (handler.includes('openTrack')) return 'TrackModal'
  if (handler.includes('openLoadSnapshot')) return 'LoadSnapshotModal'
  if (handler.includes('showProgress')) return 'ProgressModal'
  if (handler.includes('handleNavigateList')) return 'InstallationList'
  if (handler.includes('handleProgressShowDetail')) return 'DetailModal'

  if (handler.includes('switchView')) {
    const viewMatch = handler.match(/switchView\('(\w+)'\)/)
    if (viewMatch) return SWITCH_VIEW_MAP[viewMatch[1]] ?? null
  }

  // close/update handlers don't navigate
  return null
}

// ── Parse child view emit() calls ────────────────────────────

function parseChildEmits(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8')
    const emits = new Set()
    const emitPattern = /emit\(['"]([^'"]+)['"]/g
    let m
    while ((m = emitPattern.exec(content)) !== null) {
      emits.add(m[1])
    }
    return [...emits]
  } catch {
    return []
  }
}

// ── Build the graph ──────────────────────────────────────────

function buildGraph() {
  const appVue = readFileSync(APP_VUE, 'utf-8')
  const template = extractTemplate(appVue)
  const bindings = parseComponentBindings(template)

  const nodes = new Set()
  const edges = []
  const edgeSet = new Set()

  function addEdge(from, to, event) {
    const key = `${from}→${to}:${event}`
    if (edgeSet.has(key)) return
    edgeSet.add(key)
    nodes.add(from)
    nodes.add(to)
    edges.push({ from, to, event })
  }

  // Sidebar → tab views
  nodes.add('Sidebar')
  for (const view of TAB_VIEWS) {
    addEdge('Sidebar', view, 'click')
  }

  // App.vue component bindings
  for (const binding of bindings) {
    nodes.add(binding.component)
    for (const { event, handler } of binding.events) {
      const target = resolveHandler(handler)
      if (target) addEdge(binding.component, target, event)
    }
  }

  // Child view emits → App.vue handler resolution
  for (const [component, file] of Object.entries(VIEW_TO_FILE)) {
    const emits = parseChildEmits(resolve(VIEWS_DIR, file))
    const binding = bindings.find((b) => b.component === component)
    for (const event of emits) {
      const handler = binding?.events.find((e) => e.event === event)?.handler
      if (handler) {
        const target = resolveHandler(handler)
        if (target) addEdge(component, target, event)
      }
    }
  }

  return { nodes, edges }
}

// ── Generate Mermaid ─────────────────────────────────────────

function generateMermaid(nodes, edges) {
  const lines = ['flowchart TD']

  lines.push('')
  lines.push('  %% Tab Views')
  for (const node of nodes) {
    if (TAB_VIEWS.includes(node)) {
      lines.push(`  ${nodeId(node)}["${NODE_LABELS[node]}"]`)
    }
  }

  lines.push('')
  lines.push('  %% Modals')
  for (const node of nodes) {
    if (isModal(node)) {
      lines.push(`  ${nodeId(node)}("${NODE_LABELS[node]}")`)
    }
  }

  if (nodes.has('Sidebar')) {
    lines.push('')
    lines.push(`  sidebar{{"${NODE_LABELS.Sidebar}"}}`)
  }

  lines.push('')
  lines.push('  %% Sidebar navigation')
  for (const edge of edges) {
    if (edge.from === 'Sidebar') {
      lines.push(`  ${nodeId(edge.from)} --> ${nodeId(edge.to)}`)
    }
  }

  lines.push('')
  lines.push('  %% View → Modal transitions')
  for (const edge of edges) {
    if (edge.from !== 'Sidebar' && !isModal(edge.from)) {
      lines.push(`  ${nodeId(edge.from)} -->|${edge.event}| ${nodeId(edge.to)}`)
    }
  }

  lines.push('')
  lines.push('  %% Modal → View/Modal transitions')
  for (const edge of edges) {
    if (isModal(edge.from)) {
      lines.push(`  ${nodeId(edge.from)} -->|${edge.event}| ${nodeId(edge.to)}`)
    }
  }

  lines.push('')
  lines.push('  %% Styles')
  lines.push('  classDef tabView fill:#1a1a2e,stroke:#00d9ff,color:#e0e0e0,stroke-width:2px')
  lines.push('  classDef modal fill:#1a1a2e,stroke:#ff6b6b,color:#e0e0e0,stroke-width:2px')
  lines.push('  classDef nav fill:#1a1a2e,stroke:#ffd93d,color:#e0e0e0,stroke-width:2px')

  const tabNodes = [...nodes].filter((n) => TAB_VIEWS.includes(n)).map(nodeId).join(',')
  const modalNodes = [...nodes].filter(isModal).map(nodeId).join(',')

  if (tabNodes) lines.push(`  class ${tabNodes} tabView`)
  if (modalNodes) lines.push(`  class ${modalNodes} modal`)
  if (nodes.has('Sidebar')) lines.push('  class sidebar nav')

  return lines.join('\n')
}

// ── Source file table ────────────────────────────────────────

function generateSourceLinks(nodes) {
  const lines = ['', '## Source Files', '']
  lines.push('| View/Modal | Source |')
  lines.push('|------------|--------|')
  for (const node of nodes) {
    const file = VIEW_TO_FILE[node]
    if (file) {
      const fullPath = `src/renderer/src/views/${file}`
      lines.push(`| ${NODE_LABELS[node]} | [\`${fullPath}\`](../${fullPath}) |`)
    }
  }
  return lines.join('\n')
}

// ── Main ─────────────────────────────────────────────────────

const { nodes, edges } = buildGraph()
const mermaid = generateMermaid(nodes, edges)

const output = [
  '# View/Modal Flow — Desktop 2.0',
  '',
  '> Auto-generated by `scripts/generate-view-flow.mjs` — do not edit manually.',
  '>',
  '> Run: `node scripts/generate-view-flow.mjs`',
  '',
  '## Navigation Graph',
  '',
  '```mermaid',
  mermaid,
  '```',
  '',
  '## Legend',
  '',
  '- **Blue border** = Tab view (sidebar navigation)',
  '- **Red border** = Modal (overlay)',
  '- **Yellow border** = Sidebar navigator',
  '- Edge labels show the Vue event name that triggers the transition',
  generateSourceLinks(nodes),
  '',
].join('\n')

mkdirSync(dirname(OUTPUT), { recursive: true })
writeFileSync(OUTPUT, output, 'utf-8')

console.log(`✅ Generated ${OUTPUT}`)
console.log(`   ${nodes.size} nodes, ${edges.length} edges`)
