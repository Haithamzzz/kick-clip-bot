import { envPath } from './load-env.js';
import {
  ActionRowBuilder,
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

const EMBED_COLOR = 0x232428;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

function isLikelyImageAttachment(att) {
  if (!att?.url) return false;
  if (att.contentType?.startsWith('image/')) return true;
  return /\.(png|jpe?g|webp|gif)(\?.*)?$/i.test(att.url);
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
  videoUrl,
}) {
  const headerLines = [`New Kick Clip | ${title}`];
  // Put the mp4 on its own line so Discord unfurls it as an inline video player.
  if (videoUrl) headerLines.push(videoUrl);
  // Always include the clip page URL; hide auto-unfurl if we already have media/image.
  headerLines.push(videoUrl || imageUrl ? `<${pageUrl}>` : pageUrl);

  const embeds = [];
  if (!videoUrl && imageUrl) {
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

  return {
    content: headerLines.join('\n'),
    embeds,
    components: [row],
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

    let videoUrl = null;
    let imageUrl = thumbnailAttachment?.url || overrideImage || null;

    if (parsed.kind === 'kick' && parsed.clipId) {
      const kick = await fetchKickClipData(parsed.clipId);
      if (kick?.videoUrl) videoUrl = kick.videoUrl;
      if (!imageUrl && kick?.thumbnailUrl) imageUrl = kick.thumbnailUrl;
    }

    if (!imageUrl && !videoUrl) {
      imageUrl = await findLatestImageFromUser(interaction);
    }
    if (!imageUrl && !videoUrl) {
      imageUrl = await fetchOpenGraphImage(parsed.canonicalUrl);
      if (!imageUrl && pageUrl !== parsed.canonicalUrl) {
        imageUrl = await fetchOpenGraphImage(pageUrl);
      }
    }

    const { content, embeds, components } = buildClipMessage({
      title,
      pageUrl: parsed.canonicalUrl,
      displayHandle: parsed.displayHandle,
      imageUrl: imageUrl || null,
      videoUrl: videoUrl || null,
    });

    await interaction.editReply({ content, embeds, components });
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
