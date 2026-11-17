import { toolCommandReadings } from '../core/bash-tool-readings.ts';
import { isRecord, recordField, stringField } from '../core/guards.ts';
import { programsOf, type ProgramRun } from '../package-guard/programs.ts';
import type { ShellWord } from '../push-guard/tokenizer.ts';
import { refusalOutput } from './permission.ts';

/**
 * The gh guard (#1356): a raw `gh` call on a repository the team lists under `github.repos` runs on the person's own
 * gh login, which may not reach the repository, and skips the checks teamrig's own commands make (the secret scan, the
 * private-data check, the stale-write check). The guard refuses a step that writes, naming the teamrig command that
 * takes the same step on the key teamrig saves for the repository's owner; a write no teamrig command takes yet is
 * refused saying so, so the gap is reported rather than run around. Every read (an issue's or a pull request's view,
 * list or thread, a run's log, a gh api GET) and `gh pr create` run as before: `teamrig issue sync` keeps only open
 * issues it trusts, bodies cut short and no comments, so it takes no issue read yet, and refusing reads would stall
 * triage, review and CI work. `gh` on any other repository, and `gh` that names no repository (`gh auth`,
 * `gh api user`), run as before too.
 */

export interface GhGuardEnv {
  /** The folder a line starts in when the payload names none. */
  readonly cwd: string;
  readonly home: string;
  /** The team's repositories, `owner/name` in lower case (`github.repos`). */
  readonly repos: readonly string[];
  /**
   * `owner/name`, lower case, of each GitHub repository a remote of `dir` names (another host's left out). gh takes the
   * remote `gh repo set-default` chose, else `upstream`, `github` or `origin`; a folder counts as a team repository's
   * when any of its remotes names one.
   */
  readonly remotesOf: (dir: string) => readonly string[];
  /** The host's platform: on Windows a Bash line is read as written and as bash receives it (core/bash-tool-readings.ts). */
  readonly platform: NodeJS.Platform;
  /** The CLI's name, which starts each command the reason names. */
  readonly command: string;
}

/** One refused `gh` call: the repository it acts on, the step as the line writes it, and the teamrig commands that take it. */
export interface GhStep {
  readonly repo: string;
  /** The gh words that name the step: `gh issue edit`, `gh api POST repos/acme/web/issues/12/sub_issues`. */
  readonly shape: string;
  /** The teamrig commands that take the step, the CLI name left out; empty when none does yet. */
  readonly commands: readonly string[];
  /** A gh api write that names its repository by id (`repositories/<id>/...`), which the guard cannot match to a name. */
  readonly byId?: boolean;
}

/**
 * gh's command groups that act on a repository and, given no `-R`, take it from the folder's git remote. `gh repo`
 * reads one from its first argument too. `gh browse` and `gh attestation` only read, so they are not listed.
 */
const REPO_GROUPS: ReadonlySet<string> = new Set(['issue', 'pr', 'run', 'workflow', 'release', 'label', 'cache', 'secret', 'variable', 'ruleset', 'repo']);

/**
 * Per group, the commands that run as before: they only read and no teamrig command takes them, or (`gh pr create`)
 * they are the team's way to open a pull request. Any other command of a group counts as a write.
 */
const PASSING_STEPS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['issue', new Set(['view', 'list', 'status'])],
  ['pr', new Set(['view', 'list', 'status', 'diff', 'checks', 'checkout', 'create'])],
  ['run', new Set(['list', 'view', 'watch', 'download'])],
  ['workflow', new Set(['list', 'view'])],
  ['release', new Set(['list', 'view', 'download', 'verify', 'verify-asset'])],
  ['label', new Set(['list'])],
  ['cache', new Set(['list'])],
  ['secret', new Set(['list'])],
  ['variable', new Set(['list', 'get'])],
  ['ruleset', new Set(['list', 'view', 'check'])],
  ['repo', new Set(['view', 'clone', 'fork'])],
]);

/** gh api methods that only read. */
const API_READS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** `gh repo` commands whose first argument, when given, is no existing repository of the team's: a new one, or an owner. */
const REPO_NOT_TARGET: ReadonlySet<string> = new Set(['create', 'list', 'set-default', 'gitignore', 'license']);

/** gh api options that take the next word as their value. */
const API_VALUED: ReadonlySet<string> = new Set([
  '-X', '--method', '-f', '--raw-field', '-F', '--field', '-H', '--header', '--input', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview',
]);
/** gh api options that send a body, so the method is POST when none is named. */
const API_BODY: ReadonlySet<string> = new Set(['-f', '--raw-field', '-F', '--field', '--input']);

/** An issue or pull request URL on GitHub, scheme and `www.` optional: its repository and number. */
const ITEM_URL = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)\/(?:issues|pull)\/([1-9][0-9]*)(?:[/?#].*)?$/iu;
/** An `owner/name` argument. */
const REPO_WORD = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u;
/** An issue or pull request number argument, `12` or `#12`. */
const NUMBER_WORD = /^#?([1-9][0-9]*)$/u;
/** A gh api path into a repository: `repos/<owner>/<name>[/<rest>]`, with gh's `{owner}`/`{repo}` placeholders. */
const API_REPO_PATH = /^\/?repos\/([^/?#]+)\/([^/?#]+)(\/[^?#]*)?/u;
/** A gh api path into a repository named by its id: `repositories/<id>[/<rest>]`. */
const API_ID_PATH = /^\/?repositories\/([0-9]+)(?:[/?#]|$)/u;
/** The API host's prefix of a full gh api URL, which gh takes as well as the bare path. */
const API_HOST = /^https?:\/\/api\.github\.com(?=\/)/iu;

/**
 * A repository word as `owner/name` in lower case, in each form gh takes it: `owner/name`, `github.com/owner/name`, a
 * URL (`https://`, `ssh://`, `git@github.com:`), with a trailing `.git` or `/`. Undefined for a repository on another
 * host, or a word that names none.
 */
function repoName(word: string): string | undefined {
  const bare = word
    .toLowerCase()
    .replace(/^(?:https?|ssh|git):\/\//u, '')
    .replace(/^git@/u, '')
    .replace(/^(?:www\.)?github\.com[/:]/u, '')
    .replace(/\/+$/u, '')
    .replace(/\.git$/u, '');
  return REPO_WORD.test(bare) ? bare : undefined;
}

/** The words of a gh call as text; a word known only when the line runs counts as unknown. */
type Words = readonly (string | undefined)[];

function wordsOf(args: readonly ShellWord[]): Words {
  return args.map((word) => (word.dynamic ? undefined : word.text));
}

/**
 * The value of option `long` (or `short`) in `words`: the next word after `-R x` / `--repo x`, the text after `--repo=x`
 * or `-Rx`. Given twice, the last one, as gh takes it. `undefined` for none, `null` for one known only when the line runs.
 * The value of another option of `valued` is skipped, so a body such as `--body "-Rebased"` is never read as one.
 */
function optionValue(words: Words, short: string | undefined, long: string, valued: ReadonlySet<string>): string | null | undefined {
  let value: string | null | undefined;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === undefined) {
      continue;
    }
    if (word === '--') {
      break;
    }
    if (word === long || word === short) {
      value = words[i + 1] ?? null;
      i++;
    } else if (valued.has(word)) {
      i++;
    } else if (word.startsWith(`${long}=`)) {
      value = word.slice(long.length + 1);
    } else if (short !== undefined && word.startsWith(short) && !word.startsWith('--') && word.length > short.length) {
      value = word.slice(short.length);
    }
  }
  return value;
}

/** Every value of option `long` (or `short`): `--add-label a --add-label b,c` gives `a`, `b,c`; another option's value of `valued` skipped. */
function optionValues(words: Words, short: string | undefined, long: string, valued: ReadonlySet<string>): string[] {
  const values: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === long || (short !== undefined && word === short)) {
      const next = words[i + 1];
      if (next !== undefined) {
        values.push(next);
      }
      i++;
    } else if (word !== undefined && valued.has(word)) {
      i++;
    } else if (word?.startsWith(`${long}=`) === true) {
      values.push(word.slice(long.length + 1));
    }
  }
  return values;
}

function hasOption(words: Words, names: readonly string[]): boolean {
  return words.some((word) => word !== undefined && names.some((name) => word === name || word.startsWith(`${name}=`)));
}

/** The words after the subcommand that are no option: a value after an option of `valued` is skipped. */
function positionals(words: Words, valued: ReadonlySet<string>): Words {
  const found: (string | undefined)[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word !== undefined && word.startsWith('-')) {
      if (valued.has(word)) {
        i++;
      }
      continue;
    }
    found.push(word);
  }
  return found;
}

/**
 * A group call's command and its other words: the first word after the group that is no option, as gh takes the
 * group's `-R`/`--repo` before the command too (`gh issue -R acme/web close 12`). The command is undefined when the call
 * names none, or one known only when the line runs.
 */
function commandOf(words: Words): { sub: string | undefined; rest: Words } {
  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    if (word === undefined || word === '--') {
      break;
    }
    if (word === '-R' || word === '--repo') {
      i++;
    } else if (!word.startsWith('-')) {
      return { sub: word, rest: [...words.slice(1, i), ...words.slice(i + 1)] };
    }
  }
  return { sub: undefined, rest: words.slice(1) };
}

/**
 * The repository a group call acts on: its `-R`/`--repo` in any form gh takes, else `named` (a repository argument),
 * else the folder's team remote. Undefined for a repository known only when the line runs, or one on another host.
 */
function repoOf(rest: Words, named: string | undefined, folderRepo: () => string | undefined): string | undefined {
  const flag = optionValue(rest, '-R', '--repo', ITEM_VALUED);
  if (flag === null) {
    return undefined;
  }
  if (typeof flag === 'string') {
    return repoName(flag);
  }
  return named ?? folderRepo();
}

/** Options of `gh issue` and `gh pr` commands that take a value, so their value is no positional. */
const ITEM_VALUED: ReadonlySet<string> = new Set([
  '-R', '--repo', '-b', '--body', '-F', '--body-file', '-t', '--title', '-l', '--label', '-a', '--assignee', '-m', '--milestone', '-p', '--project',
  '-c', '--comment', '-r', '--reason', '-B', '--base', '-H', '--head', '-s', '--state', '-L', '--limit', '-q', '--jq', '-T', '--template', '--json', '-S', '--search',
  '--add-label', '--remove-label', '--add-assignee', '--remove-assignee', '--add-project', '--remove-project', '--add-reviewer', '--remove-reviewer', '-A', '--author',
  '--duplicate-of', '--mention', '--app',
]);

/** The repository and number one issue or pull request argument names: a URL names both, a number only itself. */
function itemOf(word: string | undefined): { repo?: string; number?: number } {
  if (word === undefined) {
    return {};
  }
  const url = ITEM_URL.exec(word);
  if (url?.[1] !== undefined && url[2] !== undefined) {
    return { repo: url[1].toLowerCase(), number: Number(url[2]) };
  }
  const number = NUMBER_WORD.exec(word)?.[1];
  return number === undefined ? {} : { number: Number(number) };
}

/** A quoted label list as the label command takes it: `p1,bug`. */
function labelList(values: readonly string[]): string {
  return values.flatMap((value) => value.split(',')).map((label) => label.trim()).filter((label) => label !== '').join(',');
}

/** A word as a shell would need it in the reason's command: quoted when it holds anything but plain characters. */
function shellQuote(text: string): string {
  return /^[A-Za-z0-9_./:#,@%+=-]+$/u.test(text) ? text : `"${text.replace(/(["\\$`])/gu, '\\$1')}"`;
}

/**
 * `gh issue close --duplicate-of` as `teamrig issue close` takes it, `owner/name#n`: a URL names its own repository, a
 * number one in `repo`. Undefined for none, or one known only when the line runs.
 */
function duplicateOf(words: Words, repo: string): string | undefined {
  const value = optionValue(words, undefined, '--duplicate-of', ITEM_VALUED);
  if (typeof value !== 'string') {
    return undefined;
  }
  const item = itemOf(value);
  return item.number === undefined ? undefined : `${item.repo ?? repo}#${item.number}`;
}

/** The teamrig commands that take a `gh issue <sub>` or `gh pr <sub>` step on `target` (`acme/web#12`, or the repository). */
function itemCommands(group: string, sub: string, words: Words, repo: string, target: string): string[] {
  switch (sub) {
    case 'comment':
      return [`issue comment ${target} --body ${shellQuote(optionValue(words, '-b', '--body', ITEM_VALUED) ?? '<text>')}`];
    case 'close': {
      const comment = optionValue(words, '-c', '--comment', ITEM_VALUED);
      const duplicate = duplicateOf(words, repo);
      // gh closes a duplicate with the reason duplicate, whatever --reason says.
      const reason = duplicate === undefined ? optionValue(words, '-r', '--reason', ITEM_VALUED) : 'duplicate';
      return [
        `issue close ${target}${typeof comment === 'string' ? ` --comment ${shellQuote(comment)}` : ''}${typeof reason === 'string' ? ` --reason ${shellQuote(reason.replace(/\s+/gu, '-'))}` : ''}${duplicate === undefined ? '' : ` --duplicate-of ${duplicate}`}`,
      ];
    }
    case 'edit': {
      const commands: string[] = [];
      const add = labelList(optionValues(words, undefined, '--add-label', ITEM_VALUED));
      const remove = labelList(optionValues(words, undefined, '--remove-label', ITEM_VALUED));
      if (add !== '' || remove !== '') {
        commands.push(`issue label ${target}${add === '' ? '' : ` --add ${shellQuote(add)}`}${remove === '' ? '' : ` --remove ${shellQuote(remove)}`}`);
      }
      if (hasOption(words, ['-b', '--body', '-F', '--body-file'])) {
        commands.push(`issue edit ${target} --body-file <path>`);
      }
      return commands;
    }
    case 'create':
      return group === 'issue' ? [`add ... --issue "<public title>" --issue-body "<public text>" --issue-repo ${repo}`] : [];
    default:
      return [];
  }
}

/** The repository, the step and its commands of a `gh issue` or `gh pr` call; undefined when it names no repository. */
function itemStep(group: string, words: Words, folderRepo: () => string | undefined): GhStep | undefined {
  const { sub, rest } = commandOf(words);
  if (sub === undefined || PASSING_STEPS.get(group)?.has(sub) === true) {
    return undefined;
  }
  const item = itemOf(positionals(rest, ITEM_VALUED)[0]);
  const repo = repoOf(rest, item.repo, folderRepo);
  if (repo === undefined) {
    return undefined;
  }
  const target = item.number === undefined ? `${repo}#<n>` : `${repo}#${item.number}`;
  return { repo, shape: `gh ${group} ${sub}`, commands: itemCommands(group, sub, rest, repo, target) };
}

/** The method a gh api call sends: `-X`/`--method`, else POST with a body, else GET. */
function apiMethod(words: Words): string {
  const named = optionValue(words, '-X', '--method', API_VALUED);
  if (typeof named === 'string') {
    return named.toUpperCase();
  }
  return hasOption(words, [...API_BODY]) ? 'POST' : 'GET';
}

/** The field names a gh api call sends (`-f state=closed` gives `state`, an array's `-f labels[]=p1` gives `labels`). */
function apiFields(words: Words): string[] {
  return [...optionValues(words, '-f', '--raw-field', API_VALUED), ...optionValues(words, '-F', '--field', API_VALUED)].map((field) => (field.split('=')[0] ?? '').replace(/\[.*$/u, ''));
}

/** The teamrig commands that take a gh api write on a repository's path `rest` (`/issues/12/sub_issues`). */
function apiCommands(method: string, rest: string, words: Words, repo: string): string[] {
  const issue = /^\/issues\/([1-9][0-9]*)(\/.*)?$/u.exec(rest);
  const number = issue?.[1];
  const tail = issue?.[2] ?? '';
  if (number === undefined) {
    return method === 'POST' && rest === '/issues' ? [`add ... --issue "<public title>" --issue-body "<public text>" --issue-repo ${repo}`] : [];
  }
  const target = `${repo}#${number}`;
  if (/^\/(?:sub_issues|dependencies\/blocked_by)(?:\/|$)/u.test(tail)) {
    return [`issue links --repo ${repo}`];
  }
  if (tail === '/comments' && method === 'POST') {
    return [`issue comment ${target} --body <text>`];
  }
  if (/^\/labels(?:\/|$)/u.test(tail)) {
    return [`issue label ${target} --add <label,...> --remove <label,...>`];
  }
  if (tail === '' && method === 'PATCH') {
    const fields = apiFields(words);
    return [
      ...(fields.includes('labels') ? [`issue label ${target} --add <label,...> --remove <label,...>`] : []),
      ...(fields.includes('body') ? [`issue edit ${target} --body-file <path>`] : []),
      ...(fields.includes('state') ? [`issue close ${target}`] : []),
    ];
  }
  return [];
}

/** The repository, the step and its commands of a `gh api` call; undefined when its path is no repository's. */
function apiStep(words: Words, folderRepo: () => string | undefined): GhStep | undefined {
  const rest = words.slice(1);
  const path = positionals(rest, API_VALUED)[0]?.replace(API_HOST, '');
  if (path === undefined) {
    return undefined;
  }
  const method = apiMethod(rest);
  const byId = API_ID_PATH.exec(path)?.[1];
  if (byId !== undefined) {
    return API_READS.has(method) ? undefined : { repo: `repositories/${byId}`, shape: `gh api ${method} ${path.replace(/^\//u, '')}`, commands: [], byId: true };
  }
  const match = API_REPO_PATH.exec(path);
  const owner = match?.[1];
  const name = match?.[2];
  if (owner === undefined || name === undefined) {
    return undefined;
  }
  const tail = match?.[3] ?? '';
  if (API_READS.has(method)) {
    return undefined;
  }
  const placeholder = owner === '{owner}' || name === '{repo}';
  const repo = placeholder ? folderRepo() : `${owner}/${name}`.toLowerCase();
  if (repo === undefined) {
    return undefined;
  }
  return { repo, shape: `gh api ${method} repos/${repo}${tail}`, commands: apiCommands(method, tail, rest, repo) };
}

/** The repository and step of any other repository-bound gh call: `-R`, `gh repo <sub> <owner/name>`, else the folder's team remote. */
function groupStep(group: string, words: Words, folderRepo: () => string | undefined): GhStep | undefined {
  const { sub, rest } = commandOf(words);
  if (sub === undefined || PASSING_STEPS.get(group)?.has(sub) === true || (group === 'repo' && REPO_NOT_TARGET.has(sub))) {
    return undefined;
  }
  const named = group === 'repo' ? positionals(rest, ITEM_VALUED)[0] : undefined;
  const repo = repoOf(rest, named === undefined ? undefined : repoName(named), folderRepo);
  return repo === undefined ? undefined : { repo, shape: `gh ${group} ${sub}`, commands: [] };
}

/**
 * The step a gh call takes and the repository it acts on, from its words after `gh`; undefined for a call that names
 * no repository, or one whose repository is known only when the line runs. `folderRepo` is read only when the call takes
 * the repository from the folder.
 */
export function ghStepOf(args: readonly ShellWord[], folderRepo: () => string | undefined): GhStep | undefined {
  const words = wordsOf(args);
  const group = words[0];
  if (group === undefined) {
    return undefined;
  }
  if (group === 'api') {
    return apiStep(words, folderRepo);
  }
  if (group === 'issue' || group === 'pr') {
    return itemStep(group, words, folderRepo);
  }
  return REPO_GROUPS.has(group) ? groupStep(group, words, folderRepo) : undefined;
}

/** Why the calls are refused: per step, the teamrig command to run instead, or that none takes it yet. */
export function ghGuardReason(steps: readonly GhStep[], command: string): string {
  const repos = [...new Set(steps.filter((step) => step.byId !== true).map((step) => step.repo))].join(', ');
  const lines = steps.map((step) => {
    if (step.byId === true) {
      return `${step.shape}: names its repository by id, which ${command} cannot match to github.repos; name it as repos/<owner>/<name> instead.`;
    }
    if (step.commands.length === 0) {
      return `${step.shape}: no ${command} command takes this step yet; report the gap to your leader rather than running it another way.`;
    }
    return `${step.shape}: run ${step.commands.map((one) => `\`${command} ${one}\``).join(' and ')} instead.`;
  });
  const why =
    repos === ''
      ? `${command} gh guard: this team lists repositories under github.repos, and GitHub steps there go through ${command}'s commands. `
      : `${command} gh guard: ${repos} ${repos.includes(',') ? 'are' : 'is'} under github.repos, so GitHub steps there go through ${command}'s commands, on the key ${command} saves for the ` +
        `repository's owner and with their checks (secret scan, private data, stale writes); raw gh runs on your own login, which may not reach it. `;
  return `${why}${lines.join(' ')} [github.repos]`;
}

/** Each step once, in the order first found: a call both readings of a line make is named once. */
function uniqueSteps(steps: readonly GhStep[]): GhStep[] {
  const seen = new Set<string>();
  return steps.filter((step) => {
    const key = `${step.repo} ${step.shape} ${step.commands.join(' ')}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * The gh calls of one program list that act on a team repository. A call that takes its repository from the folder
 * acts on a team repository when any remote of the folder names one: gh may pick `upstream` or a set default over
 * `origin`, as in a fork's clone.
 */
function teamSteps(runs: readonly ProgramRun[], env: GhGuardEnv, repos: ReadonlySet<string>, fallback: string): GhStep[] {
  return runs.flatMap((run) => {
    if (run.name !== 'gh') {
      return [];
    }
    const step = ghStepOf(run.args, () => env.remotesOf(run.dir ?? fallback).find((remote) => repos.has(remote)));
    return step !== undefined && (step.byId === true || repos.has(step.repo)) ? [step] : [];
  });
}

/**
 * The PreToolUse output for a Bash or PowerShell call: a refusal when the line runs `gh` on a repository under
 * `github.repos`, naming the teamrig command for each step, or saying none takes it yet; else nothing, so the normal
 * permission flow decides. A team with no repositories listed, and a call that names none of them, pass. A Bash line
 * on Windows is read in each text bash may run (`toolCommandReadings`), naming each step once.
 */
export function ghGuardOutput(payload: unknown, env: GhGuardEnv): string {
  if (env.repos.length === 0 || !isRecord(payload)) {
    return '';
  }
  const command = stringField(recordField(payload, 'tool_input') ?? {}, 'command');
  // No text prefilter for `gh`: the shell reader alone decides which program a line runs, and a text match can disagree.
  if (command === undefined) {
    return '';
  }
  const tool = stringField(payload, 'tool_name');
  const cwd = stringField(payload, 'cwd') ?? env.cwd;
  const repos = new Set(env.repos.map((repo) => repo.toLowerCase()));
  const context = { cwd, home: env.home, dialect: tool === 'PowerShell' ? 'powershell' : 'bash' } as const;
  const steps = uniqueSteps(toolCommandReadings(tool, command, env.platform).flatMap((text) => teamSteps(programsOf(text, context), env, repos, cwd)));
  return steps.length === 0 ? '' : refusalOutput(ghGuardReason(steps, env.command));
}
