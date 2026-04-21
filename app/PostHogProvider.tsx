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

    posthog.init(key, {
      api_host: host,
      ui_host: 'https://us.posthog.com',

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
