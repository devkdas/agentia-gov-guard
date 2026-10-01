import {appendFileSync, existsSync, mkdirSync, readFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'

export interface AuditEvent {
  at: string
  actor: string
  event: 'code-issued' | 'code-approved' | 'code-consumed'
  code: string
  story: string | null
  env: string
}

function ledgerDir(): string {
  return join(homedir(), '.agentia-gov-guard')
}

export function ledgerPath(): string {
  return join(ledgerDir(), 'audit.jsonl')
}

export function appendAudit(event: Omit<AuditEvent, 'at' | 'actor'>): void {
  try {
    mkdirSync(ledgerDir(), {recursive: true})
    const record: AuditEvent = {
      at: new Date().toISOString(),
      actor: process.env['USER'] || process.env['USERNAME'] || 'unknown',
      ...event,
    }
    appendFileSync(ledgerPath(), JSON.stringify(record) + '\n', 'utf8')
  } catch {
    return
  }
}

export function readAudit(limit = 50): AuditEvent[] {
  try {
    if (!existsSync(ledgerPath())) return []
    const out: AuditEvent[] = []
    for (const line of readFileSync(ledgerPath(), 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        out.push(JSON.parse(trimmed) as AuditEvent)
      } catch {
        continue
      }
    }
    return out.slice(-Math.max(1, limit))
  } catch {
    return []
  }
}
