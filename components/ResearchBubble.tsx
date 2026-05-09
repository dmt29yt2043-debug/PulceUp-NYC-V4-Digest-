'use client';

/**
 * ResearchBubble — recruitment widget for PulseUP user research sessions.
 *
 * Trigger logic:
 *   · Primary:  ≥ 30s on the page AND ≥ 2 user interactions (click/scroll/touch)
 *   · Fallback: ≥ 60s on the page regardless of interactions
 *
 * Suppression (so we don't nag a user who's already engaging):
 *   · Cookie `pulseup_research_invited=1` on domain `.pulseup.me` — suppresses
 *     for 7 days. Set when user clicks the CTA, OR by the research app
 *     (research4.pulseup.me) when the session starts.
 *   · localStorage `pulseup_research_dismissed_at` — suppresses for 24h after
 *     user dismisses with ✕ or "Not now, thanks".
 *   · Not shown on /quiz pages.
 */

import { useEffect, useRef, useState } from 'react';
import { trackEvent } from '@/lib/analytics';

const INTERACTION_TIMER_MS = 30_000;
const FALLBACK_TIMER_MS    = 60_000;
const INVITED_COOKIE       = 'pulseup_research_invited';
const INVITED_TTL_DAYS     = 7;
const DISMISS_KEY          = 'pulseup_research_dismissed_at';
const DISMISS_TTL_HOURS    = 24;
const DEBUG = true;

// ─── Module-level singleton state ─────────────────────────────────────────
// Why: the React effect cleanup was firing in production after ~20s without a
// matching remount (likely a Next.js 16 / React 19 / PostHog runtime quirk),
// which cleared the setTimeout calls and prevented the bubble from EVER
// appearing. Hoisting state out of the effect makes the timers immune to
// React lifecycle changes — they now run from page load until they fire,
// regardless of how many times ResearchBubble's effect mounts/unmounts.
let _setupStarted = false;
let _alreadyShown = false;
let _interactions = 0;
let _timeReady = false;
const _setVisibleListeners = new Set<(v: boolean) => void>();

function _broadcastVisible(v: boolean) {
  _setVisibleListeners.forEach((fn) => fn(v));
}

function _showNow(reason: string) {
  if (_alreadyShown) return;
  _alreadyShown = true;
  if (DEBUG) console.log('[ResearchBubble]', 'showing bubble, reason:', reason);
  // Analytics: critical to know HOW MANY users actually see the recruitment
  // bubble vs how many click through to the research. Without this we have a
  // blind spot in the conversion funnel between "engaged with main app" and
  // "started research session".
  try { trackEvent('research_shown', { reason }); } catch { /* swallow */ }
  _broadcastVisible(true);
}

function _tryShow() {
  if (_alreadyShown) return;
  if (_timeReady && _interactions >= 2) _showNow(`30s + ${_interactions} interactions`);
}

function _onInteraction(e: Event) {
  _interactions++;
  if (DEBUG && _interactions <= 3) console.log('[ResearchBubble]', `interaction ${_interactions}: ${e.type}`);
  _tryShow();
}

function log(...args: unknown[]) {
  if (DEBUG) console.log('[ResearchBubble]', ...args);
}

function hasInvitedCookie(): boolean {
  if (typeof document === 'undefined') return false;
  return document.cookie.split(';').some(c => c.trim().startsWith(`${INVITED_COOKIE}=1`));
}

function setInvitedCookie() {
  if (typeof document === 'undefined') return;
  const maxAge = INVITED_TTL_DAYS * 24 * 60 * 60;
  // Domain `.pulseup.me` makes the cookie readable on research4.pulseup.me
  // too — and vice-versa. On localhost we fall back to a host cookie so it
  // still works in dev.
  const host = window.location.hostname;
  const domainPart = host.endsWith('pulseup.me') ? '; domain=.pulseup.me' : '';
  document.cookie = `${INVITED_COOKIE}=1${domainPart}; path=/; max-age=${maxAge}; samesite=lax`;
}

function wasRecentlyDismissed(): boolean {
  if (typeof localStorage === 'undefined') return false;
  const raw = localStorage.getItem(DISMISS_KEY);
  if (!raw) return false;
  const ts = Number(raw);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < DISMISS_TTL_HOURS * 60 * 60 * 1000;
}

function markDismissed() {
  try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch {}
}

export default function ResearchBubble() {
  const [visible, setVisible] = useState(_alreadyShown);
  const setVisibleRef = useRef(setVisible);
  setVisibleRef.current = setVisible;

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Subscribe — re-fired any time _showNow is called.
    const listener = (v: boolean) => setVisibleRef.current(v);
    _setVisibleListeners.add(listener);
    // If the bubble was already triggered before this effect ran (e.g. effect
    // cleaned up + remounted), reflect that immediately.
    if (_alreadyShown) setVisibleRef.current(true);

    // ── One-time setup (module level — survives effect cleanup) ──
    if (!_setupStarted) {
      _setupStarted = true;

      if (window.location.pathname.includes('/quiz')) {
        log('skipped: /quiz path');
      } else if (hasInvitedCookie()) {
        log('skipped: invited cookie present (user already engaged with research)');
      } else if (wasRecentlyDismissed()) {
        log('skipped: user dismissed within last 24h');
      } else {
        log('setup once: waiting for 30s + 2 interactions or 60s fallback');

        document.addEventListener('click',      _onInteraction, { passive: true });
        document.addEventListener('scroll',     _onInteraction, { passive: true, capture: true });
        document.addEventListener('touchstart', _onInteraction, { passive: true });
        window.addEventListener('scroll',       _onInteraction, { passive: true });

        // INTENTIONAL: timers are NOT cleared anywhere. They live until they fire
        // (or until the page unloads). A previous version cleared them in the
        // React effect cleanup, which fired prematurely in prod and prevented
        // the bubble from ever showing.
        setTimeout(() => {
          _timeReady = true;
          log('30s timer fired; interactions so far:', _interactions);
          _tryShow();
        }, INTERACTION_TIMER_MS);

        setTimeout(() => {
          _showNow(`60s fallback (${_interactions} interactions)`);
        }, FALLBACK_TIMER_MS);
      }
    }

    return () => {
      // Only unsubscribe — DON'T tear down listeners or timers, those are
      // module-level and shared across all mounts of this component.
      _setVisibleListeners.delete(listener);
    };
  }, []);

  if (!visible) return null;

  const close = () => {
    log('dismissed by user — suppressing for 24h');
    try { trackEvent('research_dismissed', {}); } catch { /* swallow */ }
    markDismissed();
    // Broadcast to all subscribed mounts + reset module state so a remount
    // of this component doesn't immediately re-open the bubble.
    _alreadyShown = true;       // keep flag true so timers won't re-trigger
    _broadcastVisible(false);
  };

  const onCtaClick = () => {
    log('CTA clicked — setting invited cookie, suppressing for 7d');
    // Track BEFORE opening the new tab — if we trust posthog's keepalive
    // setting, the event survives the navigation.
    try { trackEvent('research_cta_clicked', {}); } catch { /* swallow */ }
    setInvitedCookie();
    // Hide immediately so if the new tab fails to open, the user isn't left
    // staring at a now-irrelevant bubble.
    _alreadyShown = true;
    _broadcastVisible(false);
  };

  return (
    <div className="research-bubble" role="complementary" aria-label="Research recruitment">
      {/* Chat-bubble icon (top left) */}
      <div className="research-bubble__badge" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#e91e63" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          <path d="M9 10.5c.5.5 1.2.8 2 .8h2c.8 0 1.5-.3 2-.8" strokeLinecap="round" />
          <circle cx="8.5" cy="9" r="0.6" fill="#e91e63" stroke="none" />
          <circle cx="15.5" cy="9" r="0.6" fill="#e91e63" stroke="none" />
        </svg>
      </div>

      {/* Close (top right) */}
      <button
        className="research-bubble__close"
        onClick={close}
        aria-label="Close research invitation"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
      </button>

      <h3 className="research-bubble__title">We&rsquo;re still improving this</h3>
      <p className="research-bubble__lede">
        Want to help us make it better for parents in NYC?
      </p>
      <p className="research-bubble__body">
        We&rsquo;re inviting a few people to share quick feedback.
      </p>

      {/* Info row: duration + reward */}
      <div className="research-bubble__info">
        <div className="research-bubble__info-item">
          <span className="research-bubble__info-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e91e63" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <polyline points="12 7 12 12 15 14" />
            </svg>
          </span>
          <span className="research-bubble__info-text">~10 minutes</span>
        </div>
        <div className="research-bubble__info-item">
          <span className="research-bubble__info-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e91e63" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="8" width="18" height="4" rx="1" />
              <path d="M12 8v13" />
              <path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" />
              <path d="M7.5 8a2.5 2.5 0 1 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 1 1 0 5z" />
            </svg>
          </span>
          <span className="research-bubble__info-text">
            <strong>$10 Amazon gift card</strong>
            <em>as a thank you</em>
          </span>
        </div>
      </div>

      <a
        href="https://research4.pulseup.me/participant/pulseup-v4-research/welcome?ref=bubble"
        target="_blank"
        rel="noopener noreferrer"
        className="research-bubble__cta"
        onClick={onCtaClick}
      >
        Tell me more <span aria-hidden="true">→</span>
      </a>

      <button className="research-bubble__dismiss" onClick={close}>
        Not now, thanks
      </button>
    </div>
  );
}
