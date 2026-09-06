/**
 * STT tools a manual observation can come from.
 *
 * P2-A records what a human ran and pasted back; nothing here drives a tool.
 * There is deliberately no `STTProvider` interface yet — one Provider boundary
 * is earned by a second implementation, and manual capture is not one.
 */

export const STT_TOOL_IDS = ['windows-standard-voice-input', 'aqua-voice', 'other'] as const;

export type SttToolId = (typeof STT_TOOL_IDS)[number];

/**
 * Display names for the built-in tools are fixed server-side.
 *
 * If the caller could name them, two Results claiming
 * `windows-standard-voice-input` could carry different tool names and grouping
 * observations by tool would stop meaning anything.
 */
export const BUILT_IN_TOOL_NAMES = {
  'windows-standard-voice-input': 'Windows 標準音声入力',
  'aqua-voice': 'Aqua Voice',
} as const satisfies Record<Exclude<SttToolId, 'other'>, string>;

export const DELIVERY_PATHS = ['speaker-to-mic', 'virtual-audio', 'other', 'unknown'] as const;

export type DeliveryPath = (typeof DELIVERY_PATHS)[number];

export type ToolResolutionErrorKind =
  /** `toolId` is not one of {@link STT_TOOL_IDS}. */
  | 'UNKNOWN_TOOL_ID'
  /** `other` was selected without naming the tool. */
  | 'CUSTOM_TOOL_NAME_REQUIRED'
  /** A custom name was supplied for a tool whose name the server owns. */
  | 'CUSTOM_TOOL_NAME_NOT_ALLOWED'
  /** `deliveryPath` is not one of {@link DELIVERY_PATHS}. */
  | 'UNKNOWN_DELIVERY_PATH';

export class ToolResolutionError extends Error {
  readonly kind: ToolResolutionErrorKind;

  constructor(kind: ToolResolutionErrorKind, message: string) {
    super(message);
    this.name = 'ToolResolutionError';
    this.kind = kind;
  }
}

export function isSttToolId(value: unknown): value is SttToolId {
  return typeof value === 'string' && (STT_TOOL_IDS as readonly string[]).includes(value);
}

export function isDeliveryPath(value: unknown): value is DeliveryPath {
  return typeof value === 'string' && (DELIVERY_PATHS as readonly string[]).includes(value);
}

export interface ResolvedTool {
  id: SttToolId;
  name: string;
  version: string | null;
}

/** Trim a form field down to `null` when it carries nothing. */
function optionalField(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the tool identity recorded on a Result.
 *
 * `version` is free text because the operator is reading it off a real
 * application; `trim()` here only decides whether the field was filled in.
 */
export function resolveTool(input: {
  toolId: unknown;
  customToolName?: string | null;
  toolVersion?: string | null;
}): ResolvedTool {
  if (!isSttToolId(input.toolId)) {
    throw new ToolResolutionError(
      'UNKNOWN_TOOL_ID',
      `toolId "${String(input.toolId)}" は既知の STT tool ではありません。`,
    );
  }

  const customName = optionalField(input.customToolName);
  const version = optionalField(input.toolVersion);

  if (input.toolId === 'other') {
    if (!customName) {
      throw new ToolResolutionError(
        'CUSTOM_TOOL_NAME_REQUIRED',
        'toolId が "other" の場合は tool 名を入力してください。',
      );
    }
    return { id: 'other', name: customName, version };
  }

  if (customName) {
    throw new ToolResolutionError(
      'CUSTOM_TOOL_NAME_NOT_ALLOWED',
      `toolId "${input.toolId}" の名前はサーバー側で固定されています。customToolName は指定できません。`,
    );
  }

  return { id: input.toolId, name: BUILT_IN_TOOL_NAMES[input.toolId], version };
}

export function resolveDeliveryPath(value: unknown): DeliveryPath {
  if (!isDeliveryPath(value)) {
    throw new ToolResolutionError(
      'UNKNOWN_DELIVERY_PATH',
      `deliveryPath "${String(value)}" は既知の値ではありません。`,
    );
  }
  return value;
}
