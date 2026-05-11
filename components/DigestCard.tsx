'use client';

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
}

interface DigestCardProps {
  digest: Digest;
  onClick: (slug: string) => void;
  isActive?: boolean;
}

const TAG_COLORS: Record<string, string> = {
  // legacy — kept in case older digest data is cached somewhere
  SEASONAL:        '#4ade80',
  'VIBE CHECK':    '#a78bfa',
  CULTURE:         '#fb923c',
  HOLIDAY:         '#f472b6',
  // original 5 programmatic digests
  WEEKEND:         '#38bdf8',  // light blue
  INDOOR:          '#fbbf24',  // warm amber — cosy / rainy-day
  EASY:            '#86efac',  // mint
  BUDGET:          '#4ade80',  // green (also used by $25 or less)
  POPULAR:         '#f472b6',  // pink
  // 10 parent-query digests
  ARTS:            '#f97316',  // orange — creativity
  SCIENCE:         '#22d3ee',  // cyan — STEM
  ACTIVE:          '#84cc16',  // lime — energy
  BOOKS:           '#a78bfa',  // lavender — literary
  TODDLER:         '#fca5a5',  // soft pink — tiny humans
  TEENS:           '#818cf8',  // indigo — older kids
  BABY:            '#fbcfe8',  // baby pink
  'AFTER-SCHOOL':  '#fde047',  // warm yellow
  BROOKLYN:        '#14b8a6',  // teal — borough highlight
};

export default function DigestCard({ digest, onClick, isActive = false }: DigestCardProps) {
  const tagColor = TAG_COLORS[digest.category_tag] || '#94a3b8';

  return (
    <div
      className={`digest-card${isActive ? ' digest-card--active' : ''}`}
      onClick={() => onClick(digest.slug)}
    >
      {/* Cover image */}
      <div className="digest-card-img">
        {digest.cover_image && (
          <img src={digest.cover_image} alt={digest.title} loading="lazy" />
        )}
        <div className="digest-card-gradient" />
      </div>

      {/* Title at top — the main affordance. Photo peeks through below. */}
      <div className="digest-card-body">
        <h3 className="digest-card-title">{digest.title}</h3>
      </div>

      {/* Category tag at the bottom */}
      <span className="digest-card-tag" style={{ color: tagColor }}>
        {digest.category_tag}
      </span>
    </div>
  );
}
