import { useCallback, useEffect, useState } from 'react';
import { subscribe, workflowAPI } from '../api/ipc.js';

export default function useWorkflow() {
  const [state, setState] = useState('IDLE');
  const [transaction, setTransaction] = useState(null);
  const [lastEvent, setLastEvent] = useState(null);
  const [unknownRfid, setUnknownRfid] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const s = await workflowAPI.getState();
      if (s) {
        setState(s.state || 'IDLE');
      }
    } catch (_e) {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refresh();

    const unsubs = [
      subscribe('workflow:stateChange', (p) => {
        setState(p.to);
        setLastEvent(p);
      }),
      subscribe('workflow:transactionStarted', (p) => {
        setTransaction(p.transaction);
        setUnknownRfid(null);
        setLastEvent(p);
      }),
      subscribe('workflow:complete', (p) => {
        setTransaction(p.transaction);
        setLastEvent(p);
        refresh();
      }),
      subscribe('workflow:unknownRFID', (p) => {
        setUnknownRfid(p.tag);
        setLastEvent(p);
      }),
      subscribe('workflow:reset', () => {
        setState('IDLE');
        setTransaction(null);
        setUnknownRfid(null);
      }),
      subscribe('workflow:error', (p) => setLastEvent(p)),
      subscribe('workflow:weightUpdate', (p) => setLastEvent(p)),
      subscribe('workflow:imageCaptured', (p) => setLastEvent(p)),
    ];

    return () => unsubs.forEach((u) => u());
  }, [refresh]);

  return {
    state,
    transaction,
    lastEvent,
    unknownRfid,
    refresh,
    abort: workflowAPI.abort,
    acceptManualEntry: workflowAPI.acceptManualEntry,
  };
}
