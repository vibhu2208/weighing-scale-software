import { useEffect, useState } from 'react';
import { syncAPI } from '../api/ipc.js';

export default function useSyncStatus(pollMs = 10000) {
  const [queue, setQueue] = useState({ pending: 0, retry: 0, failed: 0 });

  useEffect(() => {
    let alive = true;

    const pull = async () => {
      try {
        const next = await syncAPI.getQueueStatus();
        if (alive && next && typeof next === 'object') setQueue(next);
      } catch (_e) {
        // ignore in Phase 1
      }
    };

    pull();
    const id = setInterval(pull, pollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [pollMs]);

  return queue;
}
