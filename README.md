# Auto Backup for Betaflight (Chrome Extension)

A fully automated backup tool for the **Betaflight Web Configurator**. It navigates through every tab, captures stitched full-page screenshots, cycles through all PID & Rate profiles, extracts your complete CLI configuration, and packages everything into a single `.zip` file.

![Betaflight Backup Extension Icon](icon-v2.png)

## Demo

<video src="demo_small.mp4" width="600" autoplay loop muted playsinline></video>

## Installation

Since this extension interacts with your connected hardware, it's provided as open source for you to review and install locally.

1. Download or clone this repository.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** (top left).
5. Select the folder containing this extension.

## Usage

1. Connect your drone via USB.
2. Open the [Betaflight Web Configurator](https://app.betaflight.com/) and connect.
3. Click the extension icon in your Chrome toolbar.
4. Choose what to include: **Screenshots**, **CLI Dump**, **Profiles**.
5. Expand **Tab Selection** to pick which tabs to screenshot.
6. Click **Start Backup** and don't move your mouse over the Betaflight window.
7. A `.zip` file downloads with all your data.

**Keyboard shortcut:** Press `Ctrl+Shift+B` (Mac: `Cmd+Shift+B`) to start a backup using your saved preferences without opening the popup.

## Features

- **Tab Selection** — Choose exactly which tabs to screenshot via a collapsible grid
- **All PID & Rate Profiles** — Automatically switches through every profile and captures each one
- **Stitched Screenshots** — Long pages are scrolled and stitched into a single seamless image
- **Stop Backup** — Abort a running backup at any time
- **Live Progress** — Determinate progress bar (Tab 5/12) + badge on the extension icon
- **Desktop Notifications** — Get notified when backup completes, even with the popup closed
- **Status Persistence** — Close and reopen the popup without losing track of progress
- **Keyboard Shortcut** — `Ctrl+Shift+B` for instant backup with saved preferences
- **Expert Mode** — Automatically enables Expert Mode for full tab access
- **Connection Monitoring** — Aborts immediately if the drone disconnects
- **Auto-Inject** — Content script is automatically injected if not loaded (no manual page reload needed)

## What's in the backup?

```
Betaflight_Backup_2026-02-23_14-30.zip
├── 01_Setup/
│   └── 01_01_Setup.jpg
├── 02_Ports/
│   └── 02_01_Ports.jpg
├── 03_Configuration/
│   └── 03_01_Configuration.jpg
├── 04_PID_Tuning/
│   ├── 04_PID_Profile1.jpg
│   ├── 04_PID_Profile2.jpg
│   ├── 04_PID_Profile3.jpg
│   ├── 04_Rates_Profile1.jpg
│   ├── 04_Rates_Profile2.jpg
│   ├── 04_Rates_Profile3.jpg
│   └── 04_Filter.jpg
├── ...
└── CLI/
    ├── diff_all.txt
    └── dump_all.txt
```

- **Screenshots** are saved as JPEG for excellent readability at small file sizes.
- **Long pages** are automatically scrolled and stitched into a single image (sticky bottom bars are hidden during capture).
- **Folder names** are always in English regardless of the configurator's UI language.
- **PID Tuning** cycles through all PID profiles and Rate profiles separately. Filter settings are captured once (they are global).
- **CLI dumps** contain the complete `diff all` and `dump all` output as plain text.

## Why this exists

Before major firmware updates, you should have a complete backup — not just the CLI dump, but also visual references of your OSD layout, PID tuning, receiver mapping, and more.

Doing this manually across 15+ tabs and multiple profiles is tedious and error-prone. This extension automates it in under a minute.

## Safety

1. **Read-only:** Only takes screenshots and reads CLI output. Never writes settings.
2. **Profile restore:** After cycling through profiles, the original selection is restored.
3. **Language-agnostic:** Uses CSS class selectors, not UI text — works in any language.
4. **Blacklisted tabs:** Firmware Flasher, Presets, and Landing page are never clicked.
5. **Connection monitoring:** Aborts immediately if the drone disconnects.
6. **Verified switching:** Profile dropdown changes are verified and retried if needed.

## How it works

| Component | Role |
|---|---|
| `manifest.json` | Extension config, permissions, keyboard shortcut |
| `popup.html/js/css` | User interface — options, tab selection, progress bar, status |
| `content.js` | Runs in the Betaflight tab — navigates tabs, cycles profiles, captures & stitches screenshots |
| `background.js` | Service worker — ZIP creation, tab capture, CLI bridge, badge, notifications |
| `jszip.min.js` | In-memory ZIP file generation |

The CLI extraction uses `chrome.scripting.executeScript` with `world: "MAIN"` to access the xterm.js terminal instance directly, with keyboard simulation as fallback.

## Compatibility

- Betaflight Web Configurator `2025.12.2` and newer
- Betaflight Firmware `4.4.x` / `4.5.x` / `4.6.x`
- Chrome / Chromium-based browsers

## License

Licensed under **GPLv3**. See [LICENSE](LICENSE). Free to use, modify, and distribute — must remain open source.

## Author

- **TikTok:** [@qriso.fpv](https://www.tiktok.com/@qriso.fpv)
- **Instagram:** [@qriso.fpv](https://www.instagram.com/qriso.fpv)
