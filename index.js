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
import { fetchOpenGraphImage, parseClipInput } from './parse-clip.js';

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

function buildClipMessage({ title, pageUrl, displayHandle, imageUrl }) {
  // If we have our own image, suppress Discord auto-unfurl (<...>) and use custom embed.
  // If not, send raw URL so Discord can auto-preview Kick (often includes thumbnail).
  const content = imageUrl
    ? `New Kick Clip | ${title}\n<${pageUrl}>`
    : `New Kick Clip | ${title}\n${pageUrl}`;

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setAuthor({ name: displayHandle })
    .setTitle('Kick Clip')
    .setURL(pageUrl)
    .setTimestamp();

  if (imageUrl) embed.setImage(imageUrl);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Download Clip')
      .setStyle(ButtonStyle.Link)
      .setURL(pageUrl)
      .setEmoji('📥')
  );

  return {
    content,
    embeds: imageUrl ? [embed] : [],
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

    let imageUrl = thumbnailAttachment?.url || overrideImage || null;
    if (!imageUrl) {
      imageUrl = await findLatestImageFromUser(interaction);
    }
    if (!imageUrl) {
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
