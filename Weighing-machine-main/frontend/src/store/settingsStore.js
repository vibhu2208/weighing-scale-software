import { create } from 'zustand';

const useSettingsStore = create((set) => ({
  settings: {},
  savedAt: null,
  setAll: (settings) => set({ settings: settings || {} }),
  setOne: (key, value) =>
    set((s) => ({ settings: { ...s.settings, [key]: value } })),
  setSavedAt: (savedAt) => set({ savedAt }),
}));

export default useSettingsStore;
