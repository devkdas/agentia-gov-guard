import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'

function runAgentia(args: string[], timeoutMs = 60_000): string {
  return execFileSync('agentia', args, {encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe']})
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}

export default class GovSimulate extends Command {
  static description =
    'Rehearse a promotion end to end without touching anything. The fear remover.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --story US-0000024 --env UAT-SFP',
    '<%= config.bin %> <%= command.id %> --story US-0000024 --env PROD --json',
  ]

  static flags = {
    story: Flags.string({char: 's', description: 'User story rehearsed.', required: true}),
    env: Flags.string({char: 'e', description: 'Target environment rehearsed.', default: 'UAT-SFP'}),
    json: Flags.boolean({char: 'j', description: 'Machine readable JSON rehearsal.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(GovSimulate)
    const story = flags.story as string
    const env = (flags.env as string) ?? 'UAT-SFP'
    const asJson = (flags.json as boolean) ?? false
    const acts: Array<{stage: string; would: string; result: string}> = []

    try {
      const parsed: any = JSON.parse(runAgentia(['gov', 'check', '--story', story, '--env', env, '--json']))
      const checks: any[] = Array.isArray(parsed?.checks) ? parsed.checks : []
      const blocked = checks.filter((c) => c?.status === 'block').length
      acts.push({
        stage: 'policy-gate',
        would: 'Run the five policy checks exactly as a real promotion would.',
        result: blocked > 0 ? `Gate would block on ${blocked} checks.` : `Gate reads ${str(parsed?.status) || 'done'}.`,
      })
    } catch (error: any) {
      const so = typeof (error as any)?.stdout === 'string' ? ((error as any).stdout as string) : ''
      try {
        const parsed: any = JSON.parse(so)
        const checks: any[] = Array.isArray(parsed?.checks) ? parsed.checks : []
        const blocked = checks.filter((c) => c?.status === 'block').length
        acts.push({
          stage: 'policy-gate',
          would: 'Run the five policy checks exactly as a real promotion would.',
          result: blocked > 0 ? `Gate would block on ${blocked} checks.` : `Gate reads ${str(parsed?.status) || 'done'}.`,
        })
      } catch {
        acts.push({stage: 'policy-gate', would: 'Run the five policy checks.', result: 'Gate unreadable in rehearsal.'})
      }
    }

    try {
      const parsed: any = JSON.parse(runAgentia(['gov', 'risk-score', '--story', story, '--env', env, '--no-ai', '--json']))
      const factors: any[] = Array.isArray(parsed?.factors) ? parsed.factors : []
      const highs = factors.filter((f) => f?.level === 'high').length
      acts.push({
        stage: 'risk-scan',
        would: 'Grade story maturity, pipeline blocks, env weight, data commits and history.',
        result: highs > 0 ? `${highs} high risk factors would need clearing first.` : 'No high risk factors in rehearsal.',
      })
    } catch {
      acts.push({stage: 'risk-scan', would: 'Grade risk signals.', result: 'Risk scan unreadable in rehearsal.'})
    }

    try {
      const parsed: any = JSON.parse(runAgentia(['doctor', '--json']))
      acts.push({
        stage: 'readiness',
        would: 'Confirm machine readiness the promotion would rely on.',
        result: `Doctor reads ${str(parsed?.status) || 'unknown'}.`,
      })
    } catch (error: any) {
      const so = typeof (error as any)?.stdout === 'string' ? ((error as any).stdout as string) : ''
      try {
        const parsed: any = JSON.parse(so)
        acts.push({
          stage: 'readiness',
          would: 'Confirm machine readiness the promotion would rely on.',
          result: `Doctor reads ${str(parsed?.status) || 'unknown'}.`,
        })
      } catch {
        acts.push({stage: 'readiness', would: 'Confirm machine readiness.', result: 'Doctor unreadable in rehearsal.'})
      }
    }

    acts.push({
      stage: 'merge',
      would: 'Would run merge on the linked promotion after approval. Branch only, never the env.',
      result: 'Not executed. Rehearsal only.',
    })
    acts.push({
      stage: 'deploy',
      would: 'Would run merge and deploy after a second approval. Only this stage writes to the env.',
      result: 'Not executed. Rehearsal only.',
    })

    const payload = {
      status: 'rehearsed',
      story,
      env,
      acts,
      note: 'Zero org writes happened. Every execute stage above is described, never run.',
    }
    if (asJson) {
      this.log(JSON.stringify(payload, null, 2))
    } else {
      this.log(`Rehearsal for ${story} to ${env}. Nothing was touched.`)
      for (const a of acts) this.log(`[${a.stage}] Would: ${a.would} Result: ${a.result}`)
    }
  }
}
