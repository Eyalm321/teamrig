import type { TimeZone } from '../core/zone.ts';
import { lineOnClock, type InboxDeps } from './inbox.ts';
import { errorMessage } from '../core/guards.ts';
import { lineHash } from './line-hash.ts';
import { indexMarks, MARK_VERSION, type InboxMark } from './marks.ts';
import { cutWhenShown, INJECT_CAPS, newestShownOf, unshownOf, type InjectCaps } from './shown.ts';
import { unreadOf } from './unread.ts';

/**
 * The prompt hook puts a session's new inbox lines into its prompt, so each line reaches the session
 * inside a turn that happens anyway, instead of a count that costs a turn of its own to read. Each
 * line is shown once per Claude Code session (shown.ts keeps track). A line shown whole is also marked read, so
 * the unread counts (`inbox status`, doctor, the pane) stop counting it (#1401); a line cut to the character cap,
 * and every line after it, stays unread until `inbox read` prints it whole.
 */

/** The first lines within the caps: one at least, cut to the character cap when it alone is longer. */
export function fitLines(pending: readonly string[], caps: InjectCaps): string[] {
  const out: string[] = [];
  let chars = 0;
  for (const line of pending) {
    if (out.length === caps.maxLines || (out.length > 0 && chars + line.length > caps.maxChars)) {
      break;
    }
    out.push(cutWhenShown(line, caps) ? `${line.slice(0, caps.maxChars)}…` : line);
    chars += line.length;
  }
  return out;
}

/** The hook's text for one prompt, the shown mark to record with it, and the read mark when lines were shown whole. */
export interface Injection {
  readonly text: string;
  readonly shown: InboxMark;
  /**
   * Marks the unread lines read up to the first one not yet shown whole; null when none is. It names no Claude Code
   * session, so it moves the read position only and never binds the tab (marks.ts `indexMarks`).
   */
  readonly read: InboxMark | null;
}

export interface InjectionInput {
  readonly area: string;
  /** Where the area's inbox lives, named in the header. */
  readonly path: string;
  readonly lines: readonly string[];
  readonly read: InboxMark | null;
  readonly shown: InboxMark | null;
  readonly claudeSession: string;
  readonly now: Date;
  /** The team's clock, which the lines' times are shown on. */
  readonly zone: TimeZone;
  readonly command: string;
}

/** The lines to show at this prompt, with the mark that records them; undefined when nothing new waits. */
export function injectionOf(input: InjectionInput, caps: InjectCaps = INJECT_CAPS): Injection | undefined {
  const unshown = unshownOf(input.area, input.lines, input.read, input.shown, lineHash);
  const onClock = unshown.map((line) => lineOnClock(line, input.zone));
  const fitted = fitLines(onClock, caps);
  if (fitted.length === 0) {
    return undefined;
  }
  const through = input.lines.length - unshown.length + fitted.length;
  const last = input.lines[through - 1];
  const more = unshown.length - fitted.length;
  const readAll = `${input.command} inbox read --session ${input.area}`;
  const cut = fitted.some((line, index) => line !== onClock[index]);
  const text = [
    `INBOX ${input.area}, new in ${input.path} (each line is shown once, and marked read when shown whole):`,
    ...fitted,
    ...(cut ? [`The line above was cut at ${caps.maxChars} characters; \`${readAll}\` prints it whole.`] : []),
    ...(more > 0 ? [`+${more} more at your next prompt, or all now with: ${readAll}`] : []),
  ];
  const shown: InboxMark = {
    v: MARK_VERSION,
    area: input.area,
    line: through,
    at: input.now.toISOString(),
    claudeSession: input.claudeSession,
    lastLineHash: last === undefined ? null : lineHash(last),
  };
  return { text: text.join('\n'), shown, read: readMarkOf(input, unshown, fitted, onClock) };
}

/**
 * The read mark through the unread lines this Claude Code session has now seen whole, from the first: those shown at
 * earlier prompts (the unread lines before `unshown`), then those fitted now, up to the first one cut to the character
 * cap. Null when the first unread line was cut.
 */
function readMarkOf(input: InjectionInput, unshown: readonly string[], fitted: readonly string[], onClock: readonly string[]): InboxMark | null {
  const unread = unreadOf(input.area, input.lines, input.read, lineHash).lines;
  const earlier = unread.slice(0, unread.length - unshown.length).map((line) => lineOnClock(line, input.zone));
  const cutEarlier = earlier.findIndex((line) => cutWhenShown(line));
  const cutNow = fitted.findIndex((line, index) => line !== onClock[index]);
  const whole = cutEarlier !== -1 ? cutEarlier : earlier.length + (cutNow === -1 ? fitted.length : cutNow);
  if (whole === 0) {
    return null;
  }
  const through = input.lines.length - unread.length + whole;
  const last = input.lines[through - 1];
  return { v: MARK_VERSION, area: input.area, line: through, at: input.now.toISOString(), claudeSession: null, lastLineHash: last === undefined ? null : lineHash(last) };
}

/**
 * The new lines of `area`'s inbox for this prompt, recorded as shown before they are handed back: when
 * the record fails this throws, so a line is never shown twice for want of its record. Those shown whole are then
 * marked read; when that mark fails the lines are still handed back, with a note that they stay unread. Undefined
 * when the area has no inbox or nothing new.
 */
export async function injectFor(
  deps: InboxDeps,
  input: { readonly area: string; readonly claudeSession: string; readonly now: Date; readonly zone: TimeZone; readonly command: string },
): Promise<string | undefined> {
  const lines = await deps.inboxes.lines(input.area);
  if (lines === undefined) {
    return undefined;
  }
  const { byArea } = indexMarks((await deps.marks.read()).marks);
  const shown = newestShownOf((await deps.shown.read()).marks, input.area, input.claudeSession);
  const injection = injectionOf({ ...input, path: deps.inboxes.pathOf(input.area), lines, read: byArea.get(input.area) ?? null, shown });
  if (injection === undefined) {
    return undefined;
  }
  await deps.shown.append(injection.shown);
  const unread = await markShownRead(deps, input.area, lines, injection.read).catch((error: unknown) => errorMessage(error));
  return unread === undefined ? injection.text : `${injection.text}\n${unreadNote(input, unread)}`;
}

/**
 * Writes the hook's read mark, unless a read since this prompt began (`inbox read`, another prompt) already went as
 * far: marks are appended and the newest wins, so a late mark behind it would make read lines unread again.
 */
async function markShownRead(deps: InboxDeps, area: string, lines: readonly string[], read: InboxMark | null): Promise<undefined> {
  if (read === null) {
    return undefined;
  }
  const now = indexMarks((await deps.marks.read()).marks).byArea.get(area) ?? null;
  if (lines.length - unreadOf(area, lines, now, lineHash).lines.length < read.line) {
    await deps.marks.append(read);
  }
  return undefined;
}

/** The line under the shown lines when their read mark could not be written: they stay unread, and how to read them. */
function unreadNote(input: { readonly area: string; readonly command: string }, why: string): string {
  return `These lines stay unread: their read mark could not be written (${why}); \`${input.command} inbox read --session ${input.area}\` marks them read.`;
}
