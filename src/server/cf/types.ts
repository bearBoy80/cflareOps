export interface CfTokenVerify {
  id: string;
  status: string;
}

/** 字段名与 SDK Zone 对象保持一致（snake_case）；除 id/name/status 外均可选，raw 为 SDK 原始对象 */
export interface CfZone {
  id: string;
  name: string;
  status: string;
  paused?: boolean;
  type?: string;
  development_mode?: number;
  name_servers?: string[];
  original_name_servers?: string[] | null;
  original_registrar?: string | null;
  account?: { id?: string; name?: string };
  plan?: { id?: string; name?: string };
  created_on?: string;
  modified_on?: string;
  activated_on?: string | null;
  raw?: unknown;
}

export interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  priority?: number;
}

export type CfDnsRecordInput = Omit<CfDnsRecord, 'id'>;

/** SDK Account 对象裁剪：聚合同步只需 id/name */
export interface CfAccount {
  id: string;
  name: string;
}

/** 字段名与 SDK ScriptListResponse 保持一致（snake_case），raw 为 SDK 原始对象 */
export interface CfWorkerScript {
  id: string;
  created_on?: string;
  modified_on?: string;
  usage_model?: string;
  last_deployed_from?: string;
  raw?: unknown;
}

/** SDK ScheduleGetResponse.Schedule（Workers cron 触发器） */
export interface CfWorkerCron {
  cron: string;
  created_on?: string;
  modified_on?: string;
}

/** SDK DomainListResponse 裁剪（Workers 自定义域） */
export interface CfWorkerDomain {
  id: string;
  hostname: string;
  service: string;
  environment?: string;
  zone_name?: string;
}

/** Worker 绑定裁剪：target 为按类型 best-effort 派生的目标资源标识（kv→namespace_id、d1→database_id 等） */
export interface CfWorkerBinding {
  type: string;
  name: string;
  target?: string | null;
}

/** SDK ScriptAndVersionSettingGetResponse 裁剪（GET /workers/scripts/:name/settings），raw 为 SDK 原始对象 */
export interface CfWorkerSettings {
  bindings: CfWorkerBinding[];
  compatibility_date?: string | null;
  compatibility_flags?: string[];
  usage_model?: string | null;
  tail_consumers?: { service: string }[] | null;
  raw: unknown;
}

/** SDK VersionListResponse 裁剪；message/triggered_by 来自 annotations（列表响应 typings 未声明但运行时返回，best-effort 读取） */
export interface CfWorkerVersion {
  id: string;
  number?: number | null;
  created_on?: string | null;
  message?: string | null;
  triggered_by?: string | null;
}

/** SDK workers Deployment 裁剪；message 来自 annotations["workers/message"] */
export interface CfWorkerDeployment {
  id: string;
  strategy?: string | null;
  created_on?: string | null;
  author_email?: string | null;
  message?: string | null;
  versions: { version_id: string; percentage: number }[];
}

/**
 * Worker 源码读取结果：mainModule 来自 cf-entrypoint 响应头（缺失时回退唯一模块名）；
 * multiModule 由模块 part 数 > 1 判定（sourcemap part 不计入）；
 * etag 优先取响应头（去 W/ 与引号），缺失时为入口模块内容的 SHA-256 hex（乐观锁用）。
 */
export interface CfWorkerContent {
  content: string;
  mainModule: string | null;
  multiModule: boolean;
  etag: string;
}

/** SDK pages DomainListResponse 裁剪：status 为域名总状态，validation_status 来自 validation_data.status */
export interface CfPagesDomain {
  id: string;
  name: string;
  status?: string | null;
  validation_status?: string | null;
}

/** SDK pages Project 裁剪 + 派生字段（source_repo/latest_deployment_on），raw 为 SDK 原始对象 */
export interface CfPagesProject {
  name: string;
  subdomain?: string;
  production_branch?: string;
  domains?: string[];
  source_repo?: string | null;
  created_on?: string;
  latest_deployment_on?: string | null;
  raw?: unknown;
}

/** SDK pages Deployment 裁剪 + latest_stage / deployment_trigger 摊平字段 */
export interface CfPagesDeployment {
  id: string;
  environment?: string;
  url?: string;
  created_on?: string;
  latest_stage_status?: string | null;
  latest_stage_name?: string | null;
  deployment_trigger_branch?: string | null;
  deployment_trigger_commit_hash?: string | null;
}

/** 脚本级 workers.dev 子域名开关（GET/POST .../workers/scripts/:name/subdomain） */
export interface CfScriptSubdomain {
  enabled: boolean;
  previews_enabled: boolean;
}
