import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { findGitInvocations } from './invocations.ts';

// Programs that run a command where the guard cannot read it (another host, a container, a terminal or
// multiplexer, later, in parallel), and code a later shell runs.

const CWD = resolve('/work/app');
const unset = { config: () => ({ kind: 'unset' as const }) };

/** `PUSH` when a push is found, `DOUBT` when the guard doubts, `pass` otherwise. */
function outcome(command: string): string {
  const found = findGitInvocations(command, { cwd: CWD, home: '/u', dialect: 'bash', git: unset });
  return found.invocations.some((invocation) => invocation.subcommand === 'push') ? 'PUSH' : found.doubts.length > 0 ? 'DOUBT' : 'pass';
}

const X = "'git push origin main'";

/** Each shape that hands X to a program the guard cannot read into: a doubt. */
const HANDS_X: readonly string[] = [
  'ssh host X',
  'ssh -p 22 host X',
  'watch -n1 X',
  'tmux new -d X',
  'tmux new-session -d X',
  'tmux send-keys X Enter',
  'screen -dm sh -c X',
  'xterm -e X',
  'gnome-terminal -- sh -c X',
  'parallel ::: X',
  'docker exec c sh -c X',
  'podman run img sh -c X',
  'kubectl exec p -- sh -c X',
  'awk \'BEGIN{system("git push")}\'',
  'at now <<< X',
  'echo X | at now',
  'crontab <<< X',
  'make -f /dev/stdin <<< X',
  'ssh host <<< X',
  'echo X >> ~/.bashrc',
  'echo X > /u/.profile',
  'tee -a ~/.zshrc <<< X',
  'PROMPT_COMMAND=X',
  'export BASH_ENV=X',
  'alias g=X',
  // the receiving shell puts a split word back together
  `ssh host 'git pu""sh origin main'`,
  `ssh host 'git p\\ush origin main'`,
  `ssh host 'x=pu; git \${x}sh origin main'`,
  `watch 'git pu""sh origin main'`,
  `tmux new -d 'git pu""sh origin main'`,
  `at now <<< 'git pu""sh origin main'`,
  `echo 'git pu""sh origin main' >> ~/.bashrc`,
  `alias g='git pu""sh origin main'`,
  `PROMPT_COMMAND='git pu""sh origin main'`,
  // later code beyond the classic startup files
  'echo X >> ~/.bash_aliases',
  'echo X > ~/.bashrc.d/x.sh',
  'echo X > /etc/profile.d/x.sh',
  'echo X >> ~/.config/fish/config.fish',
  'echo X > .git/hooks/pre-commit',
  'echo X > .envrc',
  // more runners
  'sshpass -p x ssh host X',
  'mosh host -- sh -c X',
  'toolbox run sh -c X',
  'distrobox enter box -- sh -c X',
  'podman machine ssh X',
  "make -E 'all:; git push origin main'",
  `awk '{system($0)}' <<< X`,
];

/** Shapes that stay as they were: X is data, or the program runs something else. */
const UNCHANGED: readonly (readonly [string, string])[] = [
  ['docker push registry/app:1', 'pass'],
  ['podman push app', 'pass'],
  ['kubectl get pods -o name', 'pass'],
  ["awk '/push/ {print $1}' notes.md", 'pass'],
  ['ssh host uptime', 'pass'],
  ['tmux new-session -d htop', 'pass'],
  ['watch -n1 git status', 'pass'],
  ['make push-docs', 'pass'],
  ['echo hi >> ~/.bashrc', 'pass'],
  ['echo X >> notes.md', 'pass'],
  ['PROMPT_COMMAND="history -a"', 'pass'],
  ["alias ll='ls -l'", 'pass'],
  ['gh issue create --body X', 'pass'],
  ['git commit -m X', 'pass'],
  ['export A=X', 'pass'],
  // the handed command is read, not searched for the word
  ["tmux send-keys -t lead 'echo push done' Enter", 'pass'],
  ["kubectl exec p -- cat /var/log/push.log", 'pass'],
  ["ssh host 'cat push-notes.md'", 'pass'],
  ["echo 'export PATH=$HOME/bin:$PATH' >> ~/.bashrc", 'pass'],
];

describe('findGitInvocations: programs that run a command the guard cannot read', () => {
  it('doubts each shape that hands such a program a push', () => {
    for (const shape of HANDS_X) {
      assert.equal(outcome(shape.replaceAll('X', X)), 'DOUBT', shape);
    }
  });

  it('leaves data and other commands as they were', () => {
    for (const [shape, expected] of UNCHANGED) {
      assert.equal(outcome(shape.replaceAll('X', X)), expected, shape);
    }
  });

  it('asks always when the command names a push, and only on a push line when a pipe feeds it', () => {
    const named = findGitInvocations(`ssh host ${X}`, { cwd: CWD, home: '/u', dialect: 'bash', git: unset });
    assert.deepEqual(named.doubts, [{ reason: 'it hands ssh a command that pushes, which ssh runs where the guard cannot read it', gated: false }]);
    const piped = findGitInvocations('cat jobs.txt | at now', { cwd: CWD, home: '/u', dialect: 'bash', git: unset });
    assert.deepEqual(piped.doubts, [{ reason: 'it pipes commands into at, which runs them where the guard cannot read them', gated: true }]);
  });
});
