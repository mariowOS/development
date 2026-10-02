const fs = require('node:fs');
const path = require('node:path');

const settingPath = path.join(__dirname, 'boot-mode.json');
const command = process.argv[2];

function readVerboseMode() {
  if (!fs.existsSync(settingPath)) return false;
  const setting = JSON.parse(fs.readFileSync(settingPath, 'utf8'));
  if (typeof setting.verbose !== 'boolean') {
    throw new Error(`Invalid verbose boot setting in ${settingPath}`);
  }
  return setting.verbose;
}

try {
  if (command === 'verbose' || command === 'on') {
    fs.writeFileSync(settingPath, `${JSON.stringify({ verbose: true }, null, 2)}\n`, 'utf8');
    console.log('Verbose boot enabled. It will remain enabled until you run "npm run boot:quiet".');
  } else if (command === 'quiet' || command === 'off') {
    try {
      fs.unlinkSync(settingPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    console.log('Verbose boot disabled.');
  } else if (command === 'status') {
    console.log(`Verbose boot is ${readVerboseMode() ? 'enabled' : 'disabled'}.`);
  } else {
    console.error('Usage: node system/boot-mode.js <verbose|quiet|status>');
    console.error('       npm run boot:verbose | npm run boot:quiet | npm run boot:status');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`Could not update verbose boot mode: ${error.message}`);
  process.exitCode = 1;
}
