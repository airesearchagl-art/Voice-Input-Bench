import type { DeliveryPath, SttToolId } from '@/results/tools';

/**
 * The capture metadata last used for each STT tool, for this screen only.
 *
 * A benchmark sweep records the same tools over and over, and the version and
 * delivery path do not change between two Results from the same tool. Keeping
 * the last accepted values per tool removes that retyping.
 *
 * What it deliberately does not do:
 *
 * - **It never holds a transcript.** The transcript is the observation; there
 *   is no version of this in which one Result's text is offered for another.
 *   The type has no field for it.
 * - **It never leaves memory.** No localStorage, no sessionStorage, no cookie,
 *   no server, no artifact, no config file — the profiles live in component
 *   state and are gone when the page is closed. Nothing here is evidence.
 * - **It only remembers what the server accepted.** A save that failed leaves
 *   the previous profile untouched; the caller records only on success.
 */

export interface CaptureProfile {
  /** Only meaningful for `other`; the built-in names are server-owned. */
  customToolName: string;
  toolVersion: string;
  deliveryPath: DeliveryPath;
}

export type CaptureProfiles = Partial<Record<SttToolId, CaptureProfile>>;

/**
 * The capture form as it starts, and what a tool with no profile returns to.
 *
 * One definition of "pristine", used twice: the component initialises its
 * fields from it, and switching to a tool that has never been saved resets to
 * it. Keeping both from the same constant is the point — a form default that
 * drifted from the reset default would be another way for one tool's metadata
 * to appear under a different tool's name.
 */
export const PRISTINE_CAPTURE: CaptureProfile = {
  customToolName: '',
  toolVersion: '',
  deliveryPath: 'speaker-to-mic',
};

/** The profile for one tool, or null when that tool has not been saved yet. */
export function recallCapture(profiles: CaptureProfiles, toolId: SttToolId): CaptureProfile | null {
  return profiles[toolId] ?? null;
}

/**
 * What the capture form should show for a tool.
 *
 * A tool with a profile restores its own last accepted metadata; a tool
 * without one gets the pristine form. There is deliberately no third answer.
 * "Leave whatever the previous tool had" is what let Aqua Voice's version and
 * delivery path be saved against Windows — metadata that was never true of the
 * tool the Result names, in an artifact that is write-once and cannot be
 * corrected, only superseded.
 *
 * Answering for every tool, rather than only for the ones with a profile, is
 * why this is a total function: there is no caller path that can skip the
 * reset by returning early.
 */
export function resolveCaptureForTool(
  profiles: CaptureProfiles,
  toolId: SttToolId,
): CaptureProfile {
  return recallCapture(profiles, toolId) ?? PRISTINE_CAPTURE;
}

/** Record what a successful save used. Returns a new map; the old one is untouched. */
export function rememberCapture(
  profiles: CaptureProfiles,
  toolId: SttToolId,
  profile: CaptureProfile,
): CaptureProfiles {
  return {
    ...profiles,
    [toolId]: {
      customToolName: profile.customToolName,
      toolVersion: profile.toolVersion,
      deliveryPath: profile.deliveryPath,
    },
  };
}
