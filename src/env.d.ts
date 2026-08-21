/// <reference types="astro/client" />

interface Env {
  DB: D1Database;
  ENCRYPTION_KEY: string;
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUD: string;
  DEV_MODE?: string;
  DEV_USER_EMAIL?: string;
  // OAuth「用 Cloudflare 授权」连接账号(public + PKCE client,无 secret);未配置 client id 时入口不出现
  CF_OAUTH_CLIENT_ID?: string;
  CF_OAUTH_REDIRECT_URI?: string;
  CF_OAUTH_SCOPES?: string;
}

declare namespace App {
  interface Locals {
    userEmail: string;
  }
}
