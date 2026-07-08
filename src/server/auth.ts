export function shouldBypassAuth(env: {
  DEV_MODE?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
}): boolean {
  // Access config and DEV_MODE bypass are mutually exclusive: if Cloudflare Access is
  // configured (team domain or audience tag present), the bypass is disabled regardless
  // of DEV_MODE, preventing accidental bypass in production environments.
  return env.DEV_MODE === 'true' && !env.CF_ACCESS_TEAM_DOMAIN && !env.CF_ACCESS_AUD;
}
