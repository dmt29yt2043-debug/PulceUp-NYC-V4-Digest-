'use client';

import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import type { ChatMessage, FilterState, Event, UserProfile, ChildProfile } from '@/lib/types';
import ChatMessages from './ChatMessages';
import type { MultiSelectState } from './ChatMessages';
import {
  trackChatMessageSent,
  trackChatResponseReceived,
  trackError,
  track,
} from '@/lib/analytics';

/**
 * source argument on onFiltersChange is critical for analytics:
 *   'chat'  — filters came from the AI chat response (natural language query)
 *   'ui'    — filters came from onboarding chip clicks (manual setup)
 *   'reset' — profile reset: clear everything
 * page.tsx forwards this to trackFilterApplied() with the correct source.
 */
interface ChatSidebarProps {
  filters: FilterState;
  onFiltersChange: (filters: FilterState, source: 'chat' | 'ui' | 'reset') => void;
  onEventClick: (event: Event) => void;
}

type OnboardingStep =
  | 'q1_children'
  | 'q1_confirm'
  | 'q2_interests'
  | 'q2_summary'
  | 'q3_neighborhoods'
  | 'q4_budget'
  | 'q5_special'
  | 'ready'
  | 'done';

const INTEREST_OPTIONS = ['Active', 'Creative', 'Educational', 'Shows', 'Outdoor', 'Fun & Play', 'Adventure', 'Books', 'Social'];
const NEIGHBORHOOD_OPTIONS = ['Upper Manhattan', 'Midtown', 'Lower Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island', 'Anywhere in NYC'];
const BUDGET_OPTIONS = ['Free only', 'Under $25', 'Under $50', 'Under $75', 'Under $100', 'Any budget'];

const INTEREST_TO_CATEGORIES: Record<string, string[]> = {
  'Active': ['sports', 'attractions'],
  'Creative': ['arts', 'Art'],
  'Educational': ['books', "Children's Activities"],
  'Shows': ['theater'],
  'Outdoor': ['attractions'],
  'Fun & Play': ['family', "Children's Activities"],
  'Adventure': ['attractions'],
  'Books': ['books'],
  'Social': ['family'],
};

// Quiz interests → API categories
const QUIZ_INTEREST_TO_CATEGORIES: Record<string, string[]> = {
  outdoor: ['attractions'],
  museums: ['arts', 'Art'],
  playgrounds: ['family', "Children's Activities"],
  classes: ['arts', 'Art'],
  indoor_play: ['family', "Children's Activities"],
  science: ['books', "Children's Activities"],
  arts_crafts: ['arts', 'Art'],
  sports: ['sports'],
  theater: ['theater'],
  music: ['arts'],
  play: ['family', "Children's Activities"],
};

const BOROUGH_TO_NEIGHBORHOODS: Record<string, string[]> = {
  manhattan: ['Upper Manhattan', 'Midtown', 'Lower Manhattan'],
  brooklyn: ['Brooklyn'],
  queens: ['Queens'],
  bronx: ['Bronx'],
  'staten island': ['Staten Island'],
};

function genderEmoji(gender: string): string {
  return gender === 'girl' ? '\uD83D\uDC67' : gender === 'boy' ? '\uD83D\uDC66' : '\uD83E\uDDD2';
}

function getStoredProfile(): UserProfile | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = localStorage.getItem('pulseup_profile');
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    if ('attendees' in parsed && !('children' in parsed)) {
      localStorage.removeItem('pulseup_profile');
      return null;
    }
    return parsed as UserProfile;
  } catch {
    return null;
  }
}

function storeProfile(profile: UserProfile) {
  try {
    localStorage.setItem('pulseup_profile', JSON.stringify(profile));
  } catch { /* ignore */ }
}

export default function ChatSidebar({ filters, onFiltersChange, onEventClick }: ChatSidebarProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep>('q1_children');
  const [onboardingDone, setOnboardingDone] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Onboarding state
  const [parsedChildren, setParsedChildren] = useState<ChildProfile[]>([]);
  const [currentChildIndex, setCurrentChildIndex] = useState(0);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [parsingChildren, setParsingChildren] = useState(false);

  const partialProfileRef = useRef<Partial<UserProfile>>({});

  // Apply profile to filters
  const applyProfileFilters = useCallback((p: Partial<UserProfile>) => {
    const newFilters: FilterState = {};

    if (p.children && p.children.length > 0) {
      newFilters.ageMax = Math.max(...p.children.map((c) => c.age));

      // Profile interests are used for chat context only — don't auto-apply
      // categories so the "What" filter stays at the default "Activities".
    }

    if (p.neighborhoods && p.neighborhoods.length > 0 && !p.neighborhoods.includes('Anywhere in NYC')) {
      newFilters.neighborhoods = p.neighborhoods;
    }

    if (p.budget) {
      if (p.budget === 'Free only') newFilters.isFree = true;
      else if (p.budget === 'Under $25') newFilters.priceMax = 25;
      else if (p.budget === 'Under $50') newFilters.priceMax = 50;
      else if (p.budget === 'Under $75') newFilters.priceMax = 75;
      else if (p.budget === 'Under $100') newFilters.priceMax = 100;
    }

    // Onboarding chips are manual user clicks → tag as 'ui'
    onFiltersChange(newFilters, 'ui');
  }, [onFiltersChange]);

  // On mount — check for quiz params first, then fallback to stored profile
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const source = params.get('source');

      if (source === 'quiz') {
        const childAge = params.get('child_age') || '6-8';
        const borough = (params.get('borough') || '').toLowerCase();
        const interests = (params.get('interests') || '').split(',').map(s => s.trim()).filter(Boolean);
        const pain = params.get('pain') || '';

        // Parse age range → ageMax
        const ageParts = childAge.replace('+', '-18').split('-').map(Number);
        const ageMax = ageParts[ageParts.length - 1] || 8;

        // Map quiz interests → API categories
        const cats = new Set<string>();
        interests.forEach(i => {
          (QUIZ_INTEREST_TO_CATEGORIES[i.toLowerCase()] || []).forEach(c => cats.add(c));
        });

        // Map borough → neighborhoods
        const neighborhoods = BOROUGH_TO_NEIGHBORHOODS[borough] || [];

        // Build filters
        const newFilters: FilterState = { ageMax };
        if (cats.size > 0) newFilters.categories = [...cats];
        if (neighborhoods.length > 0) newFilters.neighborhoods = neighborhoods;
        if (pain === 'too_expensive') newFilters.isFree = true;

        // Build profile & store
        const interestLabels = interests.map(i => i.charAt(0).toUpperCase() + i.slice(1));
        const child: ChildProfile = { age: ageMax, gender: 'unknown', interests: interestLabels };
        const quizProfile: UserProfile = {
          children: [child],
          neighborhoods,
          budget: pain === 'too_expensive' ? 'Free only' : 'Any budget',
        };
        setProfile(quizProfile);
        storeProfile(quizProfile);
        setOnboardingDone(true);
        setOnboardingStep('done');
        // Quiz onboarding → 'ui' (user clicked through chips / quiz URL)
        onFiltersChange(newFilters, 'ui');

        // Chat message
        const boroughLabel = borough.charAt(0).toUpperCase() + borough.slice(1);
        setMessages([{
          role: 'assistant',
          content: `Great picks for your family! Here's what I found:\n\n\uD83D\uDC76 Kids age ${childAge}\n\uD83D\uDCCD ${boroughLabel}\n\u2B50 ${interestLabels.join(', ')}\n\nI've filtered the best events for you. Feel free to ask me anything to refine!`,
        }]);

        // Clean URL without reload
        window.history.replaceState({}, '', '/');
        return;
      }
    }

    const stored = getStoredProfile();
    if (stored) {
      setProfile(stored);
      setOnboardingDone(true);
      setOnboardingStep('done');
      // Only auto-apply profile filters once per page load — not on remounts
      // triggered by the global Reset button.
      const w = window as unknown as { __pulseup_profile_filters_applied?: boolean };
      if (!w.__pulseup_profile_filters_applied) {
        applyProfileFilters(stored);
        w.__pulseup_profile_filters_applied = true;
      }
      setMessages([{ role: 'assistant', content: 'Welcome back! I remember your preferences. Ask me anything about events!' }]);
    } else {
      setMessages([{ role: 'assistant', content: "Hi! I'm your event assistant. Tell me about your children \u2014 their ages and how many. For example: \"daughter 6 and son 3\"" }]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, selectedItems]);

  // Parse children via LLM
  const parseChildren = useCallback(async (text: string) => {
    setParsingChildren(true);
    setLoading(true);
    setMessages((prev) => [...prev, { role: 'user', content: text }]);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'parse_children', message: text }),
      });
      if (!res.ok) throw new Error('Failed to parse');
      const data = await res.json();
      const children = (data.children || []) as ChildProfile[];

      if (children.length === 0) {
        setMessages((prev) => [...prev, {
          role: 'assistant',
          content: "I couldn't understand that. Could you describe your children? For example: \"daughter 6 and son 3\"",
        }]);
        return;
      }

      setParsedChildren(children);
      partialProfileRef.current.children = children;
      applyProfileFilters(partialProfileRef.current);
      setCurrentChildIndex(0);
      setSelectedItems(new Set());
      setOnboardingStep('q2_interests');
      const child = children[0];
      const label = child.name || `your ${child.age}-year-old`;
      setMessages((prev) => [...prev, { role: 'assistant', content: `Got it! What does ${label} enjoy?` }]);
    } catch {
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: 'Sorry, something went wrong. Please try again \u2014 describe your children.',
      }]);
    } finally {
      setParsingChildren(false);
      setLoading(false);
    }
  }, []);

  // Reset
  const resetProfile = useCallback(() => {
    localStorage.removeItem('pulseup_profile');
    setProfile(null);
    setOnboardingDone(false);
    setOnboardingStep('q1_children');
    setParsedChildren([]);
    setCurrentChildIndex(0);
    setSelectedItems(new Set());
    partialProfileRef.current = {};
    // Profile reset wipes filters too
    onFiltersChange({}, 'reset');
    setMessages([{ role: 'assistant', content: "Hi! I'm your event assistant. Tell me about your children \u2014 their ages and how many. For example: \"daughter 6 and son 3\"" }]);
  }, [onFiltersChange]);

  // Handle multi-select toggle
  const handleToggle = useCallback((item: string) => {
    setSelectedItems((prev) => {
      const next = new Set(prev);
      if (onboardingStep === 'q3_neighborhoods') {
        if (item === 'Anywhere in NYC') {
          return next.has(item) ? new Set() : new Set([item]);
        } else {
          next.delete('Anywhere in NYC');
          if (next.has(item)) next.delete(item);
          else next.add(item);
          return next;
        }
      }
      if (next.has(item)) next.delete(item);
      else next.add(item);
      return next;
    });
  }, [onboardingStep]);

  // Handle multi-select Done
  const handleMultiDone = useCallback(() => {
    const selected = [...selectedItems];
    if (selected.length === 0) return;

    if (onboardingStep === 'q2_interests') {
      const updatedChildren = [...parsedChildren];
      updatedChildren[currentChildIndex] = { ...updatedChildren[currentChildIndex], interests: selected };
      setParsedChildren(updatedChildren);

      setMessages((prev) => [...prev, { role: 'user', content: selected.join(', ') }]);
      setSelectedItems(new Set());

      const nextIdx = currentChildIndex + 1;
      if (nextIdx < parsedChildren.length) {
        setCurrentChildIndex(nextIdx);
        const child = parsedChildren[nextIdx];
        const label = child.name || `your ${child.age}-year-old`;
        setMessages((prev) => [...prev, { role: 'assistant', content: `What does ${label} enjoy?` }]);
      } else {
        partialProfileRef.current.children = updatedChildren;
        applyProfileFilters(partialProfileRef.current);
        setOnboardingStep('q3_neighborhoods');
        setMessages((prev) => [...prev, { role: 'assistant', content: 'Which neighborhoods are you interested in?' }]);
      }
    } else if (onboardingStep === 'q3_neighborhoods') {
      partialProfileRef.current.neighborhoods = selected;
      applyProfileFilters(partialProfileRef.current);
      setMessages((prev) => [
        ...prev,
        { role: 'user', content: selected.join(', ') },
        { role: 'assistant', content: 'Any budget preference?', quickReplies: BUDGET_OPTIONS },
      ]);
      setSelectedItems(new Set());
      setOnboardingStep('q4_budget');
    }
  }, [selectedItems, onboardingStep, parsedChildren, currentChildIndex, applyProfileFilters]);

  // Handle skip (Q5)
  const handleSkip = useCallback(() => {
    partialProfileRef.current.specialNeeds = '';
    finishOnboarding();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Finish onboarding
  const finishOnboarding = useCallback(() => {
    const finalProfile: UserProfile = {
      children: partialProfileRef.current.children || parsedChildren,
      neighborhoods: partialProfileRef.current.neighborhoods || [],
      budget: partialProfileRef.current.budget || 'Any budget',
      specialNeeds: partialProfileRef.current.specialNeeds,
    };
    setProfile(finalProfile);
    storeProfile(finalProfile);
    setOnboardingDone(true);
    setOnboardingStep('done');
    track('onboarding_completed', { children_count: finalProfile.children.length, neighborhoods_count: finalProfile.neighborhoods.length });
    applyProfileFilters(finalProfile);

    const childrenDesc = finalProfile.children.map((c) =>
      `${genderEmoji(c.gender)} ${c.name || `${c.age}yo`} \u2014 ${c.interests.join(', ')}`
    ).join('\n');

    setMessages((prev) => [...prev, {
      role: 'assistant',
      content: `All set! Here's your profile:\n\n${childrenDesc}\n\uD83D\uDCCD ${finalProfile.neighborhoods.length ? finalProfile.neighborhoods.join(', ') : 'Anywhere in NYC'}\n\uD83D\uDCB0 ${finalProfile.budget}${finalProfile.specialNeeds ? `\n\uD83D\uDCDD ${finalProfile.specialNeeds}` : ''}\n\nAsk me anything about events!`,
    }]);
  }, [parsedChildren, applyProfileFilters]);

  // Handle quick reply
  const handleQuickReply = useCallback((reply: string) => {
    if (onboardingStep === 'q4_budget') {
      partialProfileRef.current.budget = reply;
      applyProfileFilters(partialProfileRef.current);
      setMessages((prev) => [
        ...prev,
        { role: 'user', content: reply },
        { role: 'assistant', content: 'Any special preferences? (allergies, accessibility, indoor/outdoor, etc.)', showSkip: true },
      ]);
      setOnboardingStep('q5_special');
    } else if (onboardingDone) {
      sendMessage(reply);
    }
  }, [onboardingStep, parsedChildren, applyProfileFilters, onboardingDone]);

  // Send message
  const sendMessage = useCallback(async (text?: string) => {
    const msgText = (text || input).trim();
    if (!msgText || loading) return;

    if (msgText.toLowerCase() === 'reset' || msgText.toLowerCase() === '/start') {
      setInput('');
      resetProfile();
      return;
    }

    if (onboardingStep === 'q1_children') {
      setInput('');
      await parseChildren(msgText);
      return;
    }

    if (onboardingStep === 'q5_special') {
      setInput('');
      setMessages((prev) => [...prev, { role: 'user', content: msgText }]);
      partialProfileRef.current.specialNeeds = msgText;
      finishOnboarding();
      return;
    }

    if (!onboardingDone) {
      setInput('');
      return;
    }

    const userMessage: ChatMessage = { role: 'user', content: msgText };
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput('');
    setLoading(true);
    trackChatMessageSent({
      message_length: msgText.length,
      has_active_filters: !!(filters && Object.keys(filters).length),
    });
    const __recsStart = Date.now();

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: msgText,
          history: newMessages.map((m) => ({ role: m.role, content: m.content })),
          profile,
        }),
      });

      if (!res.ok) throw new Error('Chat request failed');

      const data = await res.json();
      setMessages((prev) => [...prev, {
        role: 'assistant',
        content: data.message || 'I found some events for you.',
        events: data.events,
        filters: data.filters,
      }]);

      trackChatResponseReceived({
        query: msgText,
        events_count: (data.events?.length ?? data.total) || 0,
        latency_ms: Date.now() - __recsStart,
      });

      if (data.filters && Object.keys(data.filters).length > 0) {
        // AI-generated filters → tag as 'chat'
        onFiltersChange(data.filters, 'chat');
      }
    } catch (err) {
      trackError({ type: 'chat_request_failed', message: err instanceof Error ? err.message : String(err) });
      setMessages((prev) => [...prev, { role: 'assistant', content: 'Sorry, something went wrong. Please try again.' }]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, messages, filters, onFiltersChange, profile, onboardingDone, onboardingStep, parseChildren, finishOnboarding, resetProfile]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // Multi-select state to pass to ChatMessages
  const multiSelectState: MultiSelectState | null = useMemo(() => {
    if (onboardingStep === 'q2_interests') {
      return {
        options: INTEREST_OPTIONS,
        selected: selectedItems,
        onToggle: handleToggle,
        onDone: handleMultiDone,
        doneLabel: 'Done',
      };
    }
    if (onboardingStep === 'q3_neighborhoods') {
      return {
        options: NEIGHBORHOOD_OPTIONS,
        selected: selectedItems,
        onToggle: handleToggle,
        onDone: handleMultiDone,
        doneLabel: 'Done',
      };
    }
    return null;
  }, [onboardingStep, selectedItems, handleToggle, handleMultiDone]);

  // Placeholder text
  const placeholder = useMemo(() => {
    if (onboardingStep === 'q1_children') return 'e.g. "daughter 6 and son 3"';
    if (onboardingStep === 'q5_special') return 'e.g. "no nuts, wheelchair accessible"';
    if (onboardingDone) return 'Ask about events...';
    return '';
  }, [onboardingStep, onboardingDone]);

  // Show input only for free-text steps and post-onboarding
  const showInput = onboardingStep === 'q1_children' || onboardingStep === 'q5_special' || onboardingDone;

  const chatContent = (
    <div className="chat-sidebar-inner">
      {/* data-ph-no-capture: PostHog Session Replay will mask this area.
          It contains children's names/ages typed by the user and echoed
          in the AI chat, which counts as PII we never want recorded. */}
      <div className="chat-sidebar-messages" data-ph-no-capture>
        <ChatMessages
          messages={messages}
          isLoading={loading || parsingChildren}
          onEventClick={onEventClick}
          onQuickReply={handleQuickReply}
          multiSelectState={multiSelectState}
          onSkip={handleSkip}
        />
        <div ref={messagesEndRef} />
      </div>

      {showInput && (
        <div className="chat-sidebar-input">
          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              rows={1}
              data-ph-no-capture
              className="flex-1 resize-none px-3 py-2 border border-[rgba(255,255,255,0.1)] rounded-xl text-sm focus:outline-none focus:border-[#e91e63] max-h-24 bg-[#16143a] text-white placeholder-gray-500"
              style={{ minHeight: 38 }}
            />
            <button
              onClick={() => sendMessage()}
              disabled={!input.trim() || loading}
              className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-full text-white disabled:opacity-40 transition-opacity"
              style={{ backgroundColor: '#e91e63' }}
            >
              {loading ? (
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <span className="text-lg leading-none">&uarr;</span>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <>
      {/* Desktop: render inline (parent handles layout) */}
      <div className="hidden md:flex flex-col flex-1 min-h-0">{chatContent}</div>

      {/* Mobile: FAB + slide-up panel */}
      <button onClick={() => setMobileOpen(true)} className="chat-mobile-fab" style={{ backgroundColor: '#e91e63' }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        {messages.length > 0 && (
          <span className="absolute -top-1 -right-1 w-5 h-5 bg-white text-[#e91e63] text-xs font-bold rounded-full flex items-center justify-center">
            {messages.length}
          </span>
        )}
      </button>

      {mobileOpen && (
        <>
          <div className="chat-mobile-backdrop" onClick={() => setMobileOpen(false)} />
          <div className="chat-mobile-panel">
            <div className="flex items-center justify-between px-4 py-3 border-b border-[rgba(255,255,255,0.08)]">
              <span className="font-semibold text-sm text-white">Pulse Assistant</span>
              <button
                onClick={() => setMobileOpen(false)}
                className="w-7 h-7 flex items-center justify-center rounded-full text-gray-400 hover:text-white hover:bg-[rgba(255,255,255,0.06)]"
              >
                &#10005;
              </button>
            </div>
            {chatContent}
          </div>
        </>
      )}
    </>
  );
}
