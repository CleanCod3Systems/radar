import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type {
  Activity,
  AgentUse,
  Loaded,
  LoadedItem,
  McpServer,
  Meter,
  PanelTab,
  PluginItem,
  ToolUse,
  UsageEntry,
  UsageKind,
} from '../types'

const PANE = 'radar'
const COMMAND = 'panel'
const TITLE = 'Radar'
const STORE_KEY = 'usage-v1'
const RECENT_LIMIT = 30
const MCP_PREVIEW = 6
const HISTORY_PREVIEW = 8
const LIVE_FLUSH_MS = 300
// The "Cargado" listing barely changes within a session: recount it at most this often.
const LOADED_TTL_MS = 5 * 60_000
// Bumped whenever `Loaded` changes shape: state survives reloads, so an older snapshot must be dropped.
const LOADED_VERSION = 3

const EMPTY_ACTIVITY: Activity = { toolCounts: [], recent: [], skills: [], agents: [] }

const loaded = atom({ plugin: 'radar', key: 'loaded' } as const, null as Loaded | null)
const meter = atom({ plugin: 'radar', key: 'meter' } as const, null as Meter | null)
const activity = atom({ plugin: 'radar', key: 'activity' } as const, EMPTY_ACTIVITY)
const history = atom({ plugin: 'radar', key: 'history' } as const, [] as UsageEntry[])
const tab = atom({ plugin: 'radar', key: 'tab' } as const, 'now' as PanelTab)
const hidden = atom({ plugin: 'radar', key: 'isHidden' } as const, false)
const expanded = atom({ plugin: 'radar', key: 'expanded' } as const, ['skills:proyecto', 'agents:proyecto'] as string[])

const TAB_BY_ARG: Record<string, PanelTab> = {
  ahora: 'now',
  cargado: 'loaded',
  historial: 'history',
  contexto: 'context',
}

const MEMORY_LABEL: Record<string, string> = {
  User: 'global',
  Project: 'proyecto',
  Local: 'local',
  Managed: 'empresa',
  AutoMem: 'memoria',
}

const KIND_LABEL: Record<UsageKind, string> = { skill: 'Skills', agent: 'Subagentes', tool: 'Herramientas' }

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

// Group order in the "Cargado" tab: what the person owns first, vendor packs last.
const SOURCE_ORDER = ['proyecto', 'global', 'empresa', 'claude.ai', 'Claude Code']

// Usage counted since the last flush; written to the store once per turn, not once per call.
const pending = new Map<string, UsageEntry>()

// The session's live activity lives here and reaches the pane at most every LIVE_FLUSH_MS: a burst
// of tool calls costs one redraw instead of two per call, and nothing while the pane is closed.
let live: Activity = EMPTY_ACTIVITY
let isPaneOpen = false
let liveTimer: Timer | undefined

function changeLive($: EngineInterface, change: (current: Activity) => Activity): void {
  live = change(live)
  if (!isPaneOpen || liveTimer) return
  liveTimer = $.clock.after(LIVE_FLUSH_MS, () => {
    liveTimer = undefined
    void update($, activity, () => live)
  })
}

async function publishLive($: EngineInterface): Promise<void> {
  liveTimer?.cancel()
  liveTimer = undefined
  await update($, activity, () => live)
}

type StaticInfo = {
  commandSummary: Map<string, string>
  manualSkills: { name: string; source: string; summary: string }[]
  agentSummary: Map<string, string>
  plugins: PluginItem[]
  mcpConfigured: string[]
  builtinTools: { name: string; summary: string }[]
}

// Descriptions, plugins and configured servers do not change mid-session: read them once per load.
let staticInfo: Promise<StaticInfo> | undefined

function sourceLabel(source: string, pluginName?: string): string {
  if (source === 'projectSettings') return 'proyecto'
  if (source === 'userSettings') return 'global'
  if (source === 'policySettings') return 'empresa'
  if (source === 'syncedSkills') return 'claude.ai'
  if (source === 'built-in') return 'Claude Code'
  if (source === 'plugin') return pluginName ? `plugin ${pluginName}` : 'plugin'
  return source
}

function sourceRank(source: string): number {
  const index = SOURCE_ORDER.indexOf(source)
  return index === -1 ? SOURCE_ORDER.length : index
}

function kTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
}

function when(ms: number): string {
  const date = new Date(ms)
  const now = new Date()
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(date.toDateString()).getTime()) / 86_400_000)
  if (days === 0) return `hoy ${time}`
  if (days === 1) return `ayer ${time}`
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`
}

// Set once per load from $HOME, so paths shorten on any OS, not only macOS.
let homeDir = ''

function homeless(path: string): string {
  return homeDir && path.startsWith(homeDir) ? `~${path.slice(homeDir.length)}` : path
}

function memoryName(path: string, cwd: string): string {
  if (path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1)
  const memory = path.match(/\/memory\/([^/]+)$/)
  if (memory) return `memoria/${memory[1]}`
  return homeless(path)
}

function mcpName(server: string): string {
  return server.replace(/^claude_ai_/, '').replace(/_/g, ' ')
}

// First sentence of a description, so each entry fits on one line under its name.
function summarize(text: string | undefined): string {
  if (!text) return ''
  const line = text.replace(/\s+/g, ' ').trim()
  const cut = line.search(/(\.\s|\s—\s|\s-\s|:\s)/)
  return cut > 12 ? line.slice(0, cut) : line
}

function frontmatterDescription(markdown: string): string {
  const match = markdown.match(/^---[\s\S]*?\ndescription:\s*(.+)\n[\s\S]*?---/)
  return match?.[1]?.replace(/^["']|["']$/g, '') ?? ''
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function toolDetail(input: Record<string, unknown>): string {
  const pick = ['description', 'command', 'file_path', 'path', 'pattern', 'skill', 'url', 'query', 'prompt']
  for (const key of pick) {
    const value = input[key]
    if (typeof value === 'string' && value.length > 0) return key === 'file_path' || key === 'path' ? homeless(value) : value
  }
  return ''
}

function count(kind: UsageKind, name: string): void {
  const key = `${kind}:${name}`
  const entry = pending.get(key) ?? { kind, name, count: 0, last: 0 }
  pending.set(key, { ...entry, count: entry.count + 1, last: Date.now() })
}

function isUsageEntry(value: unknown): value is UsageEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.name === 'string' && typeof entry.count === 'number' && typeof entry.last === 'number'
}

async function loadHistory($: EngineInterface): Promise<void> {
  const stored = await $.store.get(STORE_KEY)
  const entries = Array.isArray(stored) ? stored.filter(isUsageEntry) : []
  await update($, history, () => entries)
}

async function flushHistory($: EngineInterface): Promise<void> {
  if (pending.size === 0) return
  const deltas = [...pending.values()]
  pending.clear()
  const stored = await $.store.get(STORE_KEY)
  const entries = Array.isArray(stored) ? stored.filter(isUsageEntry) : []
  for (const delta of deltas) {
    const found = entries.find(one => one.kind === delta.kind && one.name === delta.name)
    if (found) {
      found.count += delta.count
      found.last = Math.max(found.last, delta.last)
    } else entries.push(delta)
  }
  await $.store.set(STORE_KEY, entries)
  await update($, history, () => entries)
}

type Group = { id: string; source: string; items: LoadedItem[]; tokens: number }

function groupBySource(kind: string, items: LoadedItem[]): Group[] {
  const groups = new Map<string, Group>()
  for (const item of items) {
    const group = groups.get(item.source) ?? { id: `${kind}:${item.source}`, source: item.source, items: [], tokens: 0 }
    // A plugin's skills repeat the plugin name ("postman:flows"); the group header already says it.
    group.items.push({ ...item, name: item.name.replace(/^[^:]+:/, '') })
    group.tokens += item.tokens
    groups.set(item.source, group)
  }
  return [...groups.values()].sort((a, b) => sourceRank(a.source) - sourceRank(b.source) || b.items.length - a.items.length)
}

async function readStatic($: EngineInterface): Promise<StaticInfo> {
  const [commands, tools, settings, cwd] = await Promise.all([
    $.command.list().catch(() => []),
    $.tool.list(),
    $.settings.read().catch(() => ({})),
    $.session.cwd(),
  ])
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${homeDir}/.claude`
  const agentSummary = new Map<string, string>()
  for (const dir of [`${cwd}/.claude/agents`, `${configDir}/agents`]) {
    const files = await $.fs.list(dir).catch(() => [])
    for (const file of files) {
      const name = String((file as { name?: string }).name ?? file).replace(/\.md$/, '')
      if (agentSummary.has(name)) continue
      const text = await $.fs.read(`${dir}/${name}.md`).catch(() => undefined)
      if (typeof text === 'string') agentSummary.set(name, summarize(frontmatterDescription(text)))
    }
  }
  const enabled = (settings as { enabledPlugins?: Record<string, unknown> }).enabledPlugins ?? {}
  const projectMcp = await $.fs.read(`${cwd}/.mcp.json`).catch(() => undefined)
  let mcpConfigured: string[] = []
  if (typeof projectMcp === 'string') {
    try {
      mcpConfigured = Object.keys((JSON.parse(projectMcp) as { mcpServers?: object }).mcpServers ?? {})
    } catch {
      mcpConfigured = []
    }
  }
  return {
    commandSummary: new Map(commands.map(command => [command.name, summarize(command.description)])),
    manualSkills: commands
      .filter(command => command.source !== 'builtin')
      .map(command => ({ name: command.name, source: command.plugin ? `plugin ${command.plugin}` : command.source, summary: summarize(command.description) })),
    agentSummary,
    plugins: Object.entries(enabled)
      .map(([name, isOn]) => ({ name: name.replace(/@.*$/, ''), isEnabled: isOn === true }))
      .sort((a, b) => Number(b.isEnabled) - Number(a.isEnabled) || a.name.localeCompare(b.name)),
    mcpConfigured,
    builtinTools: tools
      .filter(tool => !tool.mcp)
      .map(tool => ({ name: tool.name, summary: summarize(tool.description) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}

async function refreshMeter($: EngineInterface): Promise<void> {
  const [usage, model] = await Promise.all([$.session.usage(), $.session.model()])
  const next: Meter = {
    model,
    percent: usage.context.percent ?? 0,
    totalTokens: usage.context.tokens ?? 0,
    maxTokens: usage.context.window,
  }
  await update($, meter, () => next)
}

async function refreshLoaded($: EngineInterface, isForced = false): Promise<void> {
  const previous = await read($, loaded)
  if (!isForced && previous?.version === LOADED_VERSION && Date.now() - previous.updatedAt < LOADED_TTL_MS) return
  staticInfo ??= readStatic($)
  const [usage, info, cwd] = await Promise.all([$.session.usage({ breakdown: 'summary' }), staticInfo, $.session.cwd()])
  const breakdown = usage.context.breakdown
  const mcpByServer = new Map<string, McpServer>()
  for (const tool of breakdown?.mcpTools ?? []) {
    const server = mcpByServer.get(tool.serverName) ?? { server: tool.serverName, total: 0, loaded: 0, tokens: 0 }
    server.total += 1
    if (tool.isLoaded) server.loaded += 1
    server.tokens += tool.tokens
    mcpByServer.set(tool.serverName, server)
  }
  const skills = (breakdown?.skills?.skillFrontmatter ?? []).map(skill => ({
    name: skill.name,
    source: sourceLabel(skill.source, skill.pluginName),
    tokens: skill.tokens,
    summary: info.commandSummary.get(skill.name) ?? '',
  }))
  const listed = new Set(skills.map(skill => skill.name))
  const next: Loaded = {
    version: LOADED_VERSION,
    categories: (breakdown?.categories ?? [])
      .filter(category => category.tokens > 0)
      .map(category => ({ name: category.name, tokens: category.tokens })),
    memory: (breakdown?.memoryFiles ?? []).map(file => ({
      name: memoryName(file.path, cwd),
      source: MEMORY_LABEL[file.type] ?? file.type,
      tokens: file.tokens,
    })),
    skills,
    manualSkills: info.manualSkills
      .filter(skill => !listed.has(skill.name))
      .map(skill => ({ ...skill, source: 'solo con /comando', tokens: 0 })),
    skillsTotal: breakdown?.skills?.totalSkills ?? 0,
    agents: (breakdown?.agents ?? []).map(agent => ({
      name: agent.agentType,
      source: sourceLabel(agent.source),
      tokens: agent.tokens,
      summary: info.agentSummary.get(agent.agentType) ?? '',
    })),
    mcp: [...mcpByServer.values()].sort((a, b) => b.tokens - a.tokens),
    mcpOffline: info.mcpConfigured.filter(name => !mcpByServer.has(name)),
    plugins: info.plugins,
    builtinTools: info.builtinTools,
    updatedAt: Date.now(),
  }
  await update($, loaded, () => next)
}

async function refreshAgents($: EngineInterface): Promise<void> {
  if (!live.agents.some(agent => !agent.isDone)) return
  const running = await $.agent.list()
  changeLive($, now => ({
    ...now,
    agents: now.agents.map(agent => {
      const info = running.find(one => one.id === agent.id)
      if (!info) return agent
      const isDone = info.status === 'completed' || info.status === 'failed' || info.status === 'killed'
      return { ...agent, isDone }
    }),
  }))
}

async function selectTab($: EngineInterface, wanted: PanelTab): Promise<void> {
  await update($, tab, () => wanted)
  if (wanted === 'context') await refreshLoaded($, true).catch(() => undefined)
  else if (wanted !== 'now') await refreshLoaded($).catch(() => undefined)
}

async function toggleGroup($: EngineInterface, id: string): Promise<void> {
  await update($, expanded, list => (list.includes(id) ? list.filter(one => one !== id) : [...list, id]))
}

async function openPane($: EngineInterface): Promise<void> {
  await update($, hidden, () => false)
  await $.ui.open({ id: PANE, title: TITLE })
  isPaneOpen = true
  await publishLive($)
}

async function isPaneShown($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    homeDir = (await $.env.get('HOME')) ?? ''
    await $.command.register({
      name: COMMAND,
      description: 'Abre o cierra el panel Radar. Args: ahora | cargado | historial | contexto',
      argumentHint: '[ahora|cargado|historial|contexto]',
    })
    await Promise.all([refreshMeter($), loadHistory($)]).catch(() => undefined)
    if ((await read($, tab)) !== 'now') void refreshLoaded($).catch(() => undefined)
    live = await read($, activity)
    if (!(await read($, hidden))) {
      isPaneOpen = true
      void $.ui.open({ id: PANE, title: TITLE })
    }
    return result
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    const wanted = TAB_BY_ARG[arg]
    if (wanted) {
      await openPane($)
      await selectTab($, wanted)
      return { text: `Panel abierto en "${arg}".` }
    }
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
      await update($, hidden, () => true)
      await $.ui.close({ id: PANE })
      return { text: 'Panel cerrado. /panel para abrirlo.' }
    }
    await openPane($)
    return { text: 'Panel abierto. /panel para cerrarlo.' }
  }).catch(() => ({ text: 'El panel falló; detalle en claude --debug.' }))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    isPaneOpen = false
    if (e.origin.kind === 'person') await update($, hidden, () => true)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    count('tool', tool)
    const use: ToolUse = {
      id: e.tool_use_id,
      tool,
      detail: clip(toolDetail(e as unknown as Record<string, unknown>), 160),
      isDone: false,
      isError: false,
      isSub: Boolean(e.agentId),
    }
    changeLive($, current => {
      const counts = current.toolCounts.map(one => (one.tool === tool ? { ...one, count: one.count + 1 } : one))
      if (!counts.some(one => one.tool === tool)) counts.push({ tool, count: 1 })
      counts.sort((a, b) => b.count - a.count)
      return { ...current, toolCounts: counts, recent: [...current.recent, use].slice(-RECENT_LIMIT) }
    })

    const result = await next(e)

    const isError = Boolean(result.deny) || (result as { isError?: boolean }).isError === true
    changeLive($, current => ({
      ...current,
      recent: current.recent.map(one => (one.id === use.id ? { ...one, isDone: true, isError } : one)),
    }))
    return result
  }).catch(($, e, next) => next(e))

  on('skill.prompt', async ($, e, next) => {
    count('skill', e.skill)
    const source = sourceLabel(e.source, e.pluginName)
    changeLive($, current => {
      const skills = current.skills.map(one => (one.name === e.skill ? { ...one, count: one.count + 1 } : one))
      if (!skills.some(one => one.name === e.skill)) skills.push({ name: e.skill, source, count: 1 })
      return { ...current, skills }
    })
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (result.agentId) {
      count('agent', e.subagentType)
      const agent: AgentUse = {
        id: result.agentId,
        type: e.subagentType,
        description: clip(e.description, 80),
        isDone: false,
      }
      changeLive($, current => ({ ...current, agents: [...current.agents, agent].slice(-20) }))
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await Promise.all([refreshMeter($), flushHistory($), refreshAgents($)]).catch(() => undefined)
    // The heavy listing is recounted only while someone is looking at it.
    const current = await read($, tab)
    if (current !== 'now' && (await isPaneShown($))) await refreshLoaded($, current === 'context').catch(() => undefined)
    return result
  })

  on('session.end', async ($, e, next) => {
    await flushHistory($).catch(() => undefined)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(24, e.props.bodyColumns)
    const inner = width - 4
    const viewRows = Math.max(12, (e.viewport?.rows ?? 30) - 4)
    // A read subscribes this pane to that value: read only what the open tab draws, so a tool
    // call (activity) never redraws the long "Cargado" listing and vice versa.
    const current = await read($, tab)
    const isNow = current === 'now'
    const [stored, gauge, live, open, used] = await Promise.all([
      isNow ? null : read($, loaded),
      read($, meter),
      isNow ? read($, activity) : EMPTY_ACTIVITY,
      current === 'loaded' || current === 'history' ? read($, expanded) : ([] as string[]),
      current === 'history' ? read($, history) : ([] as UsageEntry[]),
    ])
    const data = stored?.version === LOADED_VERSION ? stored : null

    const section = (title: string, aside: string, body: unknown) => (
      <Box flexDirection="column" width={width} borderStyle="round" borderColor="subtle" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text weight="bold" color="claude">
            {title}
          </Text>
          <Text dimColor>{aside}</Text>
        </Box>
        {body as never}
      </Box>
    )

    const row = (label: string, value: string, labelColor?: string, mark?: { glyph: string; color: string }) => (
      <Box flexDirection="row" width={inner} gap={1}>
        {mark && <Text color={mark.color}>{mark.glyph}</Text>}
        <Box flexGrow={1} flexShrink={1}>
          <Text wrap="truncate-middle" color={labelColor}>
            {label}
          </Text>
        </Box>
        <Text dimColor>{value}</Text>
      </Box>
    )

    const entries = (items: { name: string; summary?: string; tokens?: number }[]) => (
      <Box flexDirection="column" width={inner} paddingLeft={2} marginBottom={1}>
        {items.map(item => (
          <Box flexDirection="column" width={inner - 2}>
            <Box flexDirection="row" width={inner - 2} gap={1}>
              <Text color="subtle">•</Text>
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="truncate-end">{item.name}</Text>
              </Box>
              {item.tokens ? <Text dimColor>{kTokens(item.tokens)}</Text> : null}
            </Box>
            {item.summary ? (
              <Box paddingLeft={2} width={inner - 2}>
                <Text dimColor italic wrap="truncate-end">
                  {item.summary}
                </Text>
              </Box>
            ) : null}
          </Box>
        ))}
      </Box>
    )

    const toggle = (id: string, label: string, aside: string, body: () => unknown) => {
      const isOpen = open.includes(id)
      return (
        <Box flexDirection="column" width={inner}>
          <Button key={id} plain onPress={() => toggleGroup($, id)}>
            <Text color="suggestion">{isOpen ? '▾ ' : '▸ '}</Text>
            {label}
            <Text dimColor>
              {'  '}
              {aside}
            </Text>
          </Button>
          {isOpen && (body() as never)}
        </Box>
      )
    }

    const group = (one: Group) =>
      toggle(one.id, one.source, `${one.items.length}${one.tokens ? ` · ${kTokens(one.tokens)}` : ''}`, () => entries(one.items))

    const percent = gauge?.percent ?? 0
    const meterWidth = Math.max(6, Math.min(24, width - 30))
    const filled = Math.min(meterWidth, Math.round((percent / 100) * meterWidth))
    const meterColor = percent >= 80 ? 'error' : percent >= 60 ? 'warning' : 'success'
    const tabButton = (key: PanelTab, hotkey: string, label: string) => (
      <Button key={key} onPress={() => selectTab($, key)} hotkey={hotkey} variant={current === key ? 'primary' : 'secondary'} label={label} />
    )

    const header = (
      <Box flexDirection="column" width={width} paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text weight="bold" color="claude">
            ◆ Radar
          </Text>
          <Text dimColor>{gauge?.model ?? ''}</Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          <Text color={meterColor}>{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(meterWidth - filled)}</Text>
          <Text color={meterColor} weight="bold">
            {gauge?.totalTokens ? `${percent}%` : '—'}
          </Text>
          <Text dimColor>{gauge?.totalTokens ? `${kTokens(gauge.totalTokens)} de ${kTokens(gauge.maxTokens)}` : 'contexto tras el 1er mensaje'}</Text>
        </Box>
        <Box flexDirection="row" gap={1} marginTop={1} flexWrap="wrap">
          {tabButton('now', '1', 'Ahora')}
          {tabButton('loaded', '2', 'Cargado')}
          {tabButton('history', '3', 'Historial')}
          {tabButton('context', '4', 'Contexto')}
        </Box>
      </Box>
    )

    if (current === 'now') {
      const running = live.recent.filter(one => !one.isDone).reverse()
      const fixedRows = 14 + Math.max(1, live.skills.length) + Math.min(live.agents.length, 5) + running.length
      const room = Math.max(3, viewRows - fixedRows)
      const done = live.recent.filter(one => one.isDone).slice(-room).reverse()
      const totalCalls = live.toolCounts.reduce((sum, one) => sum + one.count, 0)

      return (
        <Box flexDirection="column" width={width}>
          {header}
          {section(
            'Skills usadas',
            String(live.skills.length),
            live.skills.length === 0 ? (
              <Text dimColor>ninguna todavía</Text>
            ) : (
              live.skills.map(skill => row(skill.name, `×${skill.count} · ${skill.source}`, undefined, { glyph: '✓', color: 'success' }))
            ),
          )}
          {live.agents.length > 0 &&
            section(
              'Subagentes',
              `${live.agents.filter(agent => !agent.isDone).length} activos`,
              live.agents
                .slice(-5)
                .reverse()
                .map(agent =>
                  row(`${agent.type} — ${agent.description}`, '', undefined, agent.isDone ? { glyph: '✓', color: 'success' } : { glyph: '●', color: 'warning' }),
                ),
            )}
          {section(
            'Herramientas',
            `${totalCalls} llamadas`,
            <Box flexDirection="column" width={inner}>
              {live.toolCounts.length === 0 && <Text dimColor>ninguna todavía</Text>}
              {live.toolCounts.length > 0 && (
                <Box flexDirection="row" flexWrap="wrap" columnGap={2} width={inner}>
                  {live.toolCounts.slice(0, 10).map(one => (
                    <Text>
                      {one.tool} <Text color="suggestion">{one.count}</Text>
                    </Text>
                  ))}
                </Box>
              )}
              {(running.length > 0 || done.length > 0) && <Text dimColor>{'─'.repeat(inner)}</Text>}
              {running.map(use => row(`${use.tool}${use.isSub ? ' ·sub' : ''}  ${use.detail}`, '', undefined, { glyph: '●', color: 'warning' }))}
              {done.map(use =>
                row(`${use.tool}${use.isSub ? ' ·sub' : ''}  ${use.detail}`, '', 'inactive', use.isError ? { glyph: '✗', color: 'error' } : { glyph: '✓', color: 'success' }),
              )}
            </Box>,
          )}
        </Box>
      )
    }

    if (current === 'history') {
      const known = new Set(used.filter(one => one.kind === 'skill').map(one => one.name))
      const never = (data?.skills ?? []).filter(skill => !known.has(skill.name))
      const kinds: UsageKind[] = ['skill', 'agent', 'tool']
      const since = used.length > 0 ? Math.min(...used.map(one => one.last)) : 0
      return (
        <Box flexDirection="column" width={width}>
          {header}
          {used.length === 0 && pending.size === 0 && section('Historial', '', <Text dimColor>Se empieza a guardar desde ahora, al terminar cada respuesta.</Text>)}
          {kinds.map(kind => {
            const list = used.filter(one => one.kind === kind).sort((a, b) => b.count - a.count)
            if (list.length === 0) return null
            const id = `history:${kind}`
            const shown = open.includes(id) ? list : list.slice(0, HISTORY_PREVIEW)
            return section(
              KIND_LABEL[kind],
              `${list.length} usadas`,
              <Box flexDirection="column" width={inner}>
                <Box flexDirection="row" width={inner} gap={1}>
                  <Box flexGrow={1}>
                    <Text dimColor>nombre</Text>
                  </Box>
                  <Box width={6} justifyContent="flex-end">
                    <Text dimColor>veces</Text>
                  </Box>
                  <Box width={11} justifyContent="flex-end">
                    <Text dimColor>última</Text>
                  </Box>
                </Box>
                {shown.map(one => (
                  <Box flexDirection="row" width={inner} gap={1}>
                    <Box flexGrow={1} flexShrink={1}>
                      <Text wrap="truncate-end">{one.name}</Text>
                    </Box>
                    <Box width={6} justifyContent="flex-end">
                      <Text color="suggestion">{String(one.count)}</Text>
                    </Box>
                    <Box width={11} justifyContent="flex-end">
                      <Text dimColor>{when(one.last)}</Text>
                    </Box>
                  </Box>
                ))}
                {list.length > HISTORY_PREVIEW && (
                  <Button key={id} plain onPress={() => toggleGroup($, id)}>
                    <Text color="suggestion">{open.includes(id) ? '▴ menos' : `▾ ${list.length - HISTORY_PREVIEW} más`}</Text>
                  </Button>
                )}
              </Box>,
            )
          })}
          {data &&
            never.length > 0 &&
            section(
              'Skills sin usar',
              `${never.length} de ${data.skills.length}`,
              toggle('history:never', 'ver cuáles', since ? `desde ${when(since)}` : '', () => entries(never)),
            )}
        </Box>
      )
    }

    if (!data) {
      return (
        <Box flexDirection="column" width={width}>
          {header}
          {section('Cargando', '', <Text dimColor>Un segundo…</Text>)}
        </Box>
      )
    }

    if (current === 'loaded') {
      const memoryTokens = data.memory.reduce((sum, file) => sum + file.tokens, 0)
      const skillTokens = data.skills.reduce((sum, skill) => sum + skill.tokens, 0)
      const agentTokens = data.agents.reduce((sum, agent) => sum + agent.tokens, 0)
      const mcpTokens = data.mcp.reduce((sum, server) => sum + server.tokens, 0)
      const isMcpOpen = open.includes('mcp:all')
      const mcpShown = isMcpOpen ? data.mcp : data.mcp.slice(0, MCP_PREVIEW)
      const pluginsOn = data.plugins.filter(plugin => plugin.isEnabled).length

      return (
        <Box flexDirection="column" width={width}>
          {header}
          {section(
            'Instrucciones',
            `${data.memory.length} · ${kTokens(memoryTokens)}`,
            data.memory.map(file => (
              <Box flexDirection="row" width={inner} gap={1}>
                <Box width={9} flexShrink={0}>
                  <Text color="suggestion">{file.source}</Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text wrap="truncate-start">{file.name}</Text>
                </Box>
                <Text dimColor>{kTokens(file.tokens)}</Text>
              </Box>
            )),
          )}
          {data.plugins.length > 0 &&
            section(
              'Plugins',
              `${pluginsOn} activos · ${data.plugins.length - pluginsOn} apagados`,
              data.plugins.map(plugin =>
                row(plugin.name, plugin.isEnabled ? 'activo' : 'apagado', plugin.isEnabled ? undefined : 'inactive', plugin.isEnabled ? { glyph: '●', color: 'success' } : { glyph: '○', color: 'inactive' }),
              ),
            )}
          {section(
            'Skills',
            `${data.skills.length} activas · ${kTokens(skillTokens)}`,
            <Box flexDirection="column" width={inner}>
              {groupBySource('skills', data.skills).map(group)}
              {data.manualSkills.length > 0 && (
                <Box flexDirection="column" width={inner} marginTop={1}>
                  <Text dimColor>Claude no las ve solo; se usan escribiendo /nombre</Text>
                  {toggle('skills:manual', 'solo con /comando', String(data.manualSkills.length), () => entries(data.manualSkills))}
                </Box>
              )}
            </Box>,
          )}
          {section('Subagentes', `${data.agents.length} · ${kTokens(agentTokens)}`, groupBySource('agents', data.agents).map(group))}
          {section(
            'MCP',
            `${data.mcp.length} conectados${data.mcpOffline.length ? ` · ${data.mcpOffline.length} sin conexión` : ''}`,
            <Box flexDirection="column" width={inner}>
              {data.mcpOffline.map(name => row(name, 'sin conexión', 'error', { glyph: '✗', color: 'error' }))}
              {mcpShown.map(server => row(mcpName(server.server), `${server.loaded}/${server.total} · ${kTokens(server.tokens)}`, undefined, { glyph: '●', color: 'success' }))}
              {data.mcp.length > MCP_PREVIEW && (
                <Button key="mcp:all" plain onPress={() => toggleGroup($, 'mcp:all')}>
                  <Text color="suggestion">{isMcpOpen ? '▴ menos' : `▾ ${data.mcp.length - MCP_PREVIEW} más`}</Text>
                </Button>
              )}
              <Text dimColor>cargadas/total herramientas · {kTokens(mcpTokens)} si se cargan todas</Text>
            </Box>,
          )}
          {section(
            'Herramientas de Claude',
            String(data.builtinTools.length),
            toggle('tools:all', 'ver lista', '', () => entries(data.builtinTools)),
          )}
        </Box>
      )
    }

    const barWidth = Math.max(6, Math.min(20, inner - 24))
    const total = gauge?.totalTokens ?? 0
    const max = gauge?.maxTokens ?? 0
    const categories = [...data.categories].sort((a, b) => b.tokens - a.tokens)
    return (
      <Box flexDirection="column" width={width}>
        {header}
        {section(
          'En qué se va el contexto',
          `${kTokens(total)} de ${kTokens(max)}`,
          <Box flexDirection="column" width={inner}>
            {categories.map(category => {
              const share = max > 0 ? category.tokens / max : 0
              const cells = Math.min(barWidth, Math.max(share > 0 ? 1 : 0, Math.round(share * barWidth)))
              return (
                <Box flexDirection="row" width={inner} gap={1}>
                  <Text color="claude">{'█'.repeat(cells)}</Text>
                  <Text dimColor>{'░'.repeat(barWidth - cells)}</Text>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text wrap="truncate-end">{category.name}</Text>
                  </Box>
                  <Text dimColor>{kTokens(category.tokens)}</Text>
                </Box>
              )
            })}
            <Text dimColor>Se actualiza al terminar cada respuesta mientras esta pestaña está abierta.</Text>
          </Box>,
        )}
      </Box>
    )
  })
}
