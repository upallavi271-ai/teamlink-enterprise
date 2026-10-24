// Entry bundled by combo-custom-test.mjs (the DOM stub is installed BEFORE this runs).
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import Combo from '../src/components/Combo.jsx';
import MultiPick from '../src/components/MultiPick.jsx';

export { React, createRoot, act, Combo, MultiPick };

export function ComboHarness({ initial = '', opts = ['Java', 'Python', 'Frontend'], probe, ...props }) {
  const [v, setV] = useState(initial);
  probe.value = v;
  return (
    <Combo value={v} onChange={(e) => { probe.calls.push(e.target.value); setV(e.target.value); }} {...props}>
      <option value="">Pick</option>
      {opts.map((o) => <option key={o} value={o}>{o}</option>)}
    </Combo>
  );
}

export function MultiHarness({ initial = [], probe, ...props }) {
  const [v, setV] = useState(initial);
  probe.value = v;
  return (
    <MultiPick
      options={[{ value: 'Java', label: 'Java' }, { value: 'Python', label: 'Python' }]}
      value={v}
      onChange={(n) => setV(n)}
      {...props}
    />
  );
}
