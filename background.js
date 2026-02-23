// ============================================================================
// Betaflight Backup Extension – Background Service Worker
// Handles ZIP creation, tab capture, CLI bridge, badge, and notifications
// ============================================================================

try {
    importScripts('jszip.min.js');
} catch (e) {
    console.error('[BG] Failed to load JSZip:', e.message);
}

let isRunning = false;
let backupZip = null;
let rootFolderName = "";
let activeTabId = null;

// ═══════════════════════════════════════════════════════════════════════
//  Badge – live progress on the extension icon
// ═══════════════════════════════════════════════════════════════════════

function setBadge(text, color) {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
}

function clearBadge() {
    chrome.action.setBadgeText({ text: '' });
}

// ═══════════════════════════════════════════════════════════════════════
//  Status Persistence – survives popup close/reopen
// ═══════════════════════════════════════════════════════════════════════

function updateStatus(action, message, progress) {
    const status = { action, message, timestamp: Date.now() };
    if (progress) status.progress = progress;
    chrome.storage.session.set({ backupStatus: status });
    // Also try to relay to popup (may fail if popup is closed – that's fine)
    chrome.runtime.sendMessage({ action, message, progress }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════
//  Shared findTerminal – injected into page context via executeScript
//  Must be self-contained (no closures) because it runs in world:"MAIN"
// ═══════════════════════════════════════════════════════════════════════

function findTerminalInPage() {
    if (window.TABS?.cli?.terminal) return window.TABS.cli.terminal;
    const sels = ['.xterm', '.terminal', '#terminal', '[class*="xterm"]'];
    for (const s of sels) {
        const el = document.querySelector(s);
        if (!el) continue;
        if (el._xterm) return el._xterm;
        if (el.xterm) return el.xterm;
        if (el.terminal) return el.terminal;
        for (const k of Object.getOwnPropertyNames(el)) {
            try { const v = el[k]; if (v?.paste || v?.buffer?.active) return v; } catch(e) {}
        }
    }
    for (const el of document.querySelectorAll('#content *')) {
        const keys = Object.getOwnPropertyNames(el);
        if (keys.length <= 50) continue;
        for (const k of keys) {
            try { const v = el[k]; if (v?.paste && v?.buffer) return v; } catch(e) {}
        }
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════════════
//  Keyboard Shortcut Handler
// ═══════════════════════════════════════════════════════════════════════

chrome.commands.onCommand.addListener(async (command) => {
    if (command !== "start-backup") return;
    if (isRunning) return;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.includes("app.betaflight.com")) return;

    // Load saved preferences so keyboard shortcut respects user's tab selection
    const { backupOptions, tabSelections } = await chrome.storage.local.get(['backupOptions', 'tabSelections']);
    const options = backupOptions || { screenshots: true, cli: true, profiles: true };
    if (tabSelections) {
        options.selectedTabs = Object.entries(tabSelections)
            .filter(([_, v]) => v)
            .map(([k]) => k);
    }

    handleStartBackup(tab.id, options);
});

// ═══════════════════════════════════════════════════════════════════════
//  Start Backup – shared logic for popup + keyboard shortcut
// ═══════════════════════════════════════════════════════════════════════

function handleStartBackup(tabId, options) {
    if (isRunning) {
        updateStatus("backupError", "Backup is already running.");
        return;
    }
    isRunning = true;

    // Clear any stale error/status from previous runs
    chrome.storage.session.remove('backupStatus');

    const d = new Date();
    const timestamp = [
        d.getFullYear(),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0')
    ].join('-') + '_' + [
        String(d.getHours()).padStart(2, '0'),
        String(d.getMinutes()).padStart(2, '0')
    ].join('-');

    backupZip = new JSZip();
    rootFolderName = `Betaflight_Backup_${timestamp}`;
    backupZip.folder(rootFolderName);

    setBadge('...', '#ff9800');
    updateStatus("backupStatusUpdate", "Starting backup...");

    activeTabId = tabId;
    sendOrInject(tabId, { action: "runExtraction", options });
}

// Try to send a message to the content script. If it's not loaded yet
// (e.g. extension was just installed/reloaded), inject it and retry once.
async function sendOrInject(tabId, message) {
    try {
        await chrome.tabs.sendMessage(tabId, message);
        return; // success on first try
    } catch (_) {
        // Content script not loaded – inject it
    }

    console.log("[BG] Content script not responding, injecting...");
    updateStatus("backupStatusUpdate", "Preparing backup...");

    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content.js"]
        });
        // Give the content script time to initialize its message listener
        await new Promise(r => setTimeout(r, 500));
        await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
        console.error("[BG] Injection failed:", e.message);
        isRunning = false;
        setBadge('!', '#ef5350');
        updateStatus("backupError",
            "Could not start backup. Please RELOAD the Betaflight tab (F5) and try again.");
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  Message Handler
// ═══════════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

    // ─── Keepalive (prevents service worker termination) ──────────────
    if (request.action === "keepalive") {
        sendResponse({ alive: true });
        return true;
    }

    // ─── Stop Backup ──────────────────────────────────────────────────
    if (request.action === "stopBackup") {
        if (isRunning && activeTabId) {
            chrome.tabs.sendMessage(activeTabId, { action: "abortBackup" }).catch(() => {});
            isRunning = false;
            backupZip = null;
            setBadge('!', '#ef5350');
            setTimeout(clearBadge, 5000);
            updateStatus("backupError", "Backup stopped by user.");
        }
        return true;
    }

    // ─── Start Backup (from popup) ───────────────────────────────────
    if (request.action === "startBackup") {
        handleStartBackup(request.tabId, request.options || { screenshots: true, cli: true, profiles: true });
        return true;
    }

    // ─── Capture Visible Tab as JPEG ─────────────────────────────────
    if (request.action === "captureTab") {
        let responded = false;
        const timeout = setTimeout(() => {
            if (!responded) {
                responded = true;
                sendResponse({ error: "captureVisibleTab timed out after 10s" });
            }
        }, 10000);

        chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "jpeg", quality: 80 }, (dataUrl) => {
            if (responded) return; // timeout already fired
            responded = true;
            clearTimeout(timeout);
            if (chrome.runtime.lastError) {
                sendResponse({ error: chrome.runtime.lastError.message });
            } else {
                sendResponse({ dataUrl });
            }
        });
        return true;
    }

    // ─── Relay Status to Popup (with progress) ──────────────────────
    if (request.action === "setStatus") {
        const progress = request.progress;
        if (progress) {
            setBadge(`${progress.current}`, '#ff9800');
        }
        updateStatus("backupStatusUpdate", request.message, progress);
        return;
    }

    // ─── Save File into ZIP ──────────────────────────────────────────
    if (request.action === "saveFile") {
        if (!backupZip) {
            console.error("[BG] saveFile called but backupZip is null (backup may have been aborted).");
            sendResponse({ success: false, error: "No active backup" });
            return true;
        }
        const folder = backupZip.folder(rootFolderName).folder(request.folderName);
        if (request.isBase64) {
            const base64Data = request.content.split(',')[1];
            folder.file(request.fileName, base64Data, { base64: true });
        } else {
            folder.file(request.fileName, request.content);
        }
        sendResponse({ success: true });
        return true;
    }

    // ─── Select Bridge (MAIN world, CSP-safe) ─────────────────────────
    if (request.action === "setSelectValue") {
        const tabId = sender.tab.id;
        chrome.scripting.executeScript({
            target: { tabId }, world: "MAIN",
            func: (selector, value) => {
                const select = document.querySelector(selector);
                if (!select) return { ok: false, why: 'not found', selector };
                select.value = String(value);
                select.dispatchEvent(new Event('change', { bubbles: true }));
                select.dispatchEvent(new Event('input', { bubbles: true }));
                return { ok: true, actual: select.value };
            },
            args: [request.selector, request.value]
        }, (results) => {
            const r = results?.[0]?.result;
            if (chrome.runtime.lastError) {
                console.error("[BG] setSelectValue error:", chrome.runtime.lastError.message);
                sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            } else {
                sendResponse(r || { ok: false });
            }
        });
        return true;
    }

    // ─── CLI Bridge ──────────────────────────────────────────────────
    if (request.action === "cliExecute") {
        const tabId = sender.tab.id;
        const op = request.operation;

        // ── Debug: discover what's in the CLI DOM ────────────────────
        if (op === "debug") {
            chrome.scripting.executeScript({
                target: { tabId }, world: "MAIN",
                func: () => {
                    const info = {
                        hasXterm: !!document.querySelector('.xterm'),
                        hasTerminal: !!document.querySelector('.terminal'),
                        hasXtermHelper: !!document.querySelector('.xterm-helper-textarea'),
                        textareas: Array.from(document.querySelectorAll('#content textarea')).map(t => ({
                            id: t.id, cls: t.className, w: t.offsetWidth
                        })),
                        inputs: Array.from(document.querySelectorAll('#content input[type="text"]')).map(i => ({
                            id: i.id, cls: i.className, name: i.name, ph: i.placeholder
                        })),
                        canvasCount: document.querySelectorAll('#content canvas').length,
                        contentSnippet: document.querySelector('#content')?.innerHTML?.substring(0, 1500) || 'empty',
                        hasTABS: !!window.TABS,
                        hasTabsCli: !!(window.TABS?.cli),
                        hasTerminalRef: !!(window.TABS?.cli?.terminal),
                    };
                    for (const sel of ['.xterm', '.terminal', '#terminal']) {
                        const el = document.querySelector(sel);
                        if (el) {
                            const ownKeys = Object.getOwnPropertyNames(el).filter(k => !k.startsWith('__'));
                            info[`el_${sel}_keys`] = ownKeys.filter(k => k.length < 25).slice(0, 30);
                        }
                    }
                    return info;
                }, args: []
            }, (results) => {
                sendResponse(chrome.runtime.lastError
                    ? { error: chrome.runtime.lastError.message }
                    : (results?.[0]?.result ?? {}));
            });
            return true;
        }

        // ── Send command to terminal ─────────────────────────────────
        if (op === "send") {
            chrome.scripting.executeScript({
                target: { tabId }, world: "MAIN",
                func: (cmd, findTermSrc) => {
                    const findTerminal = new Function('return ' + findTermSrc)();
                    const term = findTerminal();
                    if (!term) return { ok: false, why: 'not found' };
                    if (typeof term.paste === 'function') { term.paste(cmd + '\n'); return { ok: true, via: 'paste' }; }
                    if (typeof term.input === 'function') { term.input(cmd + '\r'); return { ok: true, via: 'input' }; }
                    if (typeof term.write === 'function') { term.write(cmd + '\r'); return { ok: true, via: 'write' }; }
                    return { ok: false, why: 'no method', keys: Object.keys(term).slice(0, 20) };
                }, args: [request.command, findTerminalInPage.toString()]
            }, (results) => {
                const r = results?.[0]?.result;
                if (chrome.runtime.lastError) {
                    console.error("[BG] CLI send error:", chrome.runtime.lastError.message);
                    sendResponse(false);
                } else {
                    console.log("[BG] CLI send:", JSON.stringify(r));
                    sendResponse(r?.ok === true);
                }
            });
            return true;
        }

        // ── Read terminal buffer ─────────────────────────────────────
        if (op === "read") {
            chrome.scripting.executeScript({
                target: { tabId }, world: "MAIN",
                func: (findTermSrc) => {
                    const findTerminal = new Function('return ' + findTermSrc)();
                    const term = findTerminal();
                    if (!term?.buffer?.active) return '';
                    const buf = term.buffer.active;
                    const lines = [];
                    for (let i = 0; i < buf.length; i++) {
                        const line = buf.getLine(i);
                        if (line) lines.push(line.translateToString(true));
                    }
                    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
                    return lines.join('\n');
                }, args: [findTerminalInPage.toString()]
            }, (results) => {
                sendResponse(chrome.runtime.lastError ? '' : (results?.[0]?.result ?? ''));
            });
            return true;
        }

        // ── Clear terminal ───────────────────────────────────────────
        if (op === "clear") {
            chrome.scripting.executeScript({
                target: { tabId }, world: "MAIN",
                func: (findTermSrc) => {
                    const findTerminal = new Function('return ' + findTermSrc)();
                    const term = findTerminal();
                    if (term?.clear) { term.clear(); return true; }
                    return false;
                }, args: [findTerminalInPage.toString()]
            }, (results) => {
                sendResponse(results?.[0]?.result ?? false);
            });
            return true;
        }

        sendResponse(false);
        return true;
    }

    // ─── Extraction Complete → Build & Download ZIP ──────────────────
    if (request.action === "extractionComplete") {
        if (!backupZip) {
            console.error("[BG] extractionComplete called but backupZip is null.");
            isRunning = false;
            setBadge('!', '#ef5350');
            setTimeout(clearBadge, 8000);
            updateStatus("backupError", "Internal error: ZIP object lost. Please try again.");
            return true;
        }
        setBadge('ZIP', '#ff9800');
        updateStatus("backupStatusUpdate", "Generating ZIP file...");

        backupZip.generateAsync({ type: "base64" }).then((base64) => {
            const dataUrl = "data:application/zip;base64," + base64;
            chrome.downloads.download({
                url: dataUrl,
                filename: `${rootFolderName}.zip`,
                saveAs: true
            }, (downloadId) => {
                if (chrome.runtime.lastError || !downloadId) {
                    console.error("[BG] Download failed:", chrome.runtime.lastError?.message);
                    isRunning = false;
                    backupZip = null;
                    setBadge('!', '#ef5350');
                    setTimeout(clearBadge, 8000);
                    updateStatus("backupError", "Download failed: " + (chrome.runtime.lastError?.message || "cancelled"));
                    return;
                }

                isRunning = false;
                backupZip = null;
                setBadge('OK', '#66bb6a');
                setTimeout(clearBadge, 5000);

                updateStatus("backupComplete", "Backup completed!");

                // Desktop notification
                chrome.notifications.create('backup-done', {
                    type: 'basic',
                    iconUrl: 'icon-v2.png',
                    title: 'Betaflight Backup Complete',
                    message: `${rootFolderName}.zip is ready for download.`,
                    priority: 1
                });
            });
        }).catch(err => {
            isRunning = false;
            setBadge('!', '#ef5350');
            setTimeout(clearBadge, 8000);
            updateStatus("backupError", "Failed to build ZIP: " + err.message);
        });
        return true;
    }

    // ─── Extraction Error ────────────────────────────────────────────
    if (request.action === "extractionError") {
        isRunning = false;
        setBadge('!', '#ef5350');
        setTimeout(clearBadge, 8000);
        updateStatus("backupError", request.message);

        chrome.notifications.create('backup-error', {
            type: 'basic',
            iconUrl: 'icon-v2.png',
            title: 'Betaflight Backup Failed',
            message: request.message,
            priority: 2
        });
        return true;
    }
});
