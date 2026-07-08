import { describe, expect, it } from 'vitest';
import { isHostname, isIPv4, isIPv6, isRecordName, validateDnsRecord } from '../../src/lib/dnsRecordValidation';

describe('isIPv4', () => {
  it.each(['1.2.3.4', '0.0.0.0', '255.255.255.255', '192.168.001.1'])('accepts %s', (ip) => {
    expect(isIPv4(ip)).toBe(true);
  });

  it.each(['256.1.1.1', '1.2.3', '1.2.3.4.5', 'a.b.c.d', '1.2.3.-4', '1.2.3.4 ', '', '1..2.3'])('rejects %s', (ip) => {
    expect(isIPv4(ip)).toBe(false);
  });
});

describe('isIPv6', () => {
  it.each([
    '2001:db8:85a3:0:0:8a2e:370:7334',
    '2001:db8:85a3::8a2e:370:7334',
    '::1',
    '::',
    'fe80::',
    '::ffff:192.0.2.1',
    '2001:DB8::1',
  ])('accepts %s', (ip) => {
    expect(isIPv6(ip)).toBe(true);
  });

  it.each([
    '1.2.3.4',
    '2001:db8:85a3:0:0:8a2e:370', // 7 组无压缩
    '2001:db8:85a3:0:0:8a2e:370:7334:aaaa', // 9 组
    '2001::db8::1', // 两处 ::
    'g001:db8::1', // 非十六进制
    '2001:db8:::1',
    '',
    '::ffff:999.0.2.1', // 内嵌 IPv4 非法
  ])('rejects %s', (ip) => {
    expect(isIPv6(ip)).toBe(false);
  });
});

describe('isHostname / isRecordName', () => {
  it.each([
    'example.com',
    'mail.example.com.',
    'xn--fiq228c.cn',
    'a',
    'k1._domainkey.mailer.com',
  ])('accepts hostname %s', (h) => {
    expect(isHostname(h)).toBe(true);
  });

  it.each([
    '-bad.com',
    'bad-.com',
    'ex ample.com',
    '',
    '.',
    'a..b',
    `${'x'.repeat(64)}.com`,
  ])('rejects hostname %s', (h) => {
    expect(isHostname(h)).toBe(false);
  });

  it('record name additionally accepts @ and wildcards', () => {
    expect(isRecordName('@')).toBe(true);
    expect(isRecordName('*')).toBe(true);
    expect(isRecordName('*.example.com')).toBe(true);
    expect(isRecordName('www')).toBe(true);
    expect(isRecordName('*.')).toBe(false);
    expect(isRecordName('a b')).toBe(false);
  });
});

describe('validateDnsRecord', () => {
  const base = { name: 'www', ttl: 1 };

  it('A record requires IPv4 content', () => {
    expect(validateDnsRecord({ ...base, type: 'A', content: '1.2.3.4' })).toBeNull();
    expect(validateDnsRecord({ ...base, type: 'A', content: 'example.com' })).toBe('ipv4');
    expect(validateDnsRecord({ ...base, type: 'A', content: '::1' })).toBe('ipv4');
  });

  it('AAAA record requires IPv6 content', () => {
    expect(validateDnsRecord({ ...base, type: 'AAAA', content: '2001:db8::1' })).toBeNull();
    expect(validateDnsRecord({ ...base, type: 'AAAA', content: '1.2.3.4' })).toBe('ipv6');
  });

  it('CNAME / NS require hostname content', () => {
    expect(validateDnsRecord({ ...base, type: 'CNAME', content: 'target.example.com' })).toBeNull();
    expect(validateDnsRecord({ ...base, type: 'CNAME', content: 'not a host' })).toBe('hostname');
    expect(validateDnsRecord({ ...base, type: 'NS', content: 'ns1.example.com' })).toBeNull();
    expect(validateDnsRecord({ ...base, type: 'NS', content: '1.2.3.4 extra' })).toBe('hostname');
  });

  it('MX requires hostname content and integer priority 0-65535', () => {
    const mx = { ...base, type: 'MX', content: 'mail.example.com' };
    expect(validateDnsRecord({ ...mx, priority: 10 })).toBeNull();
    expect(validateDnsRecord({ ...mx, priority: 0 })).toBeNull();
    expect(validateDnsRecord(mx)).toBe('priority');
    expect(validateDnsRecord({ ...mx, priority: -1 })).toBe('priority');
    expect(validateDnsRecord({ ...mx, priority: 65536 })).toBe('priority');
    expect(validateDnsRecord({ ...mx, priority: 1.5 })).toBe('priority');
    expect(validateDnsRecord({ ...base, type: 'MX', content: 'not a host', priority: 10 })).toBe('hostname');
  });

  it('TXT only requires non-empty content', () => {
    expect(validateDnsRecord({ ...base, type: 'TXT', content: 'v=spf1 -all' })).toBeNull();
    expect(validateDnsRecord({ ...base, type: 'TXT', content: '   ' })).toBe('content');
  });

  it('validates record name for all types', () => {
    expect(validateDnsRecord({ type: 'A', name: '@', content: '1.2.3.4' })).toBeNull();
    expect(validateDnsRecord({ type: 'A', name: 'bad name', content: '1.2.3.4' })).toBe('name');
  });

  it('validates ttl range when provided', () => {
    expect(validateDnsRecord({ ...base, type: 'A', content: '1.2.3.4', ttl: 1 })).toBeNull();
    expect(validateDnsRecord({ ...base, type: 'A', content: '1.2.3.4', ttl: 300 })).toBeNull();
    expect(validateDnsRecord({ ...base, type: 'A', content: '1.2.3.4', ttl: 5 })).toBe('ttl');
    expect(validateDnsRecord({ ...base, type: 'A', content: '1.2.3.4', ttl: 90000 })).toBe('ttl');
  });
});
