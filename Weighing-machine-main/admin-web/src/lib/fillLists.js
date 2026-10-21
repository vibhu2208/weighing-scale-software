/** Shared with Fill Blocked Slips and Bulk Photos. */
export const FILL_VEHICLES = [
  'HR65A7668',
  'HR58D8715',
  'HR58E3515',
  'HR69E3748',
  'HR69D5649',
  'HR58C6215',
  'UP12BT4968',
  'HR58E3696',
  'HR58E8815',
  'HR38AB3093',
  'HR58E7930',
  'HR58E5799',
  'PB13BE9786',
  'UP14HT5656',
];

export function compactPlate(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[\s-]/g, '');
}

export function samePlate(a, b) {
  const left = compactPlate(a);
  const right = compactPlate(b);
  return Boolean(left) && left === right;
}
