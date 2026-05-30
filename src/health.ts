import { HealthStatus } from './types';
import { isLocalhostUrl } from './settings';

const HEALTH_TIMEOUT_MS = 2000;

export function validateHealthUrl(url: string): string | null {
  if (!url) return null;
  if (!isLocalhostUrl(url)) {
    return `Health URL rejected: must be localhost. Got: ${url}`;
  }
  return null;
}

export async function checkHealth(url: string): Promise<{ status: HealthStatus; error?: string }> {
  const validationError = validateHealthUrl(url);
  if (validationError) {
    return { status: 'unhealthy', error: validationError };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (response.status >= 200 && response.status < 400) {
      return { status: 'healthy' };
    }
    return { status: 'unhealthy', error: `HTTP ${response.status}` };
  } catch (e: unknown) {
    clearTimeout(timeout);
    const err = e as Error;
    const message = err.name === 'AbortError' ? 'Health check timed out' : err.message;
    return { status: 'unhealthy', error: message };
  }
}
