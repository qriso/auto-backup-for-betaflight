// Auto-populate version from manifest (single source of truth)
document.getElementById('versionLabel').textContent = 'v' + chrome.runtime.getManifest().version;

const btn = document.getElementById('startBackupBtn');
const stopBtn = document.getElementById('stopBackupBtn');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('statusText');
const progressBar = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');
const progressLabel = document.getElementById('progressLabel');

const optScreenshots = document.getElementById('optScreenshots');
const optCli = document.getElementById('optCli');
const optProfiles = document.getElementById('optProfiles');

const tabGrid = document.getElementById('tabGrid');
const tabSelectionCount = document.getElementById('tabSelectionCount');
const tabSelectionToggle = document.getElementById('tabSelectionToggle');
const tabSelectionBody = document.getElementById('tabSelectionBody');

// ─── Known Betaflight Configurator tabs ──────────────────────────────
const KNOWN_TABS = [
    { cls: 'tab_setup',         label: 'Setup',       on: true },
    { cls: 'tab_ports',         label: 'Ports',       on: true },
    { cls: 'tab_configuration', label: 'Config',      on: true },
    { cls: 'tab_power',         label: 'Power',       on: true },
    { cls: 'tab_failsafe',     label: 'Failsafe',    on: true },
    { cls: 'tab_pid_tuning',   label: 'PID',         on: true },
    { cls: 'tab_receiver',     label: 'Receiver',     on: true },
    { cls: 'tab_modes',        label: 'Modes',        on: true },
    { cls: 'tab_adjustments',  label: 'Adjust',       on: false },
    { cls: 'tab_servos',       label: 'Servos',       on: false },
    { cls: 'tab_motors',       label: 'Motors',       on: true },
    { cls: 'tab_osd',          label: 'OSD',          on: true },
    { cls: 'tab_vtx',          label: 'VTX',          on: false },
    { cls: 'tab_led_strip',    label: 'LEDs',         on: false },
    { cls: 'tab_sensors',      label: 'Sensors',      on: false },
    { cls: 'tab_gps',          label: 'GPS',          on: false },
    { cls: 'tab_logging',      label: 'Blackbox',     on: true },
];

// ─── Restore status from background (survives popup close) ──────────
// Only restore "running" and "complete" states. Never restore errors from
// session storage — they are almost always stale and confuse the user.
// Live errors are still shown via the onMessage listener below.
chrome.storage.session.get('backupStatus', ({ backupStatus }) => {
    if (!backupStatus) return;

    if (backupStatus.action === "backupStatusUpdate") {
        showStatus(backupStatus.message, "running", backupStatus.progress);
        setRunningUI(true);
    } else if (backupStatus.action === "backupComplete") {
        showStatus("Backup completed!", "success");
    }
    // Errors are intentionally NOT restored — they flash briefly and
    // are always stale by the time the popup reopens.
});

const backupHint = document.getElementById('backupHint');

function setRunningUI(running) {
    btn.style.display = running ? 'none' : '';
    stopBtn.style.display = running ? '' : 'none';
    stopBtn.disabled = false; // reset disabled state from previous stop click
    backupHint.style.display = running ? '' : 'none';
    setOptionsDisabled(running);
}

// ─── Build tab selection grid ────────────────────────────────────────
function buildTabGrid(savedSelections) {
    tabGrid.innerHTML = '';
    KNOWN_TABS.forEach(tab => {
        const isChecked = savedSelections
            ? (savedSelections[tab.cls] ?? tab.on)
            : tab.on;

        const label = document.createElement('label');
        label.className = 'tab-item';
        label.innerHTML =
            `<input type="checkbox" data-tab="${tab.cls}" ${isChecked ? 'checked' : ''}>` +
            `<span class="tab-item-check"></span>` +
            `<span class="tab-item-label">${tab.label}</span>`;
        tabGrid.appendChild(label);
    });
    updateTabCount();
}

function updateTabCount() {
    const checks = tabGrid.querySelectorAll('input[type="checkbox"]');
    const checked = Array.from(checks).filter(c => c.checked).length;
    tabSelectionCount.textContent = `${checked}/${checks.length}`;
}

function getSelectedTabClasses() {
    const checks = tabGrid.querySelectorAll('input[type="checkbox"]:checked');
    return Array.from(checks).map(c => c.dataset.tab);
}

// ─── Persist option preferences ─────────────────────────────────────
chrome.storage.local.get(['backupOptions', 'tabSelections'], ({ backupOptions, tabSelections }) => {
    if (backupOptions) {
        optScreenshots.checked = backupOptions.screenshots !== false;
        optCli.checked = backupOptions.cli !== false;
        optProfiles.checked = backupOptions.profiles !== false;
    }
    buildTabGrid(tabSelections || null);
    updateTabSelectionDisabled();
    updateProfilesDisabled();
});

function saveOptions() {
    chrome.storage.local.set({ backupOptions: {
        screenshots: optScreenshots.checked,
        cli: optCli.checked,
        profiles: optProfiles.checked,
    }});
}

function saveTabSelections() {
    const selections = {};
    tabGrid.querySelectorAll('input[type="checkbox"]').forEach(c => {
        selections[c.dataset.tab] = c.checked;
    });
    chrome.storage.local.set({ tabSelections: selections });
}

function getOptions() {
    return {
        screenshots: optScreenshots.checked,
        cli: optCli.checked,
        profiles: optProfiles.checked,
        selectedTabs: getSelectedTabClasses(),
    };
}

optScreenshots.addEventListener('change', () => {
    saveOptions();
    updateTabSelectionDisabled();
});
optCli.addEventListener('change', saveOptions);
optProfiles.addEventListener('change', saveOptions);

// ─── Tab Selection UI ───────────────────────────────────────────────
tabSelectionToggle.addEventListener('click', () => {
    const isOpen = tabSelectionBody.classList.toggle('open');
    tabSelectionToggle.querySelector('.tab-selection-arrow').textContent = isOpen ? '\u25BE' : '\u25B8';
});

tabGrid.addEventListener('change', () => {
    updateTabCount();
    saveTabSelections();
    updateProfilesDisabled();
});

document.getElementById('selectAllTabs').addEventListener('click', (e) => {
    e.preventDefault();
    tabGrid.querySelectorAll('input').forEach(c => c.checked = true);
    updateTabCount();
    saveTabSelections();
    updateProfilesDisabled();
});

document.getElementById('selectNoneTabs').addEventListener('click', (e) => {
    e.preventDefault();
    tabGrid.querySelectorAll('input').forEach(c => c.checked = false);
    updateTabCount();
    saveTabSelections();
    updateProfilesDisabled();
});

function updateTabSelectionDisabled() {
    const disabled = !optScreenshots.checked;
    tabGrid.querySelectorAll('input').forEach(c => c.disabled = disabled);
    tabSelectionToggle.style.opacity = disabled ? '0.4' : '';
    tabSelectionToggle.style.pointerEvents = disabled ? 'none' : '';
    updateProfilesDisabled();
}

function updateProfilesDisabled() {
    // Profiles only makes sense when PID Tuning tab is selected for screenshots
    const pidChecked = optScreenshots.checked &&
        !!tabGrid.querySelector('input[data-tab="tab_pid_tuning"]:checked');
    optProfiles.disabled = !pidChecked;
    optProfiles.closest('.option').style.opacity = pidChecked ? '' : '0.4';
}

// ─── Start Backup ───────────────────────────────────────────────────
btn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.url?.includes("app.betaflight.com")) {
        showStatus("Open the Betaflight Configurator first!", "error");
        return;
    }

    const options = getOptions();
    if (!options.screenshots && !options.cli) {
        showStatus("Select at least one backup option!", "error");
        return;
    }
    if (options.screenshots && options.selectedTabs.length === 0) {
        showStatus("Select at least one tab to screenshot!", "error");
        return;
    }

    setRunningUI(true);
    showStatus("Starting backup...", "running");
    chrome.runtime.sendMessage({ action: "startBackup", tabId: tab.id, options });
});

// ─── Stop Backup ───────────────────────────────────────────────────
stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: "stopBackup" });
    showStatus("Stopping backup...", "running");
    stopBtn.disabled = true;
});

// ─── Live updates from background ───────────────────────────────────
chrome.runtime.onMessage.addListener((request) => {
    if (request.action === "backupStatusUpdate") {
        showStatus(request.message, "running", request.progress);
    } else if (request.action === "backupComplete") {
        showStatus("Backup completed!", "success");
        setRunningUI(false);
    } else if (request.action === "backupError") {
        showStatus(request.message, "error");
        setRunningUI(false);
    }
});

function setOptionsDisabled(disabled) {
    optScreenshots.disabled = disabled;
    optCli.disabled = disabled;
    optProfiles.disabled = disabled;
    tabGrid.querySelectorAll('input').forEach(c => c.disabled = disabled);
    tabSelectionToggle.style.opacity = disabled ? '0.4' : '';
    tabSelectionToggle.style.pointerEvents = disabled ? 'none' : '';
}

function showStatus(msg, type, progress) {
    statusText.textContent = msg;
    statusEl.className = 'status' + (type ? ' ' + type : '');

    const isRunning = type === 'running';
    progressBar.classList.toggle('visible', isRunning);

    if (isRunning && progress && progress.total > 0) {
        const pct = Math.round((progress.current / progress.total) * 100);
        progressFill.style.width = pct + '%';
        progressFill.style.animation = 'none';
        progressLabel.textContent = `${progress.current} / ${progress.total}`;
    } else if (isRunning) {
        // Indeterminate mode
        progressFill.style.width = '';
        progressFill.style.animation = '';
        progressLabel.textContent = '';
    }
}
