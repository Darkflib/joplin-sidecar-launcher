/**
 * Joplin Web Clipper authorisation flow.
 * https://joplinapp.org/help/dev/spec/clipper_auth/
 *
 * 1. POST /auth                       -> { auth_token }
 * 2. Joplin shows the user a grant dialog.
 * 3. GET /auth/check?auth_token=...   -> { status: waiting|accepted|rejected, token? }
 *    poll until accepted (token returned) or rejected/timeout.
 *
 * The resulting API token is a normal Joplin Data API token; the launcher stores
 * it in the secure (keychain) setting and injects it into the sidecar as
 * JOPLIN_TOKEN. It is never logged or included in diagnostics.
 */

export interface AuthResult {
  ok: boolean;
  token?: string;
  message: string;
}

interface PollOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

export async function authoriseJoplinToken(
  baseUrl: string,
  opts: PollOptions = {},
): Promise<AuthResult> {
  const base = baseUrl.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 1_000;

  let authToken: string;
  try {
    const resp = await fetch(`${base}/auth`, { method: 'POST' });
    if (!resp.ok) {
      return {
        ok: false,
        message: `Joplin /auth returned HTTP ${resp.status}. Enable Tools > Options > Web Clipper.`,
      };
    }
    const body = (await resp.json()) as { auth_token?: string };
    if (!body.auth_token) {
      return { ok: false, message: 'Joplin did not return an auth_token.' };
    }
    authToken = body.auth_token;
  } catch (e) {
    return {
      ok: false,
      message:
        `Could not reach Joplin at ${base}. Enable Tools > Options > Web Clipper and check the ` +
        `base URL. (${(e as Error).message})`,
    };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const resp = await fetch(`${base}/auth/check?auth_token=${encodeURIComponent(authToken)}`);
      const body = (await resp.json()) as { status?: string; token?: string };
      if (body.status === 'accepted' && body.token) {
        return { ok: true, token: body.token, message: 'Authorised.' };
      }
      if (body.status === 'rejected') {
        return { ok: false, message: 'Authorisation was rejected in Joplin.' };
      }
      // 'waiting' — keep polling.
    } catch {
      // Transient error mid-poll — keep trying until the deadline.
    }
  }
  return { ok: false, message: 'Timed out waiting for approval in Joplin.' };
}
