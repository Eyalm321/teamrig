import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { findGitInvocations } from './invocations.ts';

// Programs that run a word of theirs as a shell command, or the command after their options.

const CWD = resolve('/work/app');
const unset = { config: () => ({ kind: 'unset' as const }) };

/** `PUSH` when a push is found, `DOUBT` when the guard doubts, `pass` otherwise. */
function outcome(command: string): string {
  const found = findGitInvocations(command, { cwd: CWD, home: '/u', dialect: 'bash', git: unset });
  return found.invocations.some((invocation) => invocation.subcommand === 'push') ? 'PUSH' : found.doubts.length > 0 ? 'DOUBT' : 'pass';
}

const X = "'git push origin main'";

/** Each launcher shape that runs X: the guard reads X as the line's own commands. */
const RUNS_X: readonly string[] = [
  'su -c X',
  'su - root -c X',
  'runuser -u u -- sh -c X',
  'runuser u -c X',
  'flock /tmp/l -c X',
  'flock /tmp/l sh -c X',
  "find . -exec sh -c X ';'",
  'find . -exec bash -c X {} +',
  "find . -execdir sh -c X ';'",
  'script -qc X /dev/null',
  'script --command X /dev/null',
  'systemd-run --user sh -c X',
  'systemd-run --user -p Nice=5 sh -c X',
  'nsenter -t 1 sh -c X',
  'chroot / sh -c X',
  'unshare sh -c X',
  'setpriv sh -c X',
  'trap X EXIT',
  'entr -n sh -c X <<< f',
  'entr -rz -- sh -c X <<< f',
  'entr -s X <<< f',
  'entr -ns X <<< f',
  'strace -f -o /dev/null sh -c X',
  'ltrace -f sh -c X',
  'taskset 1 sh -c X',
  'taskset -c 0-3 sh -c X',
  'chrt 1 sh -c X',
  'chrt -f 10 sh -c X',
];

/** Shapes that stay as they were: X is data, or the program runs something else. */
const UNCHANGED: readonly (readonly [string, string])[] = [
  ['gh issue create --body X', 'pass'],
  ['git commit -m X', 'pass'],
  ["find . -name '*.push' -print", 'pass'],
  ["trap 'rm -f /tmp/x' EXIT", 'pass'],
  ['trap - EXIT', 'pass'],
  ['trap -p', 'pass'],
  ['script -q /dev/null', 'pass'],
  ['su -', 'pass'],
  ['flock /tmp/l make build', 'pass'],
  ['entr -c make test <<< f', 'pass'],
  ['entr <<< f', 'pass'],
  ['taskset -p 1234', 'pass'],
  ['chrt -p 1234', 'pass'],
  ['strace -c ls', 'pass'],
  ['sudo -u u sh -c X', 'PUSH'],
  ['eval X', 'PUSH'],
];

describe('findGitInvocations: programs that run a word or the command after their options', () => {
  it('reads the command each launcher runs', () => {
    for (const shape of RUNS_X) {
      assert.equal(outcome(shape.replaceAll('X', X)), 'PUSH', shape);
    }
  });

  it('leaves data and other programs as they were', () => {
    for (const [shape, expected] of UNCHANGED) {
      assert.equal(outcome(shape.replaceAll('X', X)), expected, shape);
    }
  });

  it('reads the -c command su, runuser, flock and script run, in their folder', () => {
    const found = findGitInvocations("su -c 'git status' && flock /tmp/l -c 'git log -1'", { cwd: CWD, home: '/u', dialect: 'bash', git: unset });
    assert.deepEqual(
      found.invocations.map((invocation) => `${invocation.dir ?? '?'}|${invocation.subcommand}`),
      [`${CWD}|status`, `${CWD}|log`],
    );
    assert.deepEqual(found.doubts, []);
  });

  it('reads -c as each program reads it: attached, after a valued letter, before the first operand, by prefix', () => {
    const G = 'git push origin main';
    const shapes = [
      `flock /tmp/l git -c a.b=c ${G.slice(4)}`,
      `flock -n /tmp/l git -C . -c a.b=c ${G.slice(4)}`,
      `runuser -ucarl ${G}`,
      `script -c'${G}' /dev/null`,
      `script -qc'${G}' /dev/null`,
      `script -Tcx -c ${X} /dev/null`,
      `su -c'${G}' u`,
      `su --comm ${X} u`,
      `su -- root -c ${X}`,
      `su root -- -c ${X}`,
    ];
    for (const shape of shapes) {
      assert.equal(outcome(shape), 'PUSH', shape);
    }
    assert.equal(outcome('flock /tmp/l gcc -c x.c'), 'pass');
    // runuser's getopt takes this -c as its own, and refuses it beside -u.
    assert.equal(outcome(`runuser -u u git -c x=y ${G.slice(4)}`), 'DOUBT');
    assert.equal(outcome(`runuser -u u -- ${G}`), 'PUSH');
  });

  it('reads a wrapper long option by its unique prefix, and asks on one it does not know', () => {
    const G = 'git push origin main';
    const shapes = [
      `nsenter -t 1 -Z ${G}`,
      `nsenter -t 1 -W/x ${G}`,
      `nsenter --tar 1 ${G}`,
      `unshare --map-u 0 ${G}`,
      `setpriv --reu 1000 ${G}`,
      `chroot --user u / ${G}`,
      `flock --time 5 /tmp/l ${G}`,
      `systemd-run --uni x ${G}`,
      `systemd-run --capsule x ${G}`,
      `strace --trace execve ${G}`,
      `strace --signal none ${G}`,
      `strace --outp f ${G}`,
      `strace -U name ${G}`,
      `ltrace --out f ${G}`,
      `runuser --us u ${G}`,
      `timeout --sig KILL 5 ${G}`,
      `sudo --us u ${G}`,
      `nice --no-such-option 5 ${G}`,
      `nice -5 ${G}`,
      `timeout -v --sig KILL 5 ${G}`,
    ];
    for (const shape of shapes) {
      assert.notEqual(outcome(shape), 'pass', shape);
    }
    for (const shape of ['nsenter --mount git status', 'timeout --preserve-status 5 make', 'strace --follow-forks ls', 'sudo --non-interactive ls']) {
      assert.equal(outcome(shape), 'pass', shape);
    }
  });

  it('doubts a find that runs more than one command, and a -c command only known when it runs', () => {
    assert.equal(outcome(`find . -exec true ';' -exec sh -c ${X} ';'`), 'DOUBT');
    assert.equal(outcome('su -c "$CMD"'), 'DOUBT');
    assert.equal(outcome('flock /tmp/l -c'), 'DOUBT');
  });
});
