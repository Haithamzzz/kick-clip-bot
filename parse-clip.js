/**
 * Extract streamer @handle and a stable clip page URL from user-provided links.
 * Supports kick.com clip URLs and generic clip hosts (e.g. mirror pages).
 */
export function parseClipInput(rawUrl) {
  const u = new URL(rawUrl);
  const host = u.hostname.replace(/^www\./, '');

  // https://kick.com/{user}/clip/{id} or /clips/{id}
  if (host === 'kick.com' || host === 'm.kick.com') {
    const m = u.pathname.match(/^\/([^/]+)\/(clip|clips)\/([^/]+)\/?/i);
    if (m) {
      const username = m[1];
      return {
        kind: 'kick',
        handle: username,
        displayHandle: `@${username}`,
        // Preserve the original submitted path style (`/clip/` vs `/clips/`)
        canonicalUrl: `https://kick.com${u.pathname}${u.search}`,
      };
    }
  }

  // e.g. https://clips.example.com/watch/kick/n3on/clip_xxxxx
  const watchKick = u.pathname.match(
    /\/watch\/kick\/([^/]+)\/([^/]+)\/?$/i
  );
  if (watchKick) {
    const username = watchKick[1];
    return {
      kind: 'watch_mirror',
      handle: username,
      displayHandle: `@${username}`,
      canonicalUrl: rawUrl,
    };
  }

  // Fallback: no structured kick path — use last path segment or host as context
  const pathParts = u.pathname.split('/').filter(Boolean);
  const guess = pathParts[0] || 'clip';
  return {
    kind: 'link',
    handle: guess,
    displayHandle: `@${guess}`,
    canonicalUrl: rawUrl,
  };
}

const metaImageRes = [
  // Open Graph
  /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
  /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i,
  // Generic/meta itemprop image
  /<meta[^>]+itemprop=["']image["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+itemprop=["']image["']/i,
  // Twitter / X
  /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+name=["']twitter:image:src["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
  // JSON-LD / inlined app state often used by clip pages
  /"thumbnailUrl"\s*:\s*"([^"]+)"/i,
  /"thumbnail_url"\s*:\s*"([^"]+)"/i,
];

/**
 * Best-effort thumbnail for embed. Reads Open Graph + Twitter image tags from the clip page HTML.
 * Kick and third-party clip pages usually set at least one of these. If this returns null (bot
 * blocked, SPA-only meta, or no tags), use `/addclip` option `image` with a direct image URL.
 */
export async function fetchOpenGraphImage(pageUrl) {
  try {
    const res = await fetch(pageUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    for (const re of metaImageRes) {
      const m = html.match(re);
      if (m?.[1]) {
        const u = m[1].replace(/&amp;/g, '&').trim();
        if (u && !u.startsWith('data:')) return u;
      }
    }
    return null;
  } catch {
    return null;
  }
}
