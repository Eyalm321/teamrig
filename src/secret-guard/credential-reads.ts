import { SHIP_TOKEN, TOKEN_PREFIX } from '../github/tokens.ts';
import type { LineRuns, ProgramRun } from '../package-guard/programs.ts';
import type { SecretFinding } from './findings.ts';

/** A way a shell line reads a saved credential, and how the refusal names it. */
interface CredentialRead {
  readonly label: string;
  readonly pattern: RegExp;
  /** A name the store holds a key under, not an API that reads it: a search of tracked source for it reads no store. */
  readonly name?: true;
}

/**
 * The commands that read a credential out of the host's store, matched over a run's line (`<program> <args>`, the
 * program as the guards compare it, in lowercase). Each lookahead starts at the line's start, so a match costs time in
 * proportion to the line. A quiet run counts too: a session that only captures a key (`T=$(gh auth token)`) holds it
 * all the same. `cmdkey /list` and the macOS lookups without `-w` print only the entries' names, but they name what to
 * read next, and a case-ignored pattern cannot tell `-g` (print the password) from `-G` (a filter).
 */
const STORE_COMMANDS: readonly CredentialRead[] = [
  { label: 'git credential fill', pattern: /^git(?=\s)(?=[\s\S]*\scredential\s+fill(?:\s|$))/i },
  { label: 'git credential-<helper> get', pattern: /^git(?=\s)(?=[\s\S]*\scredential-[\w-]+\s+get(?:\s|$))/i },
  { label: 'git-credential-<helper> get', pattern: /^git-credential-[\w-]+(?=\s)(?=[\s\S]*\sget(?:\s|$))/i },
  { label: 'gh auth token', pattern: /^gh(?=\s)(?=[\s\S]*\sauth\s+token(?:\s|$))/i },
  { label: 'gh auth status --show-token', pattern: /^gh(?=\s)(?=[\s\S]*\sauth\s+status(?:\s|$))(?=[\s\S]*\s(?:-t|--show-token(?:=true)?)(?:\s|$))/i },
  { label: 'security find-*-password', pattern: /^security(?=\s)(?=[\s\S]*\s(?:find-(?:generic|internet)-password|dump-keychain)(?:\s|$))/i },
  { label: 'secret-tool lookup', pattern: /^secret-tool(?=\s)(?=[\s\S]*\s(?:lookup|search)(?:\s|$))/i },
  { label: 'cmdkey /list', pattern: /^cmdkey(?=\s)(?=[\s\S]*\s[/-]list(?::\S*)?(?:\s|$))/i },
  { label: 'vaultcmd /listcreds', pattern: /^vaultcmd(?=\s)(?=[\s\S]*\s[/-]listcreds(?::\S*)?(?:\s|$))/i },
  { label: 'keyring get', pattern: /^keyring(?=\s)(?=[\s\S]*\sget(?:\s|$))/i },
  { label: 'Get-Secret', pattern: /^get-secret(?:\s|$)/i },
];

/** A regular expression source that matches `text` as written. */
function literally(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * What a line reads a saved credential with wherever it stands, matched over the whole line: an API that inline code,
 * a PowerShell type or a script calls (`CredReadW`, `PasswordVault`, `keyring.get_password`, `keytar`), and the names
 * teamrig saves its GitHub tokens under, so no session reads or replaces another's key by name. Reading the whole line
 * finds them in a `node -e` script or a PowerShell `Add-Type` block the program reading never opens.
 */
const STORE_TEXTS: readonly CredentialRead[] = [
  { label: 'CredRead', pattern: /\bCred(?:Read|Enumerate)[AW]?\b/i },
  { label: 'PasswordVault', pattern: /\bPasswordVault\b/i },
  { label: 'Get-StoredCredential', pattern: /\bGet-StoredCredential\b/i },
  { label: 'keyring.get_password', pattern: /\bkeyring\.get_(?:password|credential)\b/i },
  { label: 'keytar', pattern: /\bkeytar\b/i },
  { label: `${TOKEN_PREFIX}<owner>`, pattern: new RegExp(`\\b${literally(TOKEN_PREFIX)}`, 'i'), name: true },
  { label: SHIP_TOKEN, pattern: new RegExp(`\\b${literally(SHIP_TOKEN)}\\b`, 'i'), name: true },
];

/** The git options allowed before `grep` that take the next word as their value; every other option refuses. */
const GIT_VALUE_OPTIONS = new Set(['-C', '--git-dir', '--work-tree']);

/** The git options allowed before `grep` that take no value, or their value after `=`. */
const GIT_PLAIN_OPTION = /^(?:--no-pager|-P|--git-dir=.*|--work-tree=.*)$/;

/**
 * True when `run` is a `git grep` that searches only the repository and starts nothing else (#1469). Before the
 * subcommand only the options above may stand (an allow-list: any other, such as one that turns the pager on or sets
 * config, refuses). After it: no `--no-index`, which searches any folder, no `-O`/`--open-files-in-pager`, which
 * starts a program on the files it finds (a short-option bundle holding `O` counts too), and no `--textconv`, which
 * starts the repository's configured converters.
 */
function repoSearch(run: ProgramRun): boolean {
  if (run.name !== 'git') return false;
  const args = run.args.map((arg) => arg.text);
  let at = 0;
  for (; at < args.length; at += 1) {
    const arg = args[at] ?? '';
    if (GIT_VALUE_OPTIONS.has(arg)) at += 1;
    else if (!arg.startsWith('-')) break;
    else if (!GIT_PLAIN_OPTION.test(arg)) return false;
  }
  if (args[at] !== 'grep') return false;
  return args
    .slice(at + 1)
    .every((arg) => arg !== '--no-index' && arg !== '--textconv' && !arg.startsWith('--open-files-in-pager') && !/^-[^-]*O/.test(arg));
}

/**
 * True when the line runs only repository searches (`repoSearch`) and nothing else: no command that starts no
 * program (a shell variable set alone), none whose program the walker cannot name, no shell fed from a pipe, and no
 * environment set for what it starts (`NAME=value git`, `env NAME=value git`), since the environment can name a
 * program git starts.
 */
function onlyRepoSearches(runs: LineRuns): boolean {
  return (
    runs.programs.length > 0 &&
    runs.programs.every(repoSearch) &&
    runs.bare.length === 0 &&
    runs.opaque.length === 0 &&
    runs.fedShells.length === 0 &&
    runs.foreignShells.length === 0 &&
    runs.envEdits.length === 0
  );
}

/**
 * The saved credentials a shell line reads: each run whose command reads the store, printed or not, then each store API
 * or teamrig credential name the line's text holds. Once the guard refuses these, a key saved for one tool draws a line
 * between sessions; until then any session could read every key its user saved. A credential name stands aside on a
 * line that runs only repository searches: it is text being looked for there, and a search of tracked files reads no
 * store.
 */
export function credentialReadFindings(command: string, runs: LineRuns): SecretFinding[] {
  const lines = runs.programs.map((run) => [run.name, ...run.args.map((arg) => arg.text)].join(' '));
  const byRun = STORE_COMMANDS.filter(({ pattern }) => lines.some((line) => pattern.test(line)));
  const onlySearches = onlyRepoSearches(runs);
  const byText = STORE_TEXTS.filter(({ pattern, name }) => !(name === true && onlySearches) && pattern.test(command));
  return [...byRun, ...byText].map(({ label }): SecretFinding => ({ kind: 'credential', via: label }));
}
