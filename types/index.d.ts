export type PanelTab = 'now' | 'loaded' | 'history' | 'context'

export type LoadedItem = { name: string; source: string; tokens: number; summary?: string }
export type McpServer = { server: string; total: number; loaded: number; tokens: number }
export type PluginItem = { name: string; isEnabled: boolean }

export type Meter = { model: string; percent: number; totalTokens: number; maxTokens: number }

export type Loaded = {
  version: number
  categories: { name: string; tokens: number }[]
  memory: LoadedItem[]
  skills: LoadedItem[]
  manualSkills: LoadedItem[]
  skillsTotal: number
  agents: LoadedItem[]
  mcp: McpServer[]
  mcpOffline: string[]
  plugins: PluginItem[]
  builtinTools: { name: string; summary: string }[]
  updatedAt: number
}

export type ToolUse = { id: string; tool: string; detail: string; isDone: boolean; isError: boolean; isSub: boolean }
export type SkillUse = { name: string; source: string; count: number }
export type AgentUse = { id: string; type: string; description: string; isDone: boolean }

export type Activity = {
  toolCounts: { tool: string; count: number }[]
  recent: ToolUse[]
  skills: SkillUse[]
  agents: AgentUse[]
}

export type UsageKind = 'skill' | 'tool' | 'agent'
export type UsageEntry = { kind: UsageKind; name: string; count: number; last: number }

declare module 'claude-code' {
  interface PluginState {
    'radar': {
      loaded: Loaded | null
      meter: Meter | null
      activity: Activity
      history: UsageEntry[]
      tab: PanelTab
      isHidden: boolean
      expanded: string[]
    }
  }
}
