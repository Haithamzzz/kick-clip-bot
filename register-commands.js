import { envPath } from './load-env.js';
import { REST, Routes } from 'discord.js';

const commands = [
  {
    name: 'addclip',
    description: 'Post a Kick-style clip in the channel (manual URL + title)',
    options: [
      {
        name: 'url',
        type: 3, // STRING
        description: 'Full clip page URL (e.g. kick.com/.../clip/... or any watch link)',
        required: true,
      },
      {
        name: 'title',
        type: 3,
        description: 'Headline for “New Kick Clip | …”',
        required: true,
      },
      {
        name: 'image',
        type: 3,
        description: 'Optional thumbnail image URL (direct link)',
        required: false,
      },
      {
        name: 'thumbnail',
        type: 11, // ATTACHMENT
        description: 'Optional thumbnail upload (best for guaranteed image)',
        required: false,
      },
    ],
  },
];

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID.');
  console.error('Edit this file (two lines, no spaces around =, no quotes needed):');
  console.error(' ', envPath);
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

try {
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: commands,
    });
    console.log(`Registered guild commands for guild ${guildId}.`);
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('Registered global commands (can take up to 1h to show).');
  }
} catch (e) {
  console.error(e);
  process.exit(1);
}
