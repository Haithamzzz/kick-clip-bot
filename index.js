import { envPath } from './load-env.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  EmbedBuilder,
} from 'discord.js';
import {
  fetchKickClipData,
  fetchOpenGraphImage,
  parseClipInput,
} from './parse-clip.js';
import { downloadClipWithYtDlp } from './ytdlp.js';

const EMBED_COLOR = 0x232428;
const DEFAULT_UPLOAD_LIMIT_BYTES = 10 * 1024 * 1024;
const UPLOAD_LIMIT_HEADROOM_RATIO = 0.98;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

function isLikelyImageAttachment(att) {
  if (!att?.url) return false;
  if (att.contentType?.startsWith('image/')) return true;
  return /\.(png|jpe?g|webp|gif)(\?.*)?$/i.test(att.url);
}

/**
 * Download a remote mp4 to disk, bounded by `maxBytes` so we never hit Discord's
 * per-attachment upload ceiling. Returns { filePath, bytes, dispose } or null.
 */
async function downloadMp4ToFile(videoUrl, maxBytes) {
  const filePath = path.join(
    os.tmpdir(),
    `clip-${crypto.randomBytes(8).toString('hex')}.mp4`
  );
  let handle = null;

  try {
    const res = await fetch(videoUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'video/mp4,video/*;q=0.9,*/*;q=0.8',
        Referer: 'https://kick.com/',
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok || !res.body) return null;

    const contentLength = Number(res.headers.get('content-length'));
    if (contentLength && contentLength > maxBytes) return null;

    handle = await fs.open(filePath, 'wx');
    const reader = res.body.getReader();
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        try { reader.cancel(); } catch {}
        await handle.close().catch(() => {});
        handle = null;
        await fs.unlink(filePath).catch(() => {});
        return null;
      }
      await handle.write(Buffer.from(value));
    }

    await handle.close();
    handle = null;

    return {
      filePath,
      bytes: received,
      dispose: async () => {
        await fs.unlink(filePath).catch(() => {});
      },
    };
  } catch {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(filePath).catch(() => {});
    return null;
  }
}

function getUsableUploadLimit(interaction) {
  const rawLimit = Number(interaction.attachmentSizeLimit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? rawLimit
    : DEFAULT_UPLOAD_LIMIT_BYTES;
  return Math.floor(limit * UPLOAD_LIMIT_HEADROOM_RATIO);
}

async function findLatestImageFromUser(interaction, limit = 30) {
  const channel = interaction.channel;
  if (!channel?.isTextBased?.() || !channel.messages?.fetch) return null;

  try {
    const messages = await channel.messages.fetch({ limit });
    for (const msg of messages.values()) {
      if (msg.author?.id !== interaction.user.id) continue;
      const img = msg.attachments.find((att) => isLikelyImageAttachment(att));
      if (img?.url) return img.url;
    }
  } catch {
    // Ignore fetch errors and continue with other thumbnail methods
  }
  return null;
}

function buildClipMessage({
  title,
  pageUrl,
  displayHandle,
  imageUrl,
  videoFile,
}) {
  const headerLines = [`New Kick Clip | ${title}`];
  // When we attach the mp4 file, hide the auto-link so Discord shows only the attachment preview.
  headerLines.push(videoFile || imageUrl ? `<${pageUrl}>` : pageUrl);

  const embeds = [];
  if (!videoFile && imageUrl) {
    embeds.push(
      new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setAuthor({ name: displayHandle })
        .setTitle('Kick Clip')
        .setURL(pageUrl)
        .setImage(imageUrl)
        .setTimestamp()
    );
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Download Clip')
      .setStyle(ButtonStyle.Link)
      .setURL(pageUrl)
      .setEmoji('📥')
  );

  const files = videoFile
    ? [new AttachmentBuilder(videoFile.filePath, { name: 'clip.mp4' })]
    : [];

  return {
    content: headerLines.join('\n'),
    embeds,
    components: [row],
    files,
  };
}

client.once(Events.ClientReady, (c) => {
  console.log(`Ready as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName !== 'addclip') return;

    const rawUrl = interaction.options.getString('url', true).trim();
    const title = interaction.options.getString('title', true).trim();
    const overrideImage = interaction.options.getString('image')?.trim();
    const thumbnailAttachment = interaction.options.getAttachment('thumbnail');

    let pageUrl;
    try {
      pageUrl = new URL(rawUrl).href;
    } catch {
      await interaction.reply({
        content: 'That URL is not valid.',
        ephemeral: true,
      });
      return;
    }

    const parsed = parseClipInput(pageUrl);
    await interaction.deferReply();

    const maxUploadBytes = getUsableUploadLimit(interaction);
    console.log('[addclip] upload limit:', {
      grantedBytes: interaction.attachmentSizeLimit ?? null,
      usableBytes: maxUploadBytes,
    });

    let videoFile = null;
    let imageUrl = thumbnailAttachment?.url || overrideImage || null;

    if (parsed.kind === 'kick' && parsed.clipId) {
      // Primary: yt-dlp (bypasses Cloudflare using its built-in Kick extractor).
      console.log(`[addclip] yt-dlp downloading ${parsed.canonicalUrl}`);
      videoFile = await downloadClipWithYtDlp(parsed.canonicalUrl, {
        maxBytes: maxUploadBytes,
      });
      console.log('[addclip] yt-dlp result:', {
        ok: Boolean(videoFile),
        bytes: videoFile?.bytes ?? 0,
      });

      if (!videoFile) {
        // Fallback: try direct Kick API (may need KICK_COOKIE).
        console.log('[addclip] falling back to Kick API');
        const kick = await fetchKickClipData(parsed.clipId);
        console.log('[addclip] kick api:', kick?.debug);
        if (kick?.videoUrl) {
          videoFile = await downloadMp4ToFile(kick.videoUrl, maxUploadBytes);
        }
        if (!imageUrl && kick?.thumbnailUrl) imageUrl = kick.thumbnailUrl;
      }
    }

    if (!imageUrl && !videoFile) {
      imageUrl = await findLatestImageFromUser(interaction);
    }
    if (!imageUrl && !videoFile) {
      imageUrl = await fetchOpenGraphImage(parsed.canonicalUrl);
      if (!imageUrl && pageUrl !== parsed.canonicalUrl) {
        imageUrl = await fetchOpenGraphImage(pageUrl);
      }
    }

    const { content, embeds, components, files } = buildClipMessage({
      title,
      pageUrl: parsed.canonicalUrl,
      displayHandle: parsed.displayHandle,
      imageUrl: imageUrl || null,
      videoFile,
    });

    try {
      await interaction.editReply({ content, embeds, components, files });
    } finally {
      if (videoFile) await videoFile.dispose();
    }
    return;
  }
});

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Set DISCORD_TOKEN in:');
  console.error(' ', envPath);
  process.exit(1);
}

client.login(token);
