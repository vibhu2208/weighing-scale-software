import { useCallback, useState } from 'react';
import { transactionAPI } from '../api/ipc.js';

export default function useTransaction() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const create = useCallback(async (payload) => {
    setLoading(true);
    setError(null);
    try {
      return await transactionAPI.create(payload);
    } catch (e) {
      setError(e.message);
      throw e;
    } finally {
      setLoading(false);
    }
  }, []);

  return { create, loading, error };
}
