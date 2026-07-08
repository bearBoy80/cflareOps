/** Worker secret 名称约束：字母或下划线开头，仅含字母数字下划线 */
export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}
