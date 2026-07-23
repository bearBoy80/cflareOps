import { useState } from 'react';
import { type Locale, t } from '@/i18n';

/** 输名确认删除模态(列表页与设置 Tab 共用):输入与库名完全一致才放开确认键,防误删 */
export default function DeleteDatabaseModal({
  locale,
  name,
  deleting,
  onCancel,
  onConfirm,
}: {
  locale: Locale;
  name: string;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  const matched = typed === name;
  return (
    <dialog open className="modal modal-open">
      <div className="modal-box">
        <h3 className="text-lg font-bold">{t(locale, 'd1.deleteTitle', { name })}</h3>
        <p className="py-3 text-sm">{t(locale, 'd1.deleteTypeToConfirm', { name })}</p>
        <input
          type="text"
          className="input input-bordered input-sm w-full font-mono"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={name}
        />
        <div className="modal-action">
          <button className="btn btn-ghost" disabled={deleting} onClick={onCancel}>
            {t(locale, 'common.cancel')}
          </button>
          <button className="btn btn-error" disabled={!matched || deleting} onClick={onConfirm}>
            {deleting && <span className="loading loading-spinner loading-xs" />}
            {t(locale, 'd1.delete')}
          </button>
        </div>
      </div>
      <form
        method="dialog"
        className="modal-backdrop"
        onSubmit={(e) => {
          e.preventDefault();
          if (!deleting) onCancel();
        }}
      >
        <button type="submit" aria-label={t(locale, 'common.cancel')} />
      </form>
    </dialog>
  );
}
