import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canReuseGeneratorToken, generatorConnectionFromSettings, readGeneratorConnection, writeGeneratorConnection,
} from '../src/generatorPreferences';

const key = 'entrain.generator.v1';
const connection = { url: 'https://generator.example', token: 'test-token' };
let entries: Map<string, string>;
let storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

beforeEach(() => {
  entries = new Map();
  storage = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: (key) => { entries.delete(key); },
  };
  vi.stubGlobal('window', { localStorage: storage });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('generator browser preferences', () => {
  it('restores the saved URL and token, and replaces them on an update', () => {
    expect(readGeneratorConnection()).toBeNull();
    expect(writeGeneratorConnection(connection)).toBe(true);
    expect(readGeneratorConnection()).toEqual(connection);
    const updated = { url: 'https://other.example/generator', token: 'new-token' };
    expect(writeGeneratorConnection(updated)).toBe(true);
    expect(readGeneratorConnection()).toEqual(updated);
    expect(entries.size).toBe(1);
  });

  it('disconnects without removing unrelated browser data', () => {
    entries.set('another-preference', 'keep');
    writeGeneratorConnection(connection);
    expect(writeGeneratorConnection(null)).toBe(true);
    expect(readGeneratorConnection()).toBeNull();
    expect(entries.has(key)).toBe(false);
    expect(entries.get('another-preference')).toBe('keep');
  });

  it('ignores malformed, incomplete, and unsafe saved connections', () => {
    for (const raw of ['{', 'null', '42', '[]', '"text"', '{}',
      JSON.stringify({ url: connection.url }),
      JSON.stringify({ url: 123, token: connection.token }),
      JSON.stringify({ url: connection.url, token: 123 }),
      JSON.stringify({ ...connection, token: '' }),
      JSON.stringify({ ...connection, token: 'bad\r\ntoken' }),
      ...['not a URL', 'http://generator.example', 'https://user:pass@generator.example',
        'https://generator.example?token=secret', 'https://generator.example#secret', 'javascript:alert(1)']
        .map((url) => JSON.stringify({ ...connection, url })),
    ]) {
      entries.set(key, raw);
      expect(readGeneratorConnection(), raw).toBeNull();
    }
  });

  it('normalizes stored settings and only accepts local HTTP in development', () => {
    entries.set(key, JSON.stringify({ url: ' https://GENERATOR.example:443/ ', token: ' test-token ' }));
    expect(readGeneratorConnection()).toEqual(connection);
    const local = { url: 'http://localhost:8000', token: '' };
    entries.set(key, JSON.stringify(local));
    expect(readGeneratorConnection()).toBeNull();
    expect(readGeneratorConnection(true)).toEqual(local);
  });

  it('handles browser storage being unavailable or blocked', () => {
    vi.stubGlobal('window', undefined);
    expect(readGeneratorConnection()).toBeNull();
    expect(writeGeneratorConnection(connection)).toBe(false);
    expect(writeGeneratorConnection(null)).toBe(false);
    vi.stubGlobal('window', { get localStorage() { throw new Error('Access denied'); } });
    expect(readGeneratorConnection()).toBeNull();
    expect(writeGeneratorConnection(connection)).toBe(false);
    expect(writeGeneratorConnection(null)).toBe(false);
  });

  it('reports read, save, and removal failures without throwing or changing the active settings', () => {
    writeGeneratorConnection(connection);
    vi.spyOn(storage, 'getItem').mockImplementation(() => { throw new Error('Unavailable'); });
    vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded'); });
    vi.spyOn(storage, 'removeItem').mockImplementation(() => { throw new Error('Unavailable'); });
    expect(readGeneratorConnection()).toBeNull();
    expect(writeGeneratorConnection({ ...connection, token: 'replacement' })).toBe(false);
    expect(writeGeneratorConnection(null)).toBe(false);
    expect(entries.get(key)).toBe(JSON.stringify(connection));
    expect(connection.token).toBe('test-token');
  });
});

describe('editing a saved generator connection', () => {
  it('keeps a hidden token when the normalized generator URL is unchanged', () => {
    const url = ' https://GENERATOR.example:443/// ';
    expect(canReuseGeneratorToken(url, connection)).toBe(true);
    expect(generatorConnectionFromSettings(url, ' ', connection)).toEqual(connection);
    expect(generatorConnectionFromSettings(connection.url, ' replacement-token ', connection))
      .toEqual({ ...connection, token: 'replacement-token' });
  });

  it('requires a token for a different host, port, protocol, or base path', () => {
    for (const url of ['https://other.example', 'https://generator.example:8443',
      'http://generator.example', 'https://generator.example/other', 'https://generator.example.evil.test',
      'https://user@generator.example', 'https://generator.example?token=x', 'https://generator.example#token',
      'not a URL']) {
      expect(canReuseGeneratorToken(url, connection)).toBe(false);
      expect(() => generatorConnectionFromSettings(url, '', connection)).toThrow();
    }
    expect(generatorConnectionFromSettings('https://other.example', 'other-token', connection))
      .toEqual({ url: 'https://other.example', token: 'other-token' });
    expect(generatorConnectionFromSettings('http://localhost:8000', '', connection, true))
      .toEqual({ url: 'http://localhost:8000', token: '' });
  });

  it('requires a new token after disconnect and keeps the existing local development default valid', () => {
    expect(canReuseGeneratorToken(connection.url, null)).toBe(false);
    expect(() => generatorConnectionFromSettings(connection.url, '', null)).toThrow('access token');
    const local = { url: 'http://localhost:8000', token: '' };
    expect(canReuseGeneratorToken(local.url, local)).toBe(false);
    expect(generatorConnectionFromSettings(local.url, '', local, true)).toEqual(local);
  });
});
