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
      const clipId = m[3];
      return {
        kind: 'kick',
        handle: username,
        displayHandle: `@${username}`,
        clipId,
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
    const origin = new URL(pageUrl).origin;
    const res = await fetch(pageUrl, {
      headers: kickBrowserHeaders({ referer: origin + '/' }),
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

function kickBrowserHeaders({ referer } = {}) {
  const kickCookie = process.env.KICK_COOKIE?.trim();
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: referer || 'https://kick.com/',
    DNT: '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1',
    ...(kickCookie ? { Cookie: kickCookie } : {}),
  };
}

/**
 * Ask Kick's v2 clip API for the direct video mp4 URL + thumbnail.
 * Returns { videoUrl, thumbnailUrl, title, duration, channelSlug } or null.
 */
export async function fetchKickClipData(clipId) {
  if (!clipId) return null;
  const apiUrl = `https://kick.com/api/v2/clips/${encodeURIComponent(clipId)}`;
  try {
    const res = await fetch(apiUrl, {
      headers: {
        ...kickBrowserHeaders({ referer: 'https://kick.com/' }),
        Accept: 'application/json, text/plain, */*',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      },
      signal: AbortSignal.timeout(15_000),
    });
    const debug = `${res.status} ${res.statusText}`;
    if (!res.ok) {
      console.log(`[kick api] non-ok response: ${debug}`);
      return { debug };
    }
    const data = await res.json().catch(() => null);
    if (!data) return { debug: `${debug} (no json)` };

    const clip = data.clip || data;
    const videoUrl = clip.clip_url || clip.video_url || clip.video?.url || null;
    const thumbnailUrl = clip.thumbnail_url || clip.thumbnail?.src || null;
    const title = clip.title || null;
    const duration = clip.duration || null;
    const channelSlug = clip.channel?.slug || clip.channel_slug || null;

    return { videoUrl, thumbnailUrl, title, duration, channelSlug, debug };
  } catch (err) {
    console.log('[kick api] error:', err?.message || String(err));
    return { debug: `err: ${err?.message || 'unknown'}` };
  }
}
