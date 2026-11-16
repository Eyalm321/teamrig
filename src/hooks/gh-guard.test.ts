import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ghGuardOutput, type GhGuardEnv } from './gh-guard.ts';

const ENV: GhGuardEnv = {
  cwd: '/work/web',
  home: '/home/me',
  repos: ['acme/web'],
  originOf: (dir) => (dir.startsWith('/work/web') ? 'acme/web' : dir.startsWith('/work/other') ? 'acme/other' : undefined),
  platform: 'linux',
  command: 'teamrig',
};

function bash(command: string, cwd?: string): unknown {
  return { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, ...(cwd === undefined ? {} : { cwd }) };
}

/** The refusal's reason, or undefined when the guard printed nothing. */
function reasonOf(output: string): string | undefined {
  if (output === '') {
    return undefined;
  }
  const parsed: unknown = JSON.parse(output);
  assert.ok(typeof parsed === 'object' && parsed !== null && 'hookSpecificOutput' in parsed);
  const specific = parsed.hookSpecificOutput;
  assert.ok(typeof specific === 'object' && specific !== null && 'permissionDecision' in specific && 'permissionDecisionReason' in specific);
  assert.equal(specific.permissionDecision, 'deny');
  return String(specific.permissionDecisionReason);
}

function reason(command: string, env: GhGuardEnv = ENV, cwd?: string): string | undefined {
  return reasonOf(ghGuardOutput(bash(command, cwd), env));
}

describe('ghGuardOutput: the table from each gh shape to its teamrig command', () => {
  const rows: readonly (readonly [string, string])[] = [
    ['gh issue edit 12 -R acme/web --add-label p1', '`teamrig issue label acme/web#12 --add p1`'],
    ['gh issue edit 12 -R acme/web --add-label p1 --remove-label "status:open"', '`teamrig issue label acme/web#12 --add p1 --remove status:open`'],
    ['gh issue edit 12 --repo=acme/web --body-file notes.md', '`teamrig issue edit acme/web#12 --body-file <path>`'],
    ['gh pr edit 7 -R acme/web --body "new text"', '`teamrig issue edit acme/web#7 --body-file <path>`'],
    ['gh issue comment 12 -R acme/web --body "on it"', '`teamrig issue comment acme/web#12 --body "on it"`'],
    ['gh pr comment https://github.com/acme/web/pull/9 -b done', '`teamrig issue comment acme/web#9 --body done`'],
    ['gh issue close 12 -R acme/web -r "not planned" -c dup', '`teamrig issue close acme/web#12 --comment dup --reason not-planned`'],
    ['gh issue view 12 -R acme/web', '`teamrig issue sync --repo acme/web`'],
    ['gh issue list -R acme/web --state open', '`teamrig issue sync --repo acme/web`'],
    ['gh issue create -R acme/web -t x -b y', '`teamrig add ... --issue "<public title>" --issue-body "<public text>" --issue-repo acme/web`'],
    ['gh api repos/acme/web/issues/12/sub_issues -X POST -F sub_issue_id=5', '`teamrig issue links --repo acme/web`'],
    ['gh api repos/acme/web/issues/12/dependencies/blocked_by -f issue_id=5', '`teamrig issue links --repo acme/web`'],
    ['gh api /repos/acme/web/issues/12/comments -f body=hi', '`teamrig issue comment acme/web#12 --body <text>`'],
    ['gh api repos/acme/web/issues/12/labels -X POST -f "labels[]=p1"', '`teamrig issue label acme/web#12 --add <label,...> --remove <label,...>`'],
    ['gh api -X PATCH repos/acme/web/issues/12 -f state=closed', '`teamrig issue close acme/web#12`'],
    ['gh api repos/acme/web/issues?state=open', '`teamrig issue sync --repo acme/web`'],
  ];
  for (const [line, command] of rows) {
    it(`${line} -> ${command}`, () => {
      const text = reason(line);
      assert.ok(text !== undefined, 'refused');
      assert.ok(text.includes(command), text);
      assert.match(text, /acme\/web is under github\.repos/);
      assert.match(text, /\[github\.repos\]$/);
    });
  }

  it('refuses a step no teamrig command takes yet, saying so', () => {
    for (const line of ['gh pr merge 7 -R acme/web', 'gh issue edit 12 -R acme/web --add-assignee me', 'gh run view 5 -R acme/web', 'gh api -X DELETE repos/acme/web/git/refs/heads/x']) {
      const text = reason(line);
      assert.ok(text !== undefined, line);
      assert.match(text, /no teamrig command takes this step yet; report the gap to your leader/, line);
    }
  });

  it('names the step as the line writes it', () => {
    assert.match(reason('gh api repos/acme/web/issues/12/sub_issues -X POST') ?? '', /gh api POST repos\/acme\/web\/issues\/12\/sub_issues: run/);
    assert.match(reason('gh pr merge 7 -R acme/web') ?? '', /gh pr merge: no teamrig/);
  });
});

describe('ghGuardOutput: which repository a call acts on', () => {
  it('takes the folder origin when the call names none', () => {
    assert.match(reason('gh issue comment 12 --body hi') ?? '', /teamrig issue comment acme\/web#12/);
    assert.match(reason('gh pr view 3') ?? '', /gh pr view: no teamrig command/);
    assert.equal(reason('gh issue comment 12 --body hi', ENV, '/work/other'), undefined);
  });

  it('follows a cd in the line to the folder it starts gh in', () => {
    assert.equal(reason('cd /work/other && gh issue close 3'), undefined);
    assert.ok(reason('cd /work/web && gh issue close 3', ENV, '/work/other') !== undefined);
  });

  it("reads gh api's {owner}/{repo} placeholders from the origin", () => {
    assert.match(reason('gh api repos/{owner}/{repo}/issues/4/comments -f body=x') ?? '', /issue comment acme\/web#4/);
    assert.equal(reason('gh api repos/{owner}/{repo}/issues/4/comments -f body=x', ENV, '/work/other'), undefined);
  });

  it('matches the repository case-insensitively', () => {
    assert.ok(reason('gh issue close 3 -R ACME/Web') !== undefined);
    assert.ok(reason('gh issue close 3', { ...ENV, repos: ['Acme/Web'] }) !== undefined);
  });

  it('reads gh repo <sub> <owner/name>, but not a repository it creates or an owner it lists', () => {
    assert.ok(reason('gh repo view acme/web', ENV, '/work/other') !== undefined);
    assert.equal(reason('gh repo create acme/web --private'), undefined);
    assert.equal(reason('gh repo list acme'), undefined);
  });

  it('finds gh in a pipe, a subshell and after other commands', () => {
    assert.ok(reason('echo x | gh issue comment 12 -R acme/web --body-file -') !== undefined);
    assert.ok(reason('git status; (gh issue close 3 -R acme/web)') !== undefined);
  });
});

describe('ghGuardOutput: option spellings', () => {
  it('reads -Rowner/name, --opt=value and an api PATCH of several fields', () => {
    assert.ok(reason('gh issue close 3 -Racme/web', ENV, '/elsewhere') !== undefined);
    assert.match(reason('gh issue edit 12 -R acme/web --add-label=p1,bug') ?? '', /--add p1,bug`/);
    const patch = reason('gh api repos/acme/web/issues/3 -X PATCH -f body=x -f "labels[]=a"') ?? '';
    assert.match(patch, /issue label acme\/web#3/);
    assert.match(patch, /issue edit acme\/web#3 --body-file/);
    assert.match(reason('gh api -X PUT repos/acme/web/pulls/3/merge') ?? '', /no teamrig command takes this step yet/);
  });

  it('stops reading options at --, and passes what it cannot tie to a repository', () => {
    assert.equal(reason('gh issue close 3 -- -R acme/web', ENV, '/elsewhere'), undefined);
    for (const line of ['gh issue', 'gh run list -R "$R"', 'gh api "$P"', 'gh api repos/{owner}/{repo}/issues -X GET']) {
      assert.equal(reason(line, ENV, '/elsewhere'), undefined, line);
    }
  });
});

describe('ghGuardOutput: what runs as before', () => {
  it('passes gh on a repository not listed', () => {
    assert.equal(reason('gh issue edit 12 -R acme/other --add-label p1'), undefined);
    assert.equal(reason('gh api repos/acme/other/issues/12/sub_issues -X POST'), undefined);
  });

  it('passes gh that names no repository', () => {
    for (const line of ['gh auth status', 'gh api user', 'gh api graphql -f query=x', 'gh search issues foo', 'gh --version', 'gh']) {
      assert.equal(reason(line), undefined, line);
    }
  });

  it('passes a repository known only when the line runs', () => {
    assert.equal(reason('gh issue close 3 -R "$REPO"', ENV, '/work/other'), undefined);
  });

  it('passes a team with no repositories, a line with no gh, and teamrig itself', () => {
    assert.equal(reason('gh issue close 3 -R acme/web', { ...ENV, repos: [] }), undefined);
    assert.equal(reason('git log --oneline'), undefined);
    assert.equal(reason('teamrig issue close acme/web#3'), undefined);
    assert.equal(reason('echo gh issue close 3 -R acme/web'), undefined);
  });

  it('passes input that is no hook payload, and a call with no command', () => {
    assert.equal(ghGuardOutput('nope', ENV), '');
    assert.equal(ghGuardOutput({ tool_name: 'Read', tool_input: { file_path: 'gh' } }, ENV), '');
  });

  it('names each step once when a Windows line reads two ways', () => {
    const text = reason('gh issue close 3 -R acme/web', { ...ENV, platform: 'win32' }) ?? '';
    assert.equal(text.split('gh issue close:').length, 2);
  });
});
