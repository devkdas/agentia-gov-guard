import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, writeFileSync, chmodSync, renameSync, readFileSync, rmSync} from 'node:fs'
import {join} from 'node:path'

function gitRoot(): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return out.trim() !== '' ? out.trim() : null
  } catch {
    return null
  }
}

function hookBody(env: string): string {
  return `#!/usr/bin/env bash
# Installed by agentia gov install-hook. Do not edit by hand.
# Uses the commit-msg stage because pre-commit cannot see the message.
MSG_FILE="$1"
STORY=$(grep -oE -i 'US-[0-9]+' "$MSG_FILE" | head -1)
if [ -z "$STORY" ]; then
  echo "Blocked: commit message must contain a Copado story ID (e.g. US-0000024)." >&2
  exit 1
fi
agentia gov check --story "$STORY" --env "${env}"
STATUS=$?
if [ "$STATUS" -ne 0 ]; then
  echo "Blocked: gov check failed for $STORY. Fix the blockers above or bypass with --no-verify (not recommended)." >&2
  exit 1
fi
exit 0
`
}

export default class GovInstallHook extends Command {
  static description =
    'Install a git commit-msg hook that requires a story ID and passes the Gov Guard gate.'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --env UAT-SFP --force',
    '<%= config.bin %> <%= command.id %> --uninstall',
  ]

  static flags = {
    env: Flags.string({char: 'e', description: 'Environment the gate checks.', default: 'UAT-SFP'}),
    force: Flags.boolean({description: 'Overwrite an existing hook after backing it up.', default: false}),
    uninstall: Flags.boolean({description: 'Remove the installed hook.', default: false}),
    json: Flags.boolean({char: 'j', description: 'Machine readable JSON output.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(GovInstallHook)
    const env = (flags.env as string) ?? 'UAT-SFP'
    const force = (flags.force as boolean) ?? false
    const uninstall = (flags.uninstall as boolean) ?? false
    const asJson = (flags.json as boolean) ?? false

    const root = gitRoot()
    if (!root) {
      const detail = 'Not inside a git repository. Run this from your project checkout.'
      if (asJson) this.log(JSON.stringify({installed: false, detail}, null, 2))
      else this.log(detail)
      this.exit(1)
    }

    const hooksDir = join(root as string, '.git', 'hooks')
    const hookPath = join(hooksDir, 'commit-msg')
    mkdirSync(hooksDir, {recursive: true})

    if (uninstall) {
      if (!existsSync(hookPath)) {
        const detail = 'No gov hook installed in this repository.'
        if (asJson) this.log(JSON.stringify({installed: false, detail}, null, 2))
        else this.log(detail)
        return
      }
      const content = readFileSync(hookPath, 'utf8')
      if (!content.includes('agentia gov install-hook')) {
        const detail = 'The existing hook was not installed by gov. Refusing to remove it.'
        if (asJson) this.log(JSON.stringify({installed: true, detail}, null, 2))
        else this.log(detail)
        this.exit(1)
      }
      rmSync(hookPath)
      const payload = {installed: false, path: hookPath, detail: 'Gov hook removed.'}
      if (asJson) this.log(JSON.stringify(payload, null, 2))
      else this.log(`Removed gov hook from ${hookPath}.`)
      return
    }

    if (existsSync(hookPath) && !force) {
      const detail = `A hook already exists at ${hookPath}. Re-run with --force to back it up and replace it.`
      if (asJson) this.log(JSON.stringify({installed: false, detail}, null, 2))
      else this.log(detail)
      this.exit(1)
    }

    if (existsSync(hookPath) && force) {
      renameSync(hookPath, `${hookPath}.bak`)
    }

    writeFileSync(hookPath, hookBody(env), {encoding: 'utf8', mode: 0o755})
    chmodSync(hookPath, 0o755)
    const payload = {installed: true, path: hookPath, env}
    if (asJson) {
      this.log(JSON.stringify(payload, null, 2))
    } else {
      this.log(`Installed gov commit-msg hook at ${hookPath} (gate env ${env}).`)
      this.log('Commits now need a story ID like US-0000024 plus a passing gov check. Bypass with --no-verify (not recommended).')
    }
  }
}
