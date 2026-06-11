/**
 * Parses ComfyUI's `python main.py --help` output into a structured schema
 * for the args-builder UI. Supports caching per installation version.
 */

import { execFile } from 'child_process'
import * as path from 'path'


export interface ComfyArgDef {
  /** CLI flag without leading dashes, e.g. "port" */
  name: string
  /** The full flag string, e.g. "--port" */
  flag: string
  help: string
  type: 'boolean' | 'value' | 'optional-value' | 'multi-value'
  /** Metavar from argparse (e.g. "PORT", "IP") */
  metavar?: string
  choices?: string[]
  /** Mutually exclusive group id (args sharing a group cannot coexist) */
  exclusiveGroup?: string
  category: string
}

export interface ComfyArgsSchema {
  args: ComfyArgDef[]
  knownFlags: Set<string>
}

const CATEGORY_MAP: Record<string, string> = {
  'listen': 'Network',
  'port': 'Network',
  'tls-keyfile': 'Network',
  'tls-certfile': 'Network',
  'enable-cors-header': 'Network',
  'max-upload-size': 'Network',
  'multi-user': 'Network',
  'enable-compress-response-body': 'Network',

  'base-directory': 'Paths',
  'extra-model-paths-config': 'Paths',
  'output-directory': 'Paths',
  'temp-directory': 'Paths',
  'input-directory': 'Paths',
  'user-directory': 'Paths',
  'front-end-root': 'Paths',

  'auto-launch': 'Launch',
  'disable-auto-launch': 'Launch',
  'windows-standalone-build': 'Launch',

  'cuda-device': 'GPU & VRAM',
  'default-device': 'GPU & VRAM',
  'cuda-malloc': 'GPU & VRAM',
  'disable-cuda-malloc': 'GPU & VRAM',
  'directml': 'GPU & VRAM',
  'oneapi-device-selector': 'GPU & VRAM',
  'disable-ipex-optimize': 'GPU & VRAM',
  'supports-fp8-compute': 'GPU & VRAM',
  'gpu-only': 'GPU & VRAM',
  'highvram': 'GPU & VRAM',
  'normalvram': 'GPU & VRAM',
  'lowvram': 'GPU & VRAM',
  'novram': 'GPU & VRAM',
  'cpu': 'GPU & VRAM',
  'reserve-vram': 'GPU & VRAM',
  'async-offload': 'GPU & VRAM',
  'disable-async-offload': 'GPU & VRAM',
  'disable-dynamic-vram': 'GPU & VRAM',
  'enable-dynamic-vram': 'GPU & VRAM',
  'fast-disk': 'GPU & VRAM',
  'force-non-blocking': 'GPU & VRAM',
  'disable-smart-memory': 'GPU & VRAM',
  'disable-pinned-memory': 'GPU & VRAM',

  'force-fp32': 'Precision',
  'force-fp16': 'Precision',
  'fp32-unet': 'Precision',
  'fp64-unet': 'Precision',
  'bf16-unet': 'Precision',
  'fp16-unet': 'Precision',
  'fp8_e4m3fn-unet': 'Precision',
  'fp8_e5m2-unet': 'Precision',
  'fp8_e8m0fnu-unet': 'Precision',
  'fp16-vae': 'Precision',
  'fp32-vae': 'Precision',
  'bf16-vae': 'Precision',
  'cpu-vae': 'Precision',
  'fp8_e4m3fn-text-enc': 'Precision',
  'fp8_e5m2-text-enc': 'Precision',
  'fp16-text-enc': 'Precision',
  'fp32-text-enc': 'Precision',
  'bf16-text-enc': 'Precision',
  'fp16-intermediates': 'Precision',
  'force-channels-last': 'Precision',

  'use-split-cross-attention': 'Performance',
  'use-quad-cross-attention': 'Performance',
  'use-pytorch-cross-attention': 'Performance',
  'use-sage-attention': 'Performance',
  'use-flash-attention': 'Performance',
  'enable-triton-backend': 'Performance',
  'disable-xformers': 'Performance',
  'force-upcast-attention': 'Performance',
  'dont-upcast-attention': 'Performance',
  'deterministic': 'Performance',
  'fast': 'Performance',
  'mmap-torch-files': 'Performance',
  'disable-mmap': 'Performance',

  'cache-classic': 'Cache',
  'cache-lru': 'Cache',
  'cache-none': 'Cache',
  'cache-ram': 'Cache',

  'preview-method': 'Preview',
  'preview-size': 'Preview',

  'enable-manager': 'Manager',
  'disable-manager-ui': 'Manager',
  'enable-manager-legacy-ui': 'Manager',

  'front-end-version': 'Frontend',

  'disable-metadata': 'Features',
  'disable-all-custom-nodes': 'Features',
  'whitelist-custom-nodes': 'Features',
  'disable-api-nodes': 'Features',
  'enable-assets': 'Features',

  'verbose': 'Logging',
  'log-stdout': 'Logging',
  'dont-print-server': 'Logging',

  'default-hashing-function': 'Advanced',
  'quick-test-for-ci': 'Advanced',
  'comfy-api-base': 'Advanced',
  'database-url': 'Advanced',
}

const CATEGORY_ORDER = [
  'Network', 'Launch', 'GPU & VRAM', 'Precision', 'Performance',
  'Cache', 'Preview', 'Manager', 'Frontend', 'Features',
  'Paths', 'Logging', 'Advanced', 'Other',
]

/**
 * Flags present in --help but hidden from the suggestion panel (internal launcher use).
 * Still kept in `knownFlags` so user-typed values survive `filterUnsupportedArgs`.
 */
const HIDDEN_ARGS = new Set(['feature-flag', 'list-feature-flags'])

function getCategory(flagName: string): string {
  return CATEGORY_MAP[flagName] || 'Other'
}

/** Parse the usage line's mutually exclusive groups: `[--flag1 | --flag2 | --flag3]`.
 *  Walks brackets depth-first so nested optional metavars (e.g. `--cache-ram [GB ...]`)
 *  don't prematurely close the surrounding group and drop later members. */
function parseExclusiveGroups(usageLine: string): Map<string, string> {
  const flagToGroup = new Map<string, string>()
  let groupId = 0
  for (let i = 0; i < usageLine.length; i++) {
    const open = usageLine[i]
    if (open !== '[' && open !== '(') continue
    // Find the matching close bracket, tracking nesting of both [] and ().
    let depth = 0
    let j = i
    for (; j < usageLine.length; j++) {
      const c = usageLine[j]
      if (c === '[' || c === '(') depth++
      else if ((c === ']' || c === ')') && --depth === 0) break
    }
    const content = usageLine.slice(i + 1, j)
    // A mutually exclusive group is a bracket containing `|`-separated alternatives.
    if (content.includes('|')) {
      const flags = content.match(/--[\w_-]+/g)
      if (flags && flags.length > 1) {
        const gid = `group_${groupId++}`
        for (const flag of flags) {
          flagToGroup.set(flag.slice(2), gid)
        }
      }
    }
    i = j // skip the whole group; nested brackets are part of it
  }
  return flagToGroup
}

interface ParsedOption {
  name: string
  flag: string
  type: 'boolean' | 'value' | 'optional-value' | 'multi-value'
  metavar?: string
  choices?: string[]
  help: string
}

function parseOptionsSection(optionsText: string): ParsedOption[] {
  const results: ParsedOption[] = []

  // argparse formats options as:
  //   --flag-name METAVAR    Help text starts here
  //                          continuation of help
  //   --another-flag         Help text on same line
  //
  // Flag definitions start at column 2. Help text is aligned ~column 24+.
  // We split on the large whitespace gap between flag and help.
  const lines = optionsText.split('\n')
  let current: { flagLine: string; helpLines: string[] } | null = null

  for (const line of lines) {
    // New option starts with 2-space indent + --
    const optMatch = line.match(/^ {2}(--\S+(?:\s+(?:\[?\S+\]?(?:\s+\.\.\.)?))*)\s{2,}(.*)$/)
    if (optMatch) {
      if (current) results.push(parseOptionBlock(current.flagLine, current.helpLines.join(' ')))
      current = { flagLine: optMatch[1]!, helpLines: [] }
      if (optMatch[2]!.trim()) current.helpLines.push(optMatch[2]!.trim())
    } else {
      // Flag-only line (no help on this line, e.g. long flag names)
      const flagOnly = line.match(/^ {2}(--\S+(?:\s+\S+)*)\s*$/)
      if (flagOnly) {
        if (current) results.push(parseOptionBlock(current.flagLine, current.helpLines.join(' ')))
        current = { flagLine: flagOnly[1]!, helpLines: [] }
      } else if (current) {
        // Continuation (help text), usually indented more
        const trimmed = line.trim()
        if (trimmed) current.helpLines.push(trimmed)
      }
    }
  }
  if (current) results.push(parseOptionBlock(current.flagLine, current.helpLines.join(' ')))

  return results
}

function parseOptionBlock(flagLine: string, helpText: string): ParsedOption {
  // Examples of flagLine patterns:
  //   --listen [IP]
  //   --port PORT
  //   --force-fp32
  //   --preview-method [none,auto,latent2rgb,taesd]
  //   --verbose [{DEBUG,INFO,WARNING,ERROR,CRITICAL}]
  //   --cache-lru CACHE_LRU
  //   --async-offload [NUM_STREAMS]
  //   --default-hashing-function {md5,sha1,sha256,sha512}
  //   --fast [FAST ...]
  //   --whitelist-custom-nodes WHITELIST_CUSTOM_NODES [WHITELIST_CUSTOM_NODES ...]

  // Extract the primary flag (first --xxx token)
  const flagMatch = flagLine.match(/--([\w_][\w_-]*)/)
  if (!flagMatch) {
    return { name: 'unknown', flag: '--unknown', type: 'boolean', help: helpText }
  }

  const name = flagMatch[1]!
  const flag = `--${name}`
  const afterFlag = flagLine.slice(flagLine.indexOf(flag) + flag.length).trim()

  // A `...` marks a variadic flag (argparse nargs `*`/`+`), e.g. `--cache-ram [GB ...]`
  // or `--whitelist-custom-nodes WL [WL ...]`, which accept several space-separated values.
  const isMulti = afterFlag.includes('...')

  // Choices: {a,b,c} or [a,b,c] or [{a,b,c}]
  const choicesMatch = afterFlag.match(/\[?\{([^}]+)\}\]?/) || afterFlag.match(/\[([\w,]+)\]/)
  if (choicesMatch) {
    const choices = choicesMatch[1]!.split(',').map((s) => s.trim())
    // Brackets [] mean optional (usable without a value)
    const isOptional = afterFlag.startsWith('[')
    return {
      name, flag, help: helpText, choices,
      type: isMulti ? 'multi-value' : isOptional ? 'optional-value' : 'value',
      metavar: undefined,
    }
  }

  // Metavar: UPPER_CASE or [UPPER_CASE] or [UPPER_CASE ...]
  const metaMatch = afterFlag.match(/\[?([A-Z][A-Z0-9_]*(?:\s+\.\.\.)?)(?:\s+\[.*\])?\]?/)
  if (metaMatch) {
    const isOptional = afterFlag.startsWith('[')
    return {
      name, flag, help: helpText,
      type: isMulti ? 'multi-value' : isOptional ? 'optional-value' : 'value',
      metavar: metaMatch[1]!.replace(/\s+\.\.\./, ''),
    }
  }

  // No metavar, no choices = boolean flag
  if (!afterFlag || afterFlag.startsWith('  ')) {
    return { name, flag, type: 'boolean', help: helpText }
  }

  return { name, flag, type: 'value', help: helpText }
}

export function parseHelpOutput(helpText: string): ComfyArgsSchema {
  helpText = helpText.replace(/\r\n/g, '\n')
  const usageMatch = helpText.match(/^usage:.*?(?=\n\noptions:|$)/s)
  const usageLine = usageMatch ? usageMatch[0].replace(/\n\s+/g, ' ') : ''
  const exclusiveGroups = parseExclusiveGroups(usageLine)

  const optionsMatch = helpText.match(/\noptions:\n([\s\S]*)$/)
  const optionsText = optionsMatch ? optionsMatch[1]! : ''

  const parsedOptions = parseOptionsSection(optionsText)
  const knownFlags = new Set<string>()

  const args: ComfyArgDef[] = []
  for (const opt of parsedOptions) {
    if (opt.name === 'h' || opt.name === 'help') continue
    knownFlags.add(opt.name)
    if (HIDDEN_ARGS.has(opt.name)) continue
    args.push({
      name: opt.name,
      flag: opt.flag,
      help: opt.help,
      type: opt.type,
      metavar: opt.metavar,
      choices: opt.choices,
      exclusiveGroup: exclusiveGroups.get(opt.name),
      category: getCategory(opt.name),
    })
  }

  // Sort by category order, then by original order within category
  args.sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a.category)
    const bi = CATEGORY_ORDER.indexOf(b.category)
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
  })

  return { args, knownFlags }
}

const schemaCache = new Map<string, { schema: ComfyArgsSchema; version: string }>()

/** Run `python main.py --help` and parse the output, cached per installationId+version. */
export async function getComfyArgsSchema(
  pythonPath: string,
  mainPyPath: string,
  cwd: string,
  installationId: string,
  version?: string
): Promise<ComfyArgsSchema> {
  const cached = schemaCache.get(installationId)
  if (cached && version && cached.version === version) {
    return cached.schema
  }

  const helpText = await runHelp(pythonPath, mainPyPath, cwd)
  const schema = parseHelpOutput(helpText)

  if (version) {
    schemaCache.set(installationId, { schema, version })
  }

  return schema
}

function runHelp(pythonPath: string, mainPyPath: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const mainPyRel = path.relative(cwd, mainPyPath)
    execFile(pythonPath, ['-s', mainPyRel, '--help'], { cwd, timeout: 15000 }, (err, stdout, stderr) => {
      if (stdout && stdout.includes('usage:')) {
        resolve(stdout)
      } else if (stderr && stderr.includes('usage:')) {
        // Some configurations print help to stderr
        resolve(stderr)
      } else if (err) {
        const detail = stderr ? `\nstderr: ${stderr.slice(0, 500)}` : ''
        reject(new Error(`Failed to get ComfyUI --help: ${err.message}${detail}`))
      } else {
        reject(new Error('No help output from ComfyUI'))
      }
    })
  })
}

/** Return the flag names in `userArgs` not recognized by the schema. */
export function validateArgs(userArgs: string[], schema: ComfyArgsSchema): string[] {
  const unsupported: string[] = []
  for (const arg of userArgs) {
    if (arg.startsWith('--')) {
      const name = arg.slice(2).replace(/=.*$/, '')
      if (!schema.knownFlags.has(name)) {
        unsupported.push(name)
      }
    }
  }
  return unsupported
}

/** Return only the args known to ComfyUI, dropping unsupported flags and their values. */
export function filterUnsupportedArgs(userArgs: string[], schema: ComfyArgsSchema): string[] {
  const argTypes = new Map(schema.args.map((a) => [a.name, a.type]))
  const result: string[] = []
  let i = 0
  while (i < userArgs.length) {
    const arg = userArgs[i]!
    if (arg.startsWith('--')) {
      const name = arg.slice(2).replace(/=.*$/, '')
      const hasInlineValue = arg.includes('=')
      const isBoolean = argTypes.get(name) === 'boolean'
      const hasTrailingValue = !hasInlineValue && !isBoolean && i + 1 < userArgs.length && !userArgs[i + 1]!.startsWith('--')
      if (schema.knownFlags.has(name)) {
        result.push(arg)
        if (hasTrailingValue) result.push(userArgs[i + 1]!)
      }
      // Advance past trailing value if present (whether known or skipped)
      if (hasTrailingValue) {
        i += 2
        continue
      }
    } else {
      result.push(arg)
    }
    i++
  }
  return result
}

/** Clear the schema cache for an installation (e.g. after version update). */
export function clearSchemaCache(installationId: string): void {
  schemaCache.delete(installationId)
}
