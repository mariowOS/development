// Sends the release in version.json to Discord (see workflows/announce-release.yml).
const fs = require("fs");

const webhook = process.env.DISCORD_WEBHOOK_URL;
if (!webhook) {
  console.log("DISCORD_WEBHOOK_URL is not set: nothing to announce.");
  process.exit(0);
}

const { version, changelog } = JSON.parse(fs.readFileSync("version.json", "utf8"));
const channel = process.env.CHANNEL_NAME || "stable";
const body = {
  username: "mariowOS",
  embeds: [{
    title: `mariowOS ${version} is out`,
    url: process.env.REPOSITORY_URL || undefined,
    description: `${String(changelog || "").slice(0, 3500)}\n\nUpdate from **Settings › Updater**.`,
    color: 0x2e5d4a,
    footer: { text: `${channel} channel` },
    timestamp: new Date().toISOString()
  }]
};

fetch(webhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  .then(response => {
    if (!response.ok) throw new Error(`Discord answered ${response.status}`);
    console.log(`Announced mariowOS ${version}.`);
  })
  .catch(error => {
    console.error(error.message);
    process.exit(1);
  });
