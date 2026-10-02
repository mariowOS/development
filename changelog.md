# mariowOS Development Changelog

### Development Branch — September 2026

And we are back! This is all of what we did in this amazing month. mariowOS really has changed, a lot. You had a taste of the old Tiles desktop, but we completely reimagined how mariowOS should have looked, and here's the result. 
 
I, personally, noted all the changes and here you go. We're basically ready for you to experience mariowOS, a little fix there and here and we're soon going to drop the update for you.
# September Development Cycle

This month has been long, tedious and really blasphemous, a breakdown is:

- Application installation and removal
    
- Application Store EULAs
    
- Secondary desktop environments
    
- Rule-based automation
    
- Sandbox environments
    
- Runtime-isolated applications
    
- Hardware-aware Quick Settings
    
- OTA update infrastructure
    
- Improved Settings
    
- Better application lifecycle handling
    
- Cross-platform system integration
    

But, even if we're almost ready, the latest development tree is still explicitly considered **experimental** and is not intended to replace the stability of DosVM, as for now. (also cuz DosVM was really simple, and here uhm... not so). The thing left to do is optimize, then everything would be ready and finally out of development.

# Sandbox

One of the largest additions is the new **Sandbox** application.

Sandbox allows mariowOS to load another mariowOS-compatible system from an uploaded ZIP archive and run its `server.js` independently from the host system.
## Architecture

When you upload a ZIP, it gets decompressed and deployed into a virtual disk, which then the kernel searches for a `server.js` entry point:

```js
function findServerJs(dir) {
  if (!fs.existsSync(dir)) return null;

  const queue = [dir];

  while (queue.length > 0) {
    const current = queue.shift();
    const files = fs.readdirSync(current);

    for (const file of files) {
      const fullPath = path.join(current, file);

      if (fs.statSync(fullPath).isDirectory()) {
        queue.push(fullPath);
      } else if (file === "server.js") {
        return fullPath;
      }
    }
  }

  return null;
}
```

This means the VHD does not have to follow one hard-coded directory layout because the backend instead looks for the system entry point dynamically. 

---
## Sandbox VHD

Sandbox images can be uploaded through:

```http
POST /api/sandbox/upload
```

The uploaded archive is extracted into an isolated directory, which is then used as a virtual disk:

```text
desktop/apps/sandbox/
└── <vmId>/
    └── disk/
        ├── server.js
        ├── desktop/
        └── ...
```

Windows uses PowerShell's `Expand-Archive`, while Unix-like systems use `unzip`:

```js
if (process.platform === "win32") {
  extractCmd =
    `powershell.exe -nologo -noprofile -command ` +
    `"Expand-Archive -Path '${zipPath}' ` +
    `-DestinationPath '${vmDisk}' -Force"`;
} else {
  extractCmd = `unzip -o "${zipPath}" -d "${vmDisk}"`;
}
```

Temporary ZIP files are bombed after extraction.
# Isolated Sandbox Ports

Sandbox instances do not simply start on the normal mariowOS port, either the base system would overlap on the VM. The backend allocates ports dynamically:

```js
let currentSandboxPort = 3001;
```

When a Sandbox starts:

```js
const assignPort = currentSandboxPort++;
```

A wrapper is then generated around the sandbox's `server.js`.

The wrapper intercepts Node's HTTP server:

```js
const originalListen = http.Server.prototype.listen;

http.Server.prototype.listen = function(...args) {
  if (typeof args[0] === "number") {
    args[0] = ${assignPort};
  }

  return originalListen.apply(this, args);
};
```

The result is:

```text
	host
    │
    ├── :3000 → main system
    │
    ├── :3001 → Sandbox #1
    │
    ├── :3002 → Sandbox #2
    │
    └── :3003 → Sandbox #3
```

This allows multiple sandbox instances to coexist without directly competing for port `3000`.
# Sandbox Lifecycle

The backend now exposes a complete lifecycle API:

```http
POST /api/sandbox/upload
POST /api/sandbox/start
POST /api/sandbox/stop
POST /api/sandbox/delete
GET  /api/sandbox/status
```

Running sandboxes are tracked in memory:

```js
const activeVMs = {};
```

Each entry contains the child process and assigned port:

```js
activeVMs[vmId] = {
  process: p,
  port: assignPort
};
```

When the process exits, the instance is automatically removed:

```js
p.on('exit', () => {
  delete activeVMs[vmId];
});
```

# Store

The store received a BIG improvement

Applications can now be installed from either:

1. A Git repository
    
2. A remotely hosted single file

The installer determines which mode to use:

```js
const isSingleFile = !repoUrl.endsWith(".git");
```

### Git repositories

Repositories are cloned with a shallow clone:

```bash
git clone --progress --depth 1 <repository> <target>
```

### Single-file applications

Remote files can instead be downloaded directly:

```js
const fileRes = await fetch(repoUrl);
const content = await fileRes.text();

fs.writeFileSync(
  path.join(absolutePath, "index.html"),
  content
);
```

This makes the Store FINALLY capable of handling both complete applications and standalone web applications.

# App icons

When installing an application hosted on GitHub, mariowOS attempts to automatically download:

```text
icon.png
```

from the repository.

It checks both:

```text
main
master
```

branches.

Downloaded icons are stored locally:

```text
desktop/assets/icon_<appId>_<timestamp>.png
```

This allows Store-installed applications to retain their own branding even when the application repository is remote.
# Store EULAs

Store now supports application-specific EULAs.

Before installation, mariowOS can display an EULA overlay containing the application's license information, in both CLI and GUI stores.

Store can obtain EULA/license files from repositories using several conventional names:

```text
EULA.txt
LICENSE
LICENSE.txt
EULA
eula.txt
license.txt
```


---

# Secondary Desktop Environments (SDEs)

Store now supports installing secondary desktop environments.

`tiles` receives special handling:

```js
if (appId === "tiles") {
  const sourceHtml =
    path.join(absolutePath, "index.html");

  const targetHtml =
    path.join(__dirname, "desktop", "com.mariowos.twm.html");

  if (fs.existsSync(sourceHtml)) {
    fs.copyFileSync(sourceHtml, targetHtml);
  }
}
```

Uninstalling Tiles also removes the generated desktop entry.

This turns desktop environments into installable components rather than permanently embedded system components.

---

# Rules Engine expansion

The automation/rules engine was expanded considerably.

Rules can now be enabled or disabled globally:

```http
GET  /api/rules/enabled
POST /api/rules/enabled
```

The configuration is still:

```js
config.rulesEnabled = req.body.enabled;
fs.writeFileSync(
  configFile,
  JSON.stringify(config, null, 2)
);
```

---

## Battery Rules

Battery-triggered rules now maintain state so an event does not continuously fire while the battery remains below a threshold.

```js
const isBelowThreshold = level <= threshold;
const wasBelowThreshold =
  batteryRuleState[ruleId] === true;

batteryRuleState[ruleId] = isBelowThreshold;

if (isBelowThreshold && !wasBelowThreshold) {
  executeRuleAction(
    rule.action,
    rule.actionParams
  );
}
```

Either it will fire repeatedly spamming notifications and overall slowing down the system by using in a useless way precious system resources.

---

## Startup rules

Rules can also react to system startup.

Before launching an application, mariowOS checks whether that application is actually installed:

```js
const appIsInstalled =
  (config.installedApps || [])
    .some(app => app.appId === appId);

if (!appIsInstalled) {
  return res.status(400).json({
    success: false,
    error: "Startup app is not installed"
  });
}
```

Startup rules are also tracked to prevent duplicate execution.

---

## Rule Notifications

Rules can generate notifications through a pending notification queue:

```js
pendingRuleNotifications.push({
  title: params.title || "Rule notification",
  msg: params.message || "A rule just fired.",
  icon: params.icon || "🔔"
});
```

Notifications can then be consumed through the same notification implementation:

```http
GET /api/rules/notifications
```

---
## Rule Actions

The rules engine now supports several operations:

```text
notify
run
power-mode
dnd
shutdown
```

The shutdown action is platform-aware:

```js
const command =
  currentOS === 'win32'
    ? 'shutdown.exe'
    : 'shutdown';
```

Windows receives:

```text
shutdown.exe /s /t 60
```

while Unix-like systems use:

```text
shutdown -h +1
```

---

# Cross-Platform Quick Settings

Quick Settings became much more hardware-aware.

The backend now detects:

- Ethernet
    
- Wi-Fi
    
- Bluetooth
    
- Virtual adapters
    
- VPN adapters
    
- Tailscale
    
- ZeroTier
    
- VMware
    
- VirtualBox
    
- WSL
    
- Hyper-V

Virtual and wireless interfaces are filtered before Ethernet status is determined.

The backend also detects the connected Wi-Fi network differently depending on the host OS:

```js
if (currentOS === "win32") {
  wifiCmd = "netsh wlan show interfaces";
} else if (currentOS === "darwin") {
  wifiCmd =
    "/System/Library/PrivateFrameworks/" +
    "Apple80211.framework/Versions/Current/" +
    "Resources/airport -I";
} else {
  wifiCmd = "iwgetid -r";
}
```

---

# Cross-Platform Volume Control

Volume control was implemented with OS-specific commands.

### Linux

```bash
amixer -D pulse sset Master 50%
```

### macOS

```bash
osascript -e "set volume output volume 50"
```

### Windows

For now, current implementation maintains the volume state while using a Windows-specific placeholder command.

The value is persisted to `config.json`.

---

# Hardware Wi-Fi / Bluetooth Toggles

Quick Settings can now attempt to modify actual hardware state.

### Linux

```bash
nmcli radio wifi on
rfkill unblock bluetooth
```

This requires NetworkManager to be installed on your system. Check your distro's package manager repo on how to get nm.
### macOS

```bash
networksetup -setairportpower en0 on
blueutil -p 1
```

### Windows

```powershell
netsh interface set interface name="Wi-Fi" admin=enabled
```

Bluetooth uses PowerShell's Plug-and-Play device management.

---
# OTA Update Infrastructure

The update system received additional error handling and version fallback behavior.

The local version is loaded safely:

```js
const versionPath =
  path.join(__dirname, "version.json");

const local =
  fs.existsSync(versionPath)
    ? JSON.parse(
        fs.readFileSync(versionPath, "utf8")
      ).version
    : "1.0.0";
```

The system checks the stable repository:

```text
mariowOS/stable
```

and compares its remote `version.json` against the local version.

---

## OTA Progress Streaming

Updates are exposed as a Server-Sent Events stream:

```http
GET /api/system/ota-update
```

Progress is emitted progressively:

```text
0%   Preparing update engine...
8%   Setting up repository...
15%  Connecting to update servers...
30%  Fetching latest system image...
42%  Downloading packages...
75%  Verifying package integrity...
82%  Extracting system files...
88%  Installing update...
95%  Finalizing installation...
100% Update complete!
```

The actual update performs:

```bash
git remote set-url origin https://github.com/mariowOS/stable.git
git fetch origin main --depth=1
git reset --hard FETCH_HEAD
git clean -fd
```

The system then terminates the current process so the launcher/supervisor can restart it. (start.sh or start.bat)

---
# Notes backend

Notes are now synchronized directly through the backend:

```http
GET  /api/system/notes
POST /api/system/notes
```

The notes database is stored locally:

```text
desktop/notes-db.json
```

Malformed or missing data falls back to an empty list rather than crashing the kernel.

---

# User / Settings Improvements

The Settings application received, finally, a significant UI restructuring.

The newer Settings architecture includes dedicated sections for:

```text
Wallpaper & Style
System
Networking
Ethernet
Installed Applications
Security
Reset
User (previously You)
```

A, for now, live wallpaper preference placeholder was also separated into its own setting and synchronized through the desktop/lockscreen messaging system.

---
# Wallpaper Management

Wallpaper handling now supports:

- Custom wallpaper uploads
    
- Factory wallpaper restoration
    
- User wallpaper detection
    
- Desktop refresh after wallpaper changes

The desktop checks for:

```text
/desktop/assets/wallpaper.user.png
```

and falls back to the standard wallpaper when it is absent or corrupt.

---
# Installed Applications

The desktop can now dynamically load applications from the backend's installed application list.

Applications are stored in configuration as objects, they contain information which can be:

```json
{
  "appId": "sandbox",
  "title": "Sandbox",
  "icon": "...",
  "url": "apps/sandbox/index.html"
}
```

Applications can also be uninstalled through:

```http
POST /api/store/uninstall
```

---
# Terminal has been rebuilt!

From a lightweight "command" interface into a more complete system-oriented shell, combining obviously the original terminal utilities but now with improved command parsing.

---
## Terminal UX

Terminal retained the existing visual language but has been improved with new changes which are

The interface includes:

- Jetbrains typography
    
- `user@mariowos:$` prompt, finally volatile username in the terminal too
    
- Command input and output history
    
- Multiple terminal tabs
    
- Automatic prompt recreation after commands
    
- Command history navigation
    
- Built-in command discovery
    
- Lightweight shell aliases

---
## Command Parser

The original command parser has been expanded to support more shell-like input.

Previously, arguments were separated using a simple space split. The new parser supports quoted arguments:

```js
const rawArgs = cmd.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
const args = rawArgs.map(arg =>
  arg.replace(/^"(.*)"$/, "$1")
);
```

This allows commands such as:

```text
echo "hello world"
```

to keep `hello world` as a single argument.

Commands are also normalized to lowercase before execution.

---
## Command Aliases

The Terminal now includes a small alias system for commonly used commands.

```js
const terminalAliases = {
  "ll": "listkeys",
  "cls": "clear",
  "sysinfo": "status",
  "ver": "version",
  "uname-a": "uname",
  "net": "network"
};
```

Examples:

```text
ll
```

is equivalent to:

```text
listkeys
```

while:

```text
sysinfo
```

is an alias for:

```text
status
```

This makes the Terminal faster to use for powerusers without changing the underlying command implementation.

---
## Commands

### `help`

Displays the available commands and their descriptions.

### `clear`

Clears the current terminal output and recreates the prompt.

### `echo`

Prints supplied text.

```text
echo hello
```

### `math`

Evaluates supported mathematical expressions.

### `about`

Displays information about mariowOS.

### `lili`

The most important command, obviously.

### `addkey`

Adds a key to the local key storage.

### `listkeys`

Displays stored keys.

### `delkey`

Removes a stored key.

Example:

```text
addkey example
listkeys
delkey example
```

### `fetch`

It can now retrieve system information from the backend, including hardware/resource information such as:

- CPU information
    
- RAM information
    
- Underlying system information

We also implemented, as stated before store as a cli tool:

### `get`

Get is the package manager for mariowOS. It can:

- Download apps (get install)
    
- Remove apps (get remove)
    
- List local-repo apps (get list)
    
- Update local-repo or apps (get update/upgrade)

### `dmgr`

Used to switch between DEs.
## Automatic Package Installation

The existing package workflow can detect when functionality is unavailable and interact with the package-management layer to obtain the required component.

This creates a workflow closer to a your standard operating system shell:

```text
command
   ↓
dependency check
   ↓
package manager
   ↓
installation
   ↓
command execution
```

## `/api/terminal/status`

The backend collects information using Node.js's built-in `os` module.

The endpoint gathers:

```js
{
  hostname,
  platform,
  architecture,
  kernel,
  node,
  mariowOS,
  user,
  home,
  cwd,
  uptime,
  processUptime,
  memory,
  cpu,
  network
}
```

For example, the CPU information contains:

```js
cpu: {
  model: cpus[0]?.model || "Unknown CPU",
  cores: cpus.length,
  load: os.loadavg()
}
```

Memory information includes:

```js
memory: {
  total: os.totalmem(),
  free: os.freemem(),
  process: process.memoryUsage().rss
}
```

The endpoint also detects active non-internal IPv4 interfaces.
## Read-Only Architecture

The diagnostics API deliberately does **not** execute arbitrary shell commands.

Instead of exposing something equivalent to:

```text
POST /execute
command = ...
```

the Terminal receives predefined information from:

```text
GET /api/terminal/status
```

This creates a controlled architecture:

```text
┌─────────────────────┐
│   mariowOS Terminal │
└──────────┬──────────┘
           │
           │ GET
           ▼
┌─────────────────────┐
│ /api/terminal/status│
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│     Node.js / OS    │
│        APIs         │
└─────────────────────┘
```

The browser UI therefore does not need direct access to the host shell, making, finally, mariowOS an OS on it's own
## `status`

The new `status` command provides a complete system overview.

```text
status
```

It reports information such as:

```text
mariowOS
Hostname
Platform
Architecture
Kernel
Node.js
User
Working directory
Memory
CPU
System load
```

This is a more advanced version of `fetch`, which is mostly cosmetic
## Identity & Environment Commands

Several smaller commands were added around the same diagnostics infrastructure.

### `hostname`

Displays the machine hostname.

```text
hostname
```

### `whoami`

Displays the current system user.

```text
whoami
```

### `pwd`

Displays the server working directory.

```text
pwd
```

### `version`

Displays the current mariowOS version together with the Node.js runtime version.

```text
version
```

The mariowOS version is read from:

```text
system/version.json
```

when available.

---

# 14. `uname`

The new `uname` command provides basic kernel/platform information:

```text
uname
```

Output is based on:

```js
os.type()
os.release()
process.arch
```

The result allows the user to quickly identify the operating environment without opening a separate application.

An alias is also available:

```text
uname-a
```

## `memory`

The `memory` command converts raw byte values into human-readable units.

For example:

```text
memory
```

can display RAM information in:

```text
MB
GB
TB
```

The conversion is handled by:

```js
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }

  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
```

This keeps the Terminal output readable instead of exposing raw byte counts.
## `cpu`

The CPU diagnostic command reports:

- CPU model
    
- Number of logical cores
    
- Current system load

Example:

```text
cpu
```

The data comes directly from Node.js:

```js
os.cpus()
os.loadavg()
```

## `network`

The new network command displays active IPv4 interfaces.

```text
network
```

The backend scans:

```js
os.networkInterfaces()
```

and returns non-internal IPv4 addresses.

The Terminal then formats the information as a small HTML table containing:

```text
Interface | IPv4 Address
```

An alias is also available:

```text
net
```

## `uptime`

The `uptime` command converts the operating system uptime into a readable format.

For example:

```text
uptime
```

can produce:

```text
3d 7h 42m 18s
```

The value is obtained from:

```js
os.uptime()
```

This is separate from the Node.js process uptime exposed by the diagnostics endpoint.
## Terminal History

The Terminal now exposes its command history directly through:

```text
history
```

Commands are numbered and escaped before being inserted into the Terminal output.

Example:

```text
1  help
2  status
3  network
4  version
5  history
```

This makes it easier to review previous commands during longer Terminal sessions.
## `alias`

The Terminal can display its built-in aliases using:

```text
alias
```

The command exposes the current mappings:

```text
ll       → listkeys
cls      → clear
sysinfo  → status
ver      → version
uname-a  → uname
net      → network
```

This keeps the alias system transparent instead of making aliases hidden behavior.
## `motd`

A new:

```text
motd
```

command provides the Terminal's message-of-the-day style output.

It can be used as a lightweight introduction to the current Terminal environment and can also provide a small usage tip. A cute easter egg, isn't it? :)
## HTML Safety

Because the Terminal is (obviously) rendered inside a browser environment, dynamic values should not be inserted directly into HTML.

A reusable escaping helper was introduced:

```js
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[char]));
}
```

This is particularly important for dynamically generated output such as:

- network interface names
    
- IP addresses
    
- history entries
    
- backend error messages

The Terminal therefore has an explicit boundary between system-provided data and HTML rendering.

## Complete Command Reference

The current Terminal command set includes:

|Command|Purpose|
|---|---|
|`help`|Display available commands|
|`about`|Display mariowOS information|
|`clear`|Clear the Terminal|
|`echo`|Print text|
|`math`|Perform calculations|
|`lili`|mariowOS Terminal function/Easter egg|
|`addkey`|Add a key|
|`delkey`|Delete a key|
|`listkeys`|List stored keys|
|`fetch`|Display system information|
|`get`|Package/application management|
|`dmgr`|Package manager interface|
|`status`|Full system diagnostics|
|`hostname`|Display hostname|
|`whoami`|Display current user|
|`pwd`|Display working directory|
|`date`|Display current date/time|
|`uptime`|Display system uptime|
|`uname`|Display kernel/platform information|
|`memory`|Display RAM information|
|`cpu`|Display CPU information|
|`network`|Display network interfaces|
|`version`|Display mariowOS/Node version|
|`history`|Display command history|
|`alias`|Display Terminal aliases|
|`motd`|Display message of the day|

### Aliases

```text
ll       → listkeys
cls      → clear
sysinfo  → status
ver      → version
uname-a  → uname
net      → network
```
## Terminal Architecture

The current Terminal can be divided into three main layers:

```text
┌─────────────────────────────────────┐
│             Terminal UI             │
│                                     │
│  Prompt / Input / History / Output  │
└──────────────────┬──────────────────┘
                   │
                   ▼
┌─────────────────────────────────────┐
│          Command Dispatcher         │
│                                     │
│  Parser / Aliases / Built-ins       │
└───────────────┬─────────┬───────────┘
                │         │
                │         │
                ▼         ▼
       ┌────────────┐  ┌───────────────┐
       │ Local      │  │ Node.js API   │
       │ Commands   │  │ Diagnostics   │
       └────────────┘  └───────┬───────┘
                               │
                               ▼
                        ┌──────────────┐
                        │ Node.js `os` │
                        │ / filesystem │
                        └──────────────┘
```

This allows the Terminal to remain lightweight on the frontend while still accessing controlled system information through the backend.

---
# Bug Fixes & Cleanup

We also included a large number of smaller fixes across the desktop and Settings applications.

Such as

- Fixed live-wallpaper settings persistence.
    
- Improved Settings page navigation.
    
- Improved wallpaper reset behavior.
    
- Added better application uninstall handling.
    
- Fixed Tiles desktop installation/removal behavior.
    
- Improved Store installation feedback.
    
- Added Store EULA confirmation.
    
- Improved Wi-Fi parsing.
    
- Filtered problematic Windows network output.
    
- Improved Quick Settings synchronization.
    
- Improved startup rule handling.
    
- Added safer handling of missing `version.json`.
    
- Improved OTA failure reporting.
    
- Improved Notes backend fallback behavior.
    
- Added application installation state handling.
    
- Improved TV/media UI navigation.
    
- Added additional Settings pages and system controls.

---

On GitHub, we had stuff going on:
# Recent Commit Timeline

## `75d8058` — `"WOAH"`

**September 29, 2026**

This commit primarily updates the Node.js dependency tree and introduces Electron as a development dependency. We are trying to make mariowOS an Electron-based runtime for browser compatibility and more system integration

```json
"devDependencies": {
  "electron": "^44.4.3"
}
```

This commit also adds a large amount of `node_modules` content, including:

```text
electron
@types/node
semver
undici
sumchecker
graceful-fs
progress
```

Memory usage is still low so `node_modules` folder can still grow in size.

---

Other commits:
## `2026a18` — `fix bug`

**September 19, 2026**

It was focused heavily on Settings and configuration behavior.

- Settings restructuring
    
- Wallpaper & Style section
    
- System Settings improvements
    
- Live wallpaper handling
    
- Ethernet/System settings UI
    
- Installed application display
    
- Improved settings loading

---

## `abceb72` — `settin`

**September 19, 2026**

Still the largest Settings/Store/Sandbox integration commit to this day.

We touched:

```text
Settings
Store
Sandbox
Quick Settings
Wallpaper
Security
Reset
User Settings
Network
```

Oh and, backend APIs.

---

## `9f89908` — `fuck you II`

**September 19, 2026**

Introduced the initial visible Sandbox experience.

The commit added the Sandbox UI and functionality around:

```text
Boot sandbox
New sandbox
Remote sandbox
Delete sandbox
Upload sandbox disk
Start sandbox
Stop sandbox
Sandbox status
```

This was the foundation for the later backend Sandbox runtime.

---

## `5074e77` — `fuck you`

**September 17, 2026**

Expanded Store installation and desktop-management functionality.

Notable additions:

- Store installer helper
    
- Application installation queue
    
- Tiles DE switching prompt
    
- Dynamic installed application handling
    
- Improved TV interface navigation
    
- Application lifecycle events

---

## `0539706` — `vaffanculo cap in culo`

**September 7, 2026**

Introduced several important Store-side features.

Most notably:

- Store EULA overlay
    
- Application installation confirmation
    
- Installed application handling
    
- Sandbox registration
    
- Desktop manager improvements
    
- Version/history UI changes
    
- Store application lifecycle improvements


---

... this is the end, finally.
