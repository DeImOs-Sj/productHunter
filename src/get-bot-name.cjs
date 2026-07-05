// Get bot username
const fs = require("fs");
const path = require("path");
const envFile = path.resolve(".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.log("TELEGRAM_BOT_TOKEN not found"); process.exit(1); }
fetch(`https://api.telegram.org/bot${token}/getMe`)
  .then(r => r.json())
  .then(d => console.log(d.ok ? `Bot username: @${d.result.username}` : `Error: ${d.description}`))
  .catch(e => console.log("Error:", e.message));
