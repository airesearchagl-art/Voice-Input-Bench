import {
  BUILT_IN_TOOL_NAMES,
  isDeliveryPath,
  isSttToolId,
  type DeliveryPath,
  type SttToolId,
} from './tools';

/**
 * The tool and capture contract a stored Result must still satisfy.
 *
 * These fields are what a comparison is grouped by. If `tool.id` were taken on
 * faith, an edited Result could move an observation from one tool's column to
 * another's, and the matrix would attribute a transcript to a tool that never
 * produced it. So the identity is re-derived from the file and checked against
 * the same registry that wrote it.
 *
 * Split out from the rest of Result verification because the coverage matrix
 * needs to ask a narrower question: *can this tool identity be trusted?* — even
 * for a Result that failed verification for some other reason.
 */

export type ToolIdentityErrorKind =
  /** `tool` is missing, not an object, or its id is not a known tool. */
  | 'RESULT_TOOL_CONTRACT_MISMATCH'
  /** `capture.method` or `capture.delivery_path` is not what P2-A records. */
  | 'RESULT_CAPTURE_CONTRACT_MISMATCH'
  /** `captured_at` is missing or not a timestamp. */
  | 'RESULT_CAPTURED_AT_INVALID';

export class ToolIdentityError extends Error {
  readonly kind: ToolIdentityErrorKind;
  readonly detail?: string;

  constructor(kind: ToolIdentityErrorKind, message: string, detail?: string) {
    super(message);
    this.name = 'ToolIdentityError';
    this.kind = kind;
    this.detail = detail;
  }
}

export interface VerifiedToolIdentity {
  id: SttToolId;
  name: string;
  version: string | null;
  deliveryPath: DeliveryPath;
  capturedAt: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check the tool, capture and timestamp sections of a stored Result.
 *
 * Returns the identity when every field holds; throws otherwise. Callers that
 * only want to know whether the identity is trustworthy can catch and treat the
 * failure as "unattributable".
 */
export function verifyStoredToolIdentity(stored: Record<string, unknown>): VerifiedToolIdentity {
  const fail = (kind: ToolIdentityErrorKind, message: string, detail?: string): never => {
    throw new ToolIdentityError(kind, message, detail);
  };

  const capturedAt = stored.captured_at;
  if (typeof capturedAt !== 'string' || Number.isNaN(Date.parse(capturedAt))) {
    fail(
      'RESULT_CAPTURED_AT_INVALID',
      'captured_at が有効な日時ではありません。',
      `captured_at=${String(capturedAt)}`,
    );
  }

  const tool = stored.tool;
  if (!isPlainObject(tool)) {
    fail('RESULT_TOOL_CONTRACT_MISMATCH', 'tool セクションがありません。');
  }
  const toolNode = tool as Record<string, unknown>;

  const id = toolNode.id;
  if (!isSttToolId(id)) {
    fail(
      'RESULT_TOOL_CONTRACT_MISMATCH',
      `tool.id "${String(id)}" は既知の STT tool ではありません。`,
      `tool.id=${String(id)}`,
    );
  }
  const toolId = id as SttToolId;

  const name = toolNode.name;
  if (typeof name !== 'string') {
    fail('RESULT_TOOL_CONTRACT_MISMATCH', 'tool.name が文字列ではありません。');
  }
  const toolName = name as string;

  if (toolId === 'other') {
    if (toolName.trim().length === 0) {
      fail('RESULT_TOOL_CONTRACT_MISMATCH', 'tool.id が "other" ですが tool.name が空です。');
    }
  } else {
    // Built-in names are the registry's, not the file's. A Result claiming
    // `aqua-voice` under the Windows display name is not an Aqua observation.
    const expected = BUILT_IN_TOOL_NAMES[toolId];
    if (toolName !== expected) {
      fail(
        'RESULT_TOOL_CONTRACT_MISMATCH',
        `tool.name が tool.id "${toolId}" の登録名と一致しません。`,
        `expected=${expected} actual=${toolName}`,
      );
    }
  }

  const version = toolNode.version;
  if (version !== null) {
    if (typeof version !== 'string') {
      fail('RESULT_TOOL_CONTRACT_MISMATCH', 'tool.version が文字列でも null でもありません。');
    }
    const versionText = version as string;
    // Creation stores the trimmed form, or null when the field was blank.
    if (versionText.length === 0 || versionText !== versionText.trim()) {
      fail(
        'RESULT_TOOL_CONTRACT_MISMATCH',
        'tool.version が保存時の正規形（trim 済み・非空）ではありません。',
        `version=${JSON.stringify(versionText)}`,
      );
    }
  }

  const capture = stored.capture;
  if (!isPlainObject(capture)) {
    fail('RESULT_CAPTURE_CONTRACT_MISMATCH', 'capture セクションがありません。');
  }
  const captureNode = capture as Record<string, unknown>;

  if (captureNode.method !== 'manual-paste') {
    fail(
      'RESULT_CAPTURE_CONTRACT_MISMATCH',
      'capture.method が "manual-paste" ではありません。P2-A は手動 paste のみを記録します。',
      `method=${String(captureNode.method)}`,
    );
  }

  const deliveryPath = captureNode.delivery_path;
  if (!isDeliveryPath(deliveryPath)) {
    fail(
      'RESULT_CAPTURE_CONTRACT_MISMATCH',
      `capture.delivery_path "${String(deliveryPath)}" は既知の値ではありません。`,
    );
  }

  return {
    id: toolId,
    name: toolName,
    version: version === null ? null : (version as string),
    deliveryPath: deliveryPath as DeliveryPath,
    capturedAt: capturedAt as string,
  };
}

/** The tool id, when it can be trusted. `undefined` when it cannot. */
export function trustedToolIdOf(stored: unknown): SttToolId | undefined {
  if (!isPlainObject(stored)) return undefined;
  try {
    return verifyStoredToolIdentity(stored).id;
  } catch {
    return undefined;
  }
}
