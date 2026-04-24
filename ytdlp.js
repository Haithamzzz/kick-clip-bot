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

/**
 * Download a Kick clip via yt-dlp to a temp file, auto-compressing with ffmpeg
 * if the source exceeds `maxBytes`. Returns an in-memory Buffer or null on failure.
 */
export async function downloadClipWithYtDlp(pageUrl, {
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = 120_000,
} = {}) {
  const tmpDir = os.tmpdir();
  const id = crypto.randomBytes(8).toString('hex');
  const inFile = path.join(tmpDir, `clip-${id}.mp4`);
  const outFile = path.join(tmpDir, `clip-${id}-c.mp4`);

  const args = [
    '-f', 'best[ext=mp4]/best[vcodec!=none][acodec!=none]/best',
    '-o', inFile,
    '--no-playlist',
    '--no-warnings',
    '--quiet',
    '--no-progress',
    '--impersonate', 'chrome',
    '--user-agent',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    '--add-header', 'Referer:https://kick.com/',
    '--add-header', 'Accept-Language:en-US,en;q=0.9',
  ];

  const cookie = process.env.KICK_COOKIE?.trim();
  if (cookie) args.push('--add-header', `Cookie:${cookie}`);

  args.push(pageUrl);

  const ok = await new Promise((resolve) => {
    const p = spawn('yt-dlp', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const errLines = [];
    p.stderr.on('data', (d) => {
      const line = d.toString().trim();
      if (line) errLines.push(line);
    });
    const timer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch {}
      console.log('[yt-dlp] timeout');
      resolve(false);
    }, timeoutMs);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.log(`[yt-dlp] exit ${code}`, errLines.slice(-3).join(' | '));
      }
      resolve(code === 0);
    });
    p.on('error', (err) => {
      clearTimeout(timer);
      console.log('[yt-dlp] spawn error:', err.message);
      resolve(false);
    });
  });

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
