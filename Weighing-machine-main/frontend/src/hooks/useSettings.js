import { useCallback, useEffect, useState } from 'react';
import { settingsAPI } from '../api/ipc.js';

export default function useSettings() {
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const all = await settingsAPI.getAll();
        if (alive && all && typeof all === 'object') setSettings(all);
      } catch (_e) {
        // ignore in Phase 1
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const update = useCallback(async (key, value) => {
    await settingsAPI.set(key, value);
    setSettings((s) => ({ ...s, [key]: value }));
  }, []);

  return { settings, loading, update };
}
