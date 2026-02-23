// ============================================================================
// Betaflight Backup Extension – Content Script
// Runs inside the Betaflight Web Configurator tab (app.betaflight.com)
// Orchestrates tab navigation, screenshots, and CLI extraction.
// ============================================================================

// Guard against double injection (manifest + chrome.scripting.executeScript)
if (window._bfBackupLoaded) {
    console.log("[BF-Backup] Content script already loaded, skipping.");
} else {
window._bfBackupLoaded = true;

var backupRunning = false;
var abortRequested = false;

chrome.runtime.onMessage.addListener((request, _sender, _sendResponse) => {
    if (request.action === "runExtraction") {
        if (backupRunning) {
            console.warn("[BF-Backup] Backup already running – ignoring duplicate signal.");
            return;
        }
        backupRunning = true;
        abortRequested = false;
        console.log("[BF-Backup] Received runExtraction signal.");
        const options = request.options || { screenshots: true, cli: true, profiles: true };
        // Wrap in async IIFE to guarantee all errors (sync + async) are caught
        (async () => {
            try {
                await startBackupProcess(options);
            } catch (e) {
                console.error("[BF-Backup] Fatal:", e);
                chrome.runtime.sendMessage({ action: "extractionError", message: e.toString() }).catch(() => {});
            } finally {
                backupRunning = false;
                abortRequested = false;
            }
        })();
        return; // no async response needed
    }
    if (request.action === "abortBackup") {
        console.log("[BF-Backup] Abort requested.");
        abortRequested = true;
        return; // no async response needed
    }
});

function checkAbort() {
    if (abortRequested) throw new Error("Backup stopped by user.");
}

// ═══════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Service Worker Keepalive ─────────────────────────────────────────
// MV3 service workers can be terminated after ~30s of inactivity.
// Ping the background script periodically to keep it alive during long operations.
let keepaliveInterval = null;

function startKeepalive() {
    if (keepaliveInterval) return;
    keepaliveInterval = setInterval(() => {
        chrome.runtime.sendMessage({ action: "keepalive" }).catch(() => {});
    }, 20000); // every 20 seconds
}

function stopKeepalive() {
    if (keepaliveInterval) {
        clearInterval(keepaliveInterval);
        keepaliveInterval = null;
    }
}

function isConnected() {
    // Method 1: BEM-style button (newer web configurator)
    const bemBtn = document.querySelector('.connection_button__link');
    if (bemBtn) return bemBtn.classList.contains('active');

    // Method 2: Classic connect button
    const classicBtn = document.querySelector('.connect_b a, .connect_b button, .connect-button');
    if (classicBtn) return classicBtn.classList.contains('active');

    // Method 3: Connection state indicator
    const indicator = document.querySelector('[class*="connect"][class*="active"]');
    if (indicator) return true;

    // Method 4: Check if navigation tabs are visible (they only show when connected)
    const navTabs = document.querySelectorAll('ul.mode-connected > li');
    if (navTabs.length > 0) {
        const anyVisible = Array.from(navTabs).some(li => li.offsetHeight > 0);
        if (anyVisible) return true;
    }

    // If no connection indicator found at all, assume connected (don't abort)
    console.warn("[BF-Backup] Connection check: no indicator found, assuming connected.");
    return null; // null = unknown, don't abort
}

let progressState = { current: 0, total: 0 };

function setStatus(msg) {
    chrome.runtime.sendMessage({ action: "setStatus", message: msg, progress: progressState });
    console.log("[BF-Backup]", msg);
}

function setProgress(current, total) {
    progressState = { current, total };
}

// ═══════════════════════════════════════════════════════════════════════
//  Screenshot Capture (with rate limiting + retry)
// ═══════════════════════════════════════════════════════════════════════

// Chrome limits captureVisibleTab to ~2 calls/sec.
// We enforce a generous minimum interval and retry with backoff.
let lastCaptureTime = 0;
const MIN_CAPTURE_INTERVAL = 1100;

// Hide bottom bars (status bars, footers) during multi-part screenshots
// so they don't appear in the middle of stitched images.
// Catches both position:fixed/sticky AND flex-based footers below the scroll area.
function hideStickyBottomElements() {
    const hidden = [];
    const viewH = window.innerHeight;
    const scrollEl = getScrollableContainer();

    // Strategy 1: position:fixed/sticky elements at the bottom of the viewport
    for (const el of document.querySelectorAll('*')) {
        const style = getComputedStyle(el);
        if (style.position !== 'fixed' && style.position !== 'sticky') continue;
        const rect = el.getBoundingClientRect();
        if (rect.top > viewH * 0.6 && rect.height > 5 && rect.height < viewH * 0.3) {
            hidden.push({ el, prev: el.style.display });
            el.style.display = 'none';
        }
    }

    // Strategy 2: Walk up from the scroll container and hide sibling elements
    // that sit below it (e.g. flex-based status bars, footer bars).
    let current = scrollEl;
    while (current && current !== document.body && current !== document.documentElement) {
        let sibling = current.nextElementSibling;
        while (sibling) {
            const rect = sibling.getBoundingClientRect();
            if (rect.height > 5 && rect.height < viewH * 0.3 && rect.top >= viewH * 0.6) {
                hidden.push({ el: sibling, prev: sibling.style.display });
                sibling.style.display = 'none';
            }
            sibling = sibling.nextElementSibling;
        }
        current = current.parentElement;
    }

    return hidden;
}

function restoreStickyBottomElements(hidden) {
    for (const { el, prev } of hidden) {
        el.style.display = prev;
    }
}

async function captureAndSave(folderName, baseFileName) {
    const scrollEl = getScrollableContainer();
    scrollEl.scrollTop = 0;
    await sleep(300);

    const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;

    // Not meaningfully scrollable → single screenshot (keep sticky bars visible)
    if (maxScroll <= 100) {
        const dataUrl = await requestScreenshot();
        if (!dataUrl) {
            setStatus(`WARNING: Screenshot failed for ${baseFileName}`);
            return;
        }
        await saveToZip(folderName, `${baseFileName}.jpg`, dataUrl, true);
        return;
    }

    // Multi-part scroll: hide sticky bottom bars to avoid them appearing mid-stitch
    const hiddenEls = hideStickyBottomElements();

    try {
        // Re-measure after hiding (layout may shift)
        scrollEl.scrollTop = 0;
        await sleep(200);

        const parts = [];
        const scrollDeltas = [];

        while (true) {
            checkAbort();
            const dataUrl = await requestScreenshot();
            if (!dataUrl) {
                setStatus(`WARNING: Screenshot failed for ${baseFileName}`);
                break;
            }
            parts.push(dataUrl);

            if (scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 5) break;

            const prevScrollTop = scrollEl.scrollTop;
            scrollEl.scrollTop += scrollEl.clientHeight;
            await sleep(300);
            const actualDelta = scrollEl.scrollTop - prevScrollTop;
            scrollDeltas.push(actualDelta);
        }

        if (parts.length === 0) return;

        if (parts.length === 1) {
            await saveToZip(folderName, `${baseFileName}.jpg`, parts[0], true);
            return;
        }

        const stitched = await stitchScreenshots(parts, scrollDeltas);
        if (stitched) {
            await saveToZip(folderName, `${baseFileName}.jpg`, stitched, true);
        } else {
            for (let i = 0; i < parts.length; i++) {
                await saveToZip(folderName, `${baseFileName}_part${i + 1}.jpg`, parts[i], true);
            }
        }
    } finally {
        restoreStickyBottomElements(hiddenEls);
    }
}

// Combine multiple scrolled screenshots into one tall image.
// For parts 2+, only the bottom `scrollDelta` pixels contain new content –
// everything above is either the fixed header or already-captured content.
async function stitchScreenshots(dataUrls, scrollDeltas) {
    try {
        const images = await Promise.all(dataUrls.map(url => new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = url;
        })));

        const width = images[0].width;
        const imgHeight = images[0].height;
        // Scale factor: screenshot pixels vs CSS pixels
        const scale = width / window.innerWidth;

        // Total height = first image + only new pixels from each subsequent image
        let totalHeight = imgHeight;
        for (let i = 0; i < scrollDeltas.length; i++) {
            totalHeight += Math.round(scrollDeltas[i] * scale);
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = totalHeight;
        const ctx = canvas.getContext('2d');

        // First screenshot: draw fully (includes header + first page of content)
        ctx.drawImage(images[0], 0, 0);

        // Subsequent screenshots: extract ONLY the new pixels from the bottom
        let y = imgHeight;
        for (let i = 0; i < scrollDeltas.length; i++) {
            const newPx = Math.round(scrollDeltas[i] * scale);
            const srcY = imgHeight - newPx; // new content starts here in the image
            ctx.drawImage(images[i + 1],
                0, srcY, width, newPx,   // source: only bottom portion (new content)
                0, y, width, newPx);     // dest: append below previous
            y += newPx;
        }

        return canvas.toDataURL('image/jpeg', 0.85);
    } catch (e) {
        console.error('[BF-Backup] Stitch failed:', e);
        return null;
    }
}

async function requestScreenshot() {
    // Enforce minimum interval between captures
    const now = Date.now();
    const wait = MIN_CAPTURE_INTERVAL - (now - lastCaptureTime);
    if (wait > 0) await sleep(wait);

    for (let attempt = 0; attempt < 3; attempt++) {
        const result = await new Promise(resolve => {
            lastCaptureTime = Date.now();
            chrome.runtime.sendMessage({ action: "captureTab" }, res => {
                if (chrome.runtime.lastError || !res || res.error) {
                    console.warn("[BF-Backup] captureTab attempt", attempt + 1, "failed:",
                        chrome.runtime.lastError?.message || res?.error);
                    resolve(null);
                } else {
                    resolve(res.dataUrl);
                }
            });
        });
        if (result) return result;
        // Exponential backoff before retry
        await sleep(1500 * (attempt + 1));
    }
    return null;
}

function saveToZip(folderName, fileName, content, isBase64) {
    return new Promise(resolve => {
        chrome.runtime.sendMessage({
            action: "saveFile", folderName, fileName, content, isBase64
        }, () => resolve());
    });
}

function getScrollableContainer() {
    const content = document.querySelector('#content');
    if (content && content.scrollHeight > content.clientHeight + 10) return content;

    const candidates = Array.from(document.querySelectorAll('div, main, section'))
        .filter(el => {
            const s = getComputedStyle(el);
            return (s.overflowY === 'auto' || s.overflowY === 'scroll')
                && el.scrollHeight > el.clientHeight
                && el.clientHeight > 200;
        })
        .sort((a, b) => b.scrollHeight - a.scrollHeight);

    return candidates[0] || document.documentElement;
}

// ═══════════════════════════════════════════════════════════════════════
//  Main Backup Process
// ═══════════════════════════════════════════════════════════════════════

// Tabs that must NEVER be visited during backup:
// - tab_presets: clicking elements can apply presets → changes FC config, causes disconnect
const BLACKLIST = ['tab_landing', 'tab_firmware_flasher', 'tab_presets'];

// English folder names keyed by tab class (independent of UI language)
const TAB_ENGLISH_NAMES = {
    tab_setup: 'Setup',
    tab_ports: 'Ports',
    tab_configuration: 'Configuration',
    tab_power: 'Power',
    tab_failsafe: 'Failsafe',
    tab_pid_tuning: 'PID_Tuning',
    tab_receiver: 'Receiver',
    tab_modes: 'Modes',
    tab_adjustments: 'Adjustments',
    tab_servos: 'Servos',
    tab_motors: 'Motors',
    tab_osd: 'OSD',
    tab_vtx: 'VTX',
    tab_led_strip: 'LED_Strip',
    tab_sensors: 'Sensors',
    tab_gps: 'GPS',
    tab_logging: 'Blackbox',
    tab_cli: 'CLI',
};

async function startBackupProcess(options) {
    setStatus("Starting backup...");
    startKeepalive();

    try {
    // ── Enable Expert Mode ───────────────────────────────────────────
    const expertCb = document.querySelector('input[name="expertModeCheckbox"]');
    if (expertCb && !expertCb.checked) {
        setStatus("Enabling Expert Mode...");
        const label = expertCb.closest('label') || expertCb.parentElement;
        (label || expertCb).click();
        await sleep(1500);
    }

    // ── Discover navigation tabs ─────────────────────────────────────
    let tabEls = [];
    for (let attempt = 0; attempt < 10; attempt++) {
        tabEls = Array.from(document.querySelectorAll('ul.mode-connected > li > a.tabicon'))
            .filter(a => {
                const li = a.closest('li');
                return li && getComputedStyle(li).display !== 'none' && li.offsetHeight > 0;
            });
        if (tabEls.length > 0) break;
        setStatus("Waiting for Betaflight UI...");
        await sleep(500);
    }
    if (tabEls.length === 0) {
        throw new Error("Navigation not found – is the drone connected?");
    }

    const tabs = tabEls.map(a => {
        const li = a.closest('li');
        return {
            cls: li?.className.split(' ').find(c => c.startsWith('tab_')) || '',
            label: a.innerText.trim()
        };
    });

    // Filter tabs based on options and user's tab selection
    const filteredTabs = tabs.filter(tab => {
        if (BLACKLIST.some(b => tab.cls.includes(b))) return false;
        if (tab.cls === 'tab_cli' && !options.cli) return false;
        if (!options.screenshots && tab.cls !== 'tab_cli') return false;
        // If user selected specific tabs, only include those (CLI is handled above)
        if (options.selectedTabs && options.selectedTabs.length > 0 && tab.cls !== 'tab_cli') {
            if (!options.selectedTabs.includes(tab.cls)) return false;
        }
        return true;
    });

    const totalTabs = filteredTabs.length;
    setProgress(0, totalTabs);
    console.log(`[BF-Backup] Found ${tabs.length} tabs, processing ${totalTabs}.`);

    let idx = 1;
    for (const tab of filteredTabs) {
        checkAbort();

        // Connection check (multiple selectors for different BF versions)
        const connected = isConnected();
        if (connected === false) {
            throw new Error("Connection lost – backup aborted.");
        }

        setProgress(idx, totalTabs);

        const englishName = TAB_ENGLISH_NAMES[tab.cls]
            || tab.cls.replace('tab_', '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/ /g, '_');
        const folder = `${String(idx).padStart(2, '0')}_${englishName}`;
        const prefix = String(idx).padStart(2, '0');

        setStatus(`Tab ${idx}/${totalTabs}: ${tab.label}`);

        const link = document.querySelector(`li.${tab.cls} > a.tabicon`);
        if (!link) { console.warn(`[BF-Backup] Link for ${tab.cls} not found.`); continue; }
        link.click();
        await sleep(3500);

        if (tab.cls === 'tab_cli') {
            await handleCliTab();
        } else if (tab.cls === 'tab_pid_tuning') {
            if (options.profiles) {
                await handlePidTuningTab(folder, prefix);
            } else {
                await captureTabWithSubTabs(folder, prefix, englishName, tab.label);
            }
        } else {
            await captureTabWithSubTabs(folder, prefix, englishName, tab.label);
        }

        idx++;
    }

    setProgress(totalTabs, totalTabs);
    setStatus("Building ZIP...");
    chrome.runtime.sendMessage({ action: "extractionComplete" });

    } finally {
        stopKeepalive();
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  Sub-Tab Discovery (robust against Betaflight CSS class changes)
// ═══════════════════════════════════════════════════════════════════════

const SUB_TAB_SELECTORS = [
    // Betaflight Web Configurator specific
    '#content .tab-container .tab',
    '#content .tab_container .tab',
    '#content .tab-container > div',
    '#content .tab_container > div',
    '.tab-content-header .tab',
    // Generic patterns
    '#content [role="tablist"] [role="tab"]',
    '#content .subtab',
    '#content .sub-tab',
    // Broader searches (last resort)
    '#content .tabs .tab',
    '#content .tabs > a',
    '#content .tabs > div',
    '#content .tabs > button',
];

function findVisibleSubTabs() {
    // SAFETY: Only use known CSS selectors for sub-tabs.
    // Never use heuristics that could click arbitrary UI elements
    // (buttons, presets, toggles, etc.) and change FC state.
    for (const sel of SUB_TAB_SELECTORS) {
        const tabs = Array.from(document.querySelectorAll(sel))
            .filter(el => el.offsetWidth > 0 && el.offsetHeight > 0);
        if (tabs.length > 1) {
            console.log(`[BF-Backup] Found ${tabs.length} sub-tabs with "${sel}":`,
                tabs.map(t => t.innerText.trim()));
            return tabs;
        }
    }

    return [];
}

// Re-query sub-tabs from the live DOM and click the one at `index`.
// IMPORTANT: Never cache sub-tab references – Vue re-renders the DOM after
// profile switches, making old references stale (point to detached elements).
function clickSubTab(index) {
    const subTabs = findVisibleSubTabs();
    if (subTabs.length > index) {
        subTabs[index].click();
        return true;
    }
    console.warn(`[BF-Backup] Sub-tab ${index} not found (${subTabs.length} available)`);
    return false;
}

// ═══════════════════════════════════════════════════════════════════════
//  Sub-Tab Handling
// ═══════════════════════════════════════════════════════════════════════

async function captureTabWithSubTabs(folder, prefix, englishName, label) {
    const subTabs = findVisibleSubTabs();

    if (subTabs.length > 1) {
        let subIdx = 1;
        for (const sub of subTabs) {
            setStatus(`${label} > ${sub.innerText.trim()}...`);
            sub.click();
            await sleep(1000);
            await captureAndSave(folder, `${prefix}_${String(subIdx).padStart(2, '0')}_SubTab${subIdx}`);
            subIdx++;
        }
    } else {
        setStatus(`Screenshot: ${label}...`);
        await captureAndSave(folder, `${prefix}_01_${englishName}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  PID Tuning Tab – Cycles through ALL PID + Rate profiles
// ═══════════════════════════════════════════════════════════════════════

async function handlePidTuningTab(folder, prefix) {
    // Check how many sub-tabs exist (don't cache the elements – they go stale!)
    const subTabCount = findVisibleSubTabs().length;
    console.log(`[BF-Backup] PID tuning: ${subTabCount} sub-tabs found`);

    // Find profile dropdowns
    const pidSelect = findSelect('profile', 'pid');
    const rateSelect = findSelect('rate_profile', 'rate');

    if (pidSelect && pidSelect.options.length > 1) {
        const originalPid = pidSelect.value;
        const originalRate = rateSelect?.value;
        const pidCount = pidSelect.options.length;
        const rateCount = rateSelect?.options.length || 0;
        console.log(`[BF-Backup] PID profiles: ${pidCount}, current: ${originalPid}`);
        console.log(`[BF-Backup] Rate profiles: ${rateCount}, current: ${originalRate}`);

        // ── 1) PID sub-tab: screenshot per PID profile ──────────────
        for (let p = 0; p < pidCount; p++) {
            checkAbort();
            setStatus(`PID Profile ${p + 1}/${pidCount}...`);
            const targetVal = pidSelect.options[p].value;
            console.log(`[BF-Backup] Switching PID profile to "${targetVal}" (option ${p})...`);

            await setSelectValueVerified(pidSelect, targetVal);
            await sleep(2500);
            console.log(`[BF-Backup] PID select now shows: "${pidSelect.value}"`);

            // Navigate to PID sub-tab (re-query from live DOM!)
            clickSubTab(0);
            await sleep(800);
            await captureAndSave(folder, `${prefix}_PID_Profile${p + 1}`);
        }

        // ── 2) Rates sub-tab: screenshot per Rate profile ───────────
        if (subTabCount > 1) {
            if (rateSelect && rateCount > 1) {
                for (let r = 0; r < rateCount; r++) {
                    checkAbort();
                    setStatus(`Rate Profile ${r + 1}/${rateCount}...`);
                    const targetVal = rateSelect.options[r].value;
                    console.log(`[BF-Backup] Switching Rate profile to "${targetVal}" (option ${r})...`);

                    await setSelectValueVerified(rateSelect, targetVal);
                    await sleep(2500);
                    console.log(`[BF-Backup] Rate select now shows: "${rateSelect.value}"`);

                    // Navigate to Rates sub-tab (re-query from live DOM!)
                    clickSubTab(1);
                    await sleep(800);
                    await captureAndSave(folder, `${prefix}_Rates_Profile${r + 1}`);
                }
            } else {
                // Only one rate profile – single screenshot
                clickSubTab(1);
                await sleep(800);
                await captureAndSave(folder, `${prefix}_Rates`);
            }
        }

        // ── 3) Filter sub-tab: single screenshot (filters are global, not per profile)
        if (subTabCount > 2) {
            setStatus(`Filter settings...`);
            clickSubTab(2);
            await sleep(800);
            await captureAndSave(folder, `${prefix}_Filter`);
        }

        // ── Restore original profiles ────────────────────────────────
        setStatus("Restoring original profiles...");
        await setSelectValueVerified(pidSelect, originalPid);
        await sleep(1000);
        if (rateSelect && originalRate != null) {
            await setSelectValueVerified(rateSelect, originalRate);
        }
        await sleep(1000);
    } else {
        // No profile dropdowns found – just capture sub-tabs normally
        await captureTabWithSubTabs(folder, prefix, 'PID_Tuning', 'PID Tuning');
    }
}

// ═══════════════════════════════════════════════════════════════════════
//  Select Helpers – robust dropdown interaction
// ═══════════════════════════════════════════════════════════════════════

function findSelect(name, keyword) {
    // Dump all selects on the page for diagnostics (first call only)
    const allSelects = Array.from(document.querySelectorAll('#content select'));
    console.log(`[BF-Backup] findSelect("${name}", "${keyword}") – ${allSelects.length} selects on page:`,
        allSelects.map(s => ({
            name: s.name, id: s.id, cls: s.className,
            options: s.options.length,
            data: Array.from(s.attributes).filter(a => a.name.startsWith('data-')).map(a => `${a.name}=${a.value}`)
        })));

    // 1. Try exact name match
    let sel = document.querySelector(`#content select[name="${name}"]`);
    if (sel) { console.log(`[BF-Backup] → found by name="${name}"`); return sel; }

    // 2. Try common Betaflight-specific IDs and names
    const specificSelectors = keyword === 'pid' ? [
        'select[name="profile"]',
        'select#pid_profile',
        'select#pidProfile',
        'select#pid-profile',
        'select[name="pid_profile"]',
        'select[name="pidProfile"]',
        'select.pid_profile',
        'select.pid-profile',
        'select.pidprofile',
    ] : [
        'select[name="rate_profile"]',
        'select[name="rateProfile"]',
        'select#rate_profile',
        'select#rateProfile',
        'select#rate-profile',
        'select.rate_profile',
        'select.rate-profile',
        'select.rateprofile',
    ];
    for (const s of specificSelectors) {
        sel = document.querySelector(`#content ${s}`);
        if (sel) { console.log(`[BF-Backup] → found by specific selector "${s}"`); return sel; }
    }

    // 3. Try data-attribute match
    sel = document.querySelector(`#content select[data-setting*="${keyword}" i]`);
    if (sel) { console.log(`[BF-Backup] → found by data-setting`); return sel; }

    // 4. Fuzzy search by any attribute containing keyword
    sel = allSelects.find(s =>
        s.name?.toLowerCase().includes(keyword) ||
        s.className?.toLowerCase().includes(keyword) ||
        s.id?.toLowerCase().includes(keyword) ||
        Array.from(s.attributes).some(a => a.value.toLowerCase().includes(keyword))
    );
    if (sel) { console.log(`[BF-Backup] → found by fuzzy attribute match`); return sel; }

    // 5. Search by associated label or nearby text
    const labels = Array.from(document.querySelectorAll('#content label, #content span, #content div'));
    for (const label of labels) {
        const text = label.textContent?.toLowerCase() || '';
        if (!text.includes(keyword) && !text.includes(name.replace('_', ' '))) continue;

        // Check for 'for' attribute
        const forId = label.getAttribute('for');
        if (forId) {
            const byId = document.getElementById(forId);
            if (byId?.tagName === 'SELECT') {
                console.log(`[BF-Backup] → found by label[for="${forId}"]`);
                return byId;
            }
        }
        // Check nested select
        const nested = label.querySelector('select');
        if (nested) { console.log(`[BF-Backup] → found nested in label`); return nested; }

        // Check sibling select (label next to select)
        const sibling = label.nextElementSibling;
        if (sibling?.tagName === 'SELECT') {
            console.log(`[BF-Backup] → found as sibling of label`);
            return sibling;
        }
        const parent = label.parentElement;
        const siblingSelect = parent?.querySelector('select');
        if (siblingSelect) {
            console.log(`[BF-Backup] → found in same parent as label`);
            return siblingSelect;
        }
    }

    // 6. Last resort: if only a few selects with multiple options, guess by position
    const multiOptionSelects = allSelects.filter(s => s.options.length >= 2 && s.options.length <= 6);
    if (multiOptionSelects.length > 0) {
        // PID profile is typically the first multi-option select, rate the second
        const idx = keyword === 'pid' ? 0 : 1;
        if (multiOptionSelects[idx]) {
            console.warn(`[BF-Backup] → GUESSING by position (${idx}) – ${multiOptionSelects[idx].name || multiOptionSelects[idx].id || 'unnamed'}`);
            return multiOptionSelects[idx];
        }
    }

    console.error(`[BF-Backup] → findSelect FAILED for "${keyword}"`);
    return null;
}

function getSelectSelector(select) {
    // Build a unique CSS selector for the select element
    if (select.id) return `#${select.id}`;
    if (select.name) return `#content select[name="${select.name}"]`;
    // Fallback: use nth-of-type
    const parent = select.parentElement;
    if (parent) {
        const siblings = Array.from(parent.querySelectorAll(':scope > select'));
        const idx = siblings.indexOf(select);
        if (idx >= 0) {
            const parentSel = parent.id ? `#${parent.id}` : parent.tagName.toLowerCase();
            return `${parentSel} > select:nth-of-type(${idx + 1})`;
        }
    }
    return null;
}

// Set select value via chrome.scripting.executeScript in MAIN world.
// This bypasses CSP restrictions (unlike <script> injection) and runs in the
// same world as Vue, so change events properly trigger Vue's reactivity.
function setSelectViaBridge(selector, value) {
    return new Promise(resolve => {
        chrome.runtime.sendMessage(
            { action: "setSelectValue", selector, value: String(value) },
            res => {
                if (chrome.runtime.lastError) {
                    console.warn("[BF-Backup] setSelectValue bridge error:", chrome.runtime.lastError.message);
                    resolve(false);
                } else {
                    console.log("[BF-Backup] setSelectValue bridge result:", JSON.stringify(res));
                    resolve(res?.ok === true);
                }
            }
        );
    });
}

async function setSelectValueVerified(select, value, retries = 3) {
    const selector = getSelectSelector(select);
    const strValue = String(value);

    for (let attempt = 0; attempt <= retries; attempt++) {
        if (selector) {
            // Primary: MAIN world via background bridge (CSP-safe, triggers Vue)
            await setSelectViaBridge(selector, strValue);
        } else {
            // Fallback: ISOLATED world (may not trigger Vue)
            console.warn("[BF-Backup] No selector for select – using ISOLATED world fallback.");
            select.value = strValue;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            select.dispatchEvent(new Event('input', { bubbles: true }));
        }

        // Wait for Vue to process the event and FC to respond
        await sleep(500);

        if (select.value === strValue) {
            if (attempt > 0) console.log(`[BF-Backup] Select set on attempt ${attempt + 1}`);
            return true;
        }

        console.warn(`[BF-Backup] Select verify failed (got "${select.value}", want "${strValue}"), attempt ${attempt + 1}`);
        await sleep(500);
    }

    console.error(`[BF-Backup] Could not set select to "${strValue}" after ${retries + 1} attempts`);
    return false;
}

// ═══════════════════════════════════════════════════════════════════════
//  CLI Tab Handler
// ═══════════════════════════════════════════════════════════════════════

async function handleCliTab() {
    setStatus("Extracting CLI configuration...");
    await sleep(3000); // CLI needs extra time to initialize terminal

    // Connection check before CLI operations
    const connected = isConnected();
    if (connected === false) {
        throw new Error("Connection lost before CLI extraction – backup aborted.");
    }

    // Run diagnostics first to help with debugging
    const diag = await cliDiagnostics();
    console.log("[BF-Backup] CLI diagnostics:", JSON.stringify(diag, null, 2));

    const commands = [
        { cmd: "diff all",  file: "diff_all.txt", timeout: 30000 },
        { cmd: "dump all",  file: "dump_all.txt", timeout: 45000 },
    ];

    for (const { cmd, file, timeout } of commands) {
        checkAbort();

        // Check connection before each CLI command
        const stillConnected = isConnected();
        if (stillConnected === false) {
            setStatus("WARNING: Connection lost during CLI extraction.");
            throw new Error("Connection lost during CLI extraction – backup aborted.");
        }

        await cliClear();
        await sleep(500);

        setStatus(`CLI: ${cmd}...`);
        const sent = await cliSend(cmd);
        if (!sent) {
            setStatus(`WARNING: Could not send '${cmd}' – skipping.`);
            continue;
        }

        setStatus(`Waiting for '${cmd}' response...`);
        await cliWaitForStableOutput(timeout);

        // Check connection after waiting for output
        const connAfter = isConnected();
        if (connAfter === false) {
            setStatus("WARNING: Connection lost while waiting for CLI output.");
            throw new Error("Connection lost during CLI extraction – backup aborted.");
        }

        const output = await cliRead();
        if (output && output.trim().length > 10) {
            await saveToZip("CLI", file, output, false);
            setStatus(`'${cmd}' saved (${(output.length / 1024).toFixed(1)} KB).`);
        } else {
            setStatus(`WARNING: No output for '${cmd}'.`);
        }

        // Small pause between commands to avoid overloading the FC
        await sleep(1000);
    }
}

// ── CLI: Diagnostics ─────────────────────────────────────────────────
async function cliDiagnostics() {
    return new Promise(resolve => {
        chrome.runtime.sendMessage(
            { action: "cliExecute", operation: "debug" },
            res => resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : res)
        );
    });
}

// ── CLI: Send command ────────────────────────────────────────────────
async function cliSend(cmd) {
    // Method 1: chrome.scripting bridge (xterm terminal API)
    const bridgeResult = await new Promise(resolve => {
        chrome.runtime.sendMessage(
            { action: "cliExecute", operation: "send", command: cmd },
            res => {
                if (chrome.runtime.lastError) {
                    console.warn("[BF-Backup] CLI bridge error:", chrome.runtime.lastError.message);
                    resolve(false);
                } else {
                    resolve(res);
                }
            }
        );
    });
    if (bridgeResult === true) {
        console.log("[BF-Backup] CLI sent via scripting bridge.");
        return true;
    }
    console.log("[BF-Backup] CLI bridge returned:", bridgeResult);

    // Method 2: Keyboard simulation on xterm helper textarea
    const xtermTA = document.querySelector('.xterm-helper-textarea')
        || document.querySelector('textarea[aria-label]')
        || document.querySelector('.xterm textarea')
        || document.querySelector('.terminal textarea');
    if (xtermTA) {
        console.log("[BF-Backup] CLI: xterm keyboard simulation on", xtermTA.className);
        xtermTA.focus();
        await sleep(100);
        for (const ch of cmd) {
            xtermTA.dispatchEvent(new KeyboardEvent('keydown', {
                key: ch, keyCode: ch.charCodeAt(0), which: ch.charCodeAt(0),
                bubbles: true, cancelable: true, composed: true
            }));
            xtermTA.value = ch;
            xtermTA.dispatchEvent(new InputEvent('input', {
                data: ch, inputType: 'insertText', bubbles: true, composed: true
            }));
            await sleep(5);
        }
        xtermTA.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
            bubbles: true, cancelable: true, composed: true
        }));
        return true;
    }

    // Method 3: Vue-compatible input field (for non-xterm CLI implementations)
    const input = findCliInput();
    if (input) {
        console.log("[BF-Backup] CLI: Vue input fallback on", input.tagName, input.id || input.className);
        input.focus();
        await sleep(50);

        // Use native setter to work with Vue's v-model
        const setter = Object.getOwnPropertyDescriptor(
            input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
            'value'
        )?.set;
        if (setter) setter.call(input, cmd);
        else input.value = cmd;

        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));

        // Simulate Enter (Vue listens on @keydown.enter or @keyup.enter)
        for (const type of ['keydown', 'keypress', 'keyup']) {
            input.dispatchEvent(new KeyboardEvent(type, {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                bubbles: true, cancelable: true
            }));
        }
        return true;
    }

    console.error("[BF-Backup] No CLI input method available.");
    return false;
}

function findCliInput() {
    // Search specifically within the CLI content area
    const selectors = [
        '#content input.cliInput',
        '#content input[placeholder*="command" i]',
        '#content input[placeholder*="befehl" i]',
        '#content input[placeholder*="cli" i]',
        '#content input[type="text"]',
        '#content textarea:not(.xterm-helper-textarea)',
    ];
    for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetWidth > 0) return el;
    }
    return null;
}

// ── CLI: Read terminal buffer ────────────────────────────────────────
async function cliRead() {
    // Method 1: chrome.scripting bridge
    const text = await new Promise(resolve => {
        chrome.runtime.sendMessage(
            { action: "cliExecute", operation: "read" },
            res => resolve(chrome.runtime.lastError ? '' : (res || ''))
        );
    });
    if (typeof text === 'string' && text.length > 0) return text;

    // Method 2: DOM text extraction
    const selectors = [
        '#content .window .wrapper',
        '#content .terminal-output',
        '#content pre',
        '.tab_cli .window .wrapper',
        '.window .wrapper'
    ];
    for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText.trim().length > 0) return el.innerText;
    }
    return '';
}

// ── CLI: Clear terminal ──────────────────────────────────────────────
async function cliClear() {
    const clearBtn = document.querySelector('#content a.clear')
        || document.querySelector('#content button.clear')
        || Array.from(document.querySelectorAll('#content a, #content button'))
            .find(el => el.classList.contains('clear'));
    if (clearBtn) { clearBtn.click(); await sleep(400); return; }

    await new Promise(resolve => {
        chrome.runtime.sendMessage(
            { action: "cliExecute", operation: "clear" },
            () => resolve()
        );
    });
}

// ── CLI: Wait until output stops growing ─────────────────────────────
async function cliWaitForStableOutput(maxMs) {
    let lastLen = 0;
    let stable = 0;
    const start = Date.now();

    while (Date.now() - start < maxMs) {
        checkAbort(); // allow stop button to work during CLI wait
        await sleep(1000);
        checkAbort();

        const out = await cliRead();
        const len = out ? out.length : 0;

        if (len > lastLen) {
            lastLen = len;
            stable = 0;
        } else if (len > 0) {
            stable++;
            if (stable >= 2) {
                console.log(`[BF-Backup] CLI output stable after ${Date.now() - start}ms`);
                return;
            }
        }
    }
    console.log(`[BF-Backup] CLI wait timed out after ${maxMs}ms`);
}

} // end of double-injection guard
