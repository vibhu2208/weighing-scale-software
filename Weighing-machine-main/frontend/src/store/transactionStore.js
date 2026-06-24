import { create } from 'zustand';

const useTransactionStore = create((set, get) => ({
  activeTransaction: null,
  workflowState: 'IDLE',
  recentTransactions: [],
  todayStats: { total: 0, pending: 0, completed: 0, totalWeight: 0 },
  lastEvent: null,
  timeline: [],

  setWorkflowState: (workflowState) => set({ workflowState }),
  setActiveTransaction: (activeTransaction) => set({ activeTransaction }),
  setLastEvent: (lastEvent) => set({ lastEvent }),

  addTransaction: (transaction) =>
    set((s) => ({
      recentTransactions: [
        transaction,
        ...s.recentTransactions.filter((t) => t.id !== transaction.id),
      ].slice(0, 20),
    })),

  updateTransaction: (transaction) =>
    set((s) => ({
      activeTransaction:
        s.activeTransaction?.id === transaction.id
          ? transaction
          : s.activeTransaction,
      recentTransactions: s.recentTransactions.map((t) =>
        t.id === transaction.id ? transaction : t,
      ),
    })),

  setRecentTransactions: (recentTransactions) => set({ recentTransactions }),
  setTodayStats: (todayStats) => set({ todayStats }),

  resetActive: () =>
    set({
      activeTransaction: null,
      workflowState: 'IDLE',
      timeline: [],
      lastEvent: null,
    }),

  pushTimeline: (step) =>
    set((s) => ({
      timeline: [...s.timeline, { ...step, at: new Date().toISOString() }],
    })),

  clearTimeline: () => set({ timeline: [] }),
}));

export default useTransactionStore;
