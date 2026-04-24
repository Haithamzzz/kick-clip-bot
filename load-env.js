import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Same folder as `index.js` — always this path, not your shell’s cwd */
export const envPath = path.join(__dirname, '.env');

// If the shell already has empty DISCORD_TOKEN / CLIENT_ID, default dotenv would skip the file
const result = dotenv.config({ path: envPath, override: true });
if (result.error) {
  console.error(
    `Could not read ${envPath} — are you in the right folder, and is .env there?`
  );
  console.error(result.error.message);
} else {
  for (const key of ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID']) {
    const v = process.env[key];
    if (typeof v === 'string') process.env[key] = v.trim();
  }
}
