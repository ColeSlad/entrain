import { generatorConnection, type GeneratorConnection } from './api';

const STORAGE_KEY = 'entrain.generator.v1';

export function readGeneratorConnection(allowLocal = false): GeneratorConnection | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!value || typeof value !== 'object' || !('url' in value) || !('token' in value) ||
      typeof value.url !== 'string' || typeof value.token !== 'string') return null;
    return generatorConnection(value.url, value.token, allowLocal);
  } catch {
    // Invalid or unavailable browser storage must not prevent the app from opening.
    return null;
  }
}

// Call only after a successful connection check, or with null to forget it.
// A blocked/full storage area must still allow a connection for this session.
export function writeGeneratorConnection(connection: GeneratorConnection | null): boolean {
  try {
    if (connection) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ url: connection.url, token: connection.token }));
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
    return true;
  } catch {
    return false;
  }
}

export function canReuseGeneratorToken(url: string, current: GeneratorConnection | null): boolean {
  if (!current?.token) return false;
  try {
    return new URL(url.trim()).href.replace(/\/+$/, '') === current.url;
  } catch {
    return false;
  }
}

export function generatorConnectionFromSettings(
  url: string, token: string, current: GeneratorConnection | null, allowLocal = false,
): GeneratorConnection {
  // Never carry a saved token to a different host or base path.
  const secret = token.trim() || (canReuseGeneratorToken(url, current) ? current!.token : '');
  return generatorConnection(url, secret, allowLocal);
}
