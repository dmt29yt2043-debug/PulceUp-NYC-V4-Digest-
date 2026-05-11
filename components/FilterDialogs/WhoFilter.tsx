'use client';

import { useState } from 'react';

interface Child {
  age: number;
  gender: 'boy' | 'girl';
}

interface WhoFilterProps {
  ageMax?: number;
  children?: Child[];
  onApply: (ageMax?: number, children?: Child[]) => void;
  onRemember: (children: Child[]) => void;
  onClose: () => void;
}

const GENDER_LABELS: Record<Child['gender'], string> = {
  boy: '👦 Boy',
  girl: '👧 Girl',
};

export default function WhoFilter({ ageMax: initialAge, children: initialChildren, onApply, onRemember, onClose }: WhoFilterProps) {
  const [children, setChildren] = useState<Child[]>(
    initialChildren && initialChildren.length > 0
      ? initialChildren
      : initialAge !== undefined
        ? [{ age: initialAge, gender: 'boy' }]
        : []
  );

  const addChild = () => setChildren((prev) => [...prev, { age: 5, gender: 'boy' }]);

  const removeChild = (i: number) => setChildren((prev) => prev.filter((_, idx) => idx !== i));

  const updateAge = (i: number, delta: number) =>
    setChildren((prev) =>
      prev.map((c, idx) =>
        idx === i ? { ...c, age: Math.max(0, Math.min(18, c.age + delta)) } : c
      )
    );

  const setGender = (i: number, gender: Child['gender']) =>
    setChildren((prev) => prev.map((c, idx) => (idx === i ? { ...c, gender } : c)));

  const handleApply = () => {
    const ageMax = children.length > 0 ? Math.max(...children.map((c) => c.age)) : undefined;
    onApply(ageMax, children);
  };

  const handleClear = () => setChildren([]);

  return (
    <div className="filter-dialog-backdrop" onClick={onClose}>
      <div className="filter-dialog" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <h3 className="text-lg font-semibold mb-4 text-white">Who is going?</h3>

        {/* Children list */}
        <div className="space-y-3 mb-4">
          {children.map((child, i) => (
            <div key={i} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: '12px 14px' }}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-300 font-medium">Child {i + 1}</span>
                <button
                  onClick={() => removeChild(i)}
                  className="text-gray-500 hover:text-red-400 text-lg leading-none"
                  title="Remove"
                >
                  ✕
                </button>
              </div>

              {/* Age stepper */}
              <div className="flex items-center gap-3 mb-3">
                <span className="text-xs text-gray-500 w-8">Age</span>
                <button
                  onClick={() => updateAge(i, -1)}
                  className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-white"
                  style={{ background: 'rgba(255,255,255,0.08)' }}
                >
                  −
                </button>
                <span className="text-white font-semibold w-6 text-center">{child.age}</span>
                <button
                  onClick={() => updateAge(i, 1)}
                  className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-white"
                  style={{ background: 'rgba(255,255,255,0.08)' }}
                >
                  +
                </button>
              </div>

              {/* Gender */}
              <div className="flex gap-2">
                {(['boy', 'girl'] as Child['gender'][]).map((g) => (
                  <button
                    key={g}
                    onClick={() => setGender(i, g)}
                    className="flex-1 py-1.5 rounded-lg text-xs font-medium transition-all"
                    style={{
                      background: child.gender === g ? '#e91e63' : 'rgba(255,255,255,0.06)',
                      color: child.gender === g ? 'white' : '#9ca3af',
                      border: child.gender === g ? '1.5px solid #e91e63' : '1.5px solid rgba(255,255,255,0.1)',
                    }}
                  >
                    {GENDER_LABELS[g]}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Add child button */}
        <button
          onClick={addChild}
          className="w-full py-2 mb-5 rounded-lg text-sm font-medium text-pink-400 hover:text-white transition-colors"
          style={{ border: '1.5px dashed rgba(233,30,99,0.5)', background: 'transparent' }}
        >
          + Add child
        </button>

        {children.length === 0 && (
          <p className="text-xs text-gray-500 mb-4 text-center">Add children to filter events by age</p>
        )}

        <div className="flex gap-3">
          <button
            onClick={handleClear}
            className="flex-1 py-2 px-4 rounded-lg border border-[rgba(255,255,255,0.15)] text-sm font-medium text-gray-400 hover:bg-[rgba(255,255,255,0.05)]"
          >
            Clear
          </button>
          <button
            onClick={() => { handleApply(); if (children.length > 0) onRemember(children); }}
            className="flex-1 py-2 px-4 rounded-lg text-sm font-medium text-white"
            style={{ backgroundColor: '#e91e63' }}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
