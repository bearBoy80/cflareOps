import { CircleAlert, CircleCheck, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

type ToastType = 'success' | 'error';

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  showToast: (message: string, type: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const showToast = useCallback((message: string, type: ToastType) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, message, type }]);
    const handle = setTimeout(
      () => {
        timersRef.current.delete(id);
        setToasts((prev) => prev.filter((t) => t.id !== id));
      },
      type === 'error' ? 6000 : 3000,
    );
    timersRef.current.set(id, handle);
  }, []);

  const dismiss = useCallback((id: number) => {
    const handle = timersRef.current.get(id);
    if (handle) {
      clearTimeout(handle);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    return () => {
      for (const handle of timersRef.current.values()) {
        clearTimeout(handle);
      }
    };
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toasts.length > 0 && (
        <div className="toast toast-top toast-end z-[1000]">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={`alert ${toast.type === 'success' ? 'alert-success' : 'alert-error'} flex items-center gap-2`}
            >
              {toast.type === 'success' ? (
                <CircleCheck size={14} strokeWidth={1.75} />
              ) : (
                <CircleAlert size={14} strokeWidth={1.75} />
              )}
              <span className="text-sm">{toast.message}</span>
              <button className="btn btn-ghost btn-xs ml-auto" onClick={() => dismiss(toast.id)}>
                <X size={14} strokeWidth={1.75} />
              </button>
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}
