import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'

interface Finding {
  area: string
  status: 'pass' | 'fail' | 'skipped'
  detail: string
  fix?: string
}

function sh(cmd: string, args: string[], cwd?: string, timeoutMs = 120_000): string {
  return execFileSync(cmd, args, {encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], cwd})
}

function gitRoot(): string | null {
  try {
    const out = sh('git', ['rev-parse', '--show-toplevel'])
    return out.trim() !== '' ? out.trim() : null
  } catch {
    return null
  }
}

function changedFiles(root: string, base: string): {files: string[]; baseUsed: string} {
  const attempts = [base, 'main', 'master'];
  let lastError = '';
  for (const ref of attempts) {
    try {
      const mergeBase = sh('git', ['merge-base', ref, 'HEAD'], root).trim();
      const out = sh('git', ['diff', '--name-only', `${mergeBase}...HEAD`], root);
      void lastError;
      return {files: out.split('\n').map((f) => f.trim()).filter((f) => f !== ''), baseUsed: ref};
    } catch (error: any) {
      lastError = (error?.message ?? String(error)).split('\n')[0];
    }
  }
  try {
    const out = sh('git', ['diff', '--name-only', 'HEAD'], root);
    void lastError;
    return {files: out.split('\n').map((f) => f.trim()).filter((f) => f !== ''), baseUsed: 'working-tree'};
  } catch {
    return {files: [], baseUsed: 'none'};
  }
}

function storyFromBranch(root: string): string | null {
  try {
    const branch = sh('git', ['branch', '--show-current'], root).trim();
    const m = /US-\d+/i.exec(branch);
    return m ? m[0].toUpperCase() : null;
  } catch {
    return null;
  }
}

function isProfile(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.profile-meta.xml') || lower.endsWith('.profile') || lower.includes('profile');
}

function apexMember(path: string): {type: string; name: string} | null {
  const base = path.split('/').pop() ?? '';
  if (base.endsWith('.cls')) return {type: 'ApexClass', name: base.slice(0, -4)};
  if (base.endsWith('.trigger')) return {type: 'ApexTrigger', name: base.slice(0, -8)};
  return null;
}

export default class GovPrCheck extends Command {
  static description =
    'Quality gate a branch before promotion: story ID, profile noise, risky grants, blast radius and policy gate.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --story US-0000024',
    '<%= config.bin %> <%= command.id %> --base origin/main --json',
  ]

  static flags = {
    story: Flags.string({char: 's', description: 'User story ID. Defaults to US-ID parsed from the branch name.'}),
    base: Flags.string({char: 'b', description: 'Base ref for the branch diff.', default: 'origin/main'}),
    env: Flags.string({char: 'e', description: 'Environment for the policy gate.', default: 'UAT-SFP'}),
    'credential-id': Flags.string({description: 'Credential ID enabling blast radius lookups.'}),
    'org-id': Flags.string({description: 'Org ID enabling blast radius lookups.'}),
    'pipeline-id': Flags.string({description: 'Pipeline ID enabling blast radius lookups.'}),
    json: Flags.boolean({char: 'j', description: 'Machine readable JSON verdict.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(GovPrCheck)
    const env = (flags.env as string) ?? 'UAT-SFP';
    const base = (flags.base as string) ?? 'origin/main';
    const asJson = (flags.json as boolean) ?? false;
    const findings: Finding[] = [];

    const root = gitRoot();
    if (!root) {
      const detail = 'Not inside a git repository. Run this from a branch checkout.';
      if (asJson) this.log(JSON.stringify({status: 'error', detail}, null, 2));
      else this.log(detail);
      this.exit(1);
    }
    const repo = root as string;

    let story = (flags.story as string | undefined) ?? storyFromBranch(repo);
    if (!story) {
      findings.push({area: 'story-id', status: 'fail', detail: 'No story ID in flags or branch name.', fix: 'Re-run with --story US-XXXXXXX or include it in the branch name.'});
    } else {
      story = story.toUpperCase();
      findings.push({area: 'story-id', status: 'pass', detail: `Story context is ${story}.`});
    }

    const {files, baseUsed} = changedFiles(repo, base);
    const capped = files.slice(0, 50);
    if (files.length === 0) {
      findings.push({area: 'branch-diff', status: 'fail', detail: 'No changed files found against the base.', fix: 'Commit changes or point --base at the right ref.'});
    } else {
      findings.push({area: 'branch-diff', status: 'pass', detail: `${files.length} changed files versus ${baseUsed}.`});
      if (files.length > 50) findings.push({area: 'branch-diff', status: 'pass', detail: 'Scan capped at the first 50 files.'});
    }

    const profiles = capped.filter(isProfile);
    for (const file of profiles.slice(0, 10)) {
      try {
        const out = sh('agentia', ['profile', 'trim', '--file', `${repo}/${file}`, '--json'], repo);
        const parsed: any = JSON.parse(out);
        const rules: any[] = Array.isArray(parsed?.rules) ? parsed.rules : [];
        const noisy = rules.reduce((n: number, r: any) => n + (typeof r?.count === 'number' ? r.count : 0), 0);
        findings.push(noisy > 0
          ? {area: 'profile-noise', status: 'fail', detail: `${file} carries ${noisy} noise findings.`, fix: `Run agentia profile trim --file ${file} --write --out <clean> and commit the result.`}
          : {area: 'profile-noise', status: 'pass', detail: `${file} is clean.`});
      } catch {
        findings.push({area: 'profile-noise', status: 'skipped', detail: `${file} could not be scanned. Install the profile-trim plugin for this check.`});
        break;
      }
      try {
        const out = sh('agentia', ['fls', 'check', '--file', `${repo}/${file}`, '--json'], repo);
        const parsed: any = JSON.parse(out);
        const risky = typeof parsed?.riskyCount === 'number' ? parsed.riskyCount : 0;
        findings.push(risky > 0
          ? {area: 'fls-grants', status: 'fail', detail: `${file} has ${risky} risky grants.`, fix: 'Remove the grants or document the exception before promoting.'}
          : {area: 'fls-grants', status: 'pass', detail: `${file} has no risky grants.`});
      } catch {
        findings.push({area: 'fls-grants', status: 'skipped', detail: `${file} could not be scanned. Install the fls-guard plugin for this check.`});
        break;
      }
    }

    const cred = (flags['credential-id'] as string | undefined) ?? null;
    const org = (flags['org-id'] as string | undefined) ?? null;
    const pipeline = (flags['pipeline-id'] as string | undefined) ?? null;
    const apexFiles = capped.map(apexMember).filter((m): m is {type: string; name: string} => m !== null).slice(0, 5);
    if (apexFiles.length > 0 && cred && org && pipeline) {
      for (const m of apexFiles) {
        try {
          const out = sh('agentia', ['graph', 'blast', '--type', m.type, '--name', m.name,
            '--source-credential-id', cred, '--source-org-id', org, '--pipeline-id', pipeline, '--json'], repo);
          const parsed: any = JSON.parse(out);
          const down = typeof parsed?.downstreamCount === 'number' ? parsed.downstreamCount : 0;
          findings.push({area: 'blast-radius', status: 'pass', detail: `${m.type} ${m.name}: ${down} downstream dependents mapped.`});
        } catch {
          findings.push({area: 'blast-radius', status: 'skipped', detail: `${m.name} lookup failed. Install the org-graph plugin and verify scope IDs.`});
          break;
        }
      }
    } else if (apexFiles.length > 0) {
      findings.push({area: 'blast-radius', status: 'skipped', detail: `${apexFiles.length} code files found. Pass credential, org and pipeline IDs to map blast radius.`});
    }

    if (story) {
      try {
        const out = sh('agentia', ['gov', 'check', '--story', story, '--env', env, '--json'], repo);
        const parsed: any = JSON.parse(out);
        const st = typeof parsed?.status === 'string' ? parsed.status : 'unknown';
        findings.push(st === 'blocked'
          ? {area: 'policy-gate', status: 'fail', detail: `Gov check blocked for ${story}.`, fix: 'Resolve the blocking checks, then rerun this gate.'}
          : {area: 'policy-gate', status: 'pass', detail: `Gov check ${st} for ${story} to ${env}.`});
      } catch {
        findings.push({area: 'policy-gate', status: 'skipped', detail: 'Gov check unavailable in this run.'});
      }
    }

    const failed = findings.filter((f) => f.status === 'fail');
    const payload = {
      status: findings.some((f) => f.status === 'fail') ? 'fail' : 'pass',
      story: story ?? null,
      base: baseUsed,
      fileCount: files.length,
      findings,
      fixes: findings.filter((f) => f.fix).map((f) => f.fix as string),
    };
    if (asJson) {
      this.log(JSON.stringify(payload, null, 2));
    } else {
      this.log(`PR gate ${payload.status.toUpperCase()} for ${story ?? 'no story'}: ${failed.length} failing areas, ${files.length} files versus ${baseUsed}.`);
      for (const f of findings) {
        const tag = f.status === 'pass' ? 'PASS' : f.status === 'fail' ? 'FAIL' : 'SKIP';
        this.log(`[${tag}] ${f.area}: ${f.detail}`);
        if (f.fix) this.log(`      Fix: ${f.fix}`);
      }
    }
    if (failed.length > 0) this.exit(1);
  }
}
