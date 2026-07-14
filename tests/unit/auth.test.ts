import { describe, expect, it } from 'vitest';
import { shouldBypassAuth } from '@/server/auth';

describe('shouldBypassAuth', () => {
  it('bypasses only when DEV_MODE === "true"', () => {
    expect(shouldBypassAuth({ DEV_MODE: 'true' })).toBe(true);
    expect(shouldBypassAuth({ DEV_MODE: 'false' })).toBe(false);
    expect(shouldBypassAuth({ DEV_MODE: undefined })).toBe(false);
    expect(shouldBypassAuth({})).toBe(false);
  });

  it('does not bypass when CF_ACCESS_TEAM_DOMAIN is present (Access config and DEV bypass are mutually exclusive)', () => {
    expect(shouldBypassAuth({ DEV_MODE: 'true', CF_ACCESS_TEAM_DOMAIN: 'x.cloudflareaccess.com' })).toBe(false);
  });

  it('does not bypass when CF_ACCESS_AUD is present', () => {
    expect(shouldBypassAuth({ DEV_MODE: 'true', CF_ACCESS_AUD: 'some-audience-tag' })).toBe(false);
  });
});
