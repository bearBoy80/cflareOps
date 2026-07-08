import { createContext, useCallback, useContext, useEffect, useState } from 'react';

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel: string;
}

export type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within a ConfirmDialogProvider');
  return ctx;
}

interface DialogState {
  opts: ConfirmOptions;
  resolve: (value: boolean) => void;
}

export function ConfirmDialogProvider({ children }: { children: React.ReactNode }) {
  const [dialog, setDialog] = useState<DialogState | null>(null);

  const confirm: ConfirmFn = useCallback((opts) => {
    return new Promise((resolve) => {
      setDialog((prev) => {
        if (prev) {
          prev.resolve(false);
        }
        return { opts, resolve };
      });
    });
  }, []);

  const close = useCallback((result: boolean) => {
    setDialog((current) => {
      if (current) {
        current.resolve(result);
      }
      return null;
    });
  }, []);

  useEffect(() => {
    if (!dialog) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close(false);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [dialog, close]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {dialog && (
        <dialog open className="modal modal-open">
          <div className="modal-box">
            <h3 className="text-lg font-bold">{dialog.opts.title}</h3>
            {dialog.opts.description && <p className="py-4 text-sm">{dialog.opts.description}</p>}
            <div className="modal-action">
              <button className="btn btn-ghost" onClick={() => close(false)}>
                {dialog.opts.cancelLabel}
              </button>
              {/* biome-ignore lint/a11y/noAutofocus: deliberate focus of the confirm action when the modal opens */}
              <button className="btn btn-error" autoFocus onClick={() => close(true)}>
                {dialog.opts.confirmLabel}
              </button>
            </div>
          </div>
          {/* backdrop click cancels */}
          <form method="dialog" className="modal-backdrop" onSubmit={() => close(false)}>
            <button type="submit" aria-label={dialog.opts.cancelLabel} />
          </form>
        </dialog>
      )}
    </ConfirmContext.Provider>
  );
}
