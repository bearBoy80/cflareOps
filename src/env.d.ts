/// <reference types="astro/client" />

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;

interface Env {
  DB: D1Database;
  ENCRYPTION_KEY: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  DEV_MODE?: string;
  DEV_USER_EMAIL?: string;
}

declare namespace App {
  interface Locals extends Runtime {
    userEmail: string;
  }
}
