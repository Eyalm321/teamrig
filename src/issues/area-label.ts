import type { LabelSpec } from './host.ts';

/** The colour of every area label teamrig makes: one for all areas, so they read as a set; it reads on light and dark alike. */
export const AREA_LABEL_COLOR = 'c2e0c6';

/** The description of every area label teamrig makes. */
export const AREA_LABEL_DESCRIPTION = 'Area: routes the issue to the session github.areaOwners names';

/**
 * An area label as teamrig makes it in a repository that lacks it: a label github.areaOwners names, in lowercase as the
 * config keeps it, with the one area colour and description, so a team can put its first area label on an issue.
 */
export function areaLabelSpec(name: string): LabelSpec {
  return { name, color: AREA_LABEL_COLOR, description: AREA_LABEL_DESCRIPTION };
}
