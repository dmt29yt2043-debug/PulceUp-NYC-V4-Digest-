'use client';

/**
 * /results is the legacy quiz-landing URL (per docs/quiz-url-contract.md).
 * We no longer render a separate results UI — instead we forward the user to
 * the main app (/) with the quiz params preserved. ChatSidebar reads them,
 * parses children/borough/interests/pain, applies filters + saves profile,
 * and the user lands on the normal feed with their preferences set.
 */
import { useEffect, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

function ResultsRedirect() {
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    // Preserve every quiz param when forwarding to the main app.
    const qs = searchParams.toString();
    router.replace(qs ? `/?${qs}` : '/');
  }, [searchParams, router]);

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0f0d2e',
      color: '#9ca3af',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 14,
    }}>
      Loading your personalized feed…
    </div>
  );
}

export default function ResultsPage() {
  return (
    <Suspense fallback={null}>
      <ResultsRedirect />
    </Suspense>
  );
}
