import { runGit, type GitRun } from '../core/git-run.ts';
import { COMMIT_LOG_FORMAT, parseCommitLog, type CommitLog } from './commit-size.ts';
import type { ConfigValue } from './invocations.ts';
import type { RepoState } from './push.ts';

/**
 * The limit on one git query here. The push guard runs these, several per Bash line, inside its own 12 s limit
 * (guard-runner.ts), so each gets less than the kit's query limit.
 */
export const GUARD_GIT_TIMEOUT_MS = 5_000;

/** Runs one git query in `dir` with a time limit; the kit's runner keeps a run that gave no answer apart from git's own failure. */
export type GitRunner = (dir: string, args: readonly string[], timeoutMs: number) => GitRun;

/** One git query, trimmed; any failure (no repository, an unknown ref, no git on PATH, no answer) and an empty answer (no upstream, a detached HEAD) read as unknown. */
function readGit(run: GitRunner, dir: string, args: readonly string[]): string | undefined {
  const done = run(dir, args, GUARD_GIT_TIMEOUT_MS);
  const value = done.unanswered === undefined && done.status === 0 ? done.stdout.trim() : '';
  return value === '' ? undefined : value;
}

/** One config value as git in `dir` reads it: git exits 1 for a key that is not set, and fails otherwise for no git or no folder. */
function readConfig(run: GitRunner, dir: string, key: string): ConfigValue {
  const done = run(dir, ['config', '--get', key], GUARD_GIT_TIMEOUT_MS);
  if (done.unanswered !== undefined) {
    return { kind: 'unreadable' };
  }
  if (done.status === 0) {
    return { kind: 'set', value: done.stdout.replace(/\r?\n$/, '') };
  }
  return done.status === 1 ? { kind: 'unset' } : { kind: 'unreadable' };
}

/** Repository state from git through `run`. */
export function repoStateWith(run: GitRunner): RepoState {
  return {
    // symbolic-ref names a branch before its first commit, and nothing on a detached HEAD.
    branch: (dir) => readGit(run, dir, ['symbolic-ref', '--short', '-q', 'HEAD']),
    head: (dir) => readGit(run, dir, ['rev-parse', '--short', '-q', '--verify', 'HEAD']),
    // A name starting with `-` would read as an option, so it has no push target the guard can ask for.
    pushTarget: (dir, branch) => (branch?.startsWith('-') === true ? undefined : readGit(run, dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch ?? ''}@{push}`])),
    config: (dir, key) => readConfig(run, dir, key),
  };
}

/** The newest commits of a range the size rule reads; older ones in a longer range go unchecked. */
export const COMMIT_LOG_MAX = 200;

/**
 * Commits from git through `run`, with renames detected so a moved file weighs its edits, not its length. A run that
 * gave no answer reads as one (#1523), so a slow host is never reported as git refusing the range.
 */
export function commitLogWith(run: GitRunner): CommitLog {
  return {
    between: (dir, base, tip) => {
      const range = `${base}..${tip}`;
      const args = ['-c', 'core.quotePath=false', 'log', '-M', '--numstat', `--format=${COMMIT_LOG_FORMAT}`, `--max-count=${COMMIT_LOG_MAX}`, '--end-of-options', range, '--'];
      const done = run(dir, args, GUARD_GIT_TIMEOUT_MS);
      if (done.unanswered !== undefined) {
        return { unanswered: done.unanswered };
      }
      return done.status === 0 ? parseCommitLog(done.stdout) : undefined;
    },
  };
}

/** Repository state from the git CLI. */
export const GIT_CLI: RepoState = repoStateWith(runGit);

/** Commits from the git CLI. */
export const GIT_COMMIT_LOG: CommitLog = commitLogWith(runGit);
