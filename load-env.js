import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Same folder as `index.js` — always this path, not your shell’s cwd */
export const envPath = path.join(__dirname, '.env');

// Local dev: read .env if present. Cloud (Railway): file may not exist, use platform vars.
dotenv.config({ path: envPath, override: true, quiet: true });

for (const key of ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID']) {
  const v = process.env[key];
  if (typeof v === 'string') process.env[key] = v.trim();
}
