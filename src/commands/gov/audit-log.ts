import {Command, Flags} from '@oclif/core'
import {readAudit} from '../../audit.js'

export default class GovAuditLog extends Command {
  static description =
    'Read the immutable approval ledger: who approved what and when. Append only, never deletable.'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --limit 20 --json',
  ]

  static flags = {
    limit: Flags.integer({char: 'n', description: 'Newest events shown.', default: 50}),
    json: Flags.boolean({char: 'j', description: 'Machine readable JSON events.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(GovAuditLog)
    const limit = Math.max(1, Math.min(500, (flags.limit as number) ?? 50))
    const asJson = (flags.json as boolean) ?? false
    const events = readAudit(limit)

    if (asJson) {
      this.log(JSON.stringify({events, count: events.length}, null, 2))
      return
    }
    if (events.length === 0) {
      this.log('Ledger empty. Approvals appear here as codes are issued, approved and consumed.')
      return
    }
    for (const e of events) {
      this.log(`${e.at} ${e.actor} ${e.event} ${e.code} story=${e.story ?? 'none'} env=${e.env}`)
    }
  }
}
