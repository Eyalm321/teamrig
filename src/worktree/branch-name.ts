import type { BranchesConfig } from '../config/types.ts';
import { branchHint } from '../issues/ref.ts';
import type { ItemType } from '../register/events.ts';

/**
 * A new branch's name from its task (T2690), by the team's pattern (`delivery.branches`), so every branch and the
 * worktree folder named after it read the same way: `feat/t12-parser` by default, after Conventional Branch. The task id
 * starts a part of the name, which is what tells whose branch it is (owner.ts `branchTaskOf`).
 */

/** A new branch's name, which also names its folder: from a letter or digit, then letters, digits, `.`, `_`, `-` and `/`. */
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Why `branch` cannot name a new branch and its folder, or undefined when it can; git refuses what this lets through. */
export function branchNameProblem(branch: string): string | undefined {
  const bad =
    !BRANCH_NAME.test(branch) || ['..', '//', '/.'].some((part) => branch.includes(part)) || ['/', '.', '.lock'].some((end) => branch.endsWith(end));
  return bad ? 'expected a branch name: letters, digits, ., _, - and /, from a letter or digit, without .., // or a part that starts with ., and not ending in /, . or .lock' : undefined;
}

/** The placeholders a pattern may use. */
export const BRANCH_PLACEHOLDERS = ['type', 'id', 'issue', 'slug', 'session'] as const;
export type BranchPlaceholder = (typeof BRANCH_PLACEHOLDERS)[number];

/** A branch type: a lowercase word, such as `feat`, `fix`, `docs`, `chore`, `refactor`, `hotfix` or `release`. */
const BRANCH_TYPE = /^[a-z][a-z0-9]*$/;
/** A placeholder in a pattern, such as `{slug}`. */
const PLACEHOLDER = /\{([^{}]*)\}/g;

/** The words a pattern is filled with. */
export type BranchWords = { readonly [P in BranchPlaceholder]: string | undefined };

export type BranchName = { readonly kind: 'name'; readonly branch: string } | { readonly kind: 'refused'; readonly reason: string };

/** Whether `text` is a branch type `--type` and `delivery.branches.types` may give. */
export function isBranchType(text: string): boolean {
  return BRANCH_TYPE.test(text);
}

function isPlaceholder(text: string): text is BranchPlaceholder {
  return BRANCH_PLACEHOLDERS.some((name) => name === text);
}

/**
 * Why `pattern` cannot name branches, or undefined when it can: it uses only known placeholders, holds `{id}` once at
 * the start of a part (the start, or after a `/`) followed by `-`, `/` or its end, and filled with sample words makes
 * a branch name git takes.
 */
export function branchPatternProblem(pattern: string): string | undefined {
  const names = [...pattern.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');
  const unknown = names.find((name) => !isPlaceholder(name));
  if (unknown !== undefined) {
    return `{${unknown}} is no placeholder: use ${BRANCH_PLACEHOLDERS.map((name) => `{${name}}`).join(', ')}`;
  }
  if (names.filter((name) => name === 'id').length !== 1) {
    return 'needs {id} exactly once: the task id tells whose branch it is';
  }
  if (!/(?:^|\/)\{id\}(?:[-/]|$)/.test(pattern)) {
    return '{id} must start the pattern or follow a /, and be followed by -, / or the end';
  }
  const sample = fill(pattern, { type: 'feat', id: 't1', issue: '1', slug: 'a-b', session: 's' });
  const problem = branchNameProblem(sample);
  return problem === undefined ? undefined : `makes no branch name (${sample}): ${problem}`;
}

const LOWER = /[a-z]/;
const DIGIT = /[0-9]/;
const LOWER_OR_DIGIT = /[a-z0-9]/;
const SESSION_CHAR = /[a-z0-9-]/;

/** Where a run of `allowed` characters from `from` ends: `from` itself when there is none. */
function runEnd(text: string, from: number, allowed: RegExp): number {
  let at = from;
  while (at < text.length && allowed.test(text.charAt(at))) {
    at += 1;
  }
  return at;
}

/** Every end from `first` to `last`, both included; none when `first` is past `last`. */
function endsBetween(first: number, last: number): readonly number[] {
  return first > last ? [] : Array.from({ length: last - first + 1 }, (_, n) => first + n);
}

/** `first` matched at `at`, then any run of `rest`: every end after the first character. */
function headThenRun(text: string, at: number, first: RegExp, rest: RegExp): readonly number[] {
  return at < text.length && first.test(text.charAt(at)) ? endsBetween(at + 1, runEnd(text, at + 1, rest)) : [];
}

/** Lowercase words of letters and digits joined by single `-`s ({@link slugOf}): every end after a word's character. */
function slugEnds(text: string, at: number): readonly number[] {
  const ends: number[] = [];
  let word = at;
  while (word < text.length && LOWER_OR_DIGIT.test(text.charAt(word))) {
    const end = runEnd(text, word, LOWER_OR_DIGIT);
    ends.push(...endsBetween(word + 1, end));
    if (text.charAt(end) !== '-') {
      break;
    }
    word = end + 1;
  }
  return ends;
}

/**
 * Where each placeholder's word can end when it starts at `at`, as {@link taskBranchName} fills it: a branch type, the
 * task id in lowercase, an issue number, a slug, a session name (core/ids.ts).
 */
const PLACEHOLDER_ENDS: { readonly [P in BranchPlaceholder]: (text: string, at: number) => readonly number[] } = {
  type: (text, at) => headThenRun(text, at, LOWER, LOWER_OR_DIGIT),
  id: (text, at) => (text.charAt(at) === 't' ? headThenRun(text, at + 1, /[1-9]/, DIGIT) : []),
  issue: (text, at) => headThenRun(text, at, DIGIT, DIGIT),
  slug: slugEnds,
  session: (text, at) => headThenRun(text, at, LOWER, SESSION_CHAR),
};

/** A pattern as the parts a name must hold in order: text kept as written, or a placeholder's word. */
type PatternPart = { readonly text: string } | { readonly placeholder: BranchPlaceholder };

function partsOf(pattern: string): readonly PatternPart[] {
  const parts: PatternPart[] = [];
  let at = 0;
  for (const match of pattern.matchAll(PLACEHOLDER)) {
    const name = match[1] ?? '';
    parts.push({ text: pattern.slice(at, match.index) }, isPlaceholder(name) ? { placeholder: name } : { text: match[0] });
    at = match.index + match[0].length;
  }
  parts.push({ text: pattern.slice(at) });
  return parts;
}

/**
 * Whether `pattern` makes `branch`. It keeps the set of places in the name each part can end at, so it tries each split
 * between neighbouring placeholders once: a regex backtracks through every split of them, which grows as the name's
 * length to the power of their count (a long name that misses `{slug}-{slug}-{slug}` takes seconds).
 */
function patternMakes(pattern: string, branch: string): boolean {
  let places: ReadonlySet<number> = new Set([0]);
  for (const part of partsOf(pattern)) {
    const next = new Set<number>();
    for (const at of places) {
      if ('placeholder' in part) {
        PLACEHOLDER_ENDS[part.placeholder](branch, at).forEach((end) => next.add(end));
      } else if (branch.startsWith(part.text, at)) {
        next.add(at + part.text.length);
      }
    }
    places = next;
  }
  return places.has(branch.length);
}

/** A team's branch patterns: `pattern`, then each branch type's own, each once. */
export function branchPatternsOf(branches: BranchesConfig): readonly string[] {
  return [...new Set([branches.pattern, ...Object.values(branches.typePatterns)])];
}

/**
 * Why `branch` may not be made as a new branch, or undefined when it may (T1433): while `delivery.branches.enforce` is
 * on, its name must be one of the team's patterns makes, so a project never mixes branch styles. Only a new branch is
 * checked; branches already there keep their names, and every task-from-branch read stays owner.ts `branchTaskOf`,
 * whose rule is the one {@link branchPatternProblem} holds every pattern's `{id}` to.
 */
export function branchPatternRefusal(branch: string, branches: BranchesConfig): string | undefined {
  if (!branches.enforce) {
    return undefined;
  }
  const patterns = branchPatternsOf(branches);
  if (patterns.some((pattern) => patternMakes(pattern, branch))) {
    return undefined;
  }
  const sample = fill(branches.pattern, { type: branches.itemTypes.task, id: 't12', issue: '933', slug: 'parser', session: 'web' });
  const names = patterns.length === 1 ? `the branch pattern ${patterns[0]}` : `any of the branch patterns ${patterns.join(', ')}`;
  return `"${branch}" does not match ${names} (delivery.branches), such as ${sample}; delivery.branches.enforce false lets any name through`;
}

/** The branch `pattern` names for `words`; refused when it uses a word the task lacks, or makes no branch name. */
export function branchNameFor(pattern: string, words: BranchWords): BranchName {
  const patternProblem = branchPatternProblem(pattern);
  if (patternProblem !== undefined) {
    return { kind: 'refused', reason: `the branch pattern ${pattern} ${patternProblem}` };
  }
  const missing = [...pattern.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '').find((name) => isPlaceholder(name) && !words[name]);
  if (missing !== undefined) {
    return { kind: 'refused', reason: `the branch pattern ${pattern} names {${missing}}, which this task has none of: give a branch name instead` };
  }
  const branch = fill(pattern, words);
  const problem = branchNameProblem(branch);
  return problem === undefined ? { kind: 'name', branch } : { kind: 'refused', reason: `"${branch}": ${problem}` };
}

/** What a task's branch is named from. */
export interface BranchTask {
  /** Such as `T12`. */
  readonly id: string;
  readonly title: string;
  readonly owner: string;
  /** Such as `gh:acme/app#933`; null for none. */
  readonly ref: string | null;
  readonly itemType: ItemType;
  /** The work class the task counts as (register/focus.ts `classOf`). */
  readonly workClass: string;
}

/**
 * The branch `teamrig worktree add --task` makes for `task`: its branch type is `type` when given, else its work class's
 * in `branches.classes`, else its item type's; the pattern is that branch type's own, else `branches.pattern`.
 */
export function taskBranchName(task: BranchTask, branches: BranchesConfig, type: string | undefined): BranchName {
  const branchType = type ?? branches.classes[task.workClass] ?? branches.itemTypes[task.itemType];
  const pattern = branches.typePatterns[branchType] ?? branches.pattern;
  return branchNameFor(pattern, {
    type: branchType,
    id: task.id.toLowerCase(),
    issue: branchHint(task.ref),
    slug: slugOf(task.title, branches.slugMax),
    session: task.owner,
  });
}

/**
 * A title as a branch slug: lowercase letters and digits joined by `-`, task ids left out, cut at a `-` to at most
 * `max` characters; `work` when nothing is left.
 */
export function slugOf(title: string, max: number): string {
  const words = title
    .replace(/\bT\d+\b/g, ' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
  let slug = '';
  for (const word of words) {
    const next = slug === '' ? word : `${slug}-${word}`;
    if (next.length > max) {
      break;
    }
    slug = next;
  }
  return slug === '' ? (words[0]?.slice(0, max) ?? 'work') : slug;
}

function fill(pattern: string, words: BranchWords): string {
  return pattern.replace(PLACEHOLDER, (whole, name: string) => (isPlaceholder(name) ? (words[name] ?? '') : whole));
}
