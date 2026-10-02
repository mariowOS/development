

<img width="1167" height="360" alt="Frame 340" src="https://github.com/user-attachments/assets/75bb4aad-f059-44b1-9c6e-77df29639fc2" />

## A work-in-progress clean, fast, smooth web-based OS experience.

This is the main development repo, which contains the whole code that we work on prior compressing to stable images for generic devices.

Licensed under the Apache License, Version 2.0; you can use this file if you give credits to the original creators and you may not use this file except in compliance with the License. 
Obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0. 

ℹ️ This project uses open source and free fonts sourced from Google Fonts. Google Fonts is a trademark of Google LCC, privacy docs are at https://developers.google.com/fonts/faq/privacy 

ℹ️ This project uses open source and free, community made node/npm modules. All credits goes to them for their work.

**WARNING: This code isn't meant in any way to be used as a main system. it's NOT ready for production! If you're searching for stable packages and images, please head over the [stable repository](https://github.com/mariowOS/stable). If you need older versions, please use the [OTA repository](https://github.com/mariowOS/OTA).**

### Run the Electron shell

With Node.js 22.12 or newer, install the repository dependencies, then launch mariowOS with the same command on Windows, Linux, or macOS:

```
npm install
npm run start-os
```

Electron starts the local backend, displays a boot screen while it checks readiness and preloads desktop images, and then opens the OS fullscreen. Quick Settings can shut down mariowOS or reboot its kernel (restart `system/server.js`) without closing Electron; shutting down mariowOS does not shut down the host computer. This starts the development Electron runtime and does not produce platform installer packages.

Platform launchers are also provided: double-click `start.bat` on Windows, run `sh start.sh` on Linux, or open `start.command` on macOS (if needed, run `chmod +x start.command` once first). Each launcher starts the same Electron shell and requires dependencies installed with `npm install`.

The Browser app supports multiple tabs with a separate isolated webview per tab.

### Verbose boot (CLI only)

To show live startup stages over the boot logo, enable verbose boot from a terminal:

```
npm run boot:verbose
npm run start-os
```

Verbose mode stays enabled across restarts until disabled with `npm run boot:quiet`. Check the current mode with `npm run boot:status`. Startup errors remain visible even when verbose boot is disabled.

### Clone repository

```
$ mkdir mariowOS
$ cd mariowOS
$ git clone https://github.com/mariowOS/development
```

### Version changelog
- mariowOS: <img width="35" height="12" alt="Frame 394" src="https://github.com/user-attachments/assets/0d5193b7-8dbe-46bd-b16e-4905b56d8c1f"/> 1.0 insiders public release
- Community: <img width="35" height="12" alt="Frame 397" src="https://github.com/user-attachments/assets/904da047-ba55-4aa4-9a56-a68082cb9d25" /> <img width="35" height="12" alt="Frame 394" src="https://github.com/user-attachments/assets/0d5193b7-8dbe-46bd-b16e-4905b56d8c1f"/> 1.0 Pre-Release candidate
- Insider: <img width="35" height="12" alt="Frame 395" src="https://github.com/user-attachments/assets/7a201959-1d01-43a0-b3e8-59b3e69ddd5f"/> 0.8.1 Insiders
- Private: <img width="51" height="12" alt="Frame 3s94" src="https://github.com/user-attachments/assets/67953a09-3730-47ed-a8cc-a6f108ec7e1f"/> <img width="35" height="12" alt="Frame 394" src="https://github.com/user-attachments/assets/0d5193b7-8dbe-46bd-b16e-4905b56d8c1f"/> 1.0 (STABLE TEST)
- DosVM: <img width="51" height="12" alt="Frame 398" src="https://github.com/user-attachments/assets/2c3ee65c-1eca-4044-a828-38adef1f7e5b" /> <img width="35" height="12" alt="Frame 394" src="https://github.com/user-attachments/assets/af19c8f1-6c57-4466-94f7-c5711f28dfd6" /> <img width="35" height="12" alt="Frame 399" src="https://github.com/user-attachments/assets/734b06c4-2b0d-497a-9161-cd13b6361d56" /> α0.5


### External services notices

If you want to build mariowOS for other specific devices (such as tablets, laptops) or for an organization make sure you have every external service (ex. update mirrors) changed before publishing. either the official generic is gonna overwrite yours at every update.

For organizations you can set up the **Temp** account that gets flushed at every logoff, can be useful if you have multiple people that use that device (ex. a library). Temp account has no administrative rights and can't modify anything on the system. Backend is limited, external services are too.
