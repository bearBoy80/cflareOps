import { isSecretName } from './secretName';

/** compatibility_date 严格 YYYY-MM-DD */
export const COMPAT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 绑定编辑受限 schema：inherit 保留现有绑定（含 secrets），其余六种为可新增类型 */
export type BindingInput =
  | { kind: 'inherit'; name: string }
  | { kind: 'kv_namespace'; name: string; namespaceId: string }
  | { kind: 'd1'; name: string; databaseId: string }
  | { kind: 'r2_bucket'; name: string; bucketName: string }
  | { kind: 'plain_text'; name: string; text: string }
  | { kind: 'json'; name: string; json: string }
  | { kind: 'service'; name: string; service: string; environment?: string };

/** 各 kind 除 name 外的必填 string 字段 */
const REQUIRED_FIELDS: Record<string, string[]> = {
  inherit: [],
  kv_namespace: ['namespaceId'],
  d1: ['databaseId'],
  r2_bucket: ['bucketName'],
  plain_text: ['text'],
  json: ['json'],
  service: ['service'],
};

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v !== '';
}

/** 校验并窄化绑定数组；任何一项非法整体返回 null */
export function parseBindingInputs(raw: unknown): BindingInput[] | null {
  if (!Array.isArray(raw)) return null;
  const out: BindingInput[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const b = item as Record<string, unknown>;
    const kind = b.kind;
    if (typeof kind !== 'string' || !(kind in REQUIRED_FIELDS)) return null;
    // inherit 的 name 来自 CF 回显，可能含 $ 等合法字符；仅检查非空字符串
    if (kind === 'inherit') {
      if (typeof b.name !== 'string' || b.name === '') return null;
    } else {
      if (typeof b.name !== 'string' || !isSecretName(b.name)) return null;
    }
    for (const field of REQUIRED_FIELDS[kind]) {
      if (!nonEmptyString(b[field])) return null;
    }
    // json 绑定：值必须是可解析的 JSON
    if (kind === 'json') {
      try {
        JSON.parse(b.json as string);
      } catch {
        return null;
      }
    }
    if (kind === 'service' && b.environment !== undefined && typeof b.environment !== 'string') {
      return null;
    }
    const entry: Record<string, unknown> = { kind, name: b.name };
    for (const field of REQUIRED_FIELDS[kind]) entry[field] = b[field];
    if (kind === 'service' && b.environment !== undefined) entry.environment = b.environment;
    out.push(entry as BindingInput);
  }
  return out;
}

/** BindingInput → SDK PATCH bindings 线格式 */
export function toSdkBindings(bindings: BindingInput[]): Record<string, unknown>[] {
  // biome-ignore lint/suspicious/useIterableCallbackReturn: exhaustive switch over the BindingInput union — every case returns
  return bindings.map((b) => {
    switch (b.kind) {
      case 'inherit':
        return { type: 'inherit', name: b.name };
      case 'kv_namespace':
        return { type: 'kv_namespace', name: b.name, namespace_id: b.namespaceId };
      case 'd1':
        return { type: 'd1', name: b.name, database_id: b.databaseId };
      case 'r2_bucket':
        return { type: 'r2_bucket', name: b.name, bucket_name: b.bucketName };
      case 'plain_text':
        return { type: 'plain_text', name: b.name, text: b.text };
      case 'json':
        return { type: 'json', name: b.name, json: JSON.parse(b.json) };
      case 'service':
        return {
          type: 'service',
          name: b.name,
          service: b.service,
          ...(b.environment !== undefined ? { environment: b.environment } : {}),
        };
    }
  });
}
