// 1f2c - 1 Folder 2 Computers
// P2P File Synchronization Tool

// ========== CONSTANTS ==========
const BLOCK_SIZE = 16 * 1024 * 1024; // 16MB
const CHUNK_SIZE = 256 * 1024; // 256KB
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
    
    // Sender state
    folderHandle: null,
    folderPath: null,
    manifest: null,
    manifestCache: [],
    
    // Receiver state
    targetFolderHandle: null,
    targetFolderPath: null,
    receivedManifest: null,
    
    // Transfer state
    isPaused: false,
    transferring: false,
    currentFile: null,
    currentBlock: 0,
    bytesTransferred: 0,
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
    state.shareCode = null;
    state.isPaused = false;
    state.transferring = false;
    state.currentFile = null;
    state.currentBlock = 0;
    state.bytesTransferred = 0;
    state.fileMap.clear();
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
        state.folderHandle = null; // Will need to re-select if files are accessed
        state.folderPath = null;
    }
    startSenderConnection();
}

let indexingCancelled = false;
let scannerLogs = [];

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
            document.getElementById('indexing-current-file').textContent = fileInfo.path;
            
            const progress = ((i + 1) / files.length) * 100;
            document.getElementById('indexing-progress').style.width = progress + '%';
            document.getElementById('indexing-percent').textContent = Math.round(progress) + '%';
            
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
        if (!state.transferring) {
            showError('Connection closed by receiver');
        }
    });
    
    conn.on('error', (error) => {
        showError('Connection error: ' + error.message);
    });
}

function handleSenderMessage(message) {
    switch (message.type) {
        case 'hello':
            showApprovalScreen(message.username);
            break;
        case 'request_manifest':
            sendManifest();
            break;
        case 'request_block':
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
            accepted: true
        });
        
        // Wait for receiver to select folder and request manifest
        showScreen('transfer-screen');
        document.getElementById('transfer-title').textContent = 'Waiting for receiver...';
        document.getElementById('peer-name').textContent = 'Connected';
        state.transferring = true;
        state.startTime = Date.now();
    } else {
        state.connection.send({
            type: 'acknowledge',
            accepted: false,
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
            // Get file handle (need to navigate directory structure)
            const fileHandle = await getFileHandle(state.folderHandle, filePath);
            const file = await fileHandle.getFile();
            blockData = await file.slice(start, end).arrayBuffer();
        }
        
        // Split into chunks and send
        const chunkCount = Math.ceil(blockData.byteLength / CHUNK_SIZE);
        
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
            
            // Small delay to avoid overwhelming the connection
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        
        state.connection.send({
            type: 'block_complete',
            file: filePath,
            block: blockIndex
        });
        
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
        
        // Request manifest
        state.connection.send({
            type: 'request_manifest'
        });
        
        showScreen('transfer-screen');
        document.getElementById('transfer-title').textContent = 'Receiving Files';
        state.transferring = true;
        state.startTime = Date.now();
        
    } catch (error) {
        if (error.name !== 'AbortError') {
            showError('Failed to select folder: ' + error.message);
        }
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
    document.getElementById('transfer-total-bytes').textContent = formatBytes(manifest.totalSize);
    document.getElementById('file-progress').textContent = `0 / ${manifest.fileCount}`;
    
    // Start requesting blocks
    state.currentFileIndex = 0;
    requestNextBlock();
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

function requestNextBlock() {
    if (state.isPaused) return;
    
    const manifest = state.receivedManifest;
    
    // Find next block to request
    while (state.currentFileIndex < manifest.files.length) {
        const file = manifest.files[state.currentFileIndex];
        
        if (!state.fileMap.has(file.path)) {
            state.fileMap.set(file.path, {
                blocks: new Map(),
                completedBlocks: 0,
                totalBlocks: file.blocks.length
            });
        }
        
        const fileData = state.fileMap.get(file.path);
        
        if (fileData.completedBlocks < fileData.totalBlocks) {
            // Request next block for this file
            state.currentFile = file.path;
            state.currentBlock = fileData.completedBlocks;
            
            document.getElementById('current-file-name').textContent = file.path;
            
            state.connection.send({
                type: 'request_block',
                file: file.path,
                block: state.currentBlock
            });
            
            return;
        }
        
        state.currentFileIndex++;
    }
    
    // All files complete!
    completeTransfer();
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
        fileData.blocks.delete(blockIndex);
        
        // Update file progress
        const completedFiles = state.currentFileIndex;
        const totalFiles = state.receivedManifest.fileCount;
        document.getElementById('file-progress').textContent = `${completedFiles} / ${totalFiles}`;
        
        // Request next block
        requestNextBlock();
        
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
        const writable = await fileHandle.createWritable();
        
        // Seek to position and write
        await writable.seek(blockIndex * BLOCK_SIZE);
        await writable.write(data);
        await writable.close();
    }
    
    // If this is the last block, set modified date (best effort)
    if (blockIndex === fileInfo.blocks.length - 1) {
        try {
            // Note: File System Access API doesn't support setting modified date
            // This is a documented limitation
            addWarning(`File date not preserved: ${filePath}`);
        } catch (error) {
            console.warn('Failed to set file date:', error);
        }
    }
}

function addWarning(message) {
    const container = document.getElementById('transfer-warnings');
    container.classList.remove('hidden');
    const warning = document.createElement('div');
    warning.className = 'warning-item';
    warning.textContent = '⚠ ' + message;
    container.appendChild(warning);
}

// ========== TRANSFER CONTROL ==========

function pauseTransfer() {
    state.isPaused = true;
    state.connection.send({ type: 'pause' });
    document.getElementById('pause-btn').classList.add('hidden');
    document.getElementById('resume-btn').classList.remove('hidden');
    document.getElementById('connection-indicator').textContent = 'Paused';
    document.getElementById('connection-indicator').className = 'status-badge status-paused';
}

function resumeTransfer() {
    state.isPaused = false;
    state.connection.send({ type: 'resume' });
    document.getElementById('pause-btn').classList.remove('hidden');
    document.getElementById('resume-btn').classList.add('hidden');
    document.getElementById('connection-indicator').textContent = 'Connected';
    document.getElementById('connection-indicator').className = 'status-badge';
    
    if (state.mode === 'receiver') {
        requestNextBlock();
    }
}

function cancelTransfer() {
    if (confirm('Are you sure you want to cancel the transfer?')) {
        state.connection.send({ type: 'cancel' });
        state.connection.close();
        showError('Transfer cancelled');
    }
}

function updateTransferUI() {
    const manifest = state.mode === 'sender' ? state.manifest : state.receivedManifest;
    if (!manifest) return;
    
    // Update bytes
    document.getElementById('transfer-bytes').textContent = formatBytes(state.bytesTransferred);
    
    // Update percentage
    const percent = (state.bytesTransferred / manifest.totalSize) * 100;
    document.getElementById('transfer-progress').style.width = percent + '%';
    document.getElementById('transfer-percent').textContent = Math.round(percent) + '%';
    
    // Update speed and ETA
    const elapsed = (Date.now() - state.startTime) / 1000;
    const speed = state.bytesTransferred / elapsed;
    document.getElementById('transfer-speed').textContent = formatBytes(speed) + '/s';
    
    const remaining = manifest.totalSize - state.bytesTransferred;
    const eta = remaining / speed;
    document.getElementById('transfer-eta').textContent = formatTime(eta);
}

function completeTransfer() {
    const manifest = state.mode === 'sender' ? state.manifest : state.receivedManifest;
    const elapsed = (Date.now() - state.startTime) / 1000;
    
    document.getElementById('complete-stats').textContent = 
        `Transferred ${formatBytes(manifest.totalSize)} in ${formatTime(elapsed)}`;
    
    showScreen('complete-screen');
    
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
