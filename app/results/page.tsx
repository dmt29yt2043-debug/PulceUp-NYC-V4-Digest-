'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import type { Event } from '@/lib/types';
import EventCardV2 from '@/components/EventCardV2';
import EventDetail from '@/components/EventDetail';
import { track } from '@/lib/analytics';

// Extended event with personalization metadata
interface PersonalizedEvent extends Event {
  _score: number;
  _reasons: string[];
}

const PAIN_LABELS: Record<string, string> = {
  crowded: 'Less crowded places',
  too_far: 'Close to home',
  too_expensive: 'Budget-friendly options',
  boring: 'Exciting & interactive',
  hard_to_choose: 'Top-rated picks',
};

const BOROUGH_LABELS: Record<string, string> = {
  manhattan: 'Manhattan',
  brooklyn: 'Brooklyn',
  queens: 'Queens',
  bronx: 'The Bronx',
  'staten island': 'Staten Island',
  staten_island: 'Staten Island',   // quiz sends with underscore
  other: 'NYC',
};

// Parse quiz `children` param (format: `boy:3-5,girl:9-12`).
// Falls back to legacy single-child `child_age`+`gender` params.
type QuizChild = { gender: 'boy' | 'girl' | 'unknown'; ageLabel: string };
function parseChildrenParam(childrenParam: string | null, fallbackAge: string, fallbackGender: string | null): QuizChild[] {
  if (childrenParam) {
    const parsed = childrenParam.split(',').map((s) => s.trim()).filter(Boolean).map((piece) => {
      const [g, age] = piece.split(':');
      if (!age) return null;
      const gender = (g === 'boy' || g === 'girl' ? g : 'unknown') as QuizChild['gender'];
      return { gender, ageLabel: age };
    }).filter((x): x is QuizChild => x !== null);
    if (parsed.length > 0) return parsed;
  }
  const g = (fallbackGender === 'boy' || fallbackGender === 'girl' ? fallbackGender : 'unknown') as QuizChild['gender'];
  return [{ gender: g, ageLabel: fallbackAge }];
}

// Convert age label ("3-5", "16+") → numeric upper bound (for filters).
function ageLabelToMax(label: string): number {
  if (label.includes('+')) return 18;
  const parts = label.split('-').map((s) => parseInt(s, 10));
  return parts.length === 2 && !isNaN(parts[1]) ? parts[1] : 10;
}

function ResultsInner() {
  const searchParams = useSearchParams();

  // --- Step 1: Parse URL params (per docs/quiz-url-contract.md) ---
  const source     = searchParams.get('source') || '';
  const childAge   = searchParams.get('child_age') || '6-8';
  const gender     = searchParams.get('gender');
  const childrenRaw = searchParams.get('children');
  const quizChildren = parseChildrenParam(childrenRaw, childAge, gender);
  const borough    = (searchParams.get('borough') || 'manhattan').toLowerCase();
  const customArea = searchParams.get('custom_area') || '';
  const interests  = (searchParams.get('interests') || 'outdoor').split(',').map((s) => s.trim().toLowerCase());
  const pain       = searchParams.get('pain') || 'hard_to_choose';

  // --- State ---
  const [events, setEvents] = useState<PersonalizedEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const [showRefine, setShowRefine] = useState(false);

  // --- Step 4: Auto-trigger personalized search + persist profile ---
  useEffect(() => {
    track('quiz_landing_loaded', {
      source, child_age: childAge, gender, children: childrenRaw,
      borough, custom_area: customArea, interests, pain,
    });

    // Save profile to localStorage so the main app (/) inherits preferences
    // on subsequent visits. Matches the shape ChatSidebar expects.
    if (source === 'quiz' && typeof window !== 'undefined') {
      try {
        const profile = {
          children: quizChildren.map((c) => ({
            age: ageLabelToMax(c.ageLabel),
            gender: c.gender,
            interests: interests.map((i) => i.charAt(0).toUpperCase() + i.slice(1)),
          })),
          neighborhoods: borough === 'other' ? [] : [BOROUGH_LABELS[borough] || borough],
          budget: pain === 'too_expensive' ? 'Free only' : 'Any budget',
        };
        localStorage.setItem('pulseup_profile', JSON.stringify(profile));
      } catch { /* ignore storage errors */ }
    }

    // Forward ALL quiz params to the API — it supports `children`, `gender`,
    // `custom_area` on top of the legacy fields.
    const params = new URLSearchParams({
      child_age: childAge,
      borough,
      interests: interests.join(','),
      pain,
    });
    if (childrenRaw) params.set('children', childrenRaw);
    if (gender)      params.set('gender', gender);
    if (customArea)  params.set('custom_area', customArea);

    fetch(`/api/events/personalized?${params}`)
      .then((r) => r.json())
      .then((data) => {
        setEvents(data.events || []);
        track('quiz_params_parsed', {
          child_age: childAge, children: childrenRaw, borough, interests, pain,
        });
        track('personalized_results_shown', { count: data.events?.length || 0 });
      })
      .catch(console.error)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [childAge, childrenRaw, gender, borough, customArea, interests.join(','), pain, source]);

  const handleCardClick = useCallback((event: Event) => {
    setSelectedEvent(event);
    setDetailOpen(true);
    track('result_clicked', {
      event_id: event.id,
      title: event.title,
      child_age: childAge,
      borough,
      interests,
      pain,
      source: 'quiz',
    });
  }, [childAge, borough, interests, pain]);

  // --- Derived ---
  const heroEvent = events[0] || null;
  const restEvents = events.slice(1);
  const painLabel = PAIN_LABELS[pain] || pain;
  const boroughLabel = borough === 'other' && customArea
    ? customArea
    : BOROUGH_LABELS[borough] || borough;
  const interestLabels = interests
    .map((i) => i.replace(/_/g, ' '))                     // indoor_play → indoor play
    .map((i) => i.charAt(0).toUpperCase() + i.slice(1));  // → Indoor play

  return (
    <div style={{ minHeight: '100vh', background: '#0f0d2e', color: 'white' }}>
      {/* --- Step 6: Top summary block --- */}
      <div style={{
        background: 'linear-gradient(135deg, #1a1145 0%, #2a1f5e 50%, #1a1145 100%)',
        padding: '32px 24px 28px',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
      }}>
        <div style={{ maxWidth: 900, margin: '0 auto' }}>
          {source === 'quiz' && (
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: 'rgba(233,30,99,0.15)', border: '1px solid rgba(233,30,99,0.3)',
              borderRadius: 20, padding: '4px 14px', marginBottom: 16, fontSize: 12, color: '#f48fb1',
            }}>
              <span>&#10003;</span> Based on your quiz answers
            </div>
          )}

          <h1 style={{ fontSize: 28, fontWeight: 800, margin: '0 0 6px', lineHeight: 1.2 }}>
            Your personalized weekend plan
          </h1>
          <p style={{ fontSize: 14, color: '#9ca3af', margin: '0 0 20px' }}>
            Hand-picked events for your family
          </p>

          {/* Profile chips — one per child (with gender icon), then borough, interests, pain */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {quizChildren.map((c, idx) => (
              <ProfileChip
                key={`child-${idx}`}
                icon={c.gender === 'girl' ? '&#128103;' : c.gender === 'boy' ? '&#128102;' : '&#129490;'}
                label={`Ages ${c.ageLabel}`}
              />
            ))}
            <ProfileChip icon="&#128205;" label={boroughLabel} />
            {interestLabels.map((il) => (
              <ProfileChip key={il} icon="&#11088;" label={il} />
            ))}
            <ProfileChip icon="&#127919;" label={painLabel} highlight />
          </div>

          {/* Refine button */}
          <button
            onClick={() => setShowRefine((v) => !v)}
            style={{
              marginTop: 16, background: 'transparent', border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 8, padding: '6px 16px', color: '#9ca3af', fontSize: 12,
              cursor: 'pointer',
            }}
          >
            &#9998; Refine my preferences
          </button>

          {showRefine && (
            <RefinePanel
              childAge={childAge}
              borough={borough}
              interests={interests}
              pain={pain}
            />
          )}
        </div>
      </div>

      {/* --- Content area --- */}
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 16px 60px' }}>
        {loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} style={{
                height: 210, borderRadius: 12, background: 'rgba(255,255,255,0.04)',
                animation: 'pulse 1.5s ease-in-out infinite',
              }} />
            ))}
          </div>
        ) : (
          <>
            {/* --- Step 8: Hero recommendation --- */}
            {heroEvent && (
              <div style={{ marginBottom: 24 }}>
                <div style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  background: 'linear-gradient(135deg, #e91e63, #ff6090)',
                  borderRadius: 20, padding: '4px 14px', marginBottom: 12,
                  fontSize: 12, fontWeight: 700, color: 'white',
                }}>
                  &#9733; Top pick for you
                </div>
                <div style={{
                  borderRadius: 16, overflow: 'hidden', position: 'relative',
                  height: 320, cursor: 'pointer',
                }}
                  onClick={() => handleCardClick(heroEvent)}
                >
                  {heroEvent.image_url ? (
                    <img
                      src={heroEvent.image_url}
                      alt={heroEvent.title}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  ) : (
                    <div style={{
                      width: '100%', height: '100%',
                      background: 'linear-gradient(135deg, #1e1b4b, #2a2563)',
                    }} />
                  )}
                  <div style={{
                    position: 'absolute', bottom: 0, left: 0, right: 0,
                    padding: '48px 20px 20px',
                    background: 'linear-gradient(to top, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.5) 60%, transparent 100%)',
                  }}>
                    <h2 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 6px' }}>{heroEvent.short_title || heroEvent.title}</h2>
                    <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.7)', margin: '0 0 8px' }}>
                      {heroEvent.venue_name}
                    </p>
                    {heroEvent._reasons.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {heroEvent._reasons.map((r, i) => (
                          <span key={i} style={{
                            fontSize: 11, fontWeight: 600, padding: '3px 10px',
                            borderRadius: 10, background: 'rgba(233,30,99,0.8)', color: 'white',
                          }}>
                            {r}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* --- Step 7: Result cards --- */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <span style={{ fontSize: 13, color: '#9ca3af' }}>
                {events.length} events selected for you
              </span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
              {restEvents.map((event) => (
                <div key={event.id} style={{ position: 'relative' }}>
                  <EventCardV2
                    event={event}
                    isHovered={hoveredId === event.id}
                    isSelected={false}
                    onMouseEnter={() => setHoveredId(event.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    onClick={() => handleCardClick(event)}
                  />
                  {/* Why-selected label */}
                  {event._reasons.length > 0 && (
                    <div style={{
                      marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4,
                    }}>
                      {event._reasons.slice(0, 3).map((r, i) => (
                        <span key={i} style={{
                          fontSize: 9, fontWeight: 600, padding: '2px 7px',
                          borderRadius: 8, background: 'rgba(255,255,255,0.06)',
                          color: '#9ca3af', whiteSpace: 'nowrap',
                        }}>
                          {r}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {events.length === 0 && (
              <div style={{ textAlign: 'center', padding: 60, color: '#6b7280' }}>
                <p style={{ fontSize: 16 }}>No events found</p>
                <p style={{ fontSize: 13, marginTop: 8 }}>Try adjusting your preferences</p>
              </div>
            )}
          </>
        )}
      </div>

      {/* Event detail overlay */}
      <EventDetail
        event={selectedEvent}
        open={detailOpen}
        onClose={() => { setDetailOpen(false); setTimeout(() => setSelectedEvent(null), 300); }}
      />
    </div>
  );
}

function ProfileChip({ icon, label, highlight }: { icon: string; label: string; highlight?: boolean }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '5px 14px', borderRadius: 20, fontSize: 13, fontWeight: 500,
      background: highlight ? 'rgba(233,30,99,0.15)' : 'rgba(255,255,255,0.06)',
      color: highlight ? '#f48fb1' : '#d1d5db',
      border: `1px solid ${highlight ? 'rgba(233,30,99,0.3)' : 'rgba(255,255,255,0.1)'}`,
    }}>
      <span dangerouslySetInnerHTML={{ __html: icon }} />
      {label}
    </span>
  );
}

function RefinePanel({ childAge, borough, interests, pain }: {
  childAge: string; borough: string; interests: string[]; pain: string;
}) {
  const [age, setAge] = useState(childAge);
  const [bor, setBor] = useState(borough);
  const [int, setInt] = useState(interests.join(','));
  const [p, setP] = useState(pain);

  const apply = () => {
    const params = new URLSearchParams({
      source: 'quiz',
      child_age: age,
      borough: bor,
      interests: int,
      pain: p,
    });
    window.location.href = `/results?${params}`;
  };

  const inputStyle = {
    width: '100%', padding: '8px 12px', borderRadius: 8, fontSize: 13,
    background: '#16143a', color: 'white',
    border: '1px solid rgba(255,255,255,0.1)',
    outline: 'none',
  };

  return (
    <div style={{
      marginTop: 16, padding: 16, borderRadius: 12,
      background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
      display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12,
    }}>
      <div>
        <label style={{ fontSize: 11, color: '#9ca3af', display: 'block', marginBottom: 4 }}>Child age</label>
        <select value={age} onChange={(e) => setAge(e.target.value)} style={inputStyle}>
          <option value="0-2">0-2</option>
          <option value="3-5">3-5</option>
          <option value="6-8">6-8</option>
          <option value="9-12">9-12</option>
          <option value="13+">13+</option>
        </select>
      </div>
      <div>
        <label style={{ fontSize: 11, color: '#9ca3af', display: 'block', marginBottom: 4 }}>Borough</label>
        <select value={bor} onChange={(e) => setBor(e.target.value)} style={inputStyle}>
          <option value="manhattan">Manhattan</option>
          <option value="brooklyn">Brooklyn</option>
          <option value="queens">Queens</option>
          <option value="bronx">Bronx</option>
          <option value="staten island">Staten Island</option>
        </select>
      </div>
      <div>
        <label style={{ fontSize: 11, color: '#9ca3af', display: 'block', marginBottom: 4 }}>Interests</label>
        <input value={int} onChange={(e) => setInt(e.target.value)} placeholder="outdoor,museums" style={inputStyle} />
      </div>
      <div>
        <label style={{ fontSize: 11, color: '#9ca3af', display: 'block', marginBottom: 4 }}>Priority</label>
        <select value={p} onChange={(e) => setP(e.target.value)} style={inputStyle}>
          <option value="crowded">Less crowded</option>
          <option value="too_far">Close to home</option>
          <option value="too_expensive">Budget-friendly</option>
          <option value="boring">Exciting & interactive</option>
          <option value="hard_to_choose">Best rated</option>
        </select>
      </div>
      <div style={{ gridColumn: '1 / -1' }}>
        <button onClick={apply} style={{
          width: '100%', padding: '10px 0', borderRadius: 8, border: 'none',
          background: '#e91e63', color: 'white', fontSize: 14, fontWeight: 600,
          cursor: 'pointer',
        }}>
          Update results
        </button>
      </div>
    </div>
  );
}

export default function ResultsPage() {
  return (
    <Suspense fallback={
      <div style={{ minHeight: '100vh', background: '#0f0d2e', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: '#9ca3af' }}>Loading your recommendations...</p>
      </div>
    }>
      <ResultsInner />
    </Suspense>
  );
}
