import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';

const ADVANCE_FIELDS = [
  { key: 'WEIGHT_ADJUSTMENT_ENABLED', label: 'Enable weight increase', type: 'toggle' },
  { key: 'WEIGHT_OFFSET_KG', label: 'Increase loaded truck weight by (kg)', type: 'number' },
  { key: 'COMPANY_NAME', label: 'Company name', type: 'text' },
  { key: 'COMPANY_ADDRESS', label: 'Company address', type: 'text' },
  { key: 'COMPANY_PHONE', label: 'Company phone', type: 'text' },
  { key: 'SITE_NAME', label: 'Site name', type: 'text' },
  { key: 'WEIGHBRIDGE_ID', label: 'Weighbridge ID', type: 'text' },
  { key: 'REPORT_COMPANY_NAME', label: 'Report company name', type: 'text' },
  { key: 'REPORT_LOGO_PATH', label: 'Report logo path', type: 'text' },
];

const LIST_SECTIONS = [
  { name: 'materials', label: 'Materials' },
  { name: 'customers', label: 'Customers' },
  { name: 'destinations', label: 'Destinations' },
  { name: 'operators', label: 'Operators' },
];

export default function AdvanceSettings() {
  const [settings, setSettings] = useState({});
  const [listText, setListText] = useState({});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const adv = await api.getAdvanceSettings();
      setSettings(adv.settings || {});
      const textData = {};
      await Promise.all(
        LIST_SECTIONS.map(async ({ name }) => {
          const res = await api.getList(name);
          textData[name] = (res.items || []).join('\n');
        }),
      );
      setListText(textData);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function saveSettings() {
    setError('');
    try {
      await api.putAdvanceSettings(settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveList(name) {
    setError('');
    try {
      const items = String(listText[name] || '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      await api.putList(name, items);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h2 className="text-xl font-semibold">Advance Settings</h2>
        <p className="text-sm text-slate-400 mt-1">
          Changes sync to the weighbridge PC within ~30 seconds.
        </p>
      </div>

      <div className="card p-5 space-y-3">
        <h3 className="font-medium text-brand-300">Business & report settings</h3>
        {ADVANCE_FIELDS.map((field) => (
          <div key={field.key} className="flex items-center justify-between gap-4">
            <label className="text-sm text-slate-300 shrink-0">{field.label}</label>
            {field.type === 'toggle' ? (
              <input
                type="checkbox"
                checked={settings[field.key] === 'true'}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    [field.key]: e.target.checked ? 'true' : 'false',
                  }))
                }
              />
            ) : (
              <input
                type={field.type}
                className="field-input max-w-xs"
                value={settings[field.key] ?? ''}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, [field.key]: e.target.value }))
                }
              />
            )}
          </div>
        ))}
        <button type="button" className="btn-primary mt-2" onClick={saveSettings}>
          Save settings
        </button>
      </div>

      {LIST_SECTIONS.map(({ name, label }) => (
        <div key={name} className="card p-5 space-y-2">
          <h3 className="font-medium">{label}</h3>
          <p className="text-xs text-slate-500">One item per line</p>
          <textarea
            className="field-input min-h-[120px] font-mono text-xs"
            value={listText[name] || ''}
            onChange={(e) => setListText((t) => ({ ...t, [name]: e.target.value }))}
          />
          <button type="button" className="btn-ghost text-xs" onClick={() => saveList(name)}>
            Save {label.toLowerCase()}
          </button>
        </div>
      ))}

      {saved && <p className="text-sm text-emerald-400">Saved — syncing to weighbridge PC</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
