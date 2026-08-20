export interface Project {
  id: string
  workspace_id: string
  name: string
  description: string | null
  repo_url: string | null
  tech_stack: string[] | null
  created_via: 'wizard' | 'blank' | 'import'
  scan_source?: 'local' | 'github' | null
  editor_preference: 'vscode' | 'cursor' | 'claude-code' | 'copilot' | 'windsurf' | 'generic'
  created_at: string
  workspaces?: {
    name: string
    owner_id: string
  }
}

export interface Blueprint {
  architecture?: string
  techStack?: Record<string, string>
  phases?: Array<{
    name: string
    description: string
    features?: Array<{ name: string; description: string; type?: string }>
  }>
  markdownFiles?: Record<string, string>
  masterPromptTitle?: string
}

export interface GenerationEvent {
  type: 'wave_start' | 'step_start' | 'step_complete' | 'step_error'
      | 'step_skip' | 'saving' | 'complete' | 'error'
  wave?: number
  step?: number
  label?: string
  description?: string
  error?: string
  action?: string
  fatal?: boolean
  resumeStep?: number
  blueprint?: Blueprint
}

export interface Phase {
  id: string
  project_id: string
  name: string
  description: string
  order_index: number
  status: 'planned' | 'in_progress' | 'done'
  created_at: string
}

export interface Feature {
  id: string
  project_id: string
  phase_id: string
  name: string
  description: string | null
  status: 'planned' | 'active' | 'in_progress' | 'done' | 'complete'
  type: string
  priority: number
  order_index?: number
  created_at: string
  phases?: {
    name: string
  }
}
