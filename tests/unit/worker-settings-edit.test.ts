import { describe, expect, it } from 'vitest';
import { COMPAT_DATE_RE, parseBindingInputs, toSdkBindings } from '../../src/lib/workerSettingsEdit';

describe('COMPAT_DATE_RE', () => {
  it('matches YYYY-MM-DD only', () => {
    expect(COMPAT_DATE_RE.test('2026-07-06')).toBe(true);
    expect(COMPAT_DATE_RE.test('2026-7-6')).toBe(false);
    expect(COMPAT_DATE_RE.test('20260706')).toBe(false);
    expect(COMPAT_DATE_RE.test('')).toBe(false);
  });
});

describe('parseBindingInputs', () => {
  it('accepts every supported kind', () => {
    const raw = [
      { kind: 'inherit', name: 'SECRET_A' },
      { kind: 'kv_namespace', name: 'KV', namespaceId: 'ns1' },
      { kind: 'd1', name: 'DB', databaseId: 'db1' },
      { kind: 'r2_bucket', name: 'BUCKET', bucketName: 'assets' },
      { kind: 'plain_text', name: 'MODE', text: 'prod' },
      { kind: 'json', name: 'CFG', json: '{"a":1}' },
      { kind: 'service', name: 'API', service: 'api-worker', environment: 'production' },
    ];
    expect(parseBindingInputs(raw)).toEqual(raw);
  });

  it('accepts service without environment', () => {
    expect(parseBindingInputs([{ kind: 'service', name: 'API', service: 'api-worker' }])).toEqual([
      { kind: 'service', name: 'API', service: 'api-worker' },
    ]);
  });

  it('rejects non-array, unknown kind, bad name, and missing target field', () => {
    expect(parseBindingInputs('nope')).toBeNull();
    expect(parseBindingInputs([{ kind: 'queue', name: 'Q', queue: 'q1' }])).toBeNull();
    expect(parseBindingInputs([{ kind: 'plain_text', name: '1bad', text: 'x' }])).toBeNull();
    expect(parseBindingInputs([{ kind: 'kv_namespace', name: 'KV' }])).toBeNull();
    expect(parseBindingInputs([{ kind: 'kv_namespace', name: 'KV', namespaceId: '' }])).toBeNull();
  });

  it('rejects a non-string environment on service', () => {
    expect(parseBindingInputs([{ kind: 'service', name: 'API', service: 's', environment: 7 }])).toBeNull();
  });

  it('rejects a json binding with non-parseable JSON value', () => {
    expect(parseBindingInputs([{ kind: 'json', name: 'CFG', json: 'not json' }])).toBeNull();
  });

  it('accepts inherit binding with names containing $ or other CF-legal chars', () => {
    expect(parseBindingInputs([{ kind: 'inherit', name: '$weird-name' }])).toEqual([
      { kind: 'inherit', name: '$weird-name' },
    ]);
  });
});

describe('toSdkBindings', () => {
  it('maps every kind to the SDK wire shape', () => {
    expect(
      toSdkBindings([
        { kind: 'inherit', name: 'SECRET_A' },
        { kind: 'kv_namespace', name: 'KV', namespaceId: 'ns1' },
        { kind: 'd1', name: 'DB', databaseId: 'db1' },
        { kind: 'r2_bucket', name: 'BUCKET', bucketName: 'assets' },
        { kind: 'plain_text', name: 'MODE', text: 'prod' },
        { kind: 'json', name: 'CFG', json: '{"a":1}' },
        { kind: 'service', name: 'API', service: 'api-worker', environment: 'production' },
      ]),
    ).toEqual([
      { type: 'inherit', name: 'SECRET_A' },
      { type: 'kv_namespace', name: 'KV', namespace_id: 'ns1' },
      { type: 'd1', name: 'DB', database_id: 'db1' },
      { type: 'r2_bucket', name: 'BUCKET', bucket_name: 'assets' },
      { type: 'plain_text', name: 'MODE', text: 'prod' },
      { type: 'json', name: 'CFG', json: { a: 1 } },
      { type: 'service', name: 'API', service: 'api-worker', environment: 'production' },
    ]);
  });

  it('omits environment when absent on service', () => {
    expect(toSdkBindings([{ kind: 'service', name: 'API', service: 's' }])).toEqual([
      { type: 'service', name: 'API', service: 's' },
    ]);
  });
});
