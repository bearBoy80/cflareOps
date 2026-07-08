import dayjs from 'dayjs';
import relativeTimePlugin from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';
import 'dayjs/locale/en';

dayjs.extend(relativeTimePlugin);

const DAYJS_LOCALE: Record<'zh' | 'en', string> = { zh: 'zh-cn', en: 'en' };

/** ISO 时间 → 本地化相对时间；iso 为 null 时返回 ''（never 文案由调用方处理） */
export function relativeTime(iso: string | null, locale: 'zh' | 'en'): string {
  if (!iso) return '';
  return dayjs(iso).locale(DAYJS_LOCALE[locale]).fromNow();
}
