import type { ShellCommand, ShellWord } from './tokenizer.ts';

/**
 * bash arithmetic reads a name's value as an expression again, so `x='a[$(cmd)]'; echo $((x))` runs `cmd` and
 * `x='y=1'` assigns `y`. An arithmetic expansion is clear only when its text can do neither by itself and every
 * name it reads surely holds a whole number: see {@link plainArithmetic} and {@link countersHold}.
 */

/** Digits, names, blanks, parentheses and the operators of arithmetic that neither assigns nor reads text again. */
const PLAIN_TEXT = /^[\s\w+\-*/%<>&|^!~?:,()=]*$/;
/** A whole number as bash arithmetic reads one: decimal, octal or hex, never `BASE#` digits. */
const NUMBER = /^(?:\d+|0[xX][0-9a-fA-F]+)$/;
const NAME = /^[A-Za-z_]\w*$/;
/** The value text of an assignment that keeps a whole number: digits, or one arithmetic expansion. */
const WHOLE = /^\d+$/;
const EXPANSION = /^\$\(\(([^]*)\)\)$|^\$\[([^]*)\]$/;
/** Words that start a command ahead of its program: `do n=1`, `then read n`, `{ n=x; }`. */
const KEYWORDS: ReadonlySet<string> = new Set(['{', '}', 'do', 'then', 'else', 'elif', 'if', 'while', 'until', '!']);
/** `NAME=`, `NAME+=` or `NAME[` at a word's start. */
const ASSIGNMENT_LIKE = /^([A-Za-z_]\w*)(\[|\+?=)/;
/** Separators after which the next command surely runs next, in the same shell. */
const SEQUENCE = /^(?:[;\n]+|&&\n*)$/;
/**
 * Programs that can set a name in a way the line does not show as `NAME=value` (`read`, `declare`, `printf -v`),
 * or run code that can (`eval`, `source`, `trap`). One anywhere leaves every counter of the line unclear.
 */
const SETTERS: ReadonlySet<string> = new Set([
  ...['read', 'readarray', 'mapfile', 'getopts', 'let', 'declare', 'typeset', 'local', 'readonly', 'export', 'unset', 'wait'],
  ...['eval', 'source', '.', 'trap', 'command', 'builtin', 'enable', 'alias', 'select', 'coproc', 'function', 'fc', 'compgen', 'time'],
]);

/**
 * The names arithmetic text reads, when the text can neither assign (`=`, `+=`, `<<=`, `++`, `--`) nor read text
 * again past its names (`$`, quotes, a backtick, a subscript, `BASE#`); undefined otherwise. Its parentheses
 * must balance, as bash reads `$((a) )` as a command substitution.
 */
export function plainArithmetic(text: string): readonly string[] | undefined {
  if (!PLAIN_TEXT.test(text) || /\+\+|--|<<=|>>=/.test(text) || text.replace(/[=!<>]=/g, '').includes('=')) {
    return undefined;
  }
  let open = 0;
  for (const char of text) {
    open += char === '(' ? 1 : char === ')' ? -1 : 0;
    if (open < 0) {
      return undefined;
    }
  }
  if (open !== 0) {
    return undefined;
  }
  const names: string[] = [];
  for (const token of text.match(/\w+/g) ?? []) {
    if (NAME.test(token)) {
      names.push(token);
    } else if (!NUMBER.test(token)) {
      return undefined;
    }
  }
  return names;
}

/**
 * True when every name in `names`, read by plain arithmetic somewhere in `commands`, surely holds a whole number
 * whenever it is read. The line must first set it to digits in its leading binding statements (commands of static
 * unquoted `NAME=value` words alone, in the line's own shell, each surely run before the next); and every other
 * word anywhere that may assign it (`NAME=`, `NAME+=`, `NAME[`, an argument such as `echo NAME=x` too) must again
 * give digits or one plain arithmetic expansion of such names. A `for` loop over it, or any program in
 * {@link SETTERS} or one a variable names, leaves it unclear.
 */
export function countersHold(commands: readonly ShellCommand[], names: readonly string[]): boolean {
  if (names.length === 0) {
    return true;
  }
  const held = new Set<string>();
  for (const command of commands) {
    // A binding that a pipe, `&`, `||` or a `{ }` group's end follows may run in a subshell, or not at all.
    const set = SEQUENCE.test(command.terminator) ? leadingBinding(command) : undefined;
    if (set === undefined) {
      break;
    }
    set.forEach((name) => held.add(name));
  }
  if (!names.every((name) => held.has(name))) {
    return false;
  }
  const assignments: { readonly name: string; readonly word: ShellWord; readonly value: string | undefined }[] = [];
  for (const command of commands) {
    const first = command.words.findIndex((word) => word.dynamic || !KEYWORDS.has(word.text));
    const words = first === -1 ? [] : command.words.slice(first);
    const start = words.findIndex((word) => !ASSIGNMENT_LIKE.test(word.text));
    const program = words[start];
    if (program !== undefined && (program.dynamic || setsUnseen(program.text, words.slice(start + 1)))) {
      return false;
    }
    if (program?.text === 'for' && held.has(words[start + 1]?.text ?? '')) {
      return false;
    }
    for (const word of command.words) {
      const [whole, name, operator] = ASSIGNMENT_LIKE.exec(word.text) ?? [];
      if (whole !== undefined && name !== undefined && held.has(name)) {
        assignments.push({ name, word, value: operator === '=' ? word.text.slice(whole.length) : undefined });
      }
    }
  }
  // Each pass drops the names an assignment may leave without a whole number, until none does.
  for (let changed = true; changed; ) {
    changed = false;
    for (const { name, word, value } of assignments) {
      if (held.has(name) && (value === undefined || !keepsWhole(word, value, held))) {
        held.delete(name);
        changed = true;
      }
    }
  }
  return names.every((name) => held.has(name));
}

/**
 * The names a leading binding statement (static unquoted `NAME=value` words alone) sets to digits: undefined when
 * the command is anything else, sits in a subshell or substitution, or has a redirection, which may fail and skip
 * the assignment.
 */
function leadingBinding(command: ShellCommand): readonly string[] | undefined {
  if (command.words.length === 0 || command.subshells.length > 0 || command.nesting > 0 || command.redirections.length > 0) {
    return undefined;
  }
  const set: string[] = [];
  for (const word of command.words) {
    const head = word.parts?.[0];
    // An expansion's word keeps no quoting, so only a static word shows its name is unquoted.
    const name = !word.dynamic && head?.kind === 'text' && !head.quoted ? /^([A-Za-z_]\w*)=/.exec(head.text)?.[1] : undefined;
    if (name === undefined) {
      return undefined;
    }
    // Any other value only assigns; the check over every assignment then drops the name if it is one read.
    if (WHOLE.test(word.text.slice(name.length + 1))) {
      set.push(name);
    }
  }
  return set;
}

/**
 * True for an assigned value that is a whole number: digits, or, in a word with an expansion, one plain arithmetic
 * expansion reading only `held` names. A static word's `$((...))` is quoted text, never arithmetic.
 */
function keepsWhole(word: ShellWord, value: string, held: ReadonlySet<string>): boolean {
  if (WHOLE.test(value)) {
    return true;
  }
  const match = word.dynamic ? EXPANSION.exec(value) : null;
  const read = match === null ? undefined : plainArithmetic(match[1] ?? match[2] ?? '=');
  return read !== undefined && read.every((name) => held.has(name));
}

/** True for a program that can set a name unseen; `printf` only with `-v` or a format only known when it runs. */
function setsUnseen(program: string, args: readonly ShellWord[]): boolean {
  if (program === 'printf') {
    return args[0] !== undefined && (args[0].dynamic || args[0].text.startsWith('-'));
  }
  return SETTERS.has(program);
}
