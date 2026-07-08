/** 详情页 URL ?tab= 解析：非法或缺失回落第一个 key（keys 非空由调用方保证） */
export function resolveTabParam<K extends string>(value: string | null | undefined, keys: readonly K[]): K {
  return value != null && (keys as readonly string[]).includes(value) ? (value as K) : keys[0];
}
