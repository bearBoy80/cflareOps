// DNS 记录字段校验：前端表单与 API 路由共用，返回错误码由调用方映射为本地化文案。
import type { MessageKey } from '../i18n';

export type DnsValidationError = 'name' | 'content' | 'ipv4' | 'ipv6' | 'hostname' | 'priority' | 'ttl';

export const DNS_VALIDATION_MESSAGES: Record<DnsValidationError, MessageKey> = {
  name: 'dns.errName',
  content: 'dns.errContent',
  ipv4: 'dns.errIPv4',
  ipv6: 'dns.errIPv6',
  hostname: 'dns.errHostname',
  priority: 'dns.errPriority',
  ttl: 'dns.errTtl',
};

export interface DnsRecordCandidate {
  type: string;
  name: string;
  content: string;
  ttl?: number;
  priority?: number;
}

export function isIPv4(s: string): boolean {
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

export function isIPv6(s: string): boolean {
  if (s === '') return false;
  const doubleColon = s.split('::');
  if (doubleColon.length > 2) return false;

  const toGroups = (str: string): string[] => (str === '' ? [] : str.split(':'));
  const groups =
    doubleColon.length === 2 ? [...toGroups(doubleColon[0]), ...toGroups(doubleColon[1])] : toGroups(doubleColon[0]);

  // 末组可为内嵌 IPv4（如 ::ffff:192.0.2.1），折算两组
  let groupCount = groups.length;
  const last = groups[groups.length - 1];
  if (last !== undefined && last.includes('.')) {
    if (!isIPv4(last)) return false;
    groups.pop();
    groupCount += 1; // IPv4 占 32 位 = 2 组
  }
  if (!groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return false;
  return doubleColon.length === 2 ? groupCount <= 7 : groupCount === 8;
}

// 主机名标签放宽允许下划线（DKIM/SRV 等目标常见，Cloudflare 亦接受）
const LABEL = /^[a-zA-Z0-9_]([a-zA-Z0-9_-]{0,61}[a-zA-Z0-9_])?$/;

export function isHostname(s: string): boolean {
  if (s === '' || s.length > 253) return false;
  const trimmed = s.endsWith('.') ? s.slice(0, -1) : s;
  if (trimmed === '') return false;
  return trimmed.split('.').every((label) => LABEL.test(label));
}

/** 记录名：'@'（根）、'*'（通配）、'*.xxx' 或普通主机名。 */
export function isRecordName(s: string): boolean {
  if (s === '@' || s === '*') return true;
  return isHostname(s.startsWith('*.') ? s.slice(2) : s);
}

export function validateDnsRecord(input: DnsRecordCandidate): DnsValidationError | null {
  const name = input.name.trim();
  const content = input.content.trim();

  if (!isRecordName(name)) return 'name';
  if (content === '') return 'content';

  switch (input.type) {
    case 'A':
      if (!isIPv4(content)) return 'ipv4';
      break;
    case 'AAAA':
      if (!isIPv6(content)) return 'ipv6';
      break;
    case 'CNAME':
    case 'NS':
      if (!isHostname(content)) return 'hostname';
      break;
    case 'MX': {
      if (!isHostname(content)) return 'hostname';
      const p = input.priority;
      if (p === undefined || !Number.isInteger(p) || p < 0 || p > 65535) return 'priority';
      break;
    }
    // TXT 等其余类型仅要求非空
  }

  const ttl = input.ttl;
  if (ttl !== undefined && ttl !== 1 && (!Number.isInteger(ttl) || ttl < 30 || ttl > 86400)) {
    return 'ttl';
  }
  return null;
}
