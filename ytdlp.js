import { spawn } from 'node:child_process';

/**
 * Download a Kick clip (or any yt-dlp supported URL) and return an in-memory Buffer.
 * Streams the mp4 through yt-dlp's stdout. Enforces a hard size cap so the bot
 * never exceeds Discord's upload limit — returns `null` if oversize or download fails.
 */
export async function downloadClipWithYtDlp(pageUrl, {
  maxBytes = 24 * 1024 * 1024,
  timeoutMs = 90_000,
} = {}) {
  return new Promise((resolve) => {
    let finished = false;
    const chunks = [];
    let received = 0;
    const errLines = [];

    const args = [
      '-f', 'best[ext=mp4]/best[vcodec!=none][acodec!=none]/best',
      '-o', '-',
      '--no-playlist',
      '--no-warnings',
      '--quiet',
      '--no-progress',
      '--restrict-filenames',
      '--impersonate', 'chrome',
      '--user-agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      '--add-header', 'Referer:https://kick.com/',
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
    ];

    const cookie = process.env.KICK_COOKIE?.trim();
    if (cookie) {
      args.push('--add-header', `Cookie:${cookie}`);
    }

    args.push(pageUrl);

    const proc = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        try { proc.kill('SIGKILL'); } catch {}
        console.log('[yt-dlp] timeout');
        resolve(null);
      }
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          try { proc.kill('SIGKILL'); } catch {}
          console.log(`[yt-dlp] exceeded maxBytes (${received})`);
          resolve(null);
        }
        return;
      }
      chunks.push(chunk);
    });

    proc.stderr.on('data', (d) => {
      const line = d.toString().trim();
      if (line) errLines.push(line);
    });

    proc.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      console.log('[yt-dlp] spawn error:', err.message);
      resolve(null);
    });

    proc.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code === 0 && chunks.length > 0) {
        resolve(Buffer.concat(chunks));
      } else {
        if (errLines.length) {
          console.log('[yt-dlp] stderr:', errLines.slice(-5).join(' | '));
        }
        console.log(`[yt-dlp] exit code ${code}, bytes=${received}`);
        resolve(null);
      }
    });
  });
}
