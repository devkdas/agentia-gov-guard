import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'

function runAgentia(args: string[], timeoutMs = 60_000): string {
  return execFileSync('agentia', args, {encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe']})
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

export default class GovWatch extends Command {
  static description =
    'Watch a story until policy gates pass or the timeout hits. Approves only with a human supplied code, escalates otherwise.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --story US-0000024 --env UAT-SFP',
    '<%= config.bin %> <%= command.id %> --story US-0000024 --env PROD --approve-code AP-XXXXXX --timeout-sec 600 --json',
  ]

  static flags = {
    story: Flags.string({char: 's', description: 'User story ID watched.', required: true}),
    env: Flags.string({char: 'e', description: 'Target environment.', default: 'UAT-SFP'}),
    'approve-code': Flags.string({description: 'Human supplied PROD approval code, consumed on pass.'}),
    'timeout-sec': Flags.integer({description: 'Max seconds to watch.', default: 600}),
    'interval-sec': Flags.integer({description: 'Seconds between gate polls.', default: 15}),
    json: Flags.boolean({char: 'j', description: 'Machine readable JSON verdict.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(GovWatch)
    const story = flags.story as string
    const env = (flags.env as string) ?? 'UAT-SFP'
    const approveCode = (flags['approve-code'] as string | undefined) ?? null
    const timeoutSec = Math.max(30, (flags['timeout-sec'] as number) ?? 600)
    const intervalSec = Math.max(5, (flags['interval-sec'] as number) ?? 15)
    const asJson = (flags.json as boolean) ?? false

    const deadline = Date.now() + timeoutSec * 1000
    let polls = 0
    let lastStatus = 'unknown'
    let lastDetail = ''
    let approved = false

    while (Date.now() < deadline) {
      polls += 1
      if (approveCode && !approved) {
        try {
          runAgentia(['gov', 'approve', approveCode, '--story', story, '--env', env])
          approved = true
          if (!asJson) this.log(`Poll ${polls}: approval code accepted. Rechecking gate.`)
        } catch {
          if (!asJson) this.log(`Poll ${polls}: approval not yet accepted. Waiting.`)
        }
      }
      const args = ['gov', 'check', '--story', story, '--env', env, '--json']
      if (approveCode) args.push('--approve-code', approveCode)
      let parsed: any = null
      try {
        parsed = JSON.parse(runAgentia(args))
      } catch (error: any) {
        const so = typeof (error as any)?.stdout === 'string' ? ((error as any).stdout as string) : ''
        try {
          parsed = JSON.parse(so)
        } catch {
          parsed = null
        }
        if (!parsed) {
          lastStatus = 'unreadable'
          lastDetail = `Gate unreadable: ${(error?.message ?? String(error)).split('\n')[0]}`
          if (!asJson) this.log(`Poll ${polls}: ${lastDetail} Retrying.`)
          await sleep(intervalSec * 1000)
          continue
        }
      }
      lastStatus = typeof parsed?.status === 'string' ? parsed.status : 'unknown'
      if (lastStatus === 'pass') {
        if (approveCode) approved = true
        const payload = {status: 'pass', story, env, polls, approvedCodeUsed: approved && approveCode !== null}
        if (asJson) this.log(JSON.stringify(payload, null, 2))
        else this.log(`Gates passed for ${story} to ${env} after ${polls} polls.${approveCode ? ' Approval code consumed.' : ''}`)
        return
      }
      const checks: any[] = Array.isArray(parsed?.checks) ? parsed.checks : []
      const blocking = checks.filter((c) => c?.status === 'block')
      lastDetail = blocking.length > 0
        ? blocking.map((c) => `${c?.name}: ${c?.detail ?? ''}`.slice(0, 160)).join(' | ')
        : `Status ${lastStatus}.`
      if (!asJson) {
        this.log(`Poll ${polls}: ${lastDetail} Waiting ${intervalSec}s.`)
      }
      await sleep(intervalSec * 1000)
    }

    const payload = {
      status: 'escalated',
      story,
      env,
      polls,
      lastStatus,
      lastDetail,
      next: 'Gates did not pass in time. Escalate to a human with the blocking checks above.',
    }
    if (asJson) this.log(JSON.stringify(payload, null, 2))
    else {
      this.log(`Escalated: gates for ${story} to ${env} did not pass within ${timeoutSec}s after ${polls} polls.`)
      this.log(`Last state: ${lastDetail}`)
    }
    this.exit(1)
  }
}
