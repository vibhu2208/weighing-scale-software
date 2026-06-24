import React, { createContext, useCallback, useContext, useState } from 'react';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const show = useCallback((message, variant = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, variant }]);
    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 3500);
  }, []);

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={[
              'rounded-lg px-4 py-2 text-sm font-medium shadow-lg border pointer-events-auto',
              t.variant === 'danger'
                ? 'bg-red-950/90 text-red-200 border-red-700/50'
                : 'bg-emerald-950/90 text-emerald-200 border-emerald-700/50',
            ].join(' ')}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    return { show: (msg) => console.log('[toast]', msg) };
  }
  return ctx;
}
