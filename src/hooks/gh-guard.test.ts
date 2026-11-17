import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ghGuardOutput, type GhGuardEnv } from './gh-guard.ts';

/** A folder as a POSIX path: on Windows the shell reader resolves `/work/web` to `D:\work\web`. */
function posix(dir: string): string {
  return dir.replace(/\\/gu, '/').replace(/^[A-Za-z]:/u, '');
}

const ENV: GhGuardEnv = {
  cwd: '/work/web',
  home: '/home/me',
  repos: ['acme/web'],
  remotesOf: (dir) => (posix(dir).startsWith('/work/web') ? ['acme/web'] : posix(dir).startsWith('/work/other') ? ['acme/other'] : []),
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
    ['gh issue close 12 -R acme/web --duplicate-of 9', '`teamrig issue close acme/web#12 --reason duplicate --duplicate-of acme/web#9`'],
    ['gh issue close 12 -R acme/web -r completed --duplicate-of https://github.com/acme/api/issues/4', '`teamrig issue close acme/web#12 --reason duplicate --duplicate-of acme/api#4`'],
    ['gh issue create -R acme/web -t x -b y', '`teamrig add ... --issue "<public title>" --issue-body "<public text>" --issue-repo acme/web`'],
    ['gh api repos/acme/web/issues -f title=x', '`teamrig add ... --issue "<public title>" --issue-body "<public text>" --issue-repo acme/web`'],
    ['gh api repos/acme/web/issues/12/sub_issues -X POST -F sub_issue_id=5', '`teamrig issue links --repo acme/web`'],
    ['gh api repos/acme/web/issues/12/dependencies/blocked_by -f issue_id=5', '`teamrig issue links --repo acme/web`'],
    ['gh api /repos/acme/web/issues/12/comments -f body=hi', '`teamrig issue comment acme/web#12 --body <text>`'],
    ['gh api repos/acme/web/issues/12/labels -X POST -f "labels[]=p1"', '`teamrig issue label acme/web#12 --add <label,...> --remove <label,...>`'],
    ['gh api -X PATCH repos/acme/web/issues/12 -f state=closed', '`teamrig issue close acme/web#12`'],
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
    for (const line of ['gh pr merge 7 -R acme/web', 'gh issue edit 12 -R acme/web --add-assignee me', 'gh run rerun 5 -R acme/web', 'gh api -X DELETE repos/acme/web/git/refs/heads/x']) {
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
  it("takes the folder's remote when the call names none", () => {
    assert.match(reason('gh issue comment 12 --body hi') ?? '', /teamrig issue comment acme\/web#12/);
    assert.match(reason('gh pr merge 3') ?? '', /gh pr merge: no teamrig command/);
    assert.equal(reason('gh issue comment 12 --body hi', ENV, '/work/other'), undefined);
  });

  it("counts a fork's clone whose upstream, or any remote gh may pick, names a team repository", () => {
    // origin is the fork, upstream (or the remote `gh repo set-default` chose) the team's: gh acts on the team's.
    const fork: GhGuardEnv = { ...ENV, remotesOf: () => ['me/web', 'acme/web'] };
    assert.match(reason('gh issue close 3', fork, '/work/fork') ?? '', /teamrig issue close acme\/web#3/);
    assert.match(reason('gh api repos/{owner}/{repo}/issues/3/comments -f body=x', fork, '/work/fork') ?? '', /issue comment acme\/web#3/);
    assert.equal(reason('gh issue close 3', { ...ENV, remotesOf: () => ['me/web', 'acme/other'] }, '/work/fork'), undefined);
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
    assert.ok(reason('gh repo edit acme/web --description x', ENV, '/work/other') !== undefined);
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

  it("never reads another option's value as -R, so a body, title or comment starting with -R names no repository", () => {
    assert.match(reason('gh issue comment 12 --body "-Rebased on main"') ?? '', /teamrig issue comment acme\/web#12 --body "-Rebased on main"/);
    assert.match(reason('gh issue create --title "-Racme/other x" -b y') ?? '', /--issue-repo acme\/web/);
    assert.match(reason('gh issue close 12 --comment -Racme/other') ?? '', /teamrig issue close acme\/web#12 --comment -Racme\/other/);
    assert.match(reason('gh issue close 12 -c "-R acme/other"') ?? '', /teamrig issue close acme\/web#12/);
  });

  it("reads the -R after a switch that shares a letter with another command's valued option", () => {
    const lines = [
      'gh pr merge 12 -s -R acme/web',
      'gh pr merge 12 -r -R acme/web',
      'gh pr merge 12 -m -R acme/web',
      'gh pr review 12 -a -R acme/web',
      'gh pr review 12 -c -R acme/web -b hi',
      'gh issue develop 12 -c -R acme/web',
      'gh release create v1 -p -R acme/web',
      'gh cache delete -a -R acme/web',
    ];
    for (const line of lines) {
      assert.ok(reason(line, ENV, '/work/other') !== undefined, line);
    }
  });

  it('reads -R=owner/name as gh does', () => {
    assert.match(reason('gh issue close 3 -R=acme/web', ENV, '/work/other') ?? '', /teamrig issue close acme\/web#3/);
  });

  it('stops reading options at --, and passes what it cannot tie to a repository', () => {
    assert.equal(reason('gh issue close 3 -- -R acme/web', ENV, '/elsewhere'), undefined);
    for (const line of ['gh issue', 'gh run list -R "$R"', 'gh api "$P"', 'gh api repos/{owner}/{repo}/issues -X GET']) {
      assert.equal(reason(line, ENV, '/elsewhere'), undefined, line);
    }
  });
});

describe('ghGuardOutput: reads no teamrig command takes, and opening a pull request', () => {
  it('passes each read of an issue, a pull request, a run, a release and the repository', () => {
    const lines = [
      'gh issue view 12 -R acme/web --comments',
      'gh issue list -R acme/web --state open',
      'gh issue status',
      'gh api repos/acme/web/issues/12/comments',
      'gh api repos/acme/web/issues?state=open',
      'gh api -X GET repos/acme/web/issues/12',
      'gh pr view 12 --json state',
      'gh pr checks 12',
      'gh pr diff 12',
      'gh pr list',
      'gh pr status',
      'gh pr checkout 12',
      'gh run view 123 --log-failed',
      'gh run list --branch main',
      'gh run watch 123',
      'gh workflow list',
      'gh release view v1 -R acme/web',
      'gh label list',
      'gh repo view acme/web',
      'gh repo clone acme/web',
      'gh browse',
      'gh api repos/acme/web/pulls/12',
      'gh api repos/acme/web/commits/abc',
      'gh api repos/acme/web/pulls/12/files --paginate',
      'gh api -X GET repos/acme/web/actions/runs',
      'gh api repositories/123/pulls',
    ];
    for (const line of lines) {
      assert.equal(reason(line), undefined, line);
    }
  });

  it('passes gh pr create, the way a session opens a pull request', () => {
    assert.equal(reason('gh pr create -R acme/web --head t1-fix --title x --body y'), undefined);
  });

  it('still refuses both writes of #1356', () => {
    assert.match(reason('gh issue edit 12 -R acme/web --add-label p1') ?? '', /teamrig issue label acme\/web#12 --add p1/);
    assert.match(reason('gh api repos/acme/web/issues/12/sub_issues -X POST -F sub_issue_id=5') ?? '', /teamrig issue links --repo acme\/web/);
  });

  it('refuses the writes of each group', () => {
    const lines = [
      'gh pr review 12 --approve',
      'gh pr ready 12',
      'gh run cancel 5',
      'gh workflow run ci.yml',
      'gh release create v2',
      'gh label create p0',
      'gh secret set TOKEN',
      'gh variable delete X',
      'gh repo edit --visibility public',
      'gh repo archive acme/web',
      'gh api repos/acme/web/pulls/12/reviews -f event=APPROVE',
    ];
    for (const line of lines) {
      assert.ok(reason(line) !== undefined, line);
    }
  });
});

describe('ghGuardOutput: each repository form gh takes', () => {
  it('reads a repository written as host/owner/name or a URL, with .git or a slash', () => {
    const forms = ['github.com/acme/web', 'https://github.com/acme/web', 'https://github.com/acme/web.git', 'acme/web/', 'git@github.com:acme/web.git'];
    for (const form of forms) {
      assert.ok(reason(`gh issue close 3 -R ${form}`, ENV, '/elsewhere') !== undefined, `-R ${form}`);
      assert.ok(reason(`gh issue close 3 --repo=${form}`, ENV, '/elsewhere') !== undefined, `--repo=${form}`);
      assert.ok(reason(`gh repo delete ${form} --yes`, ENV, '/elsewhere') !== undefined, `repo delete ${form}`);
    }
    assert.ok(reason('gh pr comment github.com/acme/web/pull/9 -b x', ENV, '/elsewhere') !== undefined);
    assert.equal(reason('gh issue close 3 -R ghe.example.com/acme/web'), undefined, 'another host is another repository');
  });

  it('reads the last of a repeated option, as gh does', () => {
    assert.ok(reason('gh issue close 3 -R acme/other -R acme/web', ENV, '/elsewhere') !== undefined);
    assert.equal(reason('gh issue close 3 -R acme/web -R acme/other', ENV, '/elsewhere'), undefined);
    assert.ok(reason('gh api repos/acme/web/pulls/1 -X GET -X DELETE', ENV, '/elsewhere') !== undefined);
    assert.equal(reason('gh api repos/acme/web/pulls/1 -X DELETE -X GET', ENV, '/elsewhere'), undefined);
  });

  it("reads the group's -R before its command", () => {
    assert.match(reason('gh issue -R acme/web close 12', ENV, '/elsewhere') ?? '', /teamrig issue close acme\/web#12/);
    assert.ok(reason('gh pr --repo acme/web merge 7', ENV, '/elsewhere') !== undefined);
    assert.equal(reason('gh pr -R acme/web view 7', ENV, '/elsewhere'), undefined);
  });

  it('reads a gh api endpoint given as a full URL, and doubts a write to a repository named by id', () => {
    assert.match(reason('gh api https://api.github.com/repos/acme/web/issues/12/comments -f body=x', ENV, '/elsewhere') ?? '', /issue comment acme\/web#12/);
    const byId = reason('gh api -X PATCH repositories/123/issues/4 -f state=closed', ENV, '/elsewhere') ?? '';
    assert.match(byId, /gh api PATCH repositories\/123\/issues\/4: names its repository by id/);
    assert.match(byId, /name it as repos\/<owner>\/<name> instead/);
    assert.equal(reason('gh api -X PATCH repositories/123/issues/4 -f state=closed', { ...ENV, repos: [] }), undefined);
  });

  it('finds gh however the line quotes its name', () => {
    assert.ok(reason('g""h issue close 3 -R acme/web') !== undefined);
    assert.ok(reason("'gh' issue close 3 -R acme/web") !== undefined);
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
