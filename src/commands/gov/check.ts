import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {randomBytes} from 'node:crypto'

type CheckStatus = 'pass' | 'warn' | 'block'

interface PolicyCheck {
  name: string
  status: CheckStatus
  detail: string
}

interface PendingApproval {
  code: string
  story: string | null
  env: string
  createdAt: string
  expiresAt: string
  approved: boolean
  approvedAt: string | null
}

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000

function pendingDir(): string {
  return join(homedir(), '.agentia-gov-guard')
}

function pendingPath(): string {
  return join(pendingDir(), 'pending.json')
}

function loadPending(): PendingApproval[] {
  try {
    if (!existsSync(pendingPath())) return []
    const raw = readFileSync(pendingPath(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as PendingApproval[]) : []
  } catch {
    return []
  }
}

function savePending(records: PendingApproval[]): void {
  mkdirSync(pendingDir(), {recursive: true})
  writeFileSync(pendingPath(), JSON.stringify(records, null, 2), 'utf8')
}

function makeCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(6)
  let code = 'AP-'
  for (const b of bytes) code += alphabet[b % alphabet.length]
  return code
}

function isProd(env: string): boolean {
  return /prod/i.test(env)
}

function runAgentia(args: string[]): string {
  return execFileSync('agentia', args, {encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe']})
}

interface AuthState {
  cicdSet: boolean
  crtReady: boolean
  crtMissing: string[]
  crtIssues: Array<{field?: string; kind?: string}>
  aiSet: boolean
  note: string | null
}

function loadAuth(): AuthState {
  const fallback: AuthState = {
    cicdSet: false,
    crtReady: false,
    crtMissing: [],
    crtIssues: [],
    aiSet: false,
    note: 'Could not read agentia auth state.',
  }
  try {
    const out = runAgentia(['auth', 'get', '--json'])
    const parsed: any = JSON.parse(out)
    const creds: any[] = parsed?.result?.credentials ?? []
    const byType = (t: string) => creds.find((c) => c?.type === t)
    const cicd = byType('cicd')
    const crt = byType('crt')
    const ai = byType('ai')
    return {
      cicdSet: Boolean(cicd?.set),
      crtReady: Boolean(crt?.ready),
      crtMissing: Array.isArray(crt?.missing) ? crt.missing : [],
      crtIssues: Array.isArray(crt?.issues) ? crt.issues : [],
      aiSet: Boolean(ai?.set),
      note: null,
    }
  } catch {
    return fallback
  }
}

export default class GovCheck extends Command {
  static description = 'Run pre-promotion policy checks with PROD approval gate and audit output.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --story US-1234 --env UAT-SFP',
    '<%= config.bin %> <%= command.id %> --story US-1234 --env PROD',
    '<%= config.bin %> <%= command.id %> --story US-1234 --env PROD --approve-code AP-XXXXXX',
    '<%= config.bin %> <%= command.id %> --story US-1234 --env UAT-SFP --json',
  ]

  static flags = {
    story: Flags.string({char: 's', description: 'User story ID under promotion.'}),
    env: Flags.string({char: 'e', description: 'Target environment.', default: 'UAT-SFP'}),
    'approve-code': Flags.string({description: 'One time approval code for PROD targets.'}),
    'self-heal': Flags.boolean({description: 'Print Operate agent diagnosis command on failure.', default: false}),
    json: Flags.boolean({char: 'j', description: 'Machine readable JSON output.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(GovCheck)
    const story = flags.story ?? null
    const env = flags.env ?? 'UAT-SFP'
    const approveCode = flags['approve-code'] ?? null
    const selfHeal = flags['self-heal'] ?? false
    const asJson = flags.json ?? false

    const auth = loadAuth()
    const checks: PolicyCheck[] = []

    checks.push(
      auth.cicdSet
        ? {name: 'auth-cicd', status: 'pass', detail: 'CICD credentials are stored.'}
        : {
            name: 'auth-cicd',
            status: 'block',
            detail: 'CICD credentials are not stored. Run agentia setup to authenticate.',
          },
    )

    if (auth.crtReady) {
      checks.push({name: 'auth-crt', status: 'pass', detail: 'CRT reports ready:true.'})
    } else {
      const missing = auth.crtMissing.length > 0 ? ` Missing: ${auth.crtMissing.join(', ')}.` : ''
      checks.push({
        name: 'auth-crt',
        status: 'warn',
        detail: `CRT is not ready. Gate automation on ready:true from agentia auth get --crt --json.${missing}`,
      })
    }

    if (auth.aiSet) {
      checks.push({name: 'auth-ai', status: 'pass', detail: 'AI credentials are stored.'})
    } else {
      checks.push({
        name: 'auth-ai',
        status: selfHeal ? 'warn' : 'pass',
        detail: 'AI credentials are not stored. Self heal diagnosis needs agentia ai agent ask access.',
      })
    }

    checks.push(
      story
        ? {name: 'story-context', status: 'pass', detail: `Story context is ${story}.`}
        : {
            name: 'story-context',
            status: 'warn',
            detail: 'No story passed. Re-run with --story <id> for scoped audit evidence.',
          },
    )

    let approval: PendingApproval | null = null
    let approvalRequired = false

    if (isProd(env)) {
      approvalRequired = true
      const records = loadPending()
      const now = Date.now()
      const live = records.filter((r) => Date.parse(r.expiresAt) > now)
      if (live.length !== records.length) savePending(live)

      if (!approveCode) {
        const existing = live.find((r) => (r.story ?? null) === story && r.env === env)
        if (existing) {
          approval = existing
          checks.push({
            name: 'env-gate',
            status: 'block',
            detail: `PROD target needs approval. Code ${existing.code} is still valid. Run agentia gov approve ${existing.code} then re-run with --approve-code ${existing.code}.`,
          })
        } else {
          const record: PendingApproval = {
            code: makeCode(),
            story,
            env,
            createdAt: new Date().toISOString(),
            expiresAt: new Date(now + APPROVAL_TTL_MS).toISOString(),
            approved: false,
            approvedAt: null,
          }
          live.push(record)
          savePending(live)
          approval = record
          checks.push({
            name: 'env-gate',
            status: 'block',
            detail: `PROD target needs approval. Generated one time code ${record.code}. Run agentia gov approve ${record.code} then re-run with --approve-code ${record.code}.`,
          })
        }
      } else {
        const match = live.find((r) => r.code === approveCode)
        if (!match) {
          checks.push({
            name: 'env-gate',
            status: 'block',
            detail: 'Unknown or already consumed approval code. Run a fresh check to generate one.',
          })
        } else if (Date.parse(match.expiresAt) <= now) {
          savePending(live.filter((r) => r.code !== approveCode))
          checks.push({
            name: 'env-gate',
            status: 'block',
            detail: 'Approval code expired. Run a fresh check to generate a new one.',
          })
        } else if ((match.story ?? null) !== story || match.env !== env) {
          checks.push({
            name: 'env-gate',
            status: 'block',
            detail: `Code ${approveCode} was issued for story ${match.story ?? 'none'} env ${match.env}, not story ${story ?? 'none'} env ${env}.`,
          })
        } else if (!match.approved) {
          approval = match
          checks.push({
            name: 'env-gate',
            status: 'block',
            detail: `Code ${approveCode} is not approved yet. Run agentia gov approve ${approveCode} then re-run this check.`,
          })
        } else {
          savePending(live.filter((r) => r.code !== approveCode))
          approval = {...match}
          checks.push({
            name: 'env-gate',
            status: 'pass',
            detail: `Approved PROD promotion for story ${story ?? 'none'} with single use code ${approveCode}.`,
          })
        }
      }
    } else {
      checks.push({name: 'env-gate', status: 'pass', detail: `Non production target ${env}. No approval gate.`})
    }

    const blocked = checks.some((c) => c.status === 'block')
    const warned = checks.some((c) => c.status === 'warn')
    const status = blocked ? 'blocked' : warned ? 'warn' : 'pass'

    const next: string[] = []
    if (!auth.cicdSet) next.push('Run agentia setup to authenticate CICD.')
    if (!auth.crtReady) next.push('Fix CRT until agentia auth get --crt --json reports ready:true.')
    if (!story) next.push('Re-run with --story <id> for scoped evidence.')
    if (approvalRequired && status === 'blocked' && approval && !approval.approved) {
      next.push(`Run agentia gov approve ${approval.code} then re-run with --approve-code ${approval.code}.`)
    }
    if (status === 'pass' && isProd(env)) next.push('Approval consumed. Proceed with the normal promotion workflow.')

    let operateHint: string | null = null
    if (selfHeal && status !== 'pass') {
      const summary = checks
        .filter((c) => c.status !== 'pass')
        .map((c) => `${c.name}: ${c.detail}`)
        .join(' | ')
        .slice(0, 400)
      operateHint = `agentia ai agent ask --agent operate "Diagnose blocked promotion for story ${story ?? 'unknown'} to ${env}: ${summary}"`
    }

    const payload = {status, story, env, approvalRequired, checks, approval, operateHint, next}

    if (asJson) {
      this.log(JSON.stringify(payload, null, 2))
    } else {
      this.log(`Gov Guard check for story ${story ?? 'none'} to ${env}: ${status.toUpperCase()}`)
      for (const c of checks) {
        const tag = c.status === 'pass' ? 'PASS' : c.status === 'warn' ? 'WARN' : 'BLOCK'
        this.log(`[${tag}] ${c.name}: ${c.detail}`)
      }
      if (operateHint) this.log(`Self heal: ${operateHint}`)
      if (next.length > 0) {
        this.log('Next:')
        for (const n of next) this.log(`- ${n}`)
      }
    }

    if (blocked) this.exit(1)
  }
}
