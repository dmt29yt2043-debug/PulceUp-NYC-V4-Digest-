'use client';

import { useState, useEffect } from 'react';
import type { ChatMessage, ChildProfile, Event } from '@/lib/types';

const THINKING_STEPS = [
  'Understanding your request\u2026',
  'Searching the event database\u2026',
  'Matching your preferences\u2026',
  'Picking the best options\u2026',
];

function ThinkingIndicator() {
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    if (stepIndex >= THINKING_STEPS.length - 1) return;
    const delay = 800 + Math.random() * 600;
    const timer = setTimeout(() => setStepIndex((s) => s + 1), delay);
    return () => clearTimeout(timer);
  }, [stepIndex]);

  return (
    <div className="inline-block max-w-[85%] px-3 py-2 rounded-xl text-sm leading-relaxed bg-[#1e1b4b] text-gray-300">
      <div className="space-y-1">
        {THINKING_STEPS.slice(0, stepIndex + 1).map((step, i) => {
          const isActive = i === stepIndex && stepIndex < THINKING_STEPS.length - 1;
          const isDone = i < stepIndex || stepIndex === THINKING_STEPS.length - 1;
          return (
            <div key={i} className="flex items-center gap-1.5 thinking-step-enter">
              {isDone && !isActive ? (
                <svg className="w-3.5 h-3.5 text-green-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <span className="flex-shrink-0 w-3.5 h-3.5 flex items-center justify-center">
                  <span className="thinking-dot" />
                </span>
              )}
              <span className={isDone && !isActive ? 'text-gray-500' : 'text-gray-200 font-medium'}>
                {step}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function genderEmoji(gender: string): string {
  return gender === 'girl' ? '\uD83D\uDC67' : gender === 'boy' ? '\uD83D\uDC66' : '\uD83E\uDDD2';
}

const INTEREST_EMOJIS: Record<string, string> = {
  'Active': '\u26BD', 'Creative': '\uD83C\uDFA8', 'Educational': '\uD83D\uDCDA', 'Shows': '\uD83C\uDFAD',
  'Outdoor': '\uD83C\uDF33', 'Fun & Play': '\uD83C\uDFAE', 'Adventure': '\uD83C\uDFD4\uFE0F', 'Books': '\uD83D\uDCD6', 'Social': '\uD83D\uDC6B',
};

function ChildSummaryBlock({ children }: { children: ChildProfile[] }) {
  return (
    <div className="mt-2 child-summary-card">
      {children.map((child, i) => (
        <div key={i} className="flex items-center gap-2 py-1">
          <span className="text-lg">{genderEmoji(child.gender)}</span>
          <span className="text-sm font-medium text-white">
            {child.name || `Child ${i + 1}`}, {child.age}yo
          </span>
        </div>
      ))}
    </div>
  );
}

function InterestSummaryBlock({ children }: { children: ChildProfile[] }) {
  return (
    <div className="mt-2 child-summary-card">
      {children.map((child, i) => (
        <div key={i} className="py-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-lg">{genderEmoji(child.gender)}</span>
            <span className="text-xs font-semibold text-gray-300">
              {child.name || `${child.age}yo`}
            </span>
          </div>
          <div className="flex flex-wrap gap-1 mt-1 ml-7">
            {child.interests.map((int) => (
              <span key={int} className="text-[11px] bg-[rgba(233,30,99,0.15)] text-pink-300 px-1.5 py-0.5 rounded-full">
                {INTEREST_EMOJIS[int] || ''} {int}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export interface MultiSelectState {
  options: string[];
  selected: Set<string>;
  onToggle: (item: string) => void;
  onDone: () => void;
  doneLabel?: string;
}

/**
 * State for the final email-capture step in onboarding. Rendered only on the
 * last assistant message — we show an email input + submit + "Not now" skip.
 */
export interface EmailAskState {
  submitting: boolean;
  error?: string;
  onSubmit: (email: string) => void;
  onSkip: () => void;
}

function EmailAskBlock({ state }: { state: EmailAskState }) {
  const [email, setEmail] = useState('');
  const disabled = state.submitting || email.trim().length < 5;
  const submit = () => {
    if (disabled) return;
    state.onSubmit(email.trim());
  };
  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-stretch gap-1.5">
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          data-ph-no-capture
          className="flex-1 min-w-0 px-3 py-2 rounded-xl text-sm bg-[#2a2760] text-white placeholder-gray-400 border border-[rgba(255,255,255,0.15)] focus:outline-none focus:border-[#e91e63]"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled}
          className="px-3 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-40 transition-opacity whitespace-nowrap"
          style={{ backgroundColor: '#e91e63' }}
        >
          {state.submitting ? '…' : 'Send weekly'}
        </button>
      </div>
      {state.error && (
        <div className="text-xs text-[#ff8d89]">{state.error}</div>
      )}
      <button
        type="button"
        onClick={state.onSkip}
        disabled={state.submitting}
        className="skip-btn"
      >
        Not now, thanks
      </button>
    </div>
  );
}

interface ChatMessagesProps {
  messages: ChatMessage[];
  isLoading?: boolean;
  onEventClick?: (event: Event) => void;
  onQuickReply?: (reply: string) => void;
  multiSelectState?: MultiSelectState | null;
  emailAskState?: EmailAskState | null;
  onSkip?: () => void;
}

export default function ChatMessages({
  messages, isLoading, onQuickReply,
  multiSelectState, emailAskState, onSkip,
}: ChatMessagesProps) {
  if (messages.length === 0 && !isLoading) return null;

  return (
    <div className="px-3 py-3 space-y-3">
      {messages.map((msg, i) => {
        const isLast = i === messages.length - 1;
        return (
          <div key={i}>
            {/* Message bubble */}
            {msg.content && (
              <>
                <div
                  className={`inline-block max-w-[85%] px-3 py-2 rounded-xl text-sm leading-relaxed whitespace-pre-line ${
                    msg.role === 'user'
                      ? 'ml-auto bg-[#e91e63] text-white float-right'
                      : 'bg-[#1e1b4b] text-gray-200'
                  }`}
                >
                  {msg.content}
                </div>
                <div className="clear-both" />
              </>
            )}

            {/* Child summary block */}
            {msg.childSummary && msg.childSummary.length > 0 && (
              <ChildSummaryBlock children={msg.childSummary} />
            )}

            {/* Interest summary block */}
            {msg.interestSummary && msg.interestSummary.length > 0 && (
              <InterestSummaryBlock children={msg.interestSummary} />
            )}


            {/* Quick reply buttons - only show on the last assistant message */}
            {msg.role === 'assistant' && isLast && msg.quickReplies && msg.quickReplies.length > 0 && onQuickReply && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {msg.quickReplies.map((reply) => (
                  <button key={reply} onClick={() => onQuickReply(reply)} className="quick-reply-pill">
                    {reply}
                  </button>
                ))}
              </div>
            )}

            {/* Multi-select buttons - only on last assistant message */}
            {msg.role === 'assistant' && isLast && multiSelectState && (
              <div className="mt-2">
                <div className="flex flex-wrap gap-1.5">
                  {multiSelectState.options.map((opt) => {
                    const isSelected = multiSelectState.selected.has(opt);
                    return (
                      <button
                        key={opt}
                        onClick={() => multiSelectState.onToggle(opt)}
                        className={`multi-select-btn ${isSelected ? 'selected' : ''}`}
                      >
                        {isSelected && <span className="mr-1">{'\u2713'}</span>}
                        {opt}
                      </button>
                    );
                  })}
                </div>
                <button
                  onClick={multiSelectState.onDone}
                  disabled={multiSelectState.selected.size === 0}
                  className="onboarding-done-btn mt-2"
                >
                  {multiSelectState.doneLabel || 'Done'}
                </button>
              </div>
            )}

            {/* Skip button */}
            {msg.role === 'assistant' && isLast && msg.showSkip && onSkip && (
              <div className="mt-2">
                <button onClick={onSkip} className="skip-btn">Skip</button>
              </div>
            )}

            {/* Email-capture block — last onboarding step */}
            {msg.role === 'assistant' && isLast && emailAskState && (
              <EmailAskBlock state={emailAskState} />
            )}
          </div>
        );
      })}

      {/* Thinking indicator */}
      {isLoading && (
        <div>
          <ThinkingIndicator />
          <div className="clear-both" />
        </div>
      )}
    </div>
  );
}
