'use client';

import { useEffect, useState } from 'react';
import DigestCard from './DigestCard';

interface Digest {
  id: number;
  slug: string;
  title: string;
  subtitle: string;
  cover_image: string;
  category_tag: string;
  curator_name: string;
  curator_role: string;
  event_count: number;
  context_tags: string;
  category: string;
}

interface Category {
  name: string;
  digests: Digest[];
}

const QUICK_TAGS = [
  { label: '👦 For Boys',  tag: 'boys'    },
  { label: '👧 Girly',     tag: 'girls'   },
  { label: '🌿 Outdoor',   tag: 'outdoor' },
];

interface DigestShelfProps {
  /**
   * Called when user picks a digest. The host page should fetch the digest's
   * events and replace the feed with them (digest-as-filter behavior).
   * Clicking the currently active digest toggles it off.
   */
  onDigestSelect: (slug: string) => void;
  /** Slug of the currently selected digest (for highlight). `null` = none. */
  activeDigestSlug: string | null;
}

export default function DigestShelf({ onDigestSelect, activeDigestSlug }: DigestShelfProps) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [activeTag, setActiveTag] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/digests')
      .then(r => r.json())
      .then(d => setCategories(d.categories || []))
      .catch(console.error);
  }, []);

  const filterDigests = (digests: Digest[]) => {
    if (!activeTag) return digests;
    return digests.filter(d => {
      const tags: string[] = JSON.parse(d.context_tags || '[]');
      return tags.some(t => t.toLowerCase().includes(activeTag));
    });
  };

  const allDigests = categories.flatMap(cat => filterDigests(cat.digests));

  if (categories.length === 0) return null;

  return (
    <div className="digest-shelf">
      {/* Header with inline tag pills */}
      <div className="digest-shelf-header">
        <div className="digest-shelf-title-row">
          <div>
            <h2 className="digest-shelf-title">Mom&apos;s Digest</h2>
            <p className="digest-shelf-sub">Curated collections for your lifestyle.</p>
          </div>
          <div className="digest-shelf-tags">
            <button
              className={`digest-tag-pill digest-tag-pill--all ${activeTag === null ? 'active' : ''}`}
              onClick={() => setActiveTag(null)}
            >
              All Digest
            </button>
            {QUICK_TAGS.map(qt => (
              <button
                key={qt.tag}
                className={`digest-tag-pill ${activeTag === qt.tag ? 'active' : ''}`}
                onClick={() => setActiveTag(activeTag === qt.tag ? null : qt.tag)}
              >
                {qt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Single horizontal scroll row */}
      <div className="digest-shelf-row">
        {allDigests.map(d => (
          <DigestCard
            key={d.slug}
            digest={d}
            onClick={onDigestSelect}
            isActive={activeDigestSlug === d.slug}
          />
        ))}
      </div>
    </div>
  );
}
