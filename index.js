import { envPath } from './load-env.js';
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

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

function isLikelyImageAttachment(att) {
  if (!att?.url) return false;
  if (att.contentType?.startsWith('image/')) return true;
  return /\.(png|jpe?g|webp|gif)(\?.*)?$/i.test(att.url);
}

/**
 * Download a remote mp4 to memory, bounded by `maxBytes` so we never hit Discord's
 * per-message upload ceiling. Returns Buffer or null on failure / oversize.
 */
async function downloadMp4ToBuffer(videoUrl, maxBytes = 24 * 1024 * 1024) {
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

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        try { reader.cancel(); } catch {}
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
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
  videoBuffer,
}) {
  const headerLines = [`New Kick Clip | ${title}`];
  // When we attach the mp4 file, hide the auto-link so Discord shows only the attachment preview.
  headerLines.push(videoBuffer || imageUrl ? `<${pageUrl}>` : pageUrl);

  const embeds = [];
  if (!videoBuffer && imageUrl) {
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

  const files = videoBuffer
    ? [new AttachmentBuilder(videoBuffer, { name: 'clip.mp4' })]
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

    let videoBuffer = null;
    let imageUrl = thumbnailAttachment?.url || overrideImage || null;

    if (parsed.kind === 'kick' && parsed.clipId) {
      // Primary: yt-dlp (bypasses Cloudflare using its built-in Kick extractor).
      console.log(`[addclip] yt-dlp downloading ${parsed.canonicalUrl}`);
      videoBuffer = await downloadClipWithYtDlp(parsed.canonicalUrl);
      console.log('[addclip] yt-dlp result:', {
        ok: Boolean(videoBuffer),
        bytes: videoBuffer?.length ?? 0,
      });

      if (!videoBuffer) {
        // Fallback: try direct Kick API (may need KICK_COOKIE).
        console.log('[addclip] falling back to Kick API');
        const kick = await fetchKickClipData(parsed.clipId);
        console.log('[addclip] kick api:', kick?.debug);
        if (kick?.videoUrl) {
          videoBuffer = await downloadMp4ToBuffer(kick.videoUrl);
        }
        if (!imageUrl && kick?.thumbnailUrl) imageUrl = kick.thumbnailUrl;
      }
    }

    if (!imageUrl && !videoBuffer) {
      imageUrl = await findLatestImageFromUser(interaction);
    }
    if (!imageUrl && !videoBuffer) {
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
      videoBuffer,
    });

    await interaction.editReply({ content, embeds, components, files });
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
