import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const DEFAULT_MAX_BYTES = 24 * 1024 * 1024; // stay under Discord's 25 MB cap

function probeDuration(file) {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('close', () => resolve(parseFloat(out.trim()) || 0));
    p.on('error', () => resolve(0));
  });
}

async function compressWithFfmpeg(inFile, outFile, targetBytes) {
  const duration = await probeDuration(inFile);
  if (!duration) return false;

  // Reserve ~5% headroom and subtract audio bitrate to compute video bitrate.
  const targetBits = targetBytes * 8 * 0.95;
  const audioKbps = 96;
  const totalKbps = Math.floor(targetBits / duration / 1000);
  const videoKbps = Math.max(totalKbps - audioKbps, 300);

  return new Promise((resolve) => {
    const p = spawn('ffmpeg', [
      '-y',
      '-i', inFile,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-b:v', `${videoKbps}k`,
      '-maxrate', `${videoKbps}k`,
      '-bufsize', `${videoKbps * 2}k`,
      '-c:a', 'aac',
      '-b:a', `${audioKbps}k`,
      '-movflags', '+faststart',
      outFile,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    const errLines = [];
    p.stderr.on('data', (d) => {
      const line = d.toString().trim();
      if (line) errLines.push(line);
    });
    p.on('close', (code) => {
      if (code !== 0) {
        console.log('[ffmpeg] stderr:', errLines.slice(-3).join(' | '));
      }
      resolve(code === 0);
    });
    p.on('error', (err) => {
      console.log('[ffmpeg] spawn error:', err.message);
      resolve(false);
    });
  });
}

function runYtDlp(pageUrl, outFile, { timeoutMs, impersonate, cookie }) {
  const args = [
    '-f', 'best[ext=mp4]/best[vcodec!=none][acodec!=none]/best',
    '-o', outFile,
    '--no-playlist',
    '--no-warnings',
    '--quiet',
    '--no-progress',
    '--retries', '10',
    '--extractor-retries', '5',
    '--socket-timeout', '15',
  ];
  if (impersonate) args.push('--impersonate', impersonate);
  args.push(
    '--user-agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    '--add-header', 'Referer:https://kick.com/',
    '--add-header', 'Origin:https://kick.com',
    '--add-header', 'Accept-Language:en-US,en;q=0.9',
  );
  if (cookie) args.push('--add-header', `Cookie:${cookie}`);
  args.push(pageUrl);

  return new Promise((resolve) => {
    const p = spawn('yt-dlp', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const errLines = [];
    p.stderr.on('data', (d) => {
      const line = d.toString().trim();
      if (line) errLines.push(line);
    });
    const timer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch {}
      resolve({ ok: false, reason: 'timeout', stderr: errLines });
    }, timeoutMs);
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stderr: errLines });
    });
    p.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: 'spawn', error: err.message, stderr: errLines });
    });
  });
}

/**
 * Download a Kick clip via yt-dlp to a temp file, auto-compressing with ffmpeg
 * if the source exceeds `maxBytes`. Retries across impersonation targets since
 * Cloudflare can 403 intermittently on data-center IPs. Returns a Buffer or null.
 */
export async function downloadClipWithYtDlp(pageUrl, {
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = 120_000,
} = {}) {
  const tmpDir = os.tmpdir();
  const id = crypto.randomBytes(8).toString('hex');
  const inFile = path.join(tmpDir, `clip-${id}.mp4`);
  const outFile = path.join(tmpDir, `clip-${id}-c.mp4`);
  const cookie = process.env.KICK_COOKIE?.trim();

  // Try a few impersonation targets; Cloudflare sometimes lets one through
  // while blocking another from the same IP.
  const targets = ['chrome', 'chrome-120', 'safari', 'edge'];
  let ok = false;

  for (const target of targets) {
    console.log(`[yt-dlp] attempt impersonate=${target}`);
    const res = await runYtDlp(pageUrl, inFile, { timeoutMs, impersonate: target, cookie });
    if (res.ok) {
      ok = true;
      break;
    }
    const tail = (res.stderr || []).slice(-2).join(' | ');
    console.log(`[yt-dlp] failed (${res.reason || 'exit'} code=${res.code ?? ''}): ${tail}`);
    await fs.unlink(inFile).catch(() => {});
  }

  if (!ok) {
    await fs.unlink(inFile).catch(() => {});
    return null;
  }

  const stat = await fs.stat(inFile).catch(() => null);
  if (!stat) return null;

  console.log(`[yt-dlp] downloaded ${stat.size} bytes`);

  let finalFile = inFile;

  if (stat.size > maxBytes) {
    console.log(`[yt-dlp] exceeds ${maxBytes} bytes — compressing with ffmpeg`);
    const compressed = await compressWithFfmpeg(inFile, outFile, maxBytes);
    if (compressed) {
      const cstat = await fs.stat(outFile).catch(() => null);
      if (cstat) {
        console.log(`[ffmpeg] compressed to ${cstat.size} bytes`);
        if (cstat.size <= maxBytes) finalFile = outFile;
      }
    }
  }

  const buf = await fs.readFile(finalFile).catch(() => null);
  await fs.unlink(inFile).catch(() => {});
  if (finalFile !== inFile) await fs.unlink(outFile).catch(() => {});

  if (!buf || buf.length > maxBytes) {
    console.log('[yt-dlp] final buffer too large or missing');
    return null;
  }
  return buf;
}
