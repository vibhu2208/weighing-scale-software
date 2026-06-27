import React, { useEffect, useMemo, useState } from 'react';
import { todayISO } from '../../lib/reportDates.js';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function pad(n) {
  return String(n).padStart(2, '0');
}

function toIsoDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseIso(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function compareIso(a, b) {
  if (!a || !b) return 0;
  return a < b ? -1 : a > b ? 1 : 0;
}

function buildMonthGrid(year, month) {
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const startDow = first.getDay();
  const mondayOffset = startDow === 0 ? 6 : startDow - 1;

  const cells = [];
  for (let i = 0; i < mondayOffset; i += 1) {
    const d = new Date(year, month, 1 - (mondayOffset - i));
    cells.push({ iso: toIsoDate(d), inMonth: false });
  }
  for (let day = 1; day <= last.getDate(); day += 1) {
    const d = new Date(year, month, day);
    cells.push({ iso: toIsoDate(d), inMonth: true });
  }
  while (cells.length % 7 !== 0 || cells.length < 42) {
    const prev = parseIso(cells[cells.length - 1].iso);
    prev.setDate(prev.getDate() + 1);
    cells.push({ iso: toIsoDate(prev), inMonth: false });
  }
  return cells;
}

function monthLabel(year, month) {
  return new Date(year, month, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

export default function DateRangeCalendar({ from, to, onChange }) {
  const today = todayISO();
  const anchorDate = parseIso(from || today);
  const [viewYear, setViewYear] = useState(anchorDate.getFullYear());
  const [viewMonth, setViewMonth] = useState(anchorDate.getMonth());
  const [rangeStart, setRangeStart] = useState(null);

  useEffect(() => {
    const d = parseIso(from || today);
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
  }, [from, today]);

  const grid = useMemo(() => buildMonthGrid(viewYear, viewMonth), [viewYear, viewMonth]);

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewYear((y) => y - 1);
      setViewMonth(11);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewYear((y) => y + 1);
      setViewMonth(0);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  const applyRange = (startIso, endIso) => {
    const cmp = compareIso(startIso, endIso);
    if (cmp <= 0) {
      onChange({ from: startIso, to: endIso });
    } else {
      onChange({ from: endIso, to: startIso });
    }
  };

  const handleDayClick = (iso) => {
    if (!rangeStart) {
      setRangeStart(iso);
      onChange({ from: iso, to: iso });
      return;
    }
    applyRange(rangeStart, iso);
    setRangeStart(null);
  };

  const isRangeStart = (iso) => iso === from;
  const isRangeEnd = (iso) => iso === to;
  const isInRange = (iso) => from && to && compareIso(iso, from) >= 0 && compareIso(iso, to) <= 0;
  const isToday = (iso) => iso === today;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-4">
      <p className="mb-3 text-[11px] text-slate-500">
        Click a start date, then an end date — future dates allowed
      </p>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="min-w-[280px] flex-1">
          <div className="mb-3 flex items-center justify-between gap-2">
            <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={prevMonth} aria-label="Previous month">
              ‹
            </button>
            <span className="text-sm font-medium text-white">{monthLabel(viewYear, viewMonth)}</span>
            <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={nextMonth} aria-label="Next month">
              ›
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-medium uppercase tracking-wide text-slate-500">
            {WEEKDAYS.map((day) => (
              <div key={day} className="py-1">
                {day}
              </div>
            ))}
          </div>

          <div className="mt-1 grid grid-cols-7 gap-1">
            {grid.map((cell) => {
              const selected = isInRange(cell.iso);
              const start = isRangeStart(cell.iso);
              const end = isRangeEnd(cell.iso);
              const pending = rangeStart === cell.iso;

              return (
                <button
                  key={cell.iso}
                  type="button"
                  onClick={() => handleDayClick(cell.iso)}
                  className={[
                    'relative rounded-md py-2 text-xs tabular-nums transition',
                    cell.inMonth ? 'text-slate-200' : 'text-slate-600',
                    selected ? 'bg-brand-600/25 text-brand-100' : 'hover:bg-slate-800',
                    (start || end || pending) ? 'bg-brand-600 text-white shadow-sm shadow-brand-600/30' : '',
                    isToday(cell.iso) && !start && !end ? 'ring-1 ring-brand-500/60' : '',
                  ].filter(Boolean).join(' ')}
                >
                  {parseIso(cell.iso).getDate()}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex w-full flex-col gap-3 sm:max-w-xs lg:w-48">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-slate-400">From</span>
            <input
              type="date"
              className="field-input"
              value={from}
              onChange={(e) => {
                setRangeStart(null);
                const nextFrom = e.target.value;
                const nextTo = compareIso(nextFrom, to) > 0 ? nextFrom : to;
                onChange({ from: nextFrom, to: nextTo });
              }}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-slate-400">To</span>
            <input
              type="date"
              className="field-input"
              value={to}
              onChange={(e) => {
                setRangeStart(null);
                const nextTo = e.target.value;
                const nextFrom = compareIso(from, nextTo) > 0 ? nextTo : from;
                onChange({ from: nextFrom, to: nextTo });
              }}
            />
          </label>
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={() => {
              setRangeStart(null);
              onChange({ from: today, to: today });
            }}
          >
            Reset to today
          </button>
        </div>
      </div>
    </div>
  );
}
