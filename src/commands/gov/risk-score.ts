import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'

const AI_TIMEOUT_MS = 120_000

function runAgentia(args: string[], timeoutMs = 60_000): string {
  return execFileSync('agentia', args, {encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe']})
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}

function rowsOf(parsed: any): any[] {
  if (!parsed || typeof parsed !== 'object') return []
  const r = parsed?.result ?? parsed
  if (Array.isArray(r)) return r
  if (Array.isArray(r?.data)) return r.data
  return []
}

function findAgentText(node: unknown, depth = 0): string | null {
  if (node == null || depth > 3) return null
  if (typeof node === 'string') return node.trim() !== '' ? node.trim().slice(0, 2000) : null
  if (typeof node === 'object' && !Array.isArray(node)) {
    const obj = node as Record<string, unknown>
    for (const key of ['response', 'text', 'answer', 'message', 'content', 'output', 'summary']) {
      const v = obj[key]
      if (typeof v === 'string' && v.trim() !== '') return v.trim().slice(0, 2000)
    }
    if ('result' in obj) return findAgentText(obj['result'], depth + 1)
  }
  return null
}

interface Factor {
  name: string
  level: 'low' | 'medium' | 'high'
  reason: string
}

const order = {low: 0, medium: 1, high: 2} as const

export default class GovRiskScore extends Command {
  static description =
    'Predict deployment risk for a story from live signals plus an AI assessment. Advisory only, never blocks.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --story US-0000024',
    '<%= config.bin %> <%= command.id %> --story US-0000024 --env PROD --json',
    '<%= config.bin %> <%= command.id %> --story US-0000024 --no-ai --json',
  ]

  static flags = {
    story: Flags.string({char: 's', description: 'User story name or ID.', required: true}),
    env: Flags.string({char: 'e', description: 'Target environment assessed.', default: 'UAT-SFP'}),
    ai: Flags.boolean({description: 'Ask the release agent for a risk narrative.', default: true, allowNo: true}),
    json: Flags.boolean({char: 'j', description: 'Machine readable JSON output.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(GovRiskScore)
    const story = flags.story as string
    const env = (flags.env as string) ?? 'UAT-SFP'
    const useAi = (flags.ai as boolean) ?? true
    const asJson = (flags.json as boolean) ?? false
    const factors: Factor[] = []

    let storyRec: any = null
    try {
      const out = runAgentia(['cicd', 'work', 'get', story, '--json'])
      const parsed = JSON.parse(out)
      storyRec = parsed?.result ?? parsed
    } catch (error: any) {
      const detail = `Story lookup failed: ${(error?.message ?? String(error)).split('\n')[0]}`
      if (asJson) this.log(JSON.stringify({status: 'error', story, detail}, null, 2))
      else this.log(detail)
      this.exit(1)
    }

    const status = str(storyRec?.status).toLowerCase()
    if (status === '' || status === 'draft') {
      factors.push({name: 'story-maturity', level: 'medium', reason: `Story status is ${str(storyRec?.status) || 'unknown'}. Unreviewed work carries change risk.`})
    } else {
      factors.push({name: 'story-maturity', level: 'low', reason: `Story status is ${str(storyRec?.status)}.`})
    }
    if (storyRec?.pipelineBlockCommits) {
      factors.push({name: 'pipeline-block', level: 'high', reason: 'Pipeline blocks commits on this story. Resolve the block before promoting.'})
    } else {
      factors.push({name: 'pipeline-block', level: 'low', reason: 'Pipeline accepts commits for this story.'})
    }
    if (/prod/i.test(env)) {
      factors.push({name: 'target-env', level: 'medium', reason: 'Production target amplifies every other risk. Pair this score with a gov check approval gate.'})
    } else {
      factors.push({name: 'target-env', level: 'low', reason: `Non production target ${env}.`})
    }

    const sid = str(storyRec?.id) || story
    try {
      const commits = rowsOf(JSON.parse(runAgentia(['cicd', 'data', 'commit', 'list', sid, '--json'])))
      factors.push(commits.length > 0
        ? {name: 'data-commits', level: 'medium', reason: `${commits.length} data commits ride along. Data has no rollback path, snapshot first.`}
        : {name: 'data-commits', level: 'low', reason: 'No data commits attached to this story.'})
    } catch {
      factors.push({name: 'data-commits', level: 'low', reason: 'Data commit state unreadable. Treated as none.'})
    }

    try {
      const promos = rowsOf(JSON.parse(runAgentia(['cicd', 'promotion', 'list', '--work-id', sid, '--json'])))
      factors.push(promos.length > 0
        ? {name: 'promotion-history', level: 'low', reason: `${promos.length} promotion records exist for context.`}
        : {name: 'promotion-history', level: 'medium', reason: 'No prior promotions found. First runs deserve extra review.'})
    } catch {
      factors.push({name: 'promotion-history', level: 'medium', reason: 'Promotion history unreadable. Review manually.'})
    }

    let aiNarrative: string | null = null
    if (useAi) {
      const prompt =
        `Estimate deployment risk in 3 sentences for Salesforce story ${story} to ${env}. ` +
        `Signals: ${factors.map((f) => `${f.name}=${f.level} (${f.reason})`).join(' | ').slice(0, 1500)}`
      try {
        const out = runAgentia(['ai', 'agent', 'ask', '-p', prompt, '--agent', 'release', '--json'], AI_TIMEOUT_MS)
        let parsed: unknown
        try {
          parsed = JSON.parse(out)
        } catch {
          parsed = out
        }
        aiNarrative = findAgentText(parsed)
      } catch {
        aiNarrative = null
      }
    }

    const overall = factors.reduce<'low' | 'medium' | 'high'>(
      (top, f) => (order[f.level] > order[top] ? f.level : top), 'low' as 'low' | 'medium' | 'high')
    const payload = {
      status: 'scored',
      story,
      env,
      overall: `${overall} (advisory estimate, not a gate verdict)`,
      factors,
      aiEnabled: useAi,
      aiNarrative,
      note: 'Advisory only. This score never blocks. Pair with gov check for enforcement.',
    }
    if (asJson) {
      this.log(JSON.stringify(payload, null, 2))
    } else {
      this.log(`Risk score for ${story} to ${env}: ${overall.toUpperCase()} (advisory, not a gate).`)
      for (const f of factors) this.log(`[${f.level.toUpperCase()}] ${f.name}: ${f.reason}`)
      if (aiNarrative) this.log(`AI assessment: ${aiNarrative}`)
      else if (useAi) this.log('AI assessment unavailable. Factor signals above still stand.')
    }
  }
}
