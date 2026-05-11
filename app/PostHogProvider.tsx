'use client';

import posthog from 'posthog-js';
import { PostHogProvider as PHProvider } from 'posthog-js/react';
import { useEffect, useState } from 'react';

export default function PostHogProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';
    const recordEnabled = process.env.NEXT_PUBLIC_POSTHOG_RECORD_ENABLED === 'true';

    if (!key) {
      // No key — analytics silently disabled (dev without env or Meta Pixel only)
      setReady(true);
      return;
    }

    // E2E bypass — mirror of the quiz's PostHogProvider check. Without this
    // the cross-domain bridge silently drops `quiz_arrival` for every test
    // run because PostHog refuses to initialise under a headless UA. We
    // detect E2E via the marker the quiz forwards in its redirect URL
    // (utm_source=fb_e2e or utm_campaign=e2e-…). Real production users are
    // unaffected — these markers are never set on real ad clicks.
    const isE2E =
      typeof window !== 'undefined' &&
      /[?&](utm_source=fb_e2e|utm_campaign=e2e-)/.test(window.location.search);

    posthog.init(key, {
      api_host: host,
      ui_host: 'https://us.posthog.com',

      // Bot UA filter bypass for E2E synthetic traffic only.
      opt_out_useragent_filter: isE2E,

      // Share distinct_id across pulseup.me ↔ quiz.pulseup.me so the
      // identity-stitch in app/page.tsx (posthog.identify(quizPhid)) can
      // actually merge the two anonymous profiles without race conditions.
      cross_subdomain_cookie: true,

      // Don't fire a page_view automatically — we'll do it ourselves in trackEvent
      capture_pageview: false,

      // Don't autocapture every click/form — we track only intentional events
      autocapture: false,

      // Anonymous profiles only until login is added
      person_profiles: 'always',

      // Session Replays — controlled by env var.
      // PII masking: elements with data-ph-no-capture are fully blocked
      // (shown as black box) — hides both rendered text AND input values.
      // Applied to: chat messages area + chat textarea in ChatSidebar.
      session_recording: {
        maskAllInputs: false,
        maskTextSelector: '[data-ph-no-capture]', // masks rendered text nodes
        blockSelector:    '[data-ph-no-capture]', // fully blocks input values too
      },
      disable_session_recording: !recordEnabled,

      // Meta Pixel integration stub — fires if pixel ID is set
      ...(process.env.NEXT_PUBLIC_META_PIXEL_ID
        ? { on_xhr_error: undefined }
        : {}),

      loaded: () => {
        setReady(true);
        // Mirror the client-side dev-mode flag so PostHog itself won't record
        // sessions from internal devices (localStorage.pulseup_dev === '1').
        try {
          if (localStorage.getItem('pulseup_dev') === '1') {
            posthog.opt_out_capturing();
          }
        } catch { /* ignore */ }
        if (process.env.NODE_ENV === 'development') {
          console.log('[PostHog] initialized, distinct_id:', posthog.get_distinct_id());
        }
      },
    });

    return () => {
      // No teardown needed — posthog is a singleton
    };
  }, []);

  // Render immediately — PostHog initializes async in the background.
  // Events queued before init completes are flushed automatically by the SDK.
  return <PHProvider client={posthog}>{children}</PHProvider>;
}
