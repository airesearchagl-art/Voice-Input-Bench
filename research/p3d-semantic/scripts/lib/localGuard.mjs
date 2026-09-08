/**
 * Loopback-only guard for the P3-D-A spike.
 *
 * Every model call in this research tree goes to a process on this machine.
 * That is not a preference: the probe corpus contains a customer's design
 * conversation, and the whole reason the bench is local-first is that transcript
 * text does not leave the machine it was captured on.
 *
 * So the guard is Fail Closed and it names the host it refused. Anything that is
 * not unambiguously loopback — including a name that merely *looks* local, and
 * including a DNS name that might resolve to loopback today — is rejected
 * rather than resolved and hoped about.
 */

export class NotLoopbackError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'NotLoopbackError';
    this.kind = 'ENDPOINT_NOT_LOOPBACK';
    this.detail = detail;
  }
}

/** The only hosts this spike will talk to. */
export const ALLOWED_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'];

/**
 * Is this hostname one of the three loopback forms?
 *
 * Exact matching only. `localhost.example.com` and `127.0.0.1.attacker.test`
 * both contain an allowed host as a substring and are both remote.
 */
export function isLoopbackHost(hostname) {
  if (typeof hostname !== 'string' || hostname.length === 0) return false;
  const host = hostname.toLowerCase();
  return ALLOWED_HOSTS.includes(host);
}

/**
 * Parse and check an endpoint, returning the URL when it is loopback.
 *
 * Throws {@link NotLoopbackError} otherwise. The caller never gets a URL it is
 * not allowed to fetch, so there is no path where a remote host is one missing
 * `if` away from being contacted.
 */
export function assertLoopbackEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new NotLoopbackError(`endpoint が URL として解釈できません: ${String(endpoint)}`, {
      endpoint: String(endpoint),
    });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NotLoopbackError(`endpoint の protocol が http/https ではありません: ${url.protocol}`, {
      endpoint: url.href,
      protocol: url.protocol,
    });
  }

  if (!isLoopbackHost(url.hostname)) {
    throw new NotLoopbackError(
      `endpoint が loopback ではありません: ${url.hostname}（許可: ${ALLOWED_HOSTS.join(' / ')}）`,
      { endpoint: url.href, hostname: url.hostname },
    );
  }

  return url;
}

/** `fetch`, but only to loopback. Same signature, one refusal. */
export async function loopbackFetch(endpoint, init) {
  const url = assertLoopbackEndpoint(endpoint);
  return fetch(url, init);
}
