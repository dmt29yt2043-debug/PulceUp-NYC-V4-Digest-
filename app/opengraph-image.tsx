/**
 * Dynamically generates the 1200×630 Open Graph card used in social-media
 * link previews. Next.js picks this up by filename convention and exposes it
 * at /opengraph-image (and auto-wires it into the root <meta> tags).
 *
 * The logo file (`public/logo.png`) is 2834×865 — using it directly as the
 * og:image would be cropped awkwardly by Facebook / Telegram / iMessage.
 * This card places the logo on a branded background with the tagline below.
 */

import { ImageResponse } from 'next/og';
import fs from 'fs';
import path from 'path';

export const alt = 'PulseUp — Better Moments with your Kids. Less Planning';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Inline the logo as a data URL so the edge runtime doesn't need to fetch it.
function getLogoDataUrl(): string {
  try {
    const logoPath = path.join(process.cwd(), 'public', 'logo.png');
    const bytes = fs.readFileSync(logoPath);
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } catch {
    return '';
  }
}

export default async function OGImage() {
  const logo = getLogoDataUrl();

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          // Matches the app's body background: dark indigo with pink accent glow.
          background:
            'radial-gradient(circle at 30% 40%, rgba(233, 30, 99, 0.25), transparent 55%), ' +
            'radial-gradient(circle at 75% 70%, rgba(124, 58, 237, 0.20), transparent 60%), ' +
            '#0f0d2e',
          padding: '80px',
          fontFamily: 'sans-serif',
        }}
      >
        {/* Logo — wide aspect, so constrain by width */}
        {logo && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logo}
            alt="PulseUp"
            width={720}
            style={{ objectFit: 'contain', marginBottom: 48 }}
          />
        )}

        {/* Tagline */}
        <div
          style={{
            fontSize: 60,
            fontWeight: 700,
            color: '#ffffff',
            textAlign: 'center',
            lineHeight: 1.15,
            letterSpacing: '-0.02em',
            maxWidth: 1000,
          }}
        >
          Better Moments with your Kids.
        </div>
        <div
          style={{
            fontSize: 60,
            fontWeight: 700,
            color: '#e91e63',            // brand pink
            textAlign: 'center',
            lineHeight: 1.15,
            letterSpacing: '-0.02em',
            marginTop: 8,
          }}
        >
          Less Planning.
        </div>
      </div>
    ),
    size,
  );
}
