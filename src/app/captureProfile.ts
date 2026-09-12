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

/** The profile for one tool, or null when that tool has not been saved yet. */
export function recallCapture(profiles: CaptureProfiles, toolId: SttToolId): CaptureProfile | null {
  return profiles[toolId] ?? null;
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
