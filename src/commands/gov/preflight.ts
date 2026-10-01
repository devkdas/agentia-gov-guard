import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'

function runAgentia(args: string[], timeoutMs = 60_000): string {
  return execFileSync('agentia', args, {encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe']})
}

interface GateResult {
  gate: string
  status: 'pass' | 'warn' | 'blocked' | 'skipped'
  detail: string
}

export default class GovPreflight extends Command {
  static description =
    'Chain every pre-promotion check into one verdict. The killer demo: one command before every push.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --story US-0000024 --env UAT-SFP',
    '<%= config.bin %> <%= command.id %> --story US-0000024 --env UAT-SFP --json',
  ]

  static flags = {
    story: Flags.string({char: 's', description: 'User story ID checked.', required: true}),
    env: Flags.string({char: 'e', description: 'Target environment.', default: 'UAT-SFP'}),
    json: Flags.boolean({char: 'j', description: 'Machine readable JSON verdict.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(GovPreflight)
    const story = flags.story as string
    const env = (flags.env as string) ?? 'UAT-SFP'
    const asJson = (flags.json as boolean) ?? false
    const gates: GateResult[] = []

    try {
      const parsed: any = JSON.parse(runAgentia(['gov', 'check', '--story', story, '--env', env, '--json']))
      const checks: any[] = Array.isArray(parsed?.checks) ? parsed.checks : []
      const blocked = checks.filter((c) => c?.status === 'block').length
      gates.push(blocked > 0
        ? {gate: 'policy', status: 'blocked', detail: `Gov check blocked on ${blocked} checks for ${story}.`}
        : {gate: 'policy', status: 'pass', detail: `Gov check ${str(parsed?.status) || 'done'} for ${story} to ${env}.`})
    } catch (error: any) {
      const so = typeof (error as any)?.stdout === 'string' ? ((error as any).stdout as string) : ''
      try {
        const parsed: any = JSON.parse(so)
        const checks: any[] = Array.isArray(parsed?.checks) ? parsed.checks : []
        const blocked = checks.filter((c) => c?.status === 'block').length
        gates.push(blocked > 0
          ? {gate: 'policy', status: 'blocked', detail: `Gov check blocked on ${blocked} checks for ${story}.`}
          : {gate: 'policy', status: 'pass', detail: `Gov check ${str(parsed?.status) || 'done'} for ${story} to ${env}.`})
      } catch {
        gates.push({gate: 'policy', status: 'skipped', detail: 'Gov check unavailable.'})
      }
    }

    try {
      const parsed: any = JSON.parse(runAgentia(['doctor', '--json']))
      const st = typeof parsed?.status === 'string' ? parsed.status : 'unknown'
      gates.push(st === 'blocked'
        ? {gate: 'readiness', status: 'blocked', detail: 'Doctor reports blocked setup. Fix before promoting.'}
        : {gate: 'readiness', status: 'pass', detail: `Doctor reports ${st}.`})
    } catch (error: any) {
      const so = typeof (error as any)?.stdout === 'string' ? ((error as any).stdout as string) : ''
      try {
        const parsed: any = JSON.parse(so)
        const st = typeof parsed?.status === 'string' ? parsed.status : 'unknown'
        gates.push(st === 'blocked'
          ? {gate: 'readiness', status: 'blocked', detail: 'Doctor reports blocked setup. Fix before promoting.'}
          : {gate: 'readiness', status: 'pass', detail: `Doctor reports ${st}.`})
      } catch {
        gates.push({gate: 'readiness', status: 'skipped', detail: 'Doctor plugin unavailable. Install doctor-dx for readiness.'})
      }
    }

    try {
      const parsed: any = JSON.parse(runAgentia(['gov', 'risk-score', '--story', story, '--env', env, '--no-ai', '--json']))
      const factors: any[] = Array.isArray(parsed?.factors) ? parsed.factors : []
      const highs = factors.filter((f) => f?.level === 'high').length
      gates.push(highs > 0
        ? {gate: 'risk', status: 'blocked', detail: `${highs} high risk factors for ${story}.`}
        : {gate: 'risk', status: 'pass', detail: `Risk signals acceptable for ${story} to ${env}.`})
    } catch {
      gates.push({gate: 'risk', status: 'skipped', detail: 'Risk scorer unavailable.'})
    }

    const blocked = gates.filter((g) => g.status === 'blocked').length
    const skipped = gates.filter((g) => g.status === 'skipped').length
    const verdict = blocked > 0 ? 'no-go' : skipped === gates.length ? 'unknown' : 'go'
    const payload = {status: verdict, story, env, gates}
    if (asJson) {
      this.log(JSON.stringify(payload, null, 2))
    } else {
      this.log(`Preflight ${verdict.toUpperCase()} for ${story} to ${env}.`)
      for (const g of gates) {
        const tag = g.status === 'pass' ? 'PASS' : g.status === 'blocked' ? 'BLOCK' : 'SKIP'
        this.log(`[${tag}] ${g.gate}: ${g.detail}`)
      }
      if (verdict === 'go') this.log('Clear to promote. Run the normal workflow next.');
      else if (verdict === 'no-go') this.log('Do not promote. Fix the blocked gates first.');
      else this.log('No gate could evaluate. Check plugin installation.');
    }
    if (verdict !== 'go') this.exit(1)
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}
