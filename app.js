// 1f2c - 1 Folder 2 Computers
// P2P File Synchronization Tool

// ========== CONSTANTS ==========
const BLOCK_SIZE = 16 * 1024 * 1024; // 16MB
const CHUNK_SIZE = 512 * 1024;
const MAX_FILES = 10000;
const CONNECTION_TIMEOUT = 60000; // 60 seconds
const CACHE_EXPIRY_DAYS = 7;

const IS_ELECTRON = !!(window.electronAPI && window.electronAPI.isElectron);

// ========== STATE ==========
const state = {
    username: null,
    mode: null, // 'sender' or 'receiver'
    peer: null,
    connection: null,
    shareCode: null,
    remoteUsername: null,
    
    // Sender state
    folderHandle: null,
    folderPath: null,
    manifest: null,
    manifestCache: [],
    
    // Receiver state
    targetFolderHandle: null,
    targetFolderPath: null,
    receivedManifest: null,
    targetIndex: new Map(), // relPath -> { size, modified, absPath? , handle? }
    
    // Transfer state
    isPaused: false,
    transferring: false,
    currentFile: null,
    currentBlock: 0,
    bytesTransferred: 0,
    bytesTotalPlanned: null, // receiver: total bytes that actually need to transfer (delta)
    bytesProcessed: 0, // receiver: bytes processed during block-checking/validation (not necessarily transferred)
    progressPhase: 'transfer', // 'transfer' | 'checking' | 'validating'
    totalBlocks: 0,
    blocksCompleted: 0,
    blocksProcessed: 0,
    receiverReportedDone: false, // sender: receiver confirmed it needs nothing / is done
    completionWarnings: [],
    startTime: null,
    fileMap: new Map(), // For storing file data during transfer
    
    // Timeouts
    timeoutId: null
};

// ========== UTILITY FUNCTIONS ==========

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    document.getElementById(screenId).classList.remove('hidden');
}

function showError(message) {
    document.getElementById('error-message').textContent = message;
    showScreen('error-screen');
}

function generateShareCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return 'Calculating...';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function normalizePath(path) {
    return path.replace(/\//g, '\\');
}

async function ensurePeerJsLoaded() {
    if (window.Peer) return;

    const loadScript = (src) => new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('Failed to load script: ' + src));
        document.head.appendChild(s);
    });

    // Prefer local PeerJS when running in Electron (offline-friendly).
    if (IS_ELECTRON) {
        try {
            await loadScript('./node_modules/peerjs/dist/peerjs.min.js');
            if (window.Peer) return;
        } catch (e) {
            // Fall through to CDN.
            console.warn(e);
        }
    }

    await loadScript('https://cdn.jsdelivr.net/npm/peerjs@latest/dist/peerjs.min.js');
}

function getRootFolderNameFromSelection(dirHandleOrPath) {
    if (typeof dirHandleOrPath === 'string') {
        return window.electronAPI.basename(dirHandleOrPath);
    }
    return dirHandleOrPath.name;
}

function resolveAbsolutePath(rootPath, relativePath) {
    if (!rootPath) throw new Error('Root path not set');
    const parts = normalizePath(relativePath).split('\\').filter(Boolean);
    return window.electronAPI.joinPath(rootPath, ...parts);
}

function safeSend(message) {
    const conn = state.connection;
    if (!conn || !conn.open) return false;
    try {
        conn.send(message);
        return true;
    } catch (e) {
        console.warn('Send failed:', e);
        return false;
    }
}

// ========== LOCAL STORAGE ==========

function saveUsername(username) {
    localStorage.setItem('1f2c_username', username);
}

function loadUsername() {
    return localStorage.getItem('1f2c_username');
}

function saveManifestCache(folderName, manifest) {
    const cache = loadManifestCache();
    const entry = {
        folderName,
        manifest,
        timestamp: Date.now()
    };
    
    // Remove old entry for same folder if exists
    const filtered = cache.filter(c => c.folderName !== folderName);
    filtered.unshift(entry);
    
    // Keep only recent entries (within 7 days)
    const cutoff = Date.now() - (CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    const valid = filtered.filter(c => c.timestamp > cutoff).slice(0, 5); // Max 5 entries
    
    localStorage.setItem('1f2c_manifest_cache', JSON.stringify(valid));
}

function loadManifestCache() {
    const cached = localStorage.getItem('1f2c_manifest_cache');
    if (!cached) return [];
    
    const cache = JSON.parse(cached);
    const cutoff = Date.now() - (CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    return cache.filter(c => c.timestamp > cutoff);
}

// ========== INITIALIZATION ==========

document.addEventListener('DOMContentLoaded', () => {
    initializeTheme();
    initializeApp();
    setupEventListeners();
});

function initializeTheme() {
    const toggle = document.getElementById('theme-toggle');
    if (toggle) {
        toggle.addEventListener('click', () => {
            const current = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
            const next = current === 'dark' ? 'light' : 'dark';
            localStorage.setItem('1f2c_theme', next);
            applyTheme(next);
        });
    }

    const stored = localStorage.getItem('1f2c_theme'); // 'light' | 'dark' | null
    const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    const prefersDark = media ? media.matches : false;
    const theme = stored || (prefersDark ? 'dark' : 'light');
    applyTheme(theme);

    // If user hasn't explicitly chosen a theme, track system/browser theme changes.
    if (!stored && media) {
        const onChange = (e) => {
            const stillNoUserChoice = !localStorage.getItem('1f2c_theme');
            if (!stillNoUserChoice) return;
            applyTheme(e.matches ? 'dark' : 'light');
        };

        if (typeof media.addEventListener === 'function') {
            media.addEventListener('change', onChange);
        } else if (typeof media.addListener === 'function') {
            media.addListener(onChange);
        }
    }
}

function applyTheme(theme) {
    document.documentElement.classList.toggle('dark', theme === 'dark');

    const toggle = document.getElementById('theme-toggle');
    if (toggle) {
        toggle.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
    }
}

function initializeApp() {
    const username = loadUsername();
    if (username) {
        state.username = username;
        document.getElementById('display-username').textContent = username;
        showScreen('mode-screen');
    } else {
        showScreen('username-screen');
    }
}

function setupEventListeners() {
    // Username setup
    document.getElementById('username-submit').addEventListener('click', handleUsernameSubmit);
    document.getElementById('username-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleUsernameSubmit();
    });
    
    // Mode selection
    document.getElementById('sender-mode-btn').addEventListener('click', () => startSenderMode());
    document.getElementById('receiver-mode-btn').addEventListener('click', () => startReceiverMode());
    
    // Sender flow
    document.getElementById('select-folder-btn').addEventListener('click', selectFolder);
    document.getElementById('sender-back-btn').addEventListener('click', () => showScreen('mode-screen'));
    document.getElementById('cancel-indexing-btn').addEventListener('click', cancelIndexing);
    document.getElementById('sender-cancel-btn').addEventListener('click', resetToMode);
    document.getElementById('copy-code-btn').addEventListener('click', copyShareCode);
    document.getElementById('approve-btn').addEventListener('click', () => handleApproval(true));
    document.getElementById('reject-btn').addEventListener('click', () => handleApproval(false));
    
    // Receiver flow
    document.getElementById('connect-btn').addEventListener('click', connectToSender);
    document.getElementById('share-code-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') connectToSender();
    });
    document.getElementById('receiver-back-btn').addEventListener('click', () => showScreen('mode-screen'));
    document.getElementById('receiver-cancel-waiting-btn').addEventListener('click', () => {
        if (state.connection) state.connection.close();
        showScreen('receiver-code-screen');
    });
    document.getElementById('select-target-folder-btn').addEventListener('click', selectTargetFolder);
    
    // Transfer controls
    document.getElementById('pause-btn').addEventListener('click', pauseTransfer);
    document.getElementById('resume-btn').addEventListener('click', resumeTransfer);
    document.getElementById('cancel-transfer-btn').addEventListener('click', cancelTransfer);
    
    // Complete/Error
    document.getElementById('new-transfer-btn').addEventListener('click', resetToMode);
    document.getElementById('error-ok-btn').addEventListener('click', handleError);
}

// ========== USERNAME SETUP ==========

function handleUsernameSubmit() {
    const input = document.getElementById('username-input');
    const username = input.value.trim();
    
    if (!username) {
        alert('Please enter a username');
        return;
    }
    
    state.username = username;
    saveUsername(username);
    document.getElementById('display-username').textContent = username;
    showScreen('mode-screen');
}

// ========== MODE SELECTION ==========

function startSenderMode() {
    state.mode = 'sender';
    
    // Load cached manifests
    const cache = loadManifestCache();
    const cacheContainer = document.getElementById('cached-manifests');
    const cacheList = document.getElementById('cached-list');
    
    if (cache.length > 0) {
        cacheList.innerHTML = '';
        
        cache.forEach((entry, index) => {
            const btn = document.createElement('button');
            btn.className = 'btn btn-secondary cache-btn';
            btn.innerHTML = `
                <strong>${entry.folderName}</strong><br>
                <small>${entry.manifest.fileCount} files, ${formatBytes(entry.manifest.totalSize)}</small>
                <span class="cache-dismiss" data-folder="${entry.folderName}">×</span>
            `;
            btn.addEventListener('click', (e) => {
                if (!e.target.classList.contains('cache-dismiss')) {
                    useCachedManifest(entry);
                }
            });
            cacheList.appendChild(btn);
        });
        
        // Add event listeners to dismiss buttons
        cacheList.querySelectorAll('.cache-dismiss').forEach(dismissBtn => {
            dismissBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const folderName = e.target.dataset.folder;
                removeCachedManifest(folderName);
                startSenderMode(); // Refresh the list
            });
        });
        
        cacheContainer.classList.remove('hidden');
    } else {
        // Hide container if no cached manifests
        cacheContainer.classList.add('hidden');
    }
    
    showScreen('sender-folder-screen');
}

function removeCachedManifest(folderName) {
    const cache = loadManifestCache();
    const filtered = cache.filter(c => c.folderName !== folderName);
    localStorage.setItem('1f2c_manifest_cache', JSON.stringify(filtered));
}

function startReceiverMode() {
    state.mode = 'receiver';
    document.getElementById('code-error').classList.add('hidden');
    document.getElementById('share-code-input').value = '';
    showScreen('receiver-code-screen');
}

function resetToMode() {
    cleanup();
    showScreen('mode-screen');
}

function cleanup() {
    if (state.peer) {
        state.peer.destroy();
        state.peer = null;
    }
    if (state.connection) {
        state.connection.close();
        state.connection = null;
    }
    if (state.timeoutId) {
        clearTimeout(state.timeoutId);
        state.timeoutId = null;
    }
    
    state.folderHandle = null;
    state.folderPath = null;
    state.manifest = null;
    state.targetFolderHandle = null;
    state.targetFolderPath = null;
    state.receivedManifest = null;
    state.targetIndex.clear();
    state.shareCode = null;
    state.remoteUsername = null;
    state.isPaused = false;
    state.transferring = false;
    state.currentFile = null;
    state.currentBlock = 0;
    state.bytesTransferred = 0;
    state.bytesTotalPlanned = null;
    state.bytesProcessed = 0;
    state.progressPhase = 'transfer';
    state.totalBlocks = 0;
    state.blocksCompleted = 0;
    state.blocksProcessed = 0;
    state.receiverReportedDone = false;
    state.completionWarnings = [];
    state.fileMap.clear();
}

function computeTotalBlocks(manifest) {
    if (!manifest || !Array.isArray(manifest.files)) return 0;
    let total = 0;
    for (const f of manifest.files) {
        if (f && Array.isArray(f.blocks)) total += f.blocks.length;
    }
    return total;
}

function updateBlockProgressUI() {
    const el = document.getElementById('file-progress');
    if (!el) return;
    el.textContent = `${state.blocksCompleted} / ${state.totalBlocks}`;
}

// ========== SENDER: FOLDER SELECTION & INDEXING ==========

async function selectFolder() {
    try {
        if (IS_ELECTRON) {
            const folderPath = await window.electronAPI.pickDirectory();
            if (!folderPath) return;
            state.folderPath = folderPath;
            state.folderHandle = null;
            await indexFolder(folderPath);
        } else {
            const handle = await window.showDirectoryPicker();
            state.folderHandle = handle;
            state.folderPath = null;
            await indexFolder(handle);
        }
    } catch (error) {
        if (error.name !== 'AbortError') {
            showError('Failed to select folder: ' + error.message);
        }
    }
}

async function useCachedManifest(entry) {
    state.manifest = entry.manifest;
    if (IS_ELECTRON) {
        const folderPath = await window.electronAPI.pickDirectory();
        if (!folderPath) return;
        state.folderPath = folderPath;
        state.folderHandle = null;
    } else {
        // Cached manifest includes hashes already; this prompt is only to regain permission
        // to read file bytes during transfer (no re-indexing / no re-hashing).
        const handle = await window.showDirectoryPicker();
        if (!handle) return;
        if (handle.name !== entry.folderName) {
            showError(`Selected folder "${handle.name}" does not match cached manifest "${entry.folderName}"`);
            return;
        }
        state.folderHandle = handle;
        state.folderPath = null;
    }
    startSenderConnection();
}

let indexingCancelled = false;
let scannerLogs = [];
let indexingTotalBlocks = 0;
let indexingHashedBlocks = 0;

function addScannerLog(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `[${timestamp}] ${message}`;
    scannerLogs.push(logEntry);
    console.log(logEntry);
    
    // Update log display if it exists
    const logContainer = document.getElementById('scanner-logs');
    if (logContainer) {
        const logItem = document.createElement('div');
        logItem.className = `log-item log-${type}`;
        logItem.textContent = logEntry;
        logContainer.appendChild(logItem);
        logContainer.scrollTop = logContainer.scrollHeight;
    }
}

async function indexFolder(dirHandleOrPath) {
    indexingCancelled = false;
    scannerLogs = [];
    showScreen('sender-indexing-screen');
    
    const files = [];
    const folders = [];
    
    document.getElementById('indexing-status').textContent = 'Scanning folder...';
    document.getElementById('indexing-current').textContent = '0';
    document.getElementById('indexing-total').textContent = '?';
    document.getElementById('indexing-percent').textContent = '0%';
    
    addScannerLog(`Starting scan of folder: ${getRootFolderNameFromSelection(dirHandleOrPath)}`, 'info');
    
    try {
        // Recursively scan folder
        if (IS_ELECTRON) {
            await scanDirectoryPath(dirHandleOrPath, '', files, folders);
        } else {
            await scanDirectory(dirHandleOrPath, '', files, folders);
        }
        
        if (indexingCancelled) {
            addScannerLog('Scan cancelled by user', 'warning');
            showScreen('sender-folder-screen');
            return;
        }
        
        addScannerLog(`Scan complete: ${folders.length} folders, ${files.length} files found`, 'success');
        
        if (files.length > MAX_FILES) {
            showError(`Folder contains ${files.length} files. Maximum is ${MAX_FILES} files.`);
            return;
        }
        
        document.getElementById('indexing-total').textContent = files.length;
        document.getElementById('indexing-status').textContent = 'Hashing files...';

        // Compute total blocks up-front so the progress % can be truly block-based.
        indexingHashedBlocks = 0;
        indexingTotalBlocks = files.reduce((sum, f) => {
            const size = IS_ELECTRON ? f.size : (f.file ? f.file.size : 0);
            return sum + Math.ceil(size / BLOCK_SIZE);
        }, 0);
        if (indexingTotalBlocks > 0) {
            document.getElementById('indexing-status').textContent = `Hashing blocks... (0 / ${indexingTotalBlocks})`;
        }
        
        addScannerLog('Starting hash computation...', 'info');
        
        // Hash files
        const manifest = {
            version: 1,
            totalSize: 0,
            fileCount: files.length,
            folders: folders,
            files: []
        };
        
        for (let i = 0; i < files.length; i++) {
            if (indexingCancelled) {
                addScannerLog('Hashing cancelled by user', 'warning');
                showScreen('sender-folder-screen');
                return;
            }
            
            const fileInfo = files[i];
            document.getElementById('indexing-current').textContent = (i + 1);
            // Keep showing the current file, but do NOT update % here when we are using block-based progress.
            document.getElementById('indexing-current-file').textContent = fileInfo.path;

            if (!indexingTotalBlocks || indexingTotalBlocks <= 0) {
                const progress = ((i + 1) / files.length) * 100;
                document.getElementById('indexing-progress').style.width = progress + '%';
                document.getElementById('indexing-percent').textContent = Math.round(progress) + '%';
            }
            
            addScannerLog(`Hashing file [${i + 1}/${files.length}]: ${fileInfo.path}`, 'info');

            let blocks;
            let size;
            let modified;

            if (IS_ELECTRON) {
                blocks = await hashFilePath(fileInfo.absPath, fileInfo.path, fileInfo.size);
                size = fileInfo.size;
                modified = fileInfo.modified;
            } else {
                blocks = await hashFile(fileInfo.file, fileInfo.path);
                size = fileInfo.file.size;
                modified = fileInfo.file.lastModified;
            }
            
            manifest.files.push({
                path: fileInfo.path,
                size,
                modified,
                blocks: blocks
            });
            
            manifest.totalSize += size;
        }
        
        addScannerLog(`Hash computation complete. Total size: ${formatBytes(manifest.totalSize)}`, 'success');
        
        state.manifest = manifest;
        
        // Cache manifest
        saveManifestCache(getRootFolderNameFromSelection(dirHandleOrPath), manifest);
        
        // Start sender connection
        startSenderConnection();
        
    } catch (error) {
        addScannerLog(`Error: ${error.message}`, 'error');
        showError('Indexing failed: ' + error.message);
    }
}

async function scanDirectoryPath(rootPath, relativePath, files, folders) {
    if (indexingCancelled) {
        addScannerLog('Scan cancelled by user', 'warning');
        return;
    }

    const folderLabel = relativePath || window.electronAPI.basename(rootPath);
    addScannerLog(`Scanning folder: ${folderLabel}`, 'info');

    const absoluteDirPath = relativePath ? resolveAbsolutePath(rootPath, relativePath) : rootPath;

    let entries;
    try {
        entries = await window.electronAPI.listDir(absoluteDirPath);
    } catch (error) {
        addScannerLog(`  Unable to enumerate folder: ${folderLabel} (${error.message})`, 'warning');
        return;
    }

    addScannerLog(`  Enumerated ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`, 'info');

    // Files first
    for (const entry of entries) {
        if (indexingCancelled) return;
        if (entry.kind !== 'file') continue;

        const entryRelPath = relativePath ? normalizePath(relativePath + '\\' + entry.name) : entry.name;
        const entryAbsPath = resolveAbsolutePath(rootPath, entryRelPath);

        try {
            const st = await window.electronAPI.statFile(entryAbsPath);
            files.push({
                absPath: entryAbsPath,
                path: entryRelPath,
                size: st.size,
                modified: Math.round(st.mtimeMs)
            });
            addScannerLog(`  Found file: ${entry.name} (${formatBytes(st.size)})`, 'info');
        } catch (error) {
            addScannerLog(`  Skipping unreadable file: ${entryRelPath} (${error.message})`, 'warning');
        }
    }

    // Then subfolders
    for (const entry of entries) {
        if (indexingCancelled) return;
        if (entry.kind !== 'directory') continue;

        const entryRelPath = relativePath ? normalizePath(relativePath + '\\' + entry.name) : entry.name;
        folders.push(entryRelPath);
        addScannerLog(`  Found subfolder: ${entry.name}`, 'info');

        try {
            await scanDirectoryPath(rootPath, entryRelPath, files, folders);
        } catch (error) {
            addScannerLog(`  Skipping unreadable folder: ${entryRelPath} (${error.message})`, 'warning');
        }
    }
}

async function hashFilePath(absoluteFilePath, relativeFilePath, fileSize) {
    const blocks = [];
    const blockCount = Math.ceil(fileSize / BLOCK_SIZE);

    for (let i = 0; i < blockCount; i++) {
        if (indexingCancelled) throw new Error('Cancelled');

        // Per-block UI updates so large files don't look stuck
        const currentFileEl = document.getElementById('indexing-current-file');
        if (currentFileEl) currentFileEl.textContent = `${relativeFilePath} (block ${i + 1}/${blockCount})`;

        const start = i * BLOCK_SIZE;
        const end = Math.min(start + BLOCK_SIZE, fileSize);
        const arrayBuffer = await window.electronAPI.readFileSlice(absoluteFilePath, start, end);
        const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashBase64 = btoa(String.fromCharCode.apply(null, hashArray));

        blocks.push({
            index: i,
            hash: hashBase64
        });

        // Block-based overall %
        indexingHashedBlocks++;
        if (indexingTotalBlocks > 0) {
            const pct = Math.max(0, Math.min(100, (indexingHashedBlocks / indexingTotalBlocks) * 100));
            const bar = document.getElementById('indexing-progress');
            const percentEl = document.getElementById('indexing-percent');
            const statusEl = document.getElementById('indexing-status');
            if (bar) bar.style.width = pct + '%';
            if (percentEl) percentEl.textContent = Math.round(pct) + '%';
            if (statusEl) statusEl.textContent = `Hashing blocks... (${indexingHashedBlocks} / ${indexingTotalBlocks})`;
        }

        addScannerLog(`    Block ${i}/${blockCount - 1}: ${hashBase64.substring(0, 16)}...`, 'info');
    }

    addScannerLog(`  Completed hashing: ${relativeFilePath} (${blockCount} blocks)`, 'success');
    return blocks;
}

async function listDirectoryEntries(dirHandle) {
    // Prefer entries() so we always get the name+handle pairs.
    // Fallback to values() if needed.
    const entries = [];

    if (typeof dirHandle.entries === 'function') {
        for await (const [name, handle] of dirHandle.entries()) {
            entries.push({ name, handle });
        }
    } else {
        for await (const handle of dirHandle.values()) {
            entries.push({ name: handle.name, handle });
        }
    }

    // Deterministic order makes debugging easier.
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return entries;
}

async function scanDirectory(dirHandle, relativePath, files, folders) {
    if (indexingCancelled) {
        addScannerLog('Scan cancelled by user', 'warning');
        return;
    }

    const folderPath = relativePath || dirHandle.name;
    addScannerLog(`Scanning folder: ${folderPath}`, 'info');

    let entries;
    try {
        entries = await listDirectoryEntries(dirHandle);
    } catch (error) {
        addScannerLog(`  Unable to enumerate folder: ${folderPath} (${error.message})`, 'warning');
        return;
    }

    addScannerLog(`  Enumerated ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`, 'info');

    // Process files first (prevents “looks like it skipped files” when a big subfolder appears early)
    for (const { name, handle } of entries) {
        if (indexingCancelled) return;

        const entryPath = relativePath
            ? normalizePath(relativePath + '\\' + name)
            : name;

        if (handle.kind !== 'file') continue;

        try {
            const file = await handle.getFile();
            files.push({ file, path: entryPath });
            addScannerLog(`  Found file: ${name} (${formatBytes(file.size)})`, 'info');
        } catch (error) {
            addScannerLog(`  Skipping unreadable file: ${entryPath} (${error.message})`, 'warning');
        }
    }

    // Then process subfolders
    for (const { name, handle } of entries) {
        if (indexingCancelled) return;

        const entryPath = relativePath
            ? normalizePath(relativePath + '\\' + name)
            : name;

        if (handle.kind !== 'directory') continue;

        folders.push(entryPath);
        addScannerLog(`  Found subfolder: ${name}`, 'info');

        try {
            await scanDirectory(handle, entryPath, files, folders);
        } catch (error) {
            addScannerLog(`  Skipping unreadable folder: ${entryPath} (${error.message})`, 'warning');
        }
    }
}

async function hashFile(file, filePath) {
    const blocks = [];
    const blockCount = Math.ceil(file.size / BLOCK_SIZE);
    
    for (let i = 0; i < blockCount; i++) {
        if (indexingCancelled) throw new Error('Cancelled');

        // Per-block UI updates so large files don't look stuck
        const currentFileEl = document.getElementById('indexing-current-file');
        if (currentFileEl) currentFileEl.textContent = `${filePath} (block ${i + 1}/${blockCount})`;
        
        const start = i * BLOCK_SIZE;
        const end = Math.min(start + BLOCK_SIZE, file.size);
        const blob = file.slice(start, end);
        const arrayBuffer = await blob.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashBase64 = btoa(String.fromCharCode.apply(null, hashArray));
        
        blocks.push({
            index: i,
            hash: hashBase64
        });

        // Block-based overall %
        indexingHashedBlocks++;
        if (indexingTotalBlocks > 0) {
            const pct = Math.max(0, Math.min(100, (indexingHashedBlocks / indexingTotalBlocks) * 100));
            const bar = document.getElementById('indexing-progress');
            const percentEl = document.getElementById('indexing-percent');
            const statusEl = document.getElementById('indexing-status');
            if (bar) bar.style.width = pct + '%';
            if (percentEl) percentEl.textContent = Math.round(pct) + '%';
            if (statusEl) statusEl.textContent = `Hashing blocks... (${indexingHashedBlocks} / ${indexingTotalBlocks})`;
        }
        
        addScannerLog(`    Block ${i}/${blockCount - 1}: ${hashBase64.substring(0, 16)}...`, 'info');
    }
    
    addScannerLog(`  Completed hashing: ${filePath} (${blockCount} blocks)`, 'success');
    
    return blocks;
}

function cancelIndexing() {
    indexingCancelled = true;
}

// ========== SENDER: CONNECTION ==========

function startSenderConnection() {
    const code = generateShareCode();
    state.shareCode = code;
    
    document.getElementById('share-code').textContent = code;
    showScreen('sender-share-screen');
    
    // Initialize PeerJS
    ensurePeerJsLoaded().then(() => {
        state.peer = new Peer(code);

        state.peer.on('open', () => {
            console.log('Sender peer initialized:', code);
        });
        
        state.peer.on('connection', (conn) => {
            handleIncomingConnection(conn);
        });
        
        state.peer.on('error', (error) => {
            console.error('Peer error:', error);
            showError('Connection error: ' + error.message);
        });
    }).catch((error) => {
        showError('Failed to load PeerJS: ' + error.message);
    });
}

function handleIncomingConnection(conn) {
    if (state.connection) {
        // Already have a connection, reject this one
        conn.close();
        return;
    }
    
    state.connection = conn;
    
    conn.on('data', (data) => {
        handleSenderMessage(data);
    });
    
    conn.on('close', () => {
        // If we're mid-transfer, a close usually means the receiver finished and exited.
        if (state.transferring && state.mode === 'sender' && state.manifest) {
            if (state.receiverReportedDone) {
                completeTransfer();
                return;
            }
            const total = state.manifest.totalSize;
            // Count as complete once we've streamed (at least) the full byte payload.
            if (typeof total === 'number' && total >= 0 && state.bytesTransferred >= total) {
                completeTransfer();
                return;
            }

            showError('Connection closed by receiver before transfer completed');
            return;
        }

        showError('Connection closed by receiver');
    });
    
    conn.on('error', (error) => {
        showError('Connection error: ' + error.message);
    });
}

function handleSenderMessage(message) {
    switch (message.type) {
        case 'hello':
            state.remoteUsername = message.username || null;
            showApprovalScreen(message.username);
            break;
        case 'request_manifest':
            // Receiver is ready; switch sender UI out of waiting state.
            if (state.mode === 'sender') {
                const titleEl = document.getElementById('transfer-title');
                if (titleEl && titleEl.textContent === 'Waiting for receiver...') {
                    titleEl.textContent = 'Sending Files';
                }
                const peerEl = document.getElementById('peer-name');
                if (peerEl && state.remoteUsername) {
                    peerEl.textContent = state.remoteUsername;
                }
            }
            sendManifest();
            break;
        case 'request_block':
            // Receiver actively requesting data; ensure we show active state.
            if (state.mode === 'sender') {
                const titleEl = document.getElementById('transfer-title');
                if (titleEl && titleEl.textContent === 'Waiting for receiver...') {
                    titleEl.textContent = 'Sending Files';
                }
                const peerEl = document.getElementById('peer-name');
                if (peerEl && state.remoteUsername) {
                    peerEl.textContent = state.remoteUsername;
                }
            }
            sendBlock(message.file, message.block);
            break;
        case 'pause':
            state.isPaused = true;
            updateTransferUI();
            break;
        case 'resume':
            state.isPaused = false;
            updateTransferUI();
            break;
        case 'cancel':
            showError('Transfer cancelled by receiver');
            break;
        case 'receiver_done':
            // Receiver indicates it did not need any data (or has completed without downloading).
            state.receiverReportedDone = true;
            if (state.transferring && state.mode === 'sender') {
                completeTransfer();
            }
            break;
        default:
            console.warn('Unknown message type:', message.type);
    }
}

function showApprovalScreen(username) {
    document.getElementById('receiver-username').textContent = username;
    showScreen('sender-approve-screen');
    
    let countdown = 60;
    document.getElementById('approve-timeout').textContent = `(${countdown}s)`;
    
    state.timeoutId = setInterval(() => {
        countdown--;
        document.getElementById('approve-timeout').textContent = `(${countdown}s)`;
        
        if (countdown <= 0) {
            clearInterval(state.timeoutId);
            handleApproval(false);
        }
    }, 1000);
}

function handleApproval(accepted) {
    if (state.timeoutId) {
        clearInterval(state.timeoutId);
        state.timeoutId = null;
    }
    
    if (accepted) {
        state.connection.send({
            type: 'acknowledge',
            accepted: true,
            senderUsername: state.username
        });
        
        // Wait for receiver to select folder and request manifest
        showScreen('transfer-screen');
        document.getElementById('transfer-title').textContent = 'Waiting for receiver...';
        document.getElementById('peer-name').textContent = state.remoteUsername || 'Receiver';
        state.transferring = true;
        state.startTime = Date.now();
        state.bytesTransferred = 0;
        state.currentFile = null;
        state.currentBlock = 0;
        state.totalBlocks = computeTotalBlocks(state.manifest);
        state.blocksCompleted = 0;
        state.blocksProcessed = 0;
        updateBlockProgressUI();
        updateTransferUI();
    } else {
        state.connection.send({
            type: 'acknowledge',
            accepted: false,
            senderUsername: state.username,
            reason: 'rejected'
        });
        state.connection.close();
        state.connection = null;
        showScreen('sender-share-screen');
    }
}

function sendManifest() {
    state.connection.send({
        type: 'manifest',
        data: state.manifest
    });
}

async function sendBlock(filePath, blockIndex) {
    if (state.isPaused) {
        // Will send when resumed
        return;
    }
    
    try {
        // Find file in manifest
        const fileInfo = state.manifest.files.find(f => f.path === filePath);
        if (!fileInfo) {
            throw new Error('File not found: ' + filePath);
        }
        
        // Read block
        const start = blockIndex * BLOCK_SIZE;
        const end = Math.min(start + BLOCK_SIZE, fileInfo.size);

        let blockData;

        if (IS_ELECTRON) {
            if (!state.folderPath) {
                throw new Error('Folder not selected. Please re-select the folder to share.');
            }
            const absoluteFilePath = resolveAbsolutePath(state.folderPath, filePath);
            blockData = await window.electronAPI.readFileSlice(absoluteFilePath, start, end);
        } else {
            if (!state.folderHandle) {
                throw new Error('Folder access not granted. Re-select the cached folder before transferring.');
            }
            // Get file handle (need to navigate directory structure)
            const fileHandle = await getFileHandle(state.folderHandle, filePath);
            const file = await fileHandle.getFile();
            blockData = await file.slice(start, end).arrayBuffer();
        }
        
        // Split into chunks and send
        const chunkCount = Math.ceil(blockData.byteLength / CHUNK_SIZE);

        // Update sender UI for current work item
        state.currentFile = filePath;
        state.currentBlock = blockIndex;
        const currentFileEl = document.getElementById('current-file-name');
        if (currentFileEl) currentFileEl.textContent = filePath;
        
        for (let i = 0; i < chunkCount; i++) {
            if (state.isPaused) {
                // Wait for resume
                await new Promise(resolve => {
                    const checkPause = setInterval(() => {
                        if (!state.isPaused) {
                            clearInterval(checkPause);
                            resolve();
                        }
                    }, 100);
                });
            }
            
            const chunkStart = i * CHUNK_SIZE;
            const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, blockData.byteLength);
            const chunkData = blockData.slice(chunkStart, chunkEnd);
            
            state.connection.send({
                type: 'block_chunk',
                file: filePath,
                block: blockIndex,
                chunk: i,
                total: chunkCount,
                data: chunkData
            });

            // Sender-side progress (bytes streamed)
            state.bytesTransferred += chunkData.byteLength;
            updateTransferUI();
            
            // Small delay to avoid overwhelming the connection
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        
        state.connection.send({
            type: 'block_complete',
            file: filePath,
            block: blockIndex
        });

        // Block-level progress for sender
        state.blocksCompleted++;
        updateBlockProgressUI();
        
    } catch (error) {
        state.connection.send({
            type: 'error',
            message: 'Failed to send block: ' + error.message
        });
    }
}

async function getFileHandle(dirHandle, path) {
    const parts = path.split('\\');
    let currentHandle = dirHandle;
    
    for (let i = 0; i < parts.length - 1; i++) {
        currentHandle = await currentHandle.getDirectoryHandle(parts[i]);
    }
    
    return await currentHandle.getFileHandle(parts[parts.length - 1]);
}

function copyShareCode() {
    const code = state.shareCode;
    navigator.clipboard.writeText(code).then(() => {
        const btn = document.getElementById('copy-code-btn');
        const originalText = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => {
            btn.textContent = originalText;
        }, 2000);
    });
}

// ========== RECEIVER: CONNECTION ==========

function connectToSender() {
    const input = document.getElementById('share-code-input');
    const code = input.value.trim().toUpperCase();
    
    if (code.length !== 8) {
        document.getElementById('code-error').textContent = 'Share code must be 8 characters';
        document.getElementById('code-error').classList.remove('hidden');
        return;
    }
    
    document.getElementById('code-error').classList.add('hidden');
    state.shareCode = code;
    
    // Initialize PeerJS and connect
    ensurePeerJsLoaded().then(() => {
        state.peer = new Peer();

        state.peer.on('open', () => {
            console.log('Receiver peer initialized');
            connectToPeer(code);
        });
        
        state.peer.on('error', (error) => {
            console.error('Peer error:', error);
            document.getElementById('code-error').textContent = 'Failed to connect: ' + error.message;
            document.getElementById('code-error').classList.remove('hidden');
        });
    }).catch((error) => {
        document.getElementById('code-error').textContent = 'Failed to load PeerJS: ' + error.message;
        document.getElementById('code-error').classList.remove('hidden');
    });
}

function connectToPeer(code) {
    showScreen('receiver-waiting-screen');
    
    const conn = state.peer.connect(code, {
        reliable: true
    });
    
    state.connection = conn;
    
    conn.on('open', () => {
        console.log('Connected to sender');
        
        // Send hello
        conn.send({
            type: 'hello',
            username: state.username
        });
        
        // Start timeout
        let countdown = 60;
        document.getElementById('waiting-timeout').textContent = `(${countdown}s)`;
        
        state.timeoutId = setInterval(() => {
            countdown--;
            document.getElementById('waiting-timeout').textContent = `(${countdown}s)`;
            
            if (countdown <= 0) {
                clearInterval(state.timeoutId);
                conn.close();
                showError('Connection timeout - sender did not respond');
            }
        }, 1000);
    });
    
    conn.on('data', (data) => {
        handleReceiverMessage(data);
    });
    
    conn.on('close', () => {
        if (state.timeoutId) {
            clearInterval(state.timeoutId);
        }
        if (!state.transferring) {
            showError('Connection closed by sender');
        }
    });
    
    conn.on('error', (error) => {
        if (state.timeoutId) {
            clearInterval(state.timeoutId);
        }
        showError('Connection error: ' + error.message);
    });
}

function handleReceiverMessage(message) {
    switch (message.type) {
        case 'acknowledge':
            if (state.timeoutId) {
                clearInterval(state.timeoutId);
                state.timeoutId = null;
            }

            // Store sender name for UI.
            if (message.senderUsername) {
                state.remoteUsername = message.senderUsername;
            }
            
            if (message.accepted) {
                // Approved! Ask for target folder
                showScreen('receiver-folder-screen');
            } else {
                showError('Connection rejected by sender');
            }
            break;
            
        case 'manifest':
            state.receivedManifest = message.data;
            startReceiving();
            break;
            
        case 'block_chunk':
            receiveChunk(message);
            break;
            
        case 'block_complete':
            completeBlock(message.file, message.block);
            break;
            
        case 'error':
            showError('Sender error: ' + message.message);
            break;

        case 'cancel':
            // Sender cancelled the transfer.
            // Mark as transferring to suppress the close handler's generic message.
            state.transferring = true;
            try {
                if (state.connection) state.connection.close();
            } catch (_) {}
            showError('Transfer cancelled by sender');
            break;
            
        default:
            console.warn('Unknown message type:', message.type);
    }
}

async function selectTargetFolder() {
    try {
        if (IS_ELECTRON) {
            const folderPath = await window.electronAPI.pickDirectory();
            if (!folderPath) return;
            state.targetFolderPath = folderPath;
            state.targetFolderHandle = null;
        } else {
            const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
            state.targetFolderHandle = handle;
            state.targetFolderPath = null;
        }

        // Index target folder first for delta sync
        showScreen('transfer-screen');
        document.getElementById('transfer-title').textContent = 'Scanning Target Folder';
        const peerNameEl = document.getElementById('peer-name');
        if (peerNameEl) peerNameEl.textContent = state.remoteUsername || 'Sender';
        document.getElementById('current-file-name').textContent = '';
        state.bytesTransferred = 0;
        state.bytesTotalPlanned = null;
        state.bytesProcessed = 0;
        state.progressPhase = 'checking';
        updateTransferUI();

        await indexReceiverTargetFolder();

        // Request manifest
        document.getElementById('transfer-title').textContent = 'Requesting Manifest';
        state.connection.send({ type: 'request_manifest' });

        // Transfer begins when manifest arrives
        state.transferring = true;
        
    } catch (error) {
        if (error.name !== 'AbortError') {
            showError('Failed to select folder: ' + error.message);
        }
    }
}

async function indexReceiverTargetFolder() {
    state.targetIndex.clear();

    if (IS_ELECTRON) {
        if (!state.targetFolderPath) throw new Error('Target folder not selected');
        await scanReceiverTargetPath(state.targetFolderPath, '', state.targetIndex);
    } else {
        if (!state.targetFolderHandle) throw new Error('Target folder not selected');
        await scanReceiverTargetHandle(state.targetFolderHandle, '', state.targetIndex);
    }
}

async function scanReceiverTargetPath(rootPath, relativePath, indexMap) {
    const absoluteDirPath = relativePath ? resolveAbsolutePath(rootPath, relativePath) : rootPath;

    const entries = await window.electronAPI.listDir(absoluteDirPath);

    for (const entry of entries) {
        if (entry.kind !== 'file') continue;
        const entryRelPath = relativePath ? normalizePath(relativePath + '\\' + entry.name) : entry.name;
        const entryAbsPath = resolveAbsolutePath(rootPath, entryRelPath);
        try {
            const st = await window.electronAPI.statFile(entryAbsPath);
            indexMap.set(entryRelPath, {
                size: st.size,
                modified: Math.round(st.mtimeMs),
                absPath: entryAbsPath
            });
        } catch (_) {
            // Skip unreadable files
        }
    }

    for (const entry of entries) {
        if (entry.kind !== 'directory') continue;
        const entryRelPath = relativePath ? normalizePath(relativePath + '\\' + entry.name) : entry.name;
        await scanReceiverTargetPath(rootPath, entryRelPath, indexMap);
    }
}

async function scanReceiverTargetHandle(dirHandle, relativePath, indexMap) {
    const entries = await listDirectoryEntries(dirHandle);

    for (const { name, handle } of entries) {
        if (handle.kind !== 'file') continue;
        const entryPath = relativePath ? normalizePath(relativePath + '\\' + name) : name;
        try {
            const file = await handle.getFile();
            indexMap.set(entryPath, {
                size: file.size,
                modified: file.lastModified,
                handle
            });
        } catch (_) {
            // Skip unreadable files
        }
    }

    for (const { name, handle } of entries) {
        if (handle.kind !== 'directory') continue;
        const entryPath = relativePath ? normalizePath(relativePath + '\\' + name) : name;
        await scanReceiverTargetHandle(handle, entryPath, indexMap);
    }
}

// ========== RECEIVER: FILE TRANSFER ==========

async function startReceiving() {
    const manifest = state.receivedManifest;
    
    // Create folder structure
    for (const folder of manifest.folders) {
        await createDirectory(IS_ELECTRON ? state.targetFolderPath : state.targetFolderHandle, folder);
    }
    
    // Process files
    state.bytesTransferred = 0;
    state.bytesProcessed = 0;
    state.progressPhase = 'checking';
    state.bytesTotalPlanned = manifest.totalSize;
    state.totalBlocks = computeTotalBlocks(manifest);
    state.blocksCompleted = 0;
    state.blocksProcessed = 0;
    document.getElementById('transfer-total-bytes').textContent = formatBytes(state.bytesTotalPlanned);
    updateBlockProgressUI();

    document.getElementById('transfer-title').textContent = 'Receiving Files';
    state.startTime = Date.now();
    
    // Start requesting blocks
    state.currentFileIndex = 0;
    await requestNextBlock();
}

async function createDirectory(rootHandle, path) {
    if (IS_ELECTRON) {
        const absolute = resolveAbsolutePath(rootHandle, path);
        await window.electronAPI.ensureDir(absolute);
        return;
    }

    const parts = path.split('\\');
    let currentHandle = rootHandle;

    for (const part of parts) {
        currentHandle = await currentHandle.getDirectoryHandle(part, { create: true });
    }
}

async function requestNextBlock() {
    if (state.isPaused) return;
    
    const manifest = state.receivedManifest;
    
    // Find next block to request
    while (state.currentFileIndex < manifest.files.length) {
        const file = manifest.files[state.currentFileIndex];
        
        if (!state.fileMap.has(file.path)) {
            state.fileMap.set(file.path, {
                blocks: new Map(),
                completedBlocks: 0,
                totalBlocks: file.blocks.length,
                nextBlockToProcess: 0,
                preparedForFullDownload: false,
                forceDownloadAll: false
            });
        }
        
        const fileData = state.fileMap.get(file.path);

        // Determine if we can do delta checks (only when local file exists AND sizes match)
        if (!fileData._initDelta) {
            const local = state.targetIndex.get(file.path);
            fileData.local = local || null;
            fileData.forceDownloadAll = !local || local.size !== file.size;
            fileData._initDelta = true;
        }

        // If local file size differs (or missing), ensure we start from a clean slate before requesting blocks
        if (fileData.forceDownloadAll && !fileData.preparedForFullDownload) {
            await prepareReceiverFileForFullDownload(file.path);
            fileData.preparedForFullDownload = true;
        }
        
        while (fileData.nextBlockToProcess < fileData.totalBlocks) {
            const blockIndex = fileData.nextBlockToProcess;
            fileData.nextBlockToProcess++;

            const blockStart = blockIndex * BLOCK_SIZE;
            const blockEnd = Math.min(blockStart + BLOCK_SIZE, file.size);
            const blockLen = Math.max(0, blockEnd - blockStart);

            // Update UI so large files don't look stuck while we decide what to request.
            state.progressPhase = 'checking';
            state.currentFile = file.path;
            state.currentBlock = blockIndex;
            const currentFileEl = document.getElementById('current-file-name');
            if (currentFileEl) currentFileEl.textContent = `${file.path} (checking block ${blockIndex + 1}/${file.blocks.length})`;
            // Count the work we're about to do (hashing or deciding) as processed progress.
            state.bytesProcessed += blockLen;
            state.blocksProcessed++;
            updateTransferUI();

            let shouldDownload = true;
            if (!fileData.forceDownloadAll) {
                shouldDownload = await receiverShouldDownloadBlock(file, blockIndex, blockStart, blockEnd);
            }

            if (!shouldDownload) {
                fileData.completedBlocks++;
                state.blocksCompleted++;
                updateBlockProgressUI();

                // Adjust planned bytes downward as we discover blocks we can reuse locally.
                if (typeof state.bytesTotalPlanned === 'number' && Number.isFinite(state.bytesTotalPlanned)) {
                    state.bytesTotalPlanned = Math.max(state.bytesTransferred, state.bytesTotalPlanned - blockLen);
                    const totalEl = document.getElementById('transfer-total-bytes');
                    if (totalEl) totalEl.textContent = formatBytes(state.bytesTotalPlanned);
                }

                if (fileData.completedBlocks === fileData.totalBlocks) {
                    break;
                }
                continue;
            }

            // Request this block
            state.progressPhase = 'transfer';
            state.currentFile = file.path;
            state.currentBlock = blockIndex;

            document.getElementById('current-file-name').textContent = file.path;

            state.connection.send({
                type: 'request_block',
                file: file.path,
                block: blockIndex
            });

            return;
        }
        
        // File complete (either fully reused or received)
        state.currentFileIndex++;
    }
    
    // All files complete!
    // If receiver ends up needing nothing, explicitly notify sender so it can wrap up cleanly.
    if (state.mode === 'receiver') {
        const planned = typeof state.bytesTotalPlanned === 'number' && Number.isFinite(state.bytesTotalPlanned)
            ? state.bytesTotalPlanned
            : 0;
        if (planned <= 0 && state.bytesTransferred === 0) {
            try {
                state.connection.send({ type: 'receiver_done' });
            } catch (_) {}
        }
    }
    completeTransfer();
}

async function prepareReceiverFileForFullDownload(relPath) {
    if (IS_ELECTRON) {
        if (!state.targetFolderPath) throw new Error('Target folder not selected');
        const abs = resolveAbsolutePath(state.targetFolderPath, relPath);
        await window.electronAPI.truncateFile(abs, 0);
        return;
    }

    if (!state.targetFolderHandle) throw new Error('Target folder not selected');
    const parts = relPath.split('\\');
    const fileName = parts.pop();
    let dirHandle = state.targetFolderHandle;
    for (const part of parts) {
        dirHandle = await dirHandle.getDirectoryHandle(part, { create: true });
    }
    const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.truncate(0);
    await writable.close();
}

async function receiverShouldDownloadBlock(fileInfo, blockIndex, start, end) {
    const local = state.targetIndex.get(fileInfo.path);
    if (!local) return true;
    if (local.size !== fileInfo.size) return true;

    let arrayBuffer;
    if (IS_ELECTRON) {
        const abs = local.absPath || (state.targetFolderPath ? resolveAbsolutePath(state.targetFolderPath, fileInfo.path) : null);
        if (!abs) return true;
        arrayBuffer = await window.electronAPI.readFileSlice(abs, start, end);
    } else {
        const fileHandle = local.handle || (state.targetFolderHandle ? await getReceiverFileHandle(state.targetFolderHandle, fileInfo.path) : null);
        if (!fileHandle) return true;
        const file = await fileHandle.getFile();
        arrayBuffer = await file.slice(start, end).arrayBuffer();
    }

    const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashBase64 = btoa(String.fromCharCode.apply(null, hashArray));

    const expectedHash = fileInfo.blocks[blockIndex].hash;
    return hashBase64 !== expectedHash;
}

function receiveChunk(message) {
    const { file, block, chunk, total, data } = message;
    
    if (!state.fileMap.has(file)) {
        state.fileMap.set(file, {
            blocks: new Map(),
            completedBlocks: 0,
            totalBlocks: 0
        });
    }
    
    const fileData = state.fileMap.get(file);
    
    if (!fileData.blocks.has(block)) {
        fileData.blocks.set(block, {
            chunks: [],
            receivedChunks: 0,
            totalChunks: total
        });
    }
    
    const blockData = fileData.blocks.get(block);
    blockData.chunks[chunk] = data;
    blockData.receivedChunks++;
    
    // Update progress
    state.bytesTransferred += data.byteLength;
    updateTransferUI();
}

async function completeBlock(filePath, blockIndex) {
    const fileInfo = state.receivedManifest.files.find(f => f.path === filePath);
    const fileData = state.fileMap.get(filePath);
    const blockData = fileData.blocks.get(blockIndex);
    
    // Concatenate chunks
    const totalSize = blockData.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const completeBlock = new Uint8Array(totalSize);
    let offset = 0;
    
    for (const chunk of blockData.chunks) {
        completeBlock.set(new Uint8Array(chunk), offset);
        offset += chunk.byteLength;
    }
    
    // Verify hash
    const hashBuffer = await crypto.subtle.digest('SHA-256', completeBlock);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashBase64 = btoa(String.fromCharCode.apply(null, hashArray));
    
    const expectedHash = fileInfo.blocks[blockIndex].hash;
    
    if (hashBase64 !== expectedHash) {
        state.connection.send({
            type: 'hash_mismatch',
            file: filePath,
            block: blockIndex
        });
        showError(`Hash mismatch for ${filePath} block ${blockIndex}`);
        return;
    }
    
    // Write block to file
    try {
        await writeBlockToFile(filePath, blockIndex, completeBlock, fileInfo);
        
        // Mark block as complete
        fileData.completedBlocks++;
        state.blocksCompleted++;
        updateBlockProgressUI();
        fileData.blocks.delete(blockIndex);
        
        // Request next block
        await requestNextBlock();
        
    } catch (error) {
        showError('Failed to write file: ' + error.message);
    }
}

async function writeBlockToFile(filePath, blockIndex, data, fileInfo) {
    if (IS_ELECTRON) {
        if (!state.targetFolderPath) {
            throw new Error('Target folder not selected');
        }
        const absoluteFilePath = resolveAbsolutePath(state.targetFolderPath, filePath);
        await window.electronAPI.writeFileAt(absoluteFilePath, blockIndex * BLOCK_SIZE, data);
    } else {
        const parts = filePath.split('\\');
        const fileName = parts.pop();
        const dirPath = parts.join('\\');
        
        let dirHandle = state.targetFolderHandle;
        if (dirPath) {
            for (const part of parts) {
                dirHandle = await dirHandle.getDirectoryHandle(part, { create: true });
            }
        }
        
        // Get or create file
        const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable({ keepExistingData: true });
        
        // Seek to position and write
        await writable.seek(blockIndex * BLOCK_SIZE);
        await writable.write(data);
        await writable.close();
    }
    
    // File date preservation is best-effort and should fail silently.
    // (Browser File System Access API doesn't support setting modified date.)
    if (blockIndex === fileInfo.blocks.length - 1) {
        try {
            // No-op
        } catch (_) {
            // Intentionally silent
        }
    }
}

function addWarning(message) {
    const container = document.getElementById('transfer-warnings');
    if (container) {
        container.classList.remove('hidden');
        const warning = document.createElement('div');
        warning.className = 'warning-item';
        warning.textContent = '⚠ ' + message;
        container.appendChild(warning);
    }

    // Also persist warnings so they can be displayed on the complete screen.
    if (Array.isArray(state.completionWarnings)) {
        state.completionWarnings.push(message);
    }
}

// ========== TRANSFER CONTROL ==========

function pauseTransfer() {
    state.isPaused = true;
    safeSend({ type: 'pause' });
    document.getElementById('pause-btn').classList.add('hidden');
    document.getElementById('resume-btn').classList.remove('hidden');
    document.getElementById('connection-indicator').textContent = 'Paused';
    document.getElementById('connection-indicator').className = 'status-badge status-paused';
}

function resumeTransfer() {
    state.isPaused = false;
    safeSend({ type: 'resume' });
    document.getElementById('pause-btn').classList.remove('hidden');
    document.getElementById('resume-btn').classList.add('hidden');
    document.getElementById('connection-indicator').textContent = 'Connected';
    document.getElementById('connection-indicator').className = 'status-badge';
    
    if (state.mode === 'receiver') {
        requestNextBlock().catch(e => showError(e && e.message ? e.message : String(e)));
    }
}

function cancelTransfer() {
    if (confirm('Are you sure you want to cancel the transfer?')) {
        safeSend({ type: 'cancel' });
        try {
            if (state.connection) state.connection.close();
        } catch (_) {}
        showError('Transfer cancelled');
    }
}

function updateTransferUI() {
    const manifest = state.mode === 'sender' ? state.manifest : state.receivedManifest;
    if (!manifest) return;
    
    const isReceiver = state.mode === 'receiver';
    const phase = isReceiver ? state.progressPhase : 'transfer';

    const totalBlocks = state.totalBlocks;
    const displayBlocks = isReceiver
        ? (phase === 'transfer' ? state.blocksCompleted : state.blocksProcessed)
        : state.blocksCompleted;

    const displayTotalSize =
        isReceiver && (phase === 'checking' || phase === 'validating')
            ? manifest.totalSize
            : (isReceiver && typeof state.bytesTotalPlanned === 'number' && Number.isFinite(state.bytesTotalPlanned)
                ? state.bytesTotalPlanned
                : manifest.totalSize);

    const displayBytes =
        isReceiver && (phase === 'checking' || phase === 'validating')
            ? state.bytesProcessed
            : state.bytesTransferred;

    // Update bytes
    document.getElementById('transfer-bytes').textContent = formatBytes(displayBytes);
    
    // Update percentage
    const percent = totalBlocks > 0
        ? (displayBlocks / totalBlocks) * 100
        : (displayTotalSize > 0 ? (displayBytes / displayTotalSize) * 100 : 0);
    document.getElementById('transfer-progress').style.width = percent + '%';
    document.getElementById('transfer-percent').textContent = Math.round(percent) + '%';
    
    // Update speed and ETA
    const elapsed = (Date.now() - state.startTime) / 1000;
    const speed = displayBytes / elapsed;
    document.getElementById('transfer-speed').textContent = formatBytes(speed) + '/s';
    
    const remaining = displayTotalSize - displayBytes;
    const eta = remaining / speed;
    document.getElementById('transfer-eta').textContent = formatTime(eta);
}

function validateManifestForReceiver(manifest) {
    if (!manifest || typeof manifest !== 'object') {
        throw new Error('Validation failed: missing or invalid manifest');
    }
    if (!Array.isArray(manifest.files)) {
        throw new Error('Validation failed: manifest.files is missing');
    }
    if (!Number.isFinite(manifest.totalSize) || manifest.totalSize < 0) {
        throw new Error('Validation failed: manifest.totalSize is invalid');
    }

    const isSafeRelPath = (p) => {
        if (typeof p !== 'string' || !p) return false;
        // Prevent path traversal / absolute paths / drive letters
        if (p.includes('..')) return false;
        if (p.startsWith('\\') || p.startsWith('/') || p.startsWith('\\\\')) return false;
        if (/^[A-Za-z]:/.test(p)) return false;
        return true;
    };

    let computedTotal = 0;
    for (const fileInfo of manifest.files) {
        if (!fileInfo || typeof fileInfo !== 'object') {
            throw new Error('Validation failed: manifest contains invalid file entry');
        }
        if (!isSafeRelPath(fileInfo.path)) {
            throw new Error(`Validation failed: invalid file path "${fileInfo.path}"`);
        }
        if (!Number.isFinite(fileInfo.size) || fileInfo.size < 0) {
            throw new Error(`Validation failed: invalid size for ${fileInfo.path}`);
        }
        if (!Array.isArray(fileInfo.blocks)) {
            throw new Error(`Validation failed: missing blocks for ${fileInfo.path}`);
        }

        const expectedBlockCount = Math.ceil(fileInfo.size / BLOCK_SIZE);
        if (fileInfo.blocks.length !== expectedBlockCount) {
            throw new Error(
                `Validation failed: block count mismatch for ${fileInfo.path} (expected ${expectedBlockCount}, got ${fileInfo.blocks.length})`
            );
        }

        for (let i = 0; i < fileInfo.blocks.length; i++) {
            const block = fileInfo.blocks[i];
            if (!block || typeof block !== 'object') {
                throw new Error(`Validation failed: invalid block entry for ${fileInfo.path} block ${i}`);
            }
            if (block.index !== i) {
                throw new Error(`Validation failed: block index mismatch for ${fileInfo.path} (expected ${i}, got ${block.index})`);
            }
            if (typeof block.hash !== 'string' || !block.hash) {
                throw new Error(`Validation failed: missing hash for ${fileInfo.path} block ${i}`);
            }
        }

        computedTotal += fileInfo.size;
    }

    if (computedTotal !== manifest.totalSize) {
        throw new Error(
            `Validation failed: manifest totalSize mismatch (expected sum ${computedTotal}, got ${manifest.totalSize})`
        );
    }
}

async function validateReceivedFiles() {
    const manifest = state.receivedManifest;
    if (!manifest) throw new Error('No manifest available for validation');

    validateManifestForReceiver(manifest);

    state.progressPhase = 'validating';
    state.bytesProcessed = 0;
    state.blocksProcessed = 0;
    updateTransferUI();

    const titleEl = document.getElementById('transfer-title');
    if (titleEl) titleEl.textContent = 'Validating Files';

    for (let fileIndex = 0; fileIndex < manifest.files.length; fileIndex++) {
        const fileInfo = manifest.files[fileIndex];
        const relPath = fileInfo.path;
        const currentFileEl = document.getElementById('current-file-name');
        if (currentFileEl) currentFileEl.textContent = relPath;

        // Resolve file once per file
        let actualSize;
        let electronAbsPath = null;
        let browserFile = null;

        if (IS_ELECTRON) {
            if (!state.targetFolderPath) throw new Error('Target folder not selected');
            electronAbsPath = resolveAbsolutePath(state.targetFolderPath, relPath);
            const st = await window.electronAPI.statFile(electronAbsPath);
            actualSize = st.size;
        } else {
            if (!state.targetFolderHandle) throw new Error('Target folder not selected');
            const fileHandle = await getReceiverFileHandle(state.targetFolderHandle, relPath);
            browserFile = await fileHandle.getFile();
            actualSize = browserFile.size;
        }

        if (actualSize !== fileInfo.size) {
            throw new Error(`Validation failed: size mismatch for ${relPath} (expected ${fileInfo.size}, got ${actualSize})`);
        }

        // Hash check (per block)
        for (let blockIndex = 0; blockIndex < fileInfo.blocks.length; blockIndex++) {
            const start = blockIndex * BLOCK_SIZE;
            const end = Math.min(start + BLOCK_SIZE, fileInfo.size);

            // Update UI progress per block during validation
            state.currentFile = relPath;
            state.currentBlock = blockIndex;
            const currentFileEl2 = document.getElementById('current-file-name');
            if (currentFileEl2) currentFileEl2.textContent = `${relPath} (validating block ${blockIndex + 1}/${fileInfo.blocks.length})`;
            state.bytesProcessed += Math.max(0, end - start);
            state.blocksProcessed++;
            updateTransferUI();

            let arrayBuffer;
            if (IS_ELECTRON) {
                arrayBuffer = await window.electronAPI.readFileSlice(electronAbsPath, start, end);
            } else {
                arrayBuffer = await browserFile.slice(start, end).arrayBuffer();
            }

            const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            const hashBase64 = btoa(String.fromCharCode.apply(null, hashArray));

            const expectedHash = fileInfo.blocks[blockIndex].hash;
            if (hashBase64 !== expectedHash) {
                throw new Error(`Validation failed: hash mismatch for ${relPath} block ${blockIndex}`);
            }
        }
    }

    // Warn (do not fail) if the target folder contains extra files not present in the manifest.
    // This indicates the local folder's “manifest” differs from what was received.
    try {
        const localIndex = new Map();
        if (IS_ELECTRON) {
            if (!state.targetFolderPath) throw new Error('Target folder not selected');
            await scanReceiverTargetPath(state.targetFolderPath, '', localIndex);
        } else {
            if (!state.targetFolderHandle) throw new Error('Target folder not selected');
            await scanReceiverTargetHandle(state.targetFolderHandle, '', localIndex);
        }

        const expectedPaths = new Set(manifest.files.map(f => f.path));
        const extras = [];
        for (const relPath of localIndex.keys()) {
            if (!expectedPaths.has(relPath)) {
                extras.push(relPath);
            }
        }

        if (extras.length > 0) {
            addWarning(`Local target differs from sender manifest: ${extras.length} extra file(s) detected`);
            extras.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
            const limit = 25;
            for (let i = 0; i < Math.min(limit, extras.length); i++) {
                addWarning(`Extra file: ${extras[i]}`);
            }
            if (extras.length > limit) {
                addWarning(`...and ${extras.length - limit} more extra file(s)`);
            }
        }
    } catch (e) {
        // Validation succeeded; scanning extras is best-effort.
        console.warn('Extra-file scan failed:', e);
    }
}

async function getReceiverFileHandle(rootHandle, relPath) {
    const parts = relPath.split('\\');
    const fileName = parts.pop();
    let dirHandle = rootHandle;
    for (const part of parts) {
        dirHandle = await dirHandle.getDirectoryHandle(part);
    }
    return await dirHandle.getFileHandle(fileName);
}

async function completeTransfer() {
    const manifest = state.mode === 'sender' ? state.manifest : state.receivedManifest;
    const elapsed = (Date.now() - state.startTime) / 1000;

    if (state.mode === 'receiver') {
        try {
            await validateReceivedFiles();
        } catch (e) {
            try {
                if (state.connection) state.connection.close();
            } catch (_) {}
            showError(e && e.message ? e.message : String(e));
            return;
        }
    }
    
    document.getElementById('complete-stats').textContent = 
        `Transferred ${formatBytes(manifest.totalSize)} in ${formatTime(elapsed)}`;
    
    showScreen('complete-screen');

    // Show any warnings gathered during transfer/validation on the complete screen.
    const completeWarnings = document.getElementById('complete-warnings');
    if (completeWarnings) {
        completeWarnings.innerHTML = '';
        const warnings = Array.isArray(state.completionWarnings) ? state.completionWarnings : [];
        if (warnings.length > 0) {
            completeWarnings.classList.remove('hidden');
            for (const msg of warnings) {
                const item = document.createElement('div');
                item.className = 'warning-item';
                item.textContent = '⚠ ' + msg;
                completeWarnings.appendChild(item);
            }
        } else {
            completeWarnings.classList.add('hidden');
        }
    }
    
    if (state.connection) {
        state.connection.close();
    }
}

function handleError() {
    cleanup();
    if (state.mode === 'sender') {
        showScreen('sender-folder-screen');
    } else {
        showScreen('receiver-code-screen');
    }
}
