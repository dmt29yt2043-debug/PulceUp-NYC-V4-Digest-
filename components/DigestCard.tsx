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
  SEASONAL:    '#4ade80',
  'VIBE CHECK':'#a78bfa',
  CULTURE:     '#fb923c',
  HOLIDAY:     '#f472b6',
  WEEKEND:     '#38bdf8',
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

      {/* Category tag top-left */}
      <span className="digest-card-tag" style={{ color: tagColor }}>
        {digest.category_tag}
      </span>

      {/* Bottom content */}
      <div className="digest-card-body">
        <h3 className="digest-card-title">{digest.title}</h3>
        {digest.subtitle && (
          <p className="digest-card-sub">{digest.subtitle}</p>
        )}
        <div className="digest-card-meta">
          <span className="digest-card-events">{digest.event_count} events</span>
          <span className="digest-card-curator">by {digest.curator_name}</span>
        </div>
      </div>
    </div>
  );
}
