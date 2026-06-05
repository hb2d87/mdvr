class ObsidianReader {
    constructor() {
        this.ALL_VAULTS_ID = '__all__';
        this.currentFile = null;
        this.currentMetadata = [[], [], []];
        this.currentResolvedLinks = new Map();
        this.isDirty = false;
        this.expandedFolders = new Set();
        this.viewMode = 'home'; // home, reader
        this.previewEnabled = true;
        this.currentFileKind = null;
        this.excalidrawBridge = null;
        this.excalidrawModulePromise = null;
        this.pdfjsModulePromise = null;
        this.excalidrawMountToken = 0;
        this.homeFileCount = 0;
        this.homeRecentCount = 0;
        this.homeRecentTotal = 0;
        this.homeRecentLimit = this.getStoredRecentLimit();
        this.homeRecentFiles = [];
        this.vaultOptions = [];
        this.vaultAliases = this.getStoredVaultAliases();
        this.selectedVaultIds = this.getStoredSelectedVaultIds();
        this.serverVaultConfig = null;
        this.serverVaultConfigDirty = false;
        this.advancedConfigLoaded = false;
        this.advancedConfigDirty = false;
        this.currentConfigVaultId = null;
        this.singleVaultConfigDirty = false;
        this.singleVaultAdvancedLoaded = false;
        this.singleVaultAdvancedDirty = false;
        this.vaultPermissions = new Map();
        this.fileMetadataByPath = new Map();
        this.contextMenuVault = null;
        this.contextMenuEnabled = true;
        this.activeVault = this.normalizeVaultId(localStorage.getItem('mdvr_vault') || localStorage.getItem('owr_vault') || this.ALL_VAULTS_ID);
        this.themeConfig = JSON.parse(localStorage.getItem('mdvr_config') || localStorage.getItem('owr_config') || '{}');
        this.appTitle = 'MDVR - md_vault_reader';
        this.permissions = {
            read: true,
            edit: false,
            new_files: false,
            rename: false,
            delete: false,
            files_format_read: ['.md', '.markdown', '.excalidraw', '.txt'],
            files_format_edit: [],
            files_format_new: []
        };
        this.init();
    }

    async init() {
        this.setupViewportHeight();
        this.applyConfig();
        this.bindEvents();
        this.setupResize();
        const deepLink = this.getDeepLink();
        if (deepLink.vault !== null) {
            this.activeVault = deepLink.vault;
        }
        await this.loadVaults();
        await this.loadServerConfig();
        await this.loadVaultName();
        await this.openRoute(deepLink, { replaceUrl: true });
        this.setupAutoSave();
        this.connectWebSocket();
    }

    getDeepLink() {
        const params = new URLSearchParams(window.location.search);
        let path = (params.get('path') || params.get('file') || params.get('note') || '').trim();
        const vaultParam = params.has('vault') ? (params.get('vault') || '').trim() : null;
        let vault = vaultParam === null ? null : (vaultParam === '/' ? '' : this.normalizeVaultId(vaultParam.replace(/^\/+|\/+$/g, '')));

        if (!path) {
            const hash = (window.location.hash || '').replace(/^#\/?/, '');
            if (hash) {
                const hashParams = new URLSearchParams(hash);
                path = (hashParams.get('path') || hashParams.get('file') || hashParams.get('note') || hash).trim();
            }
        }

        if (!path) {
            const pathname = window.location.pathname.replace(/^\/+/, '');
            if (pathname) {
                const prefix = 'obsidian/';
                if (pathname === 'obsidian' || pathname.startsWith(prefix)) {
                    if (vault === null) vault = 'obsidian';
                    path = pathname === 'obsidian' ? '' : pathname.slice(prefix.length);
                    try {
                        path = decodeURIComponent(path);
                    } catch (_) {}
                } else if (pathname === 'settings') {
                    return { path: '', vault, view: 'config' };
                } else if (pathname === 'settings/vault' || pathname.startsWith('settings/vault/')) {
                    const configVault = pathname.split('/').slice(2).join('/');
                    return { path: '', vault, view: 'vault-config', configVault: this.normalizeVaultId(decodeURIComponent(configVault || '')) };
                } else if (pathname === 'home') {
                    return { path: '', vault, view: 'home' };
                } else {
                    const segments = pathname.split('/').filter(Boolean);
                    if (segments.length > 0) {
                        if (vault === null) vault = this.normalizeVaultId(decodeURIComponent(segments[0]));
                        path = segments.slice(1).join('/');
                        try {
                            path = decodeURIComponent(path);
                        } catch (_) {}
                    }
                }
            }
        }

        return { path: path.replace(/^\/+/, ''), vault, view: path ? 'reader' : 'home' };
    }

    async openRoute(route = this.getDeepLink(), options = {}) {
        if (route.vault !== null && route.vault !== this.activeVault) {
            this.setActiveVault(route.vault);
            await this.loadServerConfig();
            if (route.path) await this.loadActiveVaultName();
            else await this.loadVaultName();
        }
        if (route.view === 'config') {
            await this.switchView('config');
            await this.loadAdminVaultConfig();
            this.populateConfigUI();
            if (options.replaceUrl) this.updateUrlForSettings({ replace: true });
            return;
        }
        if (route.view === 'vault-config') {
            await this.openVaultConfigPage(route.configVault || this.activeVault, { replaceUrl: options.replaceUrl === true });
            return;
        }
        if (route.path) {
            await this.loadActiveVaultName();
            await this.openDeepLink(route.path, { replaceUrl: options.replaceUrl === true });
            return;
        }
        await this.switchView('home');
        if (options.replaceUrl) this.updateUrlForFile(null, { replace: true });
    }

    async openDeepLink(path, options = {}) {
        await this.switchView('reader');
        await this.loadFile(path, { replaceUrl: options.replaceUrl === true });
    }

    async openFile(path, options = {}) {
        const vaultChanged = options.vault && options.vault !== this.activeVault;
        if (vaultChanged) {
            this.setActiveVault(options.vault);
            await this.loadServerConfig();
            await this.loadActiveVaultName();
        } else if (options.vault) {
            await this.loadActiveVaultName();
        }
        await this.switchView('reader');
        await this.loadFile(path, options);
    }

    isAllVaults() {
        return this.getSelectedVaultOptions().length > 1;
    }

    setActiveVault(vaultId) {
        vaultId = this.normalizeVaultId(vaultId);
        if (!vaultId || vaultId === this.activeVault) return;
        this.activeVault = vaultId;
        localStorage.setItem('mdvr_vault', this.activeVault);
        localStorage.setItem('owr_vault', this.activeVault);
    }

    normalizeVaultId(vaultId) {
        if (vaultId === 'real') return 'obsidian';
        return vaultId;
    }

    getStoredVaultAliases() {
        try {
            const parsed = JSON.parse(localStorage.getItem('mdvr_vault_aliases') || '{}');
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch (_) {}
        return {};
    }

    saveVaultAliases(aliases = this.vaultAliases) {
        this.vaultAliases = Object.fromEntries(
            Object.entries(aliases)
                .map(([id, name]) => [id, String(name || '').trim()])
                .filter(([, name]) => name)
        );
        localStorage.setItem('mdvr_vault_aliases', JSON.stringify(this.vaultAliases));
    }

    getStoredSelectedVaultIds() {
        try {
            const parsed = JSON.parse(localStorage.getItem('mdvr_selected_vaults') || '[]');
            if (Array.isArray(parsed)) return parsed.filter(id => typeof id === 'string' && id);
        } catch (_) {}
        return [];
    }

    saveSelectedVaultIds(ids = this.selectedVaultIds) {
        const uniqueIds = [...new Set(ids.map(id => this.normalizeVaultId(id)).filter(Boolean))];
        this.selectedVaultIds = uniqueIds;
        localStorage.setItem('mdvr_selected_vaults', JSON.stringify(uniqueIds));
    }

    getReadableVaultOptions() {
        return this.vaultOptions.filter(option => option.available && option.id !== this.ALL_VAULTS_ID);
    }

    getSelectedVaultOptions() {
        const selected = this.getReadableVaultOptions().filter(option => this.selectedVaultIds.includes(option.id));
        if (selected.length) return selected;
        return this.getReadableVaultOptions().slice(0, 1);
    }

    normalizeSelectedVaults() {
        const readable = this.getReadableVaultOptions();
        const readableIds = readable.map(option => option.id);
        let nextSelected = this.selectedVaultIds.filter(id => readableIds.includes(id));
        const savedActiveVault = localStorage.getItem('mdvr_vault') || localStorage.getItem('owr_vault') || '';
        if (!nextSelected.length && (this.activeVault === this.ALL_VAULTS_ID || savedActiveVault === this.ALL_VAULTS_ID)) {
            nextSelected = readableIds;
        }
        if (!nextSelected.length && this.activeVault && readableIds.includes(this.activeVault)) {
            nextSelected = [this.activeVault];
        }
        if (!nextSelected.length && readableIds.length) {
            nextSelected = [readableIds[0]];
        }
        this.saveSelectedVaultIds(nextSelected);
        if (!readableIds.includes(this.activeVault)) {
            this.activeVault = nextSelected[0] || '';
        }
        if (this.activeVault) {
            localStorage.setItem('mdvr_vault', this.activeVault);
            localStorage.setItem('owr_vault', this.activeVault);
        }
    }

    async fetchPermissionsForVault(vaultId) {
        if (!vaultId || this.vaultPermissions.has(vaultId)) return this.vaultPermissions.get(vaultId);
        try {
            const data = await this.fetchJsonForVault(vaultId, '/api/config');
            const permissions = data.permissions || this.allVaultPermissions();
            this.vaultPermissions.set(vaultId, permissions);
            return permissions;
        } catch (_) {
            const fallback = this.allVaultPermissions();
            this.vaultPermissions.set(vaultId, fallback);
            return fallback;
        }
    }

    async loadSelectedVaultPermissions() {
        await Promise.all(this.getSelectedVaultOptions().map(option => this.fetchPermissionsForVault(option.id)));
    }

    permissionsForVault(vaultId) {
        if (vaultId && this.vaultPermissions.has(vaultId)) return this.vaultPermissions.get(vaultId);
        if (!vaultId || vaultId === this.activeVault) return this.permissions;
        return this.allVaultPermissions();
    }

    permissionsForContextMenu() {
        return this.permissionsForVault(this.contextMenuVault || this.activeVault);
    }

    vaultLabel(vaultId) {
        vaultId = this.normalizeVaultId(vaultId);
        if (this.vaultAliases[vaultId]) return this.vaultAliases[vaultId];
        const option = this.vaultOptions.find(v => v.id === vaultId);
        return option?.name || vaultId || 'Vault';
    }

    async fetchJsonForVault(vaultId, url) {
        const response = await this.fetchApiForVault(url, vaultId);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
    }

    toVaultTreeNode(file, vaultOption) {
        const identityPath = `${vaultOption.id}/${file.path}`;
        return {
            ...file,
            path: identityPath,
            open_path: file.path,
            vault: vaultOption.id,
            vaultName: this.vaultLabel(vaultOption.id),
            children: (file.children || []).map(child => this.toVaultTreeNode(child, vaultOption)),
        };
    }

    toVaultTreeRoot(files, vaultOption) {
        return {
            name: this.vaultLabel(vaultOption.id),
            path: `__vault__/${vaultOption.id}`,
            open_path: '',
            is_dir: true,
            vault: vaultOption.id,
            vaultName: this.vaultLabel(vaultOption.id),
            tags: [],
            children: (files || []).map(file => this.toVaultTreeNode(file, vaultOption)),
        };
    }

    allVaultPermissions() {
        return {
            read: true,
            edit: false,
            new_files: false,
            rename: false,
            delete: false,
            files_format_read: ['*'],
            files_format_edit: [],
            files_format_new: []
        };
    }

    encodePathSegments(path) {
        return path
            .split('/')
            .filter(Boolean)
            .map(segment => encodeURIComponent(segment))
            .join('/');
    }

    getDeepLinkUrl(path, vaultId = this.activeVault) {
        // Canonical deep link: /demo/Research/note.md.
        const url = new URL(window.location.origin);
        const vaultSegment = vaultId && vaultId !== '/' && vaultId !== this.ALL_VAULTS_ID ? this.encodePathSegments(vaultId) : 'vault';
        url.pathname = `/${vaultSegment}/${this.encodePathSegments(path)}`;
        return url.toString();
    }

    isVisibleFile(path) {
        return this.matchesAllowedFormat(path, this.permissions.files_format_read || []);
    }

    getExtension(path) {
        const match = (path || '').toLowerCase().match(/(\.[^./\\]+)$/);
        return match ? match[1] : '';
    }

    matchesAllowedFormat(path, formats) {
        if (!formats || !formats.length) return false;
        if (formats.includes('*')) return true;
        return formats.includes(this.getExtension(path));
    }

    canEditPath(path) {
        return !!this.permissions.edit && this.matchesAllowedFormat(path, this.permissions.files_format_edit || []);
    }

    canCreatePath(path, permissions = this.permissions) {
        return !!permissions.new_files && this.matchesAllowedFormat(path, permissions.files_format_new || []);
    }

    canRenamePath(path) {
        return !!this.permissions.rename && this.matchesAllowedFormat(path, this.permissions.files_format_read || []);
    }

    getViewerKind(path) {
        const ext = this.getExtension(path);
        if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.ico'].includes(ext)) return 'image';
        if (ext === '.pdf') return 'pdf';
        if (ext === '.excalidraw') return 'excalidraw';
        if (this.matchesAllowedFormat(path, this.permissions.files_format_read || [])) return 'text';
        return 'binary';
    }

    isEmbeddableMediaPath(path) {
        return ['image', 'pdf'].includes(this.getViewerKind(path));
    }

    canAttachMedia() {
        return this.viewMode === 'reader'
            && !!this.currentFile
            && this.getViewerKind(this.currentFile) === 'text'
            && this.canEditPath(this.currentFile)
            && !!this.permissions.new_files;
    }

    openMediaPicker() {
        if (!this.canAttachMedia()) {
            this.updateStatus('Media upload not allowed');
            return;
        }
        document.getElementById('media-upload-input')?.click();
    }

    formatHeaderDateTime(epochSeconds) {
        if (!epochSeconds) return { date: '', time: '' };
        const date = new Date(epochSeconds * 1000);
        const pad = (value) => String(value).padStart(2, '0');
        return {
            date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
            time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
        };
    }

    formatCompactHeaderDateTime(epochSeconds) {
        if (!epochSeconds) return { date: '', time: '', title: '' };
        const full = this.formatHeaderDateTime(epochSeconds);
        return {
            date: full.date,
            time: full.time,
            title: `${full.date} ${full.time}`,
        };
    }

    getStoredRecentLimit() {
        const parsed = Number.parseInt(localStorage.getItem('mdvr_recent_limit') || '5', 10);
        if (!Number.isFinite(parsed)) return 5;
        return Math.min(12, Math.max(1, parsed));
    }

    getDisplayTitle(path) {
        const filename = (path || '').split('/').pop() || '';
        return filename.replace(/\.(md|markdown|excalidraw)$/i, '');
    }

    getDisplayPath(path) {
        return (path || '').replace(/^\/+/, '');
    }

    getDisplayFolderPath(path) {
        const cleanPath = this.getDisplayPath(path);
        const lastSlash = cleanPath.lastIndexOf('/');
        if (lastSlash === -1) return '/';
        return cleanPath.slice(0, lastSlash) || '/';
    }

    setHeaderFileInfo(path, epochSeconds) {
        const titleEl = document.getElementById('header-title');
        const pathEl = document.getElementById('header-path');
        const dateEl = document.getElementById('header-date');
        const timeEl = document.getElementById('header-time');
        if (titleEl) {
            titleEl.textContent = this.getDisplayTitle(path) || path || this.appTitle;
            titleEl.title = path ? `Open ${path}` : this.appTitle;
        }
        if (pathEl) pathEl.textContent = path ? this.getDisplayFolderPath(path) : '';
        const headerDt = this.formatCompactHeaderDateTime(epochSeconds);
        if (dateEl) dateEl.textContent = headerDt.date;
        if (timeEl) timeEl.textContent = headerDt.time;
        const dtEl = document.getElementById('header-datetime');
        if (dtEl) dtEl.title = headerDt.title;
    }

    setDownloadForPath(path, refresh = false) {
        const downloadBtn = document.getElementById('download-current-file');
        const headerNewBtn = document.getElementById('header-new-file-btn');
        if (!downloadBtn || !path) return;
        if (headerNewBtn) headerNewBtn.classList.add('hidden');
        const icon = downloadBtn.querySelector('.material-symbols-outlined');
        if (icon) icon.textContent = 'download';
        downloadBtn.title = 'Download file';
        downloadBtn.setAttribute('aria-label', 'Download file');
        downloadBtn.disabled = false;
        downloadBtn.classList.remove('hidden');
        downloadBtn.onclick = () => this.downloadPath(path, refresh);
    }

    clearDownloadButton() {
        const downloadBtn = document.getElementById('download-current-file');
        if (!downloadBtn) return;
        const icon = downloadBtn.querySelector('.material-symbols-outlined');
        if (icon) icon.textContent = 'download';
        downloadBtn.title = 'Download file';
        downloadBtn.setAttribute('aria-label', 'Download file');
        downloadBtn.disabled = false;
        downloadBtn.classList.add('hidden');
        downloadBtn.onclick = null;
    }

    getHomeCreateTarget() {
        if (this.viewMode !== 'home') return null;
        const writable = this.getSelectedVaultOptions()
            .map(vault => ({ vault, permissions: this.permissionsForVault(vault.id) }))
            .filter(entry => !!entry.permissions.new_files);
        return writable.length === 1 ? writable[0] : null;
    }

    setHomeUploadButton() {
        const uploadBtn = document.getElementById('download-current-file');
        if (!uploadBtn || this.viewMode !== 'home') return;
        const target = this.getHomeCreateTarget();
        const canUpload = !!target
            && ['.md', '.markdown', '.txt'].some(ext => (target.permissions.files_format_new || []).includes(ext));
        if (!canUpload) {
            this.clearDownloadButton();
            return;
        }
        const icon = uploadBtn.querySelector('.material-symbols-outlined');
        if (icon) icon.textContent = 'upload';
        uploadBtn.title = 'Upload Markdown or text file';
        uploadBtn.setAttribute('aria-label', 'Upload Markdown or text file');
        uploadBtn.disabled = false;
        uploadBtn.classList.remove('hidden');
        uploadBtn.onclick = () => document.getElementById('home-upload-input')?.click();
    }

    downloadPath(path, refresh = false, vaultId = this.activeVault) {
        const src = this.apiFileUrl(path, { refresh, vault: vaultId });
        const a = document.createElement('a');
        a.href = src;
        a.download = path.split('/').pop() || 'download';
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    sanitizeHomeUploadFilename(name) {
        const raw = String(name || '').replace(/\\/g, '/').split('/').pop().trim();
        const clean = raw
            .replace(/[<>:"|?*\x00-\x1F]+/g, '-')
            .replace(/\s+/g, ' ')
            .replace(/^\.+/, '')
            .trim();
        return clean || `uploaded-${Date.now()}.md`;
    }

    isHomeUploadPath(path, permissions = this.permissions) {
        const ext = this.getExtension(path);
        return ['.md', '.markdown', '.txt'].includes(ext)
            && !!permissions.new_files
            && this.matchesAllowedFormat(path, permissions.files_format_new || []);
    }

    async handleHomeUploadFiles(fileList) {
        const files = [...(fileList || [])];
        await this.loadSelectedVaultPermissions();
        const target = this.getHomeCreateTarget();
        if (!target) {
            this.updateStatus('Select one writable vault');
            return;
        }
        const { vault, permissions } = target;

        let uploadedCount = 0;
        let lastUploadedPath = '';
        for (const file of files) {
            const path = this.sanitizeHomeUploadFilename(file.name);
            if (!this.isHomeUploadPath(path, permissions)) {
                this.updateStatus('Only .md, .markdown, .txt uploads are allowed');
                continue;
            }
            try {
                const response = await this.fetchApiForVault('/api/files', vault.id, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path, content: await file.text() }),
                });
                if (response.status === 409) {
                    this.updateStatus(`${path} already exists`);
                    continue;
                }
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                uploadedCount += 1;
                lastUploadedPath = path;
            } catch (error) {
                console.error('Failed to upload text file:', error);
                this.updateStatus(`Failed to upload ${path}`);
            }
        }

        if (!uploadedCount) return;
        await Promise.all([
            this.loadRecentFiles(),
            this.loadFileTree('file-tree'),
        ]);
        if (uploadedCount === 1) {
            await this.openFile(lastUploadedPath, { vault: vault.id });
        } else {
            this.updateStatus(`Uploaded ${uploadedCount} files`);
        }
    }

    async handleMediaFiles(fileList) {
        const files = [...(fileList || [])].filter(file => file.type.startsWith('image/') || file.type === 'application/pdf');
        if (!files.length) return;
        if (!this.canAttachMedia()) {
            this.updateStatus('Media upload not allowed');
            return;
        }
        for (const file of files) {
            try {
                const uploaded = await this.uploadMediaFile(file);
                const label = uploaded.name || file.name || uploaded.path.split('/').pop();
                const markdown = uploaded.kind === 'pdf'
                    ? `[${label}](${uploaded.path})`
                    : `![${label}](${uploaded.path})`;
                this.insertBlockAtCursor(markdown);
                this.updateStatus(`Attached ${label}`);
            } catch (error) {
                console.error('Failed to attach media:', error);
                this.updateStatus('Failed to attach media');
            }
        }
        await this.loadFileTree('reader-file-tree');
        await this.loadFileTree('file-tree');
    }

    async uploadMediaFile(file) {
        const bytes = await file.arrayBuffer();
        let binary = '';
        const chunkSize = 0x8000;
        const array = new Uint8Array(bytes);
        for (let i = 0; i < array.length; i += chunkSize) {
            binary += String.fromCharCode(...array.subarray(i, i + chunkSize));
        }
        const response = await this.fetchApi('/api/assets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filename: file.name,
                content_type: file.type,
                content_base64: btoa(binary),
                current_path: this.currentFile || '',
            }),
        });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.detail || `HTTP ${response.status}`);
        }
        return response.json();
    }

    insertAtCursor(text) {
        const editor = document.getElementById('editor');
        if (!editor) return;
        const start = editor.selectionStart ?? editor.value.length;
        const end = editor.selectionEnd ?? start;
        editor.value = `${editor.value.slice(0, start)}${text}${editor.value.slice(end)}`;
        const next = start + text.length;
        editor.selectionStart = next;
        editor.selectionEnd = next;
        editor.focus();
        this.setDirty(true);
        this.updateHighlighting();
        if (this.previewEnabled) this.updatePreview();
        this.saveFile();
    }

    insertBlockAtCursor(markdown) {
        const editor = document.getElementById('editor');
        if (!editor) return;
        const start = editor.selectionStart ?? editor.value.length;
        const needsLeadingBreak = start > 0 && editor.value[start - 1] !== '\n';
        const text = `${needsLeadingBreak ? '\n' : ''}${markdown}\n`;
        this.insertAtCursor(text);
    }

    setHomeHeader() {
        const titleEl = document.getElementById('header-title');
        const pathEl = document.getElementById('header-path');
        this.clearDownloadButton();
        if (titleEl) {
            titleEl.textContent = 'MDVR';
            titleEl.title = this.vaultName ? `MDVR - ${this.vaultName}` : 'MDVR';
        }
        if (pathEl) pathEl.textContent = 'Markdown vault reader';
    }

    formatTagQuery(tag) {
        const cleanTag = String(tag || '').trim().replace(/^#+/, '');
        return cleanTag ? `#${cleanTag}` : '';
    }

    applyHomeSearch(query) {
        const search = document.getElementById('home-search');
        if (search) search.value = query;
        this.renderRecentFiles();
        this.filterFiles(query, 'file-tree');
    }

    syncHeaderDatetimeVisibility() {
        const dtEl = document.getElementById('header-datetime');
        if (!dtEl) return;
        const shouldShow = this.viewMode === 'reader';
        dtEl.classList.toggle('hidden', !shouldShow);
        dtEl.style.display = shouldShow ? 'flex' : 'none';
    }

    showTextViewer() {
        const binaryViewer = document.getElementById('binary-viewer');
        const excalidrawPane = document.getElementById('excalidraw-pane');
        const editorContainer = document.getElementById('editor-container');
        const previewPane = document.getElementById('preview-pane');
        const previewToggle = document.getElementById('preview-toggle');
        if (binaryViewer) binaryViewer.classList.add('hidden');
        if (excalidrawPane) excalidrawPane.classList.add('hidden');
        if (this.excalidrawBridge && typeof this.excalidrawBridge.destroy === 'function') {
            this.excalidrawBridge.destroy();
        }
        this.excalidrawBridge = null;
        if (previewToggle) previewToggle.classList.remove('hidden');
        if (editorContainer) editorContainer.classList.remove('hidden');
        if (previewPane) previewPane.classList.toggle('hidden', !this.previewEnabled);
        this.hideMobileSidebar();
    }

    hideMobileSidebar() {
        const sidebar = document.getElementById('reader-sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        if (!sidebar || !overlay) return;
        if (window.innerWidth < 768) {
            sidebar.classList.add('-translate-x-full');
            overlay.classList.add('hidden');
        }
    }

    renderBinaryFile(path, kind, refresh = false) {
        const binaryViewer = document.getElementById('binary-viewer');
        const excalidrawPane = document.getElementById('excalidraw-pane');
        const editorContainer = document.getElementById('editor-container');
        const previewPane = document.getElementById('preview-pane');
        const downloadBtn = document.getElementById('download-current-file');
        const previewToggle = document.getElementById('preview-toggle');
        if (!binaryViewer || !editorContainer || !previewPane) return;

        const src = this.apiFileUrl(path, { refresh });
        const title = document.getElementById('header-title');
        const headerPath = document.getElementById('header-path');

        this.currentFile = path;
        this.currentFileKind = kind;
        this.setDirty(false);

        if (excalidrawPane) excalidrawPane.classList.add('hidden');
        if (this.excalidrawBridge && typeof this.excalidrawBridge.destroy === 'function') {
            this.excalidrawBridge.destroy();
        }
        this.excalidrawBridge = null;

        editorContainer.classList.add('hidden');
        previewPane.classList.add('hidden');
        binaryViewer.classList.remove('hidden');
        if (previewToggle) previewToggle.classList.add('hidden');

        if (kind === 'image') {
            binaryViewer.innerHTML = `<img src="${src}" alt="${this.escapeHtml(path)}" class="binary-image" />`;
        } else {
            binaryViewer.innerHTML = `
                <div class="binary-pdf-viewer">
                    ${this.renderPdfPreview(src, path, { direct: true })}
                </div>
            `;
            this.renderPdfPreviews(binaryViewer);
        }

        if (downloadBtn) {
            downloadBtn.classList.remove('hidden');
            downloadBtn.onclick = () => {
                const a = document.createElement('a');
                a.href = src;
                a.download = path.split('/').pop() || 'download';
                document.body.appendChild(a);
                a.click();
                a.remove();
            };
        }

        this.setHeaderFileInfo(path, this.fileMetadataByPath.get(path)?.mtime || null);
        if (title) title.title = `Open ${path}`;
        if (headerPath) headerPath.textContent = this.getDisplayFolderPath(path);
        document.title = `${path} - ${this.appTitle}`;
        this.updateUrlForFile(path, { replace: true });
        this.selectFileInTrees(path);
        this.revealFileInTree(path, 'reader-file-tree');
        this.updateStatus(`Opened ${kind}`);
        this.updateReaderMetadataPanel();
        this.hideMobileSidebar();
    }

    async loadExcalidrawBridge() {
        if (!this.excalidrawModulePromise) {
            this.excalidrawModulePromise = import(`/excalidraw-bridge.js?v=20260530-excalidraw-fix`);
        }
        return this.excalidrawModulePromise;
    }

    async loadPdfJs() {
        if (!this.pdfjsModulePromise) {
            this.pdfjsModulePromise = import('/vendor/pdfjs/pdf.js').then(pdfjs => {
                pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.js';
                return pdfjs;
            });
        }
        return this.pdfjsModulePromise;
    }

    async renderExcalidrawFile(path, refresh = false) {
        const excalidrawPane = document.getElementById('excalidraw-pane');
        const editorContainer = document.getElementById('editor-container');
        const previewPane = document.getElementById('preview-pane');
        const binaryViewer = document.getElementById('binary-viewer');
        const downloadBtn = document.getElementById('download-current-file');
        const previewToggle = document.getElementById('preview-toggle');
        if (!excalidrawPane || !editorContainer || !previewPane) return;

        const response = await this.fetchApi(`/api/file?path=${encodeURIComponent(path)}${refresh ? `&v=${Date.now()}` : ''}`);
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.detail || `HTTP ${response.status}`);
        }
        const data = await response.json();
        if (data.permissions) this.permissions = data.permissions;

        this.currentFile = path;
        this.currentFileKind = 'excalidraw';
        this.setDirty(false);

        if (binaryViewer) binaryViewer.classList.add('hidden');
        editorContainer.classList.add('hidden');
        previewPane.classList.add('hidden');
        excalidrawPane.classList.remove('hidden');
        excalidrawPane.innerHTML = '';
        if (previewToggle) previewToggle.classList.add('hidden');

        if (downloadBtn) {
            downloadBtn.classList.remove('hidden');
            downloadBtn.onclick = () => {
                const a = document.createElement('a');
                a.href = this.apiFileUrl(path);
                a.download = path.split('/').pop() || 'download';
                document.body.appendChild(a);
                a.click();
                a.remove();
            };
        }

        this.setHeaderFileInfo(path, data.mtime);
        document.title = `${path} - ${this.appTitle}`;
        this.updateUrlForFile(path, { replace: true });
        this.selectFileInTrees(path);
        this.revealFileInTree(path, 'reader-file-tree');
        this.updateReaderMetadataPanel();


        try {
            const bridgeModule = await this.loadExcalidrawBridge();
            const mountToken = ++this.excalidrawMountToken;
            if (this.excalidrawBridge && typeof this.excalidrawBridge.destroy === 'function') {
                this.excalidrawBridge.destroy();
            }
            this._suppressExcalidrawDirty = true;
            this.excalidrawBridge = bridgeModule.mountExcalidraw(excalidrawPane, {
                content: data.content || '',
                name: path,
                onChange: () => {
                    if (mountToken !== this.excalidrawMountToken) return;
                    if (this._suppressExcalidrawDirty) return;
                    this.setDirty(true);
                },
            });
            setTimeout(() => {
                if (mountToken === this.excalidrawMountToken) this._suppressExcalidrawDirty = false;
            }, 300);
        } catch (error) {
            console.error('Failed to mount Excalidraw:', error);
            excalidrawPane.innerHTML = `<div class="p-4 md:p-8 font-mono text-sm" style="color: var(--c-body);">Failed to load Excalidraw view. Showing raw JSON instead.</div><pre class="p-4 md:p-8 whitespace-pre-wrap break-words overflow-auto font-mono text-sm">${this.escapeHtml(data.content || '')}</pre>`;
            this.updateStatus('Excalidraw unavailable');
        }

        this.updatePermissionControls();
        this.updateStatus('Opened excalidraw');
        this.hideMobileSidebar();
    }

    defaultCreateExtension(permissions = this.permissions) {
        const formats = permissions.files_format_new || [];
        return formats.find(ext => ext && ext !== '*') || '.md';
    }

    syncPreviewMode() {
        const editorContainer = document.getElementById('editor-container');
        const preview = document.getElementById('preview-pane');
        const icon = document.getElementById('preview-icon');
        if (!editorContainer || !preview || !icon) return;

        if (this.previewEnabled) {
            editorContainer.classList.add('hidden');
            preview.classList.remove('hidden');
            icon.textContent = 'edit_note';
        } else {
            editorContainer.classList.remove('hidden');
            preview.classList.add('hidden');
            icon.textContent = 'visibility';
        }
        this.updateReaderMetadataPanel();
    }

    updateUrlForFile(path, options = {}) {
        const url = path ? this.getDeepLinkUrl(path) : '/home';
        const method = options.replace ? 'replaceState' : 'pushState';
        window.history[method]({}, '', url);
    }

    updateUrlForSettings(options = {}) {
        const method = options.replace ? 'replaceState' : 'pushState';
        window.history[method]({}, '', '/settings');
    }

    updateUrlForVaultSettings(vaultId, options = {}) {
        const method = options.replace ? 'replaceState' : 'pushState';
        window.history[method]({}, '', `/settings/vault/${this.encodePathSegments(vaultId || '')}`);
    }

    setupViewportHeight() {
        const setVh = () => {
            const height = Math.round(window.visualViewport?.height || window.innerHeight);
            document.documentElement.style.setProperty('--app-vh', `${height}px`);
            this.syncHeaderDatetimeVisibility();
            this.syncRecentDatetimeVisibility();
        };
        setVh();
        window.addEventListener('resize', setVh);
        window.visualViewport?.addEventListener('resize', setVh);
        window.addEventListener('orientationchange', () => setTimeout(setVh, 150));
    }

    connectWebSocket() {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${location.host}/ws`);
        ws.onmessage = (e) => {
            try {
                const evt = JSON.parse(e.data);
                // Reload trees on any fs event
                if (this.viewMode === 'home') {
                    this.loadRecentFiles();
                    this.loadFileTree('file-tree');
                } else if (this.viewMode === 'reader') {
                    this.loadFileTree('reader-file-tree');
                    // If the currently open file was modified externally, reload it
                    if (this.currentFile && evt.path === this.currentFile && evt.type === 'modified' && !this.isDirty) {
                        if (this.currentFileKind === 'excalidraw') {
                            // Keep the mounted Excalidraw scene stable; only refresh the tree.
                        } else if (this.currentFileKind === 'image' || this.currentFileKind === 'pdf') {
                            this.renderBinaryFile(this.currentFile, this.currentFileKind, true);
                        } else {
                            this.loadFile(this.currentFile, { preservePreview: true });
                        }
                    }
                    // If current file was deleted, go home
                    if (this.currentFile && evt.path === this.currentFile && evt.type === 'deleted') {
                        this.switchView('home');
                    }
                }
            } catch (_) {}
        };
        ws.onclose = () => setTimeout(() => this.connectWebSocket(), 3000);
        ws.onerror = () => ws.close();
    }

    // Helper to send vault header
    async fetchApi(url, options = {}) {
        return this.fetchApiForVault(url, this.activeVault, options);
    }

    async fetchApiForVault(url, vaultId, options = {}) {
        options.headers = Object.assign({}, options.headers || {}, {
            'X-Vault-Path': vaultId === this.ALL_VAULTS_ID ? '' : vaultId
        });
        return fetch(url, options);
    }

    bindEvents() {
        // Return to home via home button
        document.getElementById('sidebar-home-btn').addEventListener('click', async () => {
            document.getElementById('reader-sidebar').classList.add('-translate-x-full');
            document.getElementById('sidebar-overlay').classList.add('hidden');
            await this.switchView('home');
            this.updateUrlForFile(null);
        });
        
        // Header title click -> Rename if in reader
        document.getElementById('header-title').addEventListener('click', () => {
            if (this.viewMode === 'reader' && this.currentFile) {
                this.showRenameModal();
            } else {
                this.switchView('home');
                this.updateUrlForFile(null);
            }
        });
        
        // Reader sidebar toggles
        document.getElementById('header-menu-btn').addEventListener('click', () => {
            const sidebar = document.getElementById('reader-sidebar');
            const overlay = document.getElementById('sidebar-overlay');
            if (window.innerWidth >= 768) {
                sidebar.classList.toggle('md:hidden');
            } else {
                sidebar.classList.toggle('-translate-x-full');
                overlay.classList.toggle('hidden');
            }
        });
        document.getElementById('header-new-file-btn').addEventListener('click', () => this.showNewFileModal());
        document.getElementById('home-upload-input')?.addEventListener('change', (event) => {
            this.handleHomeUploadFiles([...(event.target.files || [])]);
            event.target.value = '';
        });
        document.getElementById('media-upload-input')?.addEventListener('change', (event) => {
            this.handleMediaFiles(event.target.files);
            event.target.value = '';
        });

        // Config buttons
        const showConfig = async () => {
            document.getElementById('reader-sidebar').classList.add('-translate-x-full');
            document.getElementById('sidebar-overlay').classList.add('hidden');
            await this.switchView('config');
            await this.loadAdminVaultConfig();
            this.populateConfigUI();
            this.updateUrlForSettings();
        };
        document.getElementById('header-config-btn').addEventListener('click', showConfig);

        document.getElementById('config-cancel-btn').addEventListener('click', () => {
            this.switchView('home');
            this.updateUrlForFile(null);
        });
        document.getElementById('vault-config-back-btn')?.addEventListener('click', async () => {
            await this.switchView('config');
            await this.loadAdminVaultConfig();
            this.populateConfigUI();
            this.updateUrlForSettings();
        });
        document.getElementById('single-vault-cancel-btn')?.addEventListener('click', async () => {
            await this.switchView('config');
            await this.loadAdminVaultConfig();
            this.populateConfigUI();
            this.updateUrlForSettings();
        });
        document.getElementById('single-vault-save-btn')?.addEventListener('click', async () => {
            try {
                this.setSingleVaultConfigStatus('Saving vault config...', 'info');
                await this.saveSingleVaultConfig();
                await this.loadVaults();
                await this.loadServerConfig();
                await this.switchView('config');
                await this.loadAdminVaultConfig();
                this.populateConfigUI();
                this.updateUrlForSettings();
            } catch (error) {
                const message = this.humanizeFetchError(error);
                this.setSingleVaultConfigStatus(`Save failed: ${message}`, 'error');
                this.setSingleVaultAdvancedStatus(`Save failed: ${message}`, 'error');
            }
        });
        document.getElementById('config-save-btn').addEventListener('click', async () => {
            try {
                await this.saveConfig();
                await this.switchView('home');
                this.updateUrlForFile(null);
                // Reload all content to reflect new vault
                await this.loadVaults();
                await this.loadVaultName();
                await Promise.all([
                    this.loadRecentFiles(),
                    this.loadFileTree('file-tree')
                ]);
            } catch (error) {
                const message = this.humanizeFetchError(error);
                this.setServerConfigStatus(`Save failed: ${message}`, 'error');
                this.setAdvancedConfigStatus(`Save failed: ${message}`, 'error');
            }
        });

        // Theme presets
        document.getElementById('config-theme').addEventListener('change', (e) => this.applyThemePreset(e.target.value));
        document.getElementById('config-add-vault-btn')?.addEventListener('click', () => this.addServerVaultConfigRow());
        document.getElementById('server-vault-config-list')?.addEventListener('input', () => this.markServerVaultConfigDirty());
        document.getElementById('server-vault-config-list')?.addEventListener('change', () => this.markServerVaultConfigDirty());
        document.getElementById('advanced-config-toggle')?.addEventListener('click', () => this.toggleAdvancedConfig());
        document.getElementById('single-vault-advanced-toggle')?.addEventListener('click', () => this.toggleSingleVaultAdvancedConfig());
        document.getElementById('single-vault-advanced-text')?.addEventListener('input', () => {
            this.singleVaultAdvancedDirty = true;
            this.setSingleVaultAdvancedStatus('Advanced vault YAML changed. Save Vault to apply.', 'warn');
        });
        document.getElementById('advanced-config-text')?.addEventListener('input', () => {
            this.advancedConfigDirty = true;
            this.setAdvancedConfigStatus('Advanced YAML changed. Save Settings to apply.', 'warn');
        });
        document.querySelectorAll('.color-token input[type="color"]').forEach(input => {
            input.addEventListener('input', () => this.syncPalettePreview());
        });
        document.getElementById('sidebar-overlay').addEventListener('click', () => {
            document.getElementById('reader-sidebar').classList.add('-translate-x-full');
            document.getElementById('sidebar-overlay').classList.add('hidden');
        });

        const readingArea = document.getElementById('reading-area');

        // Click on reading area to hide sidebar
        readingArea.addEventListener('click', () => {
            const sidebar = document.getElementById('reader-sidebar');
            if (!sidebar.classList.contains('-translate-x-full')) {
                sidebar.classList.add('-translate-x-full');
                document.getElementById('sidebar-overlay').classList.add('hidden');
            }
        });

        // Search in Home
        document.getElementById('home-search').addEventListener('input', (e) => {
            this.applyHomeSearch(e.target.value);
        });
        
        // Search in Sidebar
        document.getElementById('sidebar-search').addEventListener('input', (e) => {
            this.filterFiles(e.target.value, 'reader-file-tree');
        });

        document.getElementById('toggle-file-tree').addEventListener('click', () => {
            this.toggleAllFolders('file-tree');
        });
        document.getElementById('sidebar-folder-toggle').addEventListener('click', () => {
            this.toggleAllFolders('reader-file-tree');
        });

        document.getElementById('recent-limit-dec').addEventListener('click', () => this.setRecentLimit(this.homeRecentLimit - 1));
        document.getElementById('recent-limit-inc').addEventListener('click', () => this.setRecentLimit(this.homeRecentLimit + 1));

        // New file
        document.getElementById('nav-new-file').addEventListener('click', () => this.showNewFileModal());
        const sidebarNewFile = document.getElementById('sidebar-new-file');
        if (sidebarNewFile) sidebarNewFile.addEventListener('click', () => this.showNewFileModal());
        document.getElementById('new-file-cancel').addEventListener('click', () => this.hideNewFileModal());
        document.getElementById('new-file-create').addEventListener('click', () => this.createNewFile());
        document.getElementById('new-file-path').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.createNewFile();
        });
        
        // Rename file
        document.getElementById('rename-file-cancel').addEventListener('click', () => this.hideRenameModal());
        document.getElementById('rename-file-execute').addEventListener('click', () => this.executeRename());
        document.getElementById('rename-file-path').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.executeRename();
        });

        // Context Menu
        document.addEventListener('click', () => {
            document.getElementById('context-menu').classList.add('hidden');
            document.getElementById('reader-context-menu').classList.add('hidden');
        });
        this.bindReaderContextMenu(readingArea);
        document.getElementById('cm-open').addEventListener('click', () => {
            if (this.contextMenuPath) {
                this.openFile(this.contextMenuPath, this.contextMenuVault ? { vault: this.contextMenuVault } : {});
            }
        });
        document.getElementById('cm-download').addEventListener('click', () => {
            if (this.contextMenuPath && !this.contextMenuIsDir) {
                this.downloadPath(this.contextMenuPath, false, this.contextMenuVault || this.activeVault);
            }
        });
        document.getElementById('cm-rename').addEventListener('click', async () => {
            const perms = this.permissionsForContextMenu();
            const canRename = this.contextMenuPath && !!perms.rename && this.matchesAllowedFormat(this.contextMenuPath, perms.files_format_read || []);
            if (canRename) {
                if (this.contextMenuVault && this.contextMenuVault !== this.activeVault) {
                    this.setActiveVault(this.contextMenuVault);
                    await this.loadServerConfig();
                    await this.loadVaultName();
                }
                this.currentFile = this.contextMenuPath;
                this.showRenameModal();
            }
        });
        document.getElementById('cm-new-here').addEventListener('click', async () => {
            const perms = this.permissionsForContextMenu();
            if (this.contextMenuPath && perms.new_files) {
                if (this.contextMenuVault && this.contextMenuVault !== this.activeVault) {
                    this.setActiveVault(this.contextMenuVault);
                    await this.loadServerConfig();
                    await this.loadVaultName();
                }
                let folder = this.contextMenuPath;
                // If it's a file, use its parent folder
                if (folder.includes('.')) folder = folder.substring(0, folder.lastIndexOf('/')) || '';
                this.showNewFileModal(folder ? folder + '/' : '');
            }
        });
        document.getElementById('cm-delete').addEventListener('click', async () => {
            const perms = this.permissionsForContextMenu();
            if (this.contextMenuPath && perms.delete && confirm(`Delete ${this.contextMenuPath}?`)) {
                await this.deleteFile(this.contextMenuPath, this.contextMenuVault || this.activeVault);
            }
        });
        document.getElementById('reader-cm-toggle-view').addEventListener('click', () => {
            if (this.viewMode === 'reader' && this.getViewerKind(this.currentFile) === 'text') this.togglePreview();
        });
        document.getElementById('reader-cm-copy')?.addEventListener('click', () => this.copyEditorSelection());
        document.getElementById('reader-cm-cut')?.addEventListener('click', () => this.cutEditorSelection());
        document.getElementById('reader-cm-paste')?.addEventListener('click', () => this.pasteIntoEditor());
        document.getElementById('reader-cm-font-inc').addEventListener('click', () => this.adjustReaderFontSize(1));
        document.getElementById('reader-cm-font-dec').addEventListener('click', () => this.adjustReaderFontSize(-1));
        document.getElementById('reader-cm-attach-media').addEventListener('click', () => this.openMediaPicker());
        
        // Editor
        const editor = document.getElementById('editor');
        const backdrop = document.getElementById('editor-backdrop');
        
        editor.addEventListener('input', () => {
            this.setDirty(true);
            this.updateHighlighting();
            if (this.previewEnabled) this.updatePreview();
        });
        editor.addEventListener('paste', (event) => {
            const files = [...(event.clipboardData?.files || [])]
                .filter(file => file.type.startsWith('image/') || file.type === 'application/pdf');
            if (!files.length) return;
            event.preventDefault();
            this.handleMediaFiles(files);
        });
        
        editor.addEventListener('scroll', () => {
            backdrop.scrollTop = editor.scrollTop;
            backdrop.scrollLeft = editor.scrollLeft;
        });

        editor.addEventListener('blur', () => this.saveFile());

        // Preview toggle
        document.getElementById('preview-toggle').addEventListener('click', () => this.togglePreview());

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                this.saveFile();
            }
        });

        window.addEventListener('popstate', async () => {
            await this.openRoute(this.getDeepLink(), { replaceUrl: true });
        });
    }

    bindReaderContextMenu(readingArea) {
        if (!readingArea) return;

        const mediaFilesFromEvent = (event) => Array.from(event.dataTransfer?.files || [])
            .filter(file => file.type.startsWith('image/') || file.type === 'application/pdf');

        const showAt = (x, y) => {
            if (this.viewMode !== 'reader' || !this.currentFile || this.getViewerKind(this.currentFile) !== 'text') return;
            this.showReaderContextMenu(x, y);
        };

        readingArea.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            event.stopPropagation();
            showAt(event.pageX, event.pageY);
        });

        let longPressTimer = null;
        readingArea.addEventListener('touchstart', (event) => {
            clearTimeout(longPressTimer);
            longPressTimer = setTimeout(() => {
                const touch = event.touches[0];
                if (!touch) return;
                event.preventDefault();
                showAt(touch.pageX, touch.pageY);
            }, 550);
        }, { passive: false });
        readingArea.addEventListener('touchend', () => clearTimeout(longPressTimer));
        readingArea.addEventListener('touchmove', () => clearTimeout(longPressTimer));
        readingArea.addEventListener('touchcancel', () => clearTimeout(longPressTimer));

        readingArea.addEventListener('dragover', (event) => {
            const hasMedia = Array.from(event.dataTransfer?.items || [])
                .some(item => item.kind === 'file' && (item.type.startsWith('image/') || item.type === 'application/pdf'));
            if (!hasMedia) return;
            event.preventDefault();
            if (this.canAttachMedia()) readingArea.classList.add('media-drop-active');
        });
        readingArea.addEventListener('dragleave', (event) => {
            if (event.currentTarget.contains(event.relatedTarget)) return;
            readingArea.classList.remove('media-drop-active');
        });
        readingArea.addEventListener('drop', (event) => {
            const files = mediaFilesFromEvent(event);
            if (!files.length) return;
            event.preventDefault();
            readingArea.classList.remove('media-drop-active');
            this.handleMediaFiles(files);
        });
    }

    showReaderContextMenu(x, y) {
        const menu = document.getElementById('reader-context-menu');
        if (!menu) return;

        document.getElementById('context-menu')?.classList.add('hidden');

        const toggleBtn = document.getElementById('reader-cm-toggle-view');
        const toggleIcon = toggleBtn?.querySelector('.material-symbols-outlined');
        if (toggleBtn) {
            const label = toggleBtn.querySelector('[data-reader-toggle-label]');
            if (label) label.textContent = this.previewEnabled ? 'Switch To Edit' : 'Switch To View';
            if (toggleIcon) toggleIcon.textContent = this.previewEnabled ? 'edit_note' : 'visibility';
        }

        const attachBtn = document.getElementById('reader-cm-attach-media');
        const canAttach = this.canAttachMedia();
        if (attachBtn) {
            attachBtn.classList.toggle('hidden', !canAttach);
            attachBtn.disabled = !canAttach;
        }

        const editorActions = this.getEditorActionState();
        const readerActions = this.getReaderCopyState();
        const canCopy = editorActions.hasSelection || readerActions.hasSelection;
        const editDivider = document.getElementById('reader-cm-edit-divider');
        const copyBtn = document.getElementById('reader-cm-copy');
        const cutBtn = document.getElementById('reader-cm-cut');
        const pasteBtn = document.getElementById('reader-cm-paste');
        if (editDivider) editDivider.classList.toggle('hidden', !editorActions.canEdit && !canCopy);
        if (copyBtn) {
            copyBtn.classList.toggle('hidden', !canCopy);
            copyBtn.disabled = !canCopy;
        }
        if (cutBtn) {
            cutBtn.classList.toggle('hidden', !editorActions.canEdit || !editorActions.hasSelection);
            cutBtn.disabled = !editorActions.hasSelection;
        }
        if (pasteBtn) {
            pasteBtn.classList.toggle('hidden', !editorActions.canEdit);
            pasteBtn.disabled = !editorActions.canEdit;
        }

        menu.classList.remove('hidden');
        const width = menu.offsetWidth || 190;
        const height = menu.offsetHeight || 160;
        const left = Math.min(x, window.scrollX + window.innerWidth - width - 8);
        const top = Math.min(y, window.scrollY + window.innerHeight - height - 8);
        menu.style.left = `${Math.max(8, left)}px`;
        menu.style.top = `${Math.max(8, top)}px`;
    }

    getEditorActionState() {
        const editor = document.getElementById('editor');
        const canEdit = !!editor
            && this.viewMode === 'reader'
            && this.getViewerKind(this.currentFile) === 'text'
            && !this.previewEnabled
            && !editor.readOnly;
        const start = editor?.selectionStart ?? 0;
        const end = editor?.selectionEnd ?? 0;
        return { editor, canEdit, hasSelection: canEdit && end > start, start, end };
    }

    getReaderCopyState() {
        const previewPane = document.getElementById('preview-pane');
        const selection = window.getSelection?.();
        const text = String(selection?.toString() || '');
        const anchor = selection?.anchorNode;
        const focus = selection?.focusNode;
        const containsSelection = !!previewPane
            && !!text.trim()
            && (
                (anchor && previewPane.contains(anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentNode))
                || (focus && previewPane.contains(focus.nodeType === Node.ELEMENT_NODE ? focus : focus.parentNode))
            );
        return {
            canCopy: this.viewMode === 'reader' && this.previewEnabled && containsSelection,
            hasSelection: this.viewMode === 'reader' && this.previewEnabled && containsSelection,
            text,
        };
    }

    async writeClipboardText(text) {
        if (!text) return false;
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (_) {}
        const helper = document.createElement('textarea');
        helper.value = text;
        helper.setAttribute('readonly', '');
        helper.style.position = 'fixed';
        helper.style.opacity = '0';
        document.body.appendChild(helper);
        helper.select();
        let copied = false;
        try {
            copied = document.execCommand('copy');
        } catch (_) {
            copied = false;
        }
        helper.remove();
        return copied;
    }

    async readClipboardText() {
        try {
            if (navigator.clipboard?.readText) return await navigator.clipboard.readText();
        } catch (_) {}
        return '';
    }

    async copyEditorSelection() {
        const state = this.getEditorActionState();
        const reader = this.getReaderCopyState();
        const text = state.hasSelection
            ? state.editor.value.slice(state.start, state.end)
            : reader.hasSelection ? reader.text : '';
        if (!text) return;
        await this.writeClipboardText(text);
        if (state.editor && !this.previewEnabled) state.editor.focus();
    }

    async cutEditorSelection() {
        const state = this.getEditorActionState();
        if (!state.hasSelection) return;
        const text = state.editor.value.slice(state.start, state.end);
        await this.writeClipboardText(text);
        state.editor.setRangeText('', state.start, state.end, 'start');
        this.setDirty(true);
        this.updateHighlighting();
        if (this.previewEnabled) this.updatePreview();
        state.editor.focus();
    }

    async pasteIntoEditor() {
        const state = this.getEditorActionState();
        if (!state.canEdit) return;
        const text = await this.readClipboardText();
        if (!text) {
            this.updateStatus('Clipboard unavailable');
            state.editor.focus();
            return;
        }
        state.editor.setRangeText(text, state.start, state.end, 'end');
        this.setDirty(true);
        this.updateHighlighting();
        if (this.previewEnabled) this.updatePreview();
        state.editor.focus();
    }

    adjustReaderFontSize(direction) {
        const sizes = ['10px', '12px', '14px', '16px', '18px'];
        const current = this.themeConfig.size || getComputedStyle(document.documentElement).getPropertyValue('--text-size').trim() || '14px';
        let index = sizes.indexOf(current);
        if (index === -1) {
            const numeric = parseFloat(current) || 14;
            index = sizes.reduce((best, size, i) => (
                Math.abs(parseFloat(size) - numeric) < Math.abs(parseFloat(sizes[best]) - numeric) ? i : best
            ), 2);
        }
        const nextIndex = Math.max(0, Math.min(sizes.length - 1, index + direction));
        const nextSize = sizes[nextIndex];
        this.themeConfig = { ...this.themeConfig, size: nextSize };
        localStorage.setItem('mdvr_config', JSON.stringify(this.themeConfig));
        localStorage.setItem('owr_config', JSON.stringify(this.themeConfig));
        const sizeSelect = document.getElementById('config-size');
        if (sizeSelect) sizeSelect.value = nextSize;
        this.applyConfig();
        this.updateStatus(`Font ${nextSize}`);
    }

    setupResize() {
        const sidebar = document.getElementById('reader-sidebar');
        const resizer = document.getElementById('sidebar-resizer');
        let isResizing = false;
        let startX = 0;
        let startWidth = 0;

        const startResize = (e) => {
            if (window.innerWidth < 768) return;
            isResizing = true;
            startX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX;
            startWidth = sidebar.offsetWidth;
            document.body.style.cursor = 'ew-resize';
            document.body.style.userSelect = 'none';
        };

        const doResize = (e) => {
            if (!isResizing) return;
            const clientX = e.type === 'touchmove' ? e.touches[0].clientX : e.clientX;
            const delta = clientX - startX;
            let newWidth = startWidth + delta;
            
            const containerWidth = sidebar.parentElement.offsetWidth;
            const minWidth = containerWidth * 0.15;
            const maxWidth = containerWidth * 0.50;
            newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
            
            sidebar.style.width = `${newWidth}px`;
        };

        const stopResize = () => {
            if (!isResizing) return;
            isResizing = false;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };

        resizer.addEventListener('mousedown', startResize);
        document.addEventListener('mousemove', doResize);
        document.addEventListener('mouseup', stopResize);
        resizer.addEventListener('touchstart', startResize, { passive: false });
        document.addEventListener('touchmove', doResize, { passive: false });
        document.addEventListener('touchend', stopResize);
    }

    async switchView(view) {
        this.viewMode = view;
        
        document.querySelectorAll('.view-panel').forEach(v => v.classList.add('hidden'));
        document.getElementById(`view-${view}`).classList.remove('hidden');

        const menuBtn = document.getElementById('header-menu-btn');
        const previewBtn = document.getElementById('preview-toggle');
        const configBtn = document.getElementById('header-config-btn');
        const headerNewBtn = document.getElementById('header-new-file-btn');
        
        if (view === 'reader') {
            menuBtn.classList.remove('hidden');
            previewBtn.classList.remove('hidden');
            configBtn.classList.add('hidden');
            if (headerNewBtn) headerNewBtn.classList.add('hidden');
            this.clearDownloadButton();
            this.syncHeaderDatetimeVisibility();
            await this.loadFileTree('reader-file-tree');
            this.hideMobileSidebar();
        } else {
            menuBtn.classList.add('hidden');
            previewBtn.classList.add('hidden');
            if (headerNewBtn) headerNewBtn.classList.add('hidden');
            this.syncHeaderDatetimeVisibility();
            this.clearDownloadButton();
            this.setHomeHeader();
            document.title = this.appTitle;
            if (view === 'home') {
                configBtn.classList.remove('hidden');
                await this.loadVaultName();
                this.updatePermissionControls();
                await Promise.all([
                    this.loadRecentFiles(),
                    this.loadFileTree('file-tree')
                ]);
                this.setHomeUploadButton();
            } else if (view === 'config' || view === 'vault-config') {
                configBtn.classList.add('hidden');
            }
        }
    }

    async loadVaults() {
        try {
            const res = await this.fetchApi('/api/vaults');
            const data = await res.json();
            const select = document.getElementById('config-vault');
            select.innerHTML = '';
            const configuredOptions = (data.vaults || []).map(v => {
                if (typeof v === 'string') {
                    const id = this.normalizeVaultId(v);
                    return {
                        id,
                        name: this.vaultAliases[id] || (id === '/' ? 'Root (Vault)' : id),
                        originalName: id === '/' ? 'Root (Vault)' : id,
                        description: '',
                        path: '',
                        source: 'local',
                        mode: '',
                        available: true,
                    };
                }
                const id = this.normalizeVaultId(v.id);
                return {
                    id,
                    name: this.vaultAliases[id] || v.name || id,
                    originalName: v.name || id,
                    description: v.description || '',
                    path: v.path || '',
                    source: v.source || 'configured',
                    mode: v.mode || '',
                    available: v.available !== false,
                    status: v.status || (v.available === false ? 'missing' : 'ready'),
                    error: v.error || '',
                };
            });
            this.vaultOptions = configuredOptions;
            this.normalizeSelectedVaults();
            const fallback = this.vaultOptions.find(v => v.available) || this.vaultOptions[0];
            const activeOption = this.vaultOptions.find(v => v.id === this.activeVault);
            if (fallback && (!activeOption || activeOption.available === false)) {
                const previous = this.activeVault;
                this.activeVault = fallback.id;
                localStorage.setItem('mdvr_vault', this.activeVault);
                localStorage.setItem('owr_vault', this.activeVault);
                this.showVaultFallback(previous, fallback);
            }
            this.normalizeSelectedVaults();
            this.vaultOptions.forEach(v => {
                const opt = document.createElement('option');
                opt.value = v.id;
                opt.textContent = this.vaultLabel(v.id);
                if (v.description) opt.title = v.description;
                opt.disabled = !v.available;
                select.appendChild(opt);
            });
            this.renderVaultOptions();
        } catch(e) {
            console.error('Failed to load vaults:', e);
        }
    }

    showVaultFallback(previous, fallback) {
        const note = document.getElementById('config-vault-fallback');
        if (!note || !previous) return;
        note.textContent = `Saved vault "${previous}" is unavailable. Falling back to "${fallback.name}".`;
        note.classList.remove('hidden');
    }

    renderVaultOptions() {
        const container = document.getElementById('config-vault-options');
        const select = document.getElementById('config-vault');
        if (!container || !select) return;
        container.innerHTML = '';
        select.value = this.activeVault;
        this.vaultOptions.forEach(option => {
            const label = document.createElement('label');
            label.className = 'vault-option';
            label.dataset.available = String(option.available);
            label.title = option.error || option.description || option.path || option.name;

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.name = 'mdvr-vault';
            checkbox.value = option.id;
            checkbox.checked = option.available && this.selectedVaultIds.includes(option.id);
            checkbox.disabled = !option.available;
            checkbox.addEventListener('change', () => {
                if (checkbox.disabled) return;
                const checked = [...container.querySelectorAll('input[name="mdvr-vault"]:checked')].map(input => input.value);
                if (!checked.length) {
                    checkbox.checked = true;
                    return;
                }
                this.selectedVaultIds = checked;
                if (!this.selectedVaultIds.includes(this.activeVault)) {
                    this.activeVault = this.selectedVaultIds[0];
                    select.value = this.activeVault;
                }
                const note = document.getElementById('config-vault-fallback');
                if (note) note.classList.add('hidden');
            });

            const body = document.createElement('div');
            body.className = 'vault-option-body';
            const title = document.createElement('strong');
            title.textContent = this.vaultLabel(option.id);
            const statusLine = document.createElement('p');
            const modeLabel = option.available ? (option.mode || 'ready') : (option.status || 'missing');
            const details = option.available
                ? option.description
                : (option.error || option.description || 'Configured path is not available');
            statusLine.textContent = `${modeLabel}${details ? ` · ${details}` : ''}`;
            if (!option.available) statusLine.dataset.tone = 'error';
            body.append(title, statusLine);

            const meta = document.createElement('div');
            meta.className = 'vault-option-actions';
            const configButton = document.createElement('button');
            configButton.type = 'button';
            configButton.className = 'vault-config-button';
            configButton.title = `Configure ${this.vaultLabel(option.id)}`;
            configButton.innerHTML = '<span class="material-symbols-outlined text-[18px]">tune</span>';
            configButton.addEventListener('click', async (event) => {
                event.preventDefault();
                event.stopPropagation();
                await this.openVaultConfigPage(option.id);
            });
            meta.append(configButton);

            label.append(checkbox, body, meta);
            container.appendChild(label);
        });
    }

    setServerConfigStatus(message, tone = 'info') {
        const status = document.getElementById('server-config-status');
        if (!status) return;
        status.textContent = message || '';
        status.dataset.tone = tone;
    }

    setAdvancedConfigStatus(message, tone = 'info') {
        const status = document.getElementById('advanced-config-status');
        if (!status) return;
        status.textContent = message || '';
        status.dataset.tone = tone;
    }

    setSingleVaultConfigStatus(message, tone = 'info') {
        const status = document.getElementById('single-vault-config-status');
        if (!status) return;
        status.textContent = message || '';
        status.dataset.tone = tone;
    }

    setSingleVaultAdvancedStatus(message, tone = 'info') {
        const status = document.getElementById('single-vault-advanced-status');
        if (!status) return;
        status.textContent = message || '';
        status.dataset.tone = tone;
    }

    async loadAdminVaultConfig() {
        const list = document.getElementById('server-vault-config-list');
        if (list) list.innerHTML = '';
        this.setServerConfigStatus('Loading mdvr.yaml...', 'info');
        try {
            const response = await this.fetchApi('/api/admin/vault-config');
            if (!response.ok) throw new Error(await response.text());
            this.serverVaultConfig = await response.json();
            this.serverVaultConfigDirty = false;
            this.renderServerVaultConfig();
        } catch (error) {
            this.serverVaultConfig = null;
            this.setServerConfigStatus(`Unable to load vault config: ${this.humanizeFetchError(error)}`, 'error');
        }
    }

    humanizeFetchError(error) {
        const raw = String(error?.message || error || '');
        try {
            const parsed = JSON.parse(raw);
            return parsed.detail || raw;
        } catch (_) {
            return raw.replace(/^Error:\s*/, '') || 'unknown error';
        }
    }

    renderServerVaultConfig() {
        const list = document.getElementById('server-vault-config-list');
        if (!list) return;
        list.innerHTML = '';
        const config = this.serverVaultConfig;
        if (!config) return;
        const vaults = config.vaults || [];
        const path = config.config_file || 'mdvr.yaml';
        const writable = config.writable ? 'writable' : 'read-only';
        const auth = config.auth_enabled ? 'auth on' : 'auth off';
        const tone = config.writable && config.auth_enabled ? 'ok' : 'warn';
        this.setServerConfigStatus(`${path} · ${writable} · ${auth}`, tone);
        vaults.forEach(vault => list.appendChild(this.createServerVaultConfigCard(vault)));
        this.updateServerVaultRemoveButtons();
    }

    getServerVaultConfig(vaultId) {
        const id = this.normalizeVaultId(vaultId);
        return (this.serverVaultConfig?.vaults || []).find(vault => this.normalizeVaultId(vault.id) === id);
    }

    async openVaultConfigPage(vaultId, options = {}) {
        await this.loadAdminVaultConfig();
        const fallback = this.getReadableVaultOptions()[0]?.id || '';
        this.currentConfigVaultId = this.normalizeVaultId(vaultId || fallback);
        await this.switchView('vault-config');
        this.renderSingleVaultConfigPage();
        this.updateUrlForVaultSettings(this.currentConfigVaultId, { replace: options.replaceUrl === true });
    }

    renderSingleVaultConfigPage() {
        const vault = this.getServerVaultConfig(this.currentConfigVaultId);
        const container = document.getElementById('single-vault-config-card');
        const title = document.getElementById('vault-config-title');
        const subtitle = document.getElementById('vault-config-subtitle');
        if (container) container.innerHTML = '';
        this.singleVaultConfigDirty = false;
        this.singleVaultAdvancedLoaded = false;
        this.singleVaultAdvancedDirty = false;
        const advancedText = document.getElementById('single-vault-advanced-text');
        const advancedToggle = document.getElementById('single-vault-advanced-toggle');
        if (advancedText) {
            advancedText.value = '';
            advancedText.classList.add('hidden');
        }
        if (advancedToggle) advancedToggle.textContent = 'Open YAML';

        if (!vault) {
            if (title) title.textContent = 'Vault Missing';
            if (subtitle) subtitle.textContent = '';
            this.setSingleVaultConfigStatus('Vault not found in mdvr.yaml.', 'error');
            return;
        }

        if (title) title.textContent = vault.name || vault.id;
        if (subtitle) subtitle.textContent = '';
        this.setSingleVaultConfigStatus(`${this.serverVaultConfig?.config_file || 'mdvr.yaml'} · ${this.serverVaultConfig?.writable ? 'writable' : 'read-only'}`, this.serverVaultConfig?.writable ? 'ok' : 'warn');
        this.setSingleVaultAdvancedStatus('', 'info');
        if (container) {
            container.appendChild(this.createServerVaultConfigCard(vault, { removable: false, single: true }));
            container.appendChild(this.createSingleVaultActions(vault));
        }
    }

    createSingleVaultActions(vault) {
        const actions = document.createElement('div');
        actions.className = 'single-vault-actions';
        const hints = document.createElement('p');
        hints.className = 'config-note';
        hints.dataset.tone = vault.available ? 'ok' : 'error';
        hints.textContent = vault.available ? 'Vault path is available.' : (vault.error || 'Vault path is not available.');
        actions.appendChild(hints);

        const buttons = document.createElement('div');
        buttons.className = 'single-vault-action-buttons';

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'config-mini-button config-danger-button';
        removeButton.textContent = 'Reset Settings';
        removeButton.title = 'Remove this vault settings entry from mdvr.yaml. The mounted volume remains visible.';
        removeButton.addEventListener('click', async () => this.removeCurrentVaultConfig(vault.id));
        buttons.appendChild(removeButton);

        actions.appendChild(buttons);
        return actions;
    }

    createServerVaultConfigCard(vault = {}, options = {}) {
        const card = document.createElement('div');
        card.className = 'vault-config-card';
        card._basePermissions = { ...(vault.permissions || {}) };

        const effective = vault.resolved_permissions || {};
        const status = vault.available ? 'ready' : 'missing';
        const mode = vault.mode || 'read-only';
        const deleteEnabled = Object.prototype.hasOwnProperty.call(card._basePermissions, 'delete')
            ? !!card._basePermissions.delete
            : !!effective.delete;
        const headHtml = options.single ? '' : `
            <div class="vault-config-card-head">
                <div>
                    <strong data-vault-title>${this.escapeHtml(vault.name || vault.id || 'Vault')}</strong>
                    <p>${this.escapeHtml(vault.path || '')}</p>
                </div>
                <div class="vault-config-statuses">
                    <span class="vault-status ${vault.available ? 'is-ok' : 'is-missing'}">${status}</span>
                    <span class="vault-source">${this.escapeHtml(mode)}</span>
                </div>
            </div>
        `;

        card.innerHTML = `
            ${headHtml}
            <div class="vault-config-grid">
                <label><span>ID</span><input data-vault-field="id" value="${this.escapeAttr(vault.id || '')}" placeholder="main"></label>
                <label><span>Name</span><input data-vault-field="name" value="${this.escapeAttr(vault.name || '')}" placeholder="Main vault"></label>
                <label class="vault-config-wide"><span>Path in container</span><input data-vault-field="path" value="${this.escapeAttr(vault.path || '')}" placeholder="/vaults/main"></label>
                <label class="vault-config-wide"><span>Description</span><input data-vault-field="description" value="${this.escapeAttr(vault.description || '')}" placeholder="Optional note"></label>
                <label><span>Mode</span><select data-vault-field="mode">
                    ${this.configModeOptions(mode)}
                </select></label>
                <label class="vault-config-check"><input data-vault-field="delete" type="checkbox" ${deleteEnabled ? 'checked' : ''}><span>Allow soft delete</span></label>
            </div>
            <div class="vault-config-actions">
                <button type="button" data-vault-action="remove" class="config-mini-button">Remove</button>
            </div>
        `;

        const removeButton = card.querySelector('[data-vault-action="remove"]');
        if (options.removable === false) {
            removeButton?.remove();
        } else {
            removeButton?.addEventListener('click', () => {
                card.remove();
                this.markServerVaultConfigDirty();
                this.updateServerVaultRemoveButtons();
            });
        }
        card.querySelectorAll('input, select').forEach(input => {
            input.addEventListener('input', () => options.single ? this.syncSingleVaultCard(card) : this.syncServerVaultCard(card));
            input.addEventListener('change', () => options.single ? this.syncSingleVaultCard(card) : this.syncServerVaultCard(card));
        });
        return card;
    }

    configModeOptions(activeMode) {
        const modes = this.serverVaultConfig?.modes || ['read-only', 'read-write', 'admin'];
        return modes.map(mode => `<option value="${this.escapeAttr(mode)}" ${mode === activeMode ? 'selected' : ''}>${this.escapeHtml(mode)}</option>`).join('');
    }

    escapeAttr(value) {
        return this.escapeHtml(value).replace(/`/g, '&#96;');
    }

    syncServerVaultCard(card) {
        const title = card.querySelector('[data-vault-title]');
        const name = card.querySelector('[data-vault-field="name"]')?.value?.trim();
        const id = card.querySelector('[data-vault-field="id"]')?.value?.trim();
        if (title) title.textContent = name || id || 'Vault';
        this.markServerVaultConfigDirty();
    }

    syncSingleVaultCard(card) {
        const title = card.querySelector('[data-vault-title]');
        const pageTitle = document.getElementById('vault-config-title');
        const subtitle = document.getElementById('vault-config-subtitle');
        const name = card.querySelector('[data-vault-field="name"]')?.value?.trim();
        const id = card.querySelector('[data-vault-field="id"]')?.value?.trim();
        const mode = card.querySelector('[data-vault-field="mode"]')?.value || 'read-only';
        const label = name || id || 'Vault';
        if (title) title.textContent = label;
        if (pageTitle) pageTitle.textContent = label;
        if (subtitle) subtitle.textContent = '';
        this.singleVaultConfigDirty = true;
        this.setSingleVaultConfigStatus('Vault config changed. Save Vault to write mdvr.yaml.', 'warn');
    }

    markServerVaultConfigDirty() {
        this.serverVaultConfigDirty = true;
        this.setServerConfigStatus('Vault config changed. Save Settings to write mdvr.yaml.', 'warn');
    }

    updateServerVaultRemoveButtons() {
        const cards = [...document.querySelectorAll('.vault-config-card')];
        cards.forEach(card => {
            const button = card.querySelector('[data-vault-action="remove"]');
            if (button) button.disabled = cards.length <= 1;
        });
    }

    addServerVaultConfigRow() {
        const list = document.getElementById('server-vault-config-list');
        if (!list) return;
        const index = list.querySelectorAll('.vault-config-card').length + 1;
        const card = this.createServerVaultConfigCard({
            id: `vault-${index}`,
            name: `Vault ${index}`,
            description: '',
            path: `/vaults/vault-${index}`,
            mode: 'read-only',
            permissions: { delete: false },
            resolved_permissions: { delete: false },
            available: false,
        });
        list.appendChild(card);
        this.markServerVaultConfigDirty();
        this.updateServerVaultRemoveButtons();
    }

    readServerVaultConfigFromForm() {
        return [...document.querySelectorAll('.vault-config-card')].map(card => {
            return this.readServerVaultConfigCard(card);
        });
    }

    readServerVaultConfigCard(card) {
        const permissions = { ...(card._basePermissions || {}) };
        permissions.delete = !!card.querySelector('[data-vault-field="delete"]')?.checked;
        return {
            id: card.querySelector('[data-vault-field="id"]')?.value?.trim() || '',
            name: card.querySelector('[data-vault-field="name"]')?.value?.trim() || '',
            description: card.querySelector('[data-vault-field="description"]')?.value?.trim() || '',
            path: card.querySelector('[data-vault-field="path"]')?.value?.trim() || '',
            mode: card.querySelector('[data-vault-field="mode"]')?.value || 'read-only',
            permissions,
        };
    }

    async removeCurrentVaultConfig(vaultId) {
        const id = this.normalizeVaultId(vaultId || this.currentConfigVaultId);
        const vault = this.getServerVaultConfig(id);
        if (!id || !vault) return;
        const confirmed = window.confirm(`Reset "${vault.name || id}" settings in mdvr.yaml? The Docker-mounted vault remains visible.`);
        if (!confirmed) return;
        this.setSingleVaultConfigStatus('Removing vault entry...', 'info');
        const response = await this.fetchApi(`/api/admin/vault-config/${encodeURIComponent(id)}`, {
            method: 'DELETE',
        });
        if (!response.ok) {
            const message = this.humanizeFetchError(await response.text());
            this.setSingleVaultConfigStatus(`Remove failed: ${message}`, 'error');
            return;
        }
        this.serverVaultConfig = await response.json();
        this.vaultPermissions.clear();
        await this.loadVaults();
        await this.switchView('config');
        await this.loadAdminVaultConfig();
        this.populateConfigUI();
        this.updateUrlForSettings();
    }

    async saveAdminVaultConfigIfDirty() {
        if (this.advancedConfigDirty) {
            await this.saveAdvancedConfigText();
            return;
        }
        if (!this.serverVaultConfigDirty) return;
        const response = await this.fetchApi('/api/admin/vault-config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vaults: this.readServerVaultConfigFromForm() }),
        });
        if (!response.ok) throw new Error(await response.text());
        this.serverVaultConfig = await response.json();
        this.serverVaultConfigDirty = false;
        this.vaultPermissions.clear();
        this.setServerConfigStatus('Vault config saved.', 'ok');
        this.renderServerVaultConfig();
    }

    async toggleAdvancedConfig() {
        const textarea = document.getElementById('advanced-config-text');
        const button = document.getElementById('advanced-config-toggle');
        if (!textarea || !button) return;
        const opening = textarea.classList.contains('hidden');
        textarea.classList.toggle('hidden', !opening);
        button.textContent = opening ? 'Close YAML' : 'Open YAML';
        if (opening && !this.advancedConfigLoaded) {
            this.setAdvancedConfigStatus('Loading raw mdvr.yaml...', 'info');
            try {
                const response = await this.fetchApi('/api/admin/config-text');
                if (!response.ok) throw new Error(await response.text());
                const data = await response.json();
                textarea.value = data.content || '';
                this.advancedConfigLoaded = true;
                this.advancedConfigDirty = false;
                this.setAdvancedConfigStatus(`${data.config_file || 'mdvr.yaml'} · ${data.writable ? 'writable' : 'read-only'}`, data.writable ? 'ok' : 'warn');
            } catch (error) {
                this.setAdvancedConfigStatus(`Unable to load YAML: ${this.humanizeFetchError(error)}`, 'error');
            }
        }
    }

    async saveAdvancedConfigText() {
        const textarea = document.getElementById('advanced-config-text');
        if (!textarea) return;
        const response = await this.fetchApi('/api/admin/config-text', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: textarea.value }),
        });
        if (!response.ok) throw new Error(await response.text());
        this.serverVaultConfig = await response.json();
        this.serverVaultConfigDirty = false;
        this.advancedConfigDirty = false;
        this.vaultPermissions.clear();
        this.renderServerVaultConfig();
        this.setAdvancedConfigStatus('Advanced YAML saved.', 'ok');
    }

    async saveSingleVaultConfig() {
        if (this.singleVaultAdvancedDirty) {
            await this.saveSingleVaultAdvancedConfigText();
            return;
        }
        const card = document.querySelector('#single-vault-config-card .vault-config-card');
        if (!card) throw new Error('No vault config card found');
        const nextVault = this.readServerVaultConfigCard(card);
        const currentVaults = this.serverVaultConfig?.vaults || [];
        const replaced = currentVaults.map(vault => this.normalizeVaultId(vault.id) === this.currentConfigVaultId ? nextVault : {
            id: vault.id,
            name: vault.name,
            description: vault.description || '',
            path: vault.path,
            mode: vault.mode || 'read-only',
            permissions: vault.permissions || {},
        });
        const response = await this.fetchApi('/api/admin/vault-config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ vaults: replaced }),
        });
        if (!response.ok) throw new Error(await response.text());
        this.serverVaultConfig = await response.json();
        this.currentConfigVaultId = this.normalizeVaultId(nextVault.id);
        this.singleVaultConfigDirty = false;
        this.vaultPermissions.clear();
        this.renderSingleVaultConfigPage();
        this.updateUrlForVaultSettings(this.currentConfigVaultId, { replace: true });
        this.setSingleVaultConfigStatus('Vault config saved.', 'ok');
    }

    async toggleSingleVaultAdvancedConfig() {
        const textarea = document.getElementById('single-vault-advanced-text');
        const button = document.getElementById('single-vault-advanced-toggle');
        if (!textarea || !button || !this.currentConfigVaultId) return;
        const opening = textarea.classList.contains('hidden');
        textarea.classList.toggle('hidden', !opening);
        button.textContent = opening ? 'Close YAML' : 'Open YAML';
        if (opening && !this.singleVaultAdvancedLoaded) {
            this.setSingleVaultAdvancedStatus('Loading vault YAML...', 'info');
            try {
                const response = await this.fetchApi(`/api/admin/vault-config/${encodeURIComponent(this.currentConfigVaultId)}/text`);
                if (!response.ok) throw new Error(await response.text());
                const data = await response.json();
                textarea.value = data.content || '';
                this.singleVaultAdvancedLoaded = true;
                this.singleVaultAdvancedDirty = false;
                this.setSingleVaultAdvancedStatus(`${data.config_file || 'mdvr.yaml'} · ${data.writable ? 'writable' : 'read-only'}`, data.writable ? 'ok' : 'warn');
            } catch (error) {
                this.setSingleVaultAdvancedStatus(`Unable to load vault YAML: ${this.humanizeFetchError(error)}`, 'error');
            }
        }
    }

    async saveSingleVaultAdvancedConfigText() {
        const textarea = document.getElementById('single-vault-advanced-text');
        if (!textarea || !this.currentConfigVaultId) return;
        const response = await this.fetchApi(`/api/admin/vault-config/${encodeURIComponent(this.currentConfigVaultId)}/text`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: textarea.value }),
        });
        if (!response.ok) throw new Error(await response.text());
        const data = await response.json();
        this.serverVaultConfig = data;
        this.currentConfigVaultId = this.normalizeVaultId(data.vault?.id || this.currentConfigVaultId);
        this.singleVaultConfigDirty = false;
        this.singleVaultAdvancedDirty = false;
        this.vaultPermissions.clear();
        this.renderSingleVaultConfigPage();
        this.updateUrlForVaultSettings(this.currentConfigVaultId, { replace: true });
        this.setSingleVaultAdvancedStatus('Advanced vault YAML saved.', 'ok');
    }

    async loadServerConfig() {
        if (!this.activeVault || this.activeVault === this.ALL_VAULTS_ID) {
            this.permissions = this.allVaultPermissions();
            this.updatePermissionControls();
            return;
        }
        try {
            const response = await this.fetchApi('/api/config');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data.app && data.app.name) this.appTitle = `${data.app.name} - md_vault_reader`;
            if (data.permissions) this.permissions = data.permissions;
            this.updatePermissionControls();
        } catch (error) {
            console.error('Failed to load server config:', error);
            this.updatePermissionControls();
        }
    }

    updatePermissionControls() {
        const menuPermissions = this.permissionsForContextMenu();
        const openBtn = document.getElementById('cm-open');
        if (openBtn) {
            const canOpen = !this.contextMenuIsDir;
            openBtn.classList.toggle('hidden', !canOpen);
            openBtn.disabled = !canOpen;
        }

        const downloadBtn = document.getElementById('cm-download');
        if (downloadBtn) {
            const canDownload = !this.contextMenuIsDir;
            downloadBtn.classList.toggle('hidden', !canDownload);
            downloadBtn.disabled = !canDownload;
        }

        const homeTarget = this.getHomeCreateTarget();
        const navNewBtn = document.getElementById('nav-new-file');
        if (navNewBtn) {
            const canCreateFromHome = this.viewMode === 'home' ? !!homeTarget : !!this.permissions.new_files;
            navNewBtn.classList.toggle('hidden', !canCreateFromHome);
            navNewBtn.disabled = !canCreateFromHome;
        }
        const headerNewBtn = document.getElementById('header-new-file-btn');
        if (headerNewBtn) {
            const canCreateFromHeader = this.viewMode === 'home' && !!homeTarget;
            headerNewBtn.classList.toggle('hidden', !canCreateFromHeader);
            headerNewBtn.disabled = !canCreateFromHeader;
            headerNewBtn.title = homeTarget ? `New file in ${this.vaultLabel(homeTarget.vault.id)}` : 'New file';
        }
        const sidebarNewBtn = document.getElementById('sidebar-new-file');
        if (sidebarNewBtn) {
            sidebarNewBtn.classList.toggle('hidden', !this.permissions.new_files);
            sidebarNewBtn.disabled = !this.permissions.new_files;
        }
        const newHereBtn = document.getElementById('cm-new-here');
        if (newHereBtn) {
            const canCreateHere = !!menuPermissions.new_files && !!this.contextMenuPath;
            newHereBtn.classList.toggle('hidden', !canCreateHere);
            newHereBtn.disabled = !canCreateHere;
        }


        const renameButtons = [document.getElementById('cm-rename')];
        renameButtons.forEach(btn => {
            if (!btn) return;
            const allowed = this.contextMenuPath
                ? !!menuPermissions.rename && this.matchesAllowedFormat(this.contextMenuPath, menuPermissions.files_format_read || [])
                : !!this.permissions.rename;
            btn.classList.toggle('hidden', !allowed);
            btn.disabled = !allowed;
        });

        const deleteBtn = document.getElementById('cm-delete');
        const deleteDivider = document.getElementById('cm-delete-divider');
        if (deleteBtn) {
            const canDelete = !!menuPermissions.delete && !!this.contextMenuPath;
            deleteBtn.classList.toggle('hidden', !canDelete);
            deleteBtn.disabled = !canDelete;
        }
        if (deleteDivider) deleteDivider.classList.toggle('hidden', !menuPermissions.delete);

        const editor = document.getElementById('editor');
        if (editor) {
            const canEdit = this.currentFile ? this.canEditPath(this.currentFile) : false;
            editor.readOnly = !canEdit;
        }
        if (this.viewMode === 'home') this.setHomeUploadButton();
    }

    async loadVaultName() {
        if (this.isAllVaults()) {
            const names = this.getSelectedVaultOptions().map(option => this.vaultLabel(option.id));
            this.vaultName = names.length ? names.join(' + ') : 'Selected vaults';
            if (this.viewMode !== 'reader') this.setHomeHeader();
            this.syncHomeTelemetry();
            return;
        }
        try {
            await this.loadActiveVaultName();
        } catch (error) {
            console.error('Failed to load vault name:', error);
            this.vaultName = 'Obsidian Vault';
            this.syncHomeTelemetry();
        }
    }

    async loadActiveVaultName() {
        try {
            const response = await this.fetchApi('/api/vault-name');
            const data = await response.json();
            this.vaultName = this.vaultLabel(this.activeVault) || data.name;
            if (this.viewMode !== 'reader') this.setHomeHeader();
            this.syncHomeTelemetry();
        } catch (error) {
            console.error('Failed to load active vault name:', error);
            throw error;
        }
    }

    countVisibleFiles(files) {
        return (files || []).reduce((total, file) => {
            if (file.is_dir) return total + this.countVisibleFiles(file.children || []);
            return total + (this.isVisibleFile(file.path) ? 1 : 0);
        }, 0);
    }

    syncHomeTelemetry() {
        const fileCount = String(this.homeFileCount).padStart(3, '0');
        const recentCount = String(this.homeRecentCount).padStart(2, '0');
        const treeCount = document.getElementById('home-tree-count');
        const recent = document.getElementById('home-recent-count');
        const recentDec = document.getElementById('recent-limit-dec');
        const recentInc = document.getElementById('recent-limit-inc');
        if (treeCount) treeCount.textContent = `${fileCount} OBJECTS`;
        if (recent) recent.textContent = `${recentCount} ACTIVE`;
        if (recentDec) recentDec.disabled = this.homeRecentLimit <= 1;
        if (recentInc) recentInc.disabled = this.homeRecentLimit >= Math.min(12, Math.max(1, this.homeRecentTotal));
    }

    setRecentLimit(limit) {
        const nextLimit = Math.min(12, Math.max(1, limit));
        if (nextLimit === this.homeRecentLimit) return;
        this.homeRecentLimit = nextLimit;
        localStorage.setItem('mdvr_recent_limit', String(nextLimit));
        this.renderRecentFiles();
    }

    recentSearchMatches(file, query) {
        query = String(query || '').toLowerCase().trim();
        if (!query) return true;
        const tags = (file.tags || []).map(tag => this.formatTagQuery(tag).toLowerCase());
        if (query.startsWith('#')) return tags.includes(query);
        const title = String(file.name || '').replace(/\.(md|markdown|excalidraw)$/i, '').toLowerCase();
        const path = String(file.path || '').toLowerCase();
        const vaultName = String(file.vaultName || this.vaultLabel(file.vault)).toLowerCase();
        return title.includes(query)
            || path.includes(query)
            || vaultName.includes(query)
            || tags.some(tag => tag.includes(query));
    }

    renderRecentFiles() {
        const grid = document.getElementById('recent-files-grid');
        if (!grid) return;
        const query = document.getElementById('home-search')?.value || '';
        const selectedVaults = this.getSelectedVaultOptions();
        const filteredFiles = (this.homeRecentFiles || [])
            .filter(file => this.recentSearchMatches(file, query));
        this.homeRecentTotal = filteredFiles.length;
        const recentFiles = filteredFiles.slice(0, this.homeRecentLimit);
        this.homeRecentCount = recentFiles.length;
        this.syncHomeTelemetry();

        grid.innerHTML = '';
        recentFiles.forEach(file => {
            const timestamp = this.formatHeaderDateTime(file.mtime);
            const title = file.name.replace(/\.(md|markdown|excalidraw)$/i, '');
            const folderPath = file.path.substring(0, file.path.lastIndexOf('/')) || '/';
            const vaultPrefix = file.vaultName || this.vaultLabel(file.vault);
            const displayFolderPath = selectedVaults.length > 1
                ? `${vaultPrefix}${folderPath === '/' ? ' /' : ` / ${folderPath}`}`
                : folderPath;

            const card = document.createElement('div');
            card.className = 'border border-outline-variant p-4 hover:opacity-90 transition-colors cursor-pointer file-card shadow-sm mechanical-button h-36 flex flex-col';
            card.style.backgroundColor = 'var(--c-sidebar)';
            card.dataset.path = selectedVaults.length > 1 ? `${file.vault}/${file.path}` : file.path;
            card.dataset.openPath = file.path;
            card.dataset.vault = file.vault || this.activeVault;
            card.dataset.tags = (file.tags || []).map(tag => this.formatTagQuery(tag)).join(' ');

            const inner = document.createElement('div');
            inner.className = 'flex-grow flex flex-col overflow-hidden';

            const topRow = document.createElement('div');
            topRow.className = 'file-card-header mb-1';
            const primary = document.createElement('div');
            primary.className = 'file-card-primary';
            const h3 = document.createElement('h3');
            h3.className = 'font-mono-value font-bold text-sm truncate';
            h3.style.color = 'var(--c-body)';
            h3.textContent = title;
            const fp = document.createElement('div');
            fp.className = 'file-card-path';
            fp.textContent = displayFolderPath;
            primary.appendChild(h3);
            primary.appendChild(fp);
            const datetime = document.createElement('div');
            datetime.className = 'file-card-datetime';
            datetime.style.color = 'var(--c-body)';
            datetime.innerHTML = `<span>${timestamp.date}</span><span>${timestamp.time}</span>`;
            topRow.appendChild(primary);
            topRow.appendChild(datetime);
            inner.appendChild(topRow);

            const p = document.createElement('p');
            p.className = 'font-body text-xs mt-1 line-clamp-2 leading-snug break-words whitespace-normal opacity-60';
            p.style.color = 'var(--c-body)';
            p.textContent = file.excerpt || '';
            inner.appendChild(p);

            card.appendChild(inner);
            card.addEventListener('click', () => this.openFile(file.path, { vault: card.dataset.vault }));
            grid.appendChild(card);
        });
        requestAnimationFrame(() => this.syncRecentDatetimeVisibility());
    }

    async loadRecentFiles() {
        try {
            let files = [];
            const selectedVaults = this.getSelectedVaultOptions();
            if (selectedVaults.length > 1) {
                await this.loadSelectedVaultPermissions();
                const settled = await Promise.allSettled(
                    selectedVaults.map(async vault => {
                        const data = await this.fetchJsonForVault(vault.id, '/api/recent');
                        return (data.files || []).map(file => ({
                            ...file,
                            vault: vault.id,
                            vaultName: this.vaultLabel(vault.id),
                        }));
                    })
                );
                files = settled.flatMap(result => result.status === 'fulfilled' ? result.value : []);
                this.permissions = this.allVaultPermissions();
                this.updatePermissionControls();
            } else {
                const vault = selectedVaults[0];
                if (vault && vault.id !== this.activeVault && this.viewMode === 'home') {
                    this.setActiveVault(vault.id);
                    await this.loadServerConfig();
                    await this.loadVaultName();
                }
                const response = vault
                    ? await this.fetchApiForVault('/api/recent', vault.id)
                    : await this.fetchApi('/api/recent');
                const data = await response.json();
                if (data.permissions) {
                    this.permissions = data.permissions;
                    this.updatePermissionControls();
                }
                files = (data.files || []).map(file => ({
                    ...file,
                    vault: vault?.id || this.activeVault,
                    vaultName: vault ? this.vaultLabel(vault.id) : this.vaultName || this.activeVault,
                }));
            }
            if (selectedVaults.length <= 1 && this.permissions) {
                this.updatePermissionControls();
            }
            if (selectedVaults.length > 1) {
                files.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
            }
            this.homeRecentFiles = files.filter(file => this.isVisibleFile(file.path));
            this.renderRecentFiles();
        } catch (error) {
            console.error('Failed to load recent files:', error);
            this.updateStatus('Failed to load recent files');
        }
    }

    syncRecentDatetimeVisibility() {
        document.querySelectorAll('.file-card').forEach(card => {
            const datetime = card.querySelector('.file-card-datetime');
            if (!datetime) return;
            datetime.classList.remove('hidden');
            datetime.classList.toggle('hidden', datetime.scrollWidth > card.clientWidth * 0.4);
        });
    }

    syncFolderToggle(containerId = 'file-tree') {
        const container = document.getElementById(containerId);
        const toggle = document.getElementById(containerId === 'reader-file-tree' ? 'sidebar-folder-toggle' : 'toggle-file-tree');
        if (!container || !toggle) return;
        const folders = [...container.querySelectorAll('.file-item.folder')]
            .filter(folder => folder.nextElementSibling?.classList.contains('folder-children'));
        const allExpanded = folders.length > 0 && folders.every(folder => this.expandedFolders.has(folder.dataset.path));
        toggle.setAttribute('aria-pressed', String(allExpanded));
        toggle.title = allExpanded ? 'Collapse folders' : 'Expand folders';
        toggle.setAttribute('aria-label', toggle.title);
        if (containerId === 'reader-file-tree') {
            toggle.innerHTML = allExpanded
                ? '<span class="material-symbols-outlined text-[16px]" style="color: var(--c-body)">unfold_less</span>'
                : '<span class="material-symbols-outlined text-[16px]" style="color: var(--c-body)">unfold_more</span>';
        } else {
            toggle.innerHTML = allExpanded
                ? '<span class="material-symbols-outlined text-[14px]">unfold_less</span> COLLAPSE_FOLDERS'
                : '<span class="material-symbols-outlined text-[14px]">unfold_more</span> EXPAND_FOLDERS';
        }
    }

    toggleAllFolders(containerId = 'file-tree') {
        const container = document.getElementById(containerId);
        if (!container) return;
        const folders = [...container.querySelectorAll('.file-item.folder')]
            .filter(folder => folder.nextElementSibling?.classList.contains('folder-children'));
        const shouldExpand = folders.some(folder => !this.expandedFolders.has(folder.dataset.path));
        folders.forEach(folder => {
            const children = folder.nextElementSibling;
            children.classList.toggle('hidden', !shouldExpand);
            this.expandedFolders[shouldExpand ? 'add' : 'delete'](folder.dataset.path);
            const icon = folder.querySelector('.folder-icon');
            if (icon) icon.textContent = shouldExpand ? '▼' : '▶';
        });
        this.syncFolderToggle(containerId);
    }

    getAncestorFolderPaths(path) {
        const parts = String(path || '').split('/').filter(Boolean);
        parts.pop();
        return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
    }

    selectFileInTrees(path) {
        document.querySelectorAll('.file-item').forEach(item => item.classList.remove('selected'));
        document.querySelectorAll(`.file-item[data-path="${CSS.escape(path)}"]`).forEach(el => el.classList.add('selected'));
        document.querySelectorAll(`.file-item[data-open-path="${CSS.escape(path)}"]`).forEach(el => el.classList.add('selected'));
    }

    revealFileInTree(path, containerId = 'reader-file-tree') {
        const container = document.getElementById(containerId);
        if (!container || !path) return;

        const ancestors = this.getAncestorFolderPaths(path);
        ancestors.forEach(folderPath => this.expandedFolders.add(folderPath));

        ancestors.forEach(folderPath => {
            const folder = container.querySelector(`.file-item.folder[data-path="${CSS.escape(folderPath)}"]`);
            if (!folder) return;
            const children = folder.nextElementSibling;
            if (children && children.classList.contains('folder-children')) {
                children.classList.remove('hidden');
                children.style.display = '';
            }
            const icon = folder.querySelector('.folder-icon');
            if (icon) icon.textContent = '▼';
            folder.style.display = '';
        });

        this.selectFileInTrees(path);
        const target = container.querySelector(`.file-item.file[data-path="${CSS.escape(path)}"]`);
        if (!target) return;
        target.style.display = '';
        requestAnimationFrame(() => {
            target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
        });
        this.syncFolderToggle(containerId);
    }

    async loadFileTree(containerId) {
        try {
            let files = [];
            const selectedVaults = this.getSelectedVaultOptions();
            if (containerId === 'file-tree' && selectedVaults.length > 1) {
                await this.loadSelectedVaultPermissions();
                const settled = await Promise.allSettled(
                    selectedVaults.map(async vault => {
                        const data = await this.fetchJsonForVault(vault.id, '/api/files');
                        return {
                            vault,
                            files: data.files || [],
                        };
                    })
                );
                const fulfilled = settled
                    .filter(result => result.status === 'fulfilled')
                    .map(result => result.value);
                this.homeFileCount = fulfilled.reduce((total, entry) => total + this.countVisibleFiles(entry.files), 0);
                files = fulfilled.map(entry => this.toVaultTreeRoot(entry.files, entry.vault));
            } else {
                const vault = containerId === 'file-tree' ? selectedVaults[0] : null;
                if (vault && vault.id !== this.activeVault && this.viewMode === 'home') {
                    this.setActiveVault(vault.id);
                    await this.loadServerConfig();
                    await this.loadVaultName();
                }
                const response = vault
                    ? await this.fetchApiForVault('/api/files', vault.id)
                    : await this.fetchApi('/api/files');
                const data = await response.json();
                files = data.files || [];
                if (containerId === 'file-tree') this.homeFileCount = this.countVisibleFiles(files);
            }
            this.syncHomeTelemetry();
            this.renderFileTree(files, document.getElementById(containerId));
            if (containerId === 'reader-file-tree' && this.currentFile) {
                this.revealFileInTree(this.currentFile, containerId);
            }
        } catch (error) {
            console.error('Failed to load file tree:', error);
        }
    }

    renderFileTree(files, container, level = 0) {
        if (level === 0) container.innerHTML = '';

        const sortedFiles = [...files].sort((a, b) => {
            if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
            return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        });

        sortedFiles.forEach(file => {
            if (!file.is_dir && !this.isVisibleFile(file.path)) return;
            if (!file.is_dir) {
                this.fileMetadataByPath.set(file.open_path || file.path, {
                    mtime: file.mtime || null,
                });
            }

            const fileElement = document.createElement('div');
            fileElement.className = `file-item ${file.is_dir ? 'folder' : 'file'}`;
            fileElement.dataset.path = file.path;
            fileElement.dataset.openPath = file.open_path || file.path;
            fileElement.dataset.vault = file.vault || '';
            fileElement.dataset.tags = (file.tags || []).map(tag => this.formatTagQuery(tag)).join(' ');

            const isExpanded = file.is_dir && this.expandedFolders.has(file.path);
            
            if (file.is_dir) {
                const folderIcon = document.createElement('span');
                folderIcon.className = 'folder-icon font-mono';
                folderIcon.textContent = isExpanded ? '▼' : '▶';
                const folderName = document.createElement('span');
                folderName.className = 'folder-name truncate';
                folderName.textContent = file.name;
                fileElement.appendChild(folderIcon);
                fileElement.appendChild(folderName);
                fileElement.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleFolder(fileElement, file.path);
                });
            } else {
                const fileIcon = document.createElement('span');
                fileIcon.className = 'file-icon font-mono';
                fileIcon.textContent = '─';
                const fileName = document.createElement('span');
                fileName.className = 'file-name truncate';
                fileName.title = file.open_path || file.path;
                fileName.textContent = file.name;
                fileElement.appendChild(fileIcon);
                fileElement.appendChild(fileName);
                fileElement.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const openPath = file.open_path || file.path;
                    const vault = file.vault || null;
                    await this.openFile(openPath, vault ? { vault } : {});
                    
                    const sidebar = document.getElementById('reader-sidebar');
                    if (!sidebar.classList.contains('-translate-x-full')) {
                        sidebar.classList.add('-translate-x-full');
                        document.getElementById('sidebar-overlay').classList.add('hidden');
                    }
                });
            }

            // Keep the unfinished management surface dormant until it is exposed deliberately.
            const showCtx = (x, y) => {
                this.contextMenuPath = file.open_path || file.path;
                this.contextMenuVault = file.vault || this.activeVault;
                this.contextMenuIsDir = file.is_dir;
                this.updatePermissionControls();
                const menu = document.getElementById('context-menu');
                menu.style.left = `${x}px`;
                menu.style.top = `${y}px`;
                menu.classList.remove('hidden');
            };
            if (this.contextMenuEnabled) {
                fileElement.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    showCtx(e.pageX, e.pageY);
                });
                // Long press for mobile
                let lpTimer = null;
                fileElement.addEventListener('touchstart', (e) => {
                    lpTimer = setTimeout(() => {
                        e.preventDefault();
                        const t = e.touches[0];
                        showCtx(t.pageX, t.pageY);
                    }, 500);
                }, { passive: false });
                fileElement.addEventListener('touchend', () => clearTimeout(lpTimer));
                fileElement.addEventListener('touchmove', () => clearTimeout(lpTimer));
            }

            container.appendChild(fileElement);

            if (file.is_dir && file.children && file.children.length > 0) {
                const childrenContainer = document.createElement('div');
                childrenContainer.className = `folder-children${isExpanded ? '' : ' hidden'}`;
                container.appendChild(childrenContainer);
                this.renderFileTree(file.children, childrenContainer, level + 1);
            }
        });

        // Ensure selection highlighting persists across re-renders
        if (this.currentFile) {
            document.querySelectorAll(`.file-item[data-open-path="${CSS.escape(this.currentFile)}"]`).forEach(el => el.classList.add('selected'));
            document.querySelectorAll(`.file-item[data-path="${CSS.escape(this.currentFile)}"]`).forEach(el => el.classList.add('selected'));
        }
        if (container.id === 'file-tree' || container.id === 'reader-file-tree') this.syncFolderToggle(container.id);
    }

    toggleFolder(folderElement, folderPath) {
        const children = folderElement.nextElementSibling;
        if (children && children.classList.contains('folder-children')) {
            const isCurrentlyHidden = children.classList.contains('hidden');
            if (isCurrentlyHidden) {
                children.classList.remove('hidden');
                this.expandedFolders.add(folderPath);
                folderElement.querySelector('.folder-icon').textContent = '▼';
            } else {
                children.classList.add('hidden');
                this.expandedFolders.delete(folderPath);
                folderElement.querySelector('.folder-icon').textContent = '▶';
            }
            if (folderElement.closest('#file-tree')) this.syncFolderToggle('file-tree');
            if (folderElement.closest('#reader-file-tree')) this.syncFolderToggle('reader-file-tree');
        }
    }

    filterFiles(query, containerId) {
        query = query.toLowerCase().trim();
        const isTagSearch = query.startsWith('#');
        if (containerId === 'recent-files-grid') {
            const cards = document.querySelectorAll('.file-card');
            cards.forEach(card => {
                const name = card.querySelector('h3').textContent.toLowerCase();
                const path = (card.dataset.path || '').toLowerCase();
                const tags = (card.dataset.tags || '').toLowerCase();
                if (query === '' || (isTagSearch ? tags.split(/\s+/).includes(query) : (name.includes(query) || path.includes(query) || tags.includes(query)))) card.style.display = '';
                else card.style.display = 'none';
            });
        } else {
            const container = document.getElementById(containerId);
            if (!container) return;
            const fileItems = container.querySelectorAll('.file-item');
            const folderMatchPrefixes = new Set();
            
            fileItems.forEach(item => {
                const fileName = item.textContent.toLowerCase();
                const filePath = (item.dataset.path || '').toLowerCase();
                const tags = (item.dataset.tags || '').toLowerCase();
                const directMatch = query === '' || (isTagSearch ? tags.split(/\s+/).includes(query) : (fileName.includes(query) || filePath.includes(query) || tags.includes(query)));
                if (directMatch && query !== '' && item.classList.contains('folder')) {
                    folderMatchPrefixes.add(item.dataset.path || '');
                }
            });

            fileItems.forEach(item => {
                const fileName = item.textContent.toLowerCase();
                const filePath = (item.dataset.path || '').toLowerCase();
                const tags = (item.dataset.tags || '').toLowerCase();
                const directMatch = query === '' || (isTagSearch ? tags.split(/\s+/).includes(query) : (fileName.includes(query) || filePath.includes(query) || tags.includes(query)));
                const folderDescendantMatch = query !== '' && [...folderMatchPrefixes].some(prefix => prefix && item.dataset.path?.startsWith(`${prefix}/`));
                if (directMatch || folderDescendantMatch) {
                    item.style.display = '';
                    
                    if (query !== '' && !item.querySelector('.search-path') && item.dataset.path) {
                        const pathText = document.createElement('span');
                        pathText.className = 'search-path text-[9px] text-zinc-400 ml-2 uppercase truncate max-w-[100px] flex-shrink-0';
                        const parts = item.dataset.path.split('/');
                        parts.pop(); // Remove filename
                        if (parts.length > 0) {
                            pathText.textContent = parts.join('/');
                            item.appendChild(pathText);
                        }
                    } else if (query === '' && item.querySelector('.search-path')) {
                        item.querySelector('.search-path').remove();
                    }

                    if (query !== '') {
                        let branch = item.parentElement;
                        while (branch && branch.classList.contains('folder-children')) {
                            branch.classList.remove('hidden');
                            branch.style.display = '';
                            const parentFolder = branch.previousElementSibling;
                            if (parentFolder && parentFolder.classList.contains('folder')) {
                                parentFolder.style.display = '';
                                const icon = parentFolder.querySelector('.folder-icon');
                                if (icon) {
                                    icon.textContent = '▼';
                                }
                            }
                            branch = parentFolder ? parentFolder.parentElement : null;
                        }
                    }
                } else {
                    item.style.display = 'none';
                }
            });

            container.querySelectorAll('.folder-children').forEach(cont => {
                if (query === '') {
                    const folder = cont.previousElementSibling;
                    const expanded = !!folder && this.expandedFolders.has(folder.dataset.path);
                    cont.classList.toggle('hidden', !expanded);
                    cont.style.display = '';
                    const icon = folder && folder.querySelector('.folder-icon');
                    if (icon) icon.textContent = expanded ? '▼' : '▶';
                    return;
                }
                const visibleItems = cont.querySelectorAll('.file-item:not([style*="display: none"])');
                if (visibleItems.length === 0) {
                    cont.style.display = 'none';
                } else {
                    cont.style.display = '';
                }
            });
        }
    }

    async loadFile(path, options = {}) {
        if (this.isDirty) await this.saveFile();
        const viewerKind = this.getViewerKind(path);
        if (viewerKind === 'excalidraw') {
            await this.renderExcalidrawFile(path, options.refreshBinary === true);
            return;
        }
        if (viewerKind === 'image' || viewerKind === 'pdf') {
            this.renderBinaryFile(path, viewerKind, options.refreshBinary === true);
            return;
        }

        if (!this.isVisibleFile(path)) {
            this.updateStatus('Unsupported file type');
            return;
        }

        try {
            const response = await this.fetchApi(`/api/file?path=${encodeURIComponent(path)}`);
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.detail || `HTTP ${response.status}`);
            }
            const data = await response.json();
            if (data.permissions) this.permissions = data.permissions;
            this.currentMetadata = Array.isArray(data.metadata) ? data.metadata : [[], [], []];
            this.currentResolvedLinks = new Map((this.currentMetadata[1] || []).map(link => [String(link.label || '').toLowerCase(), link.path || link.label || '']));
            
            document.getElementById('editor').value = data.content;
            this.currentFile = path;
            this.currentFileKind = data.kind || 'text';
            if (options.preservePreview !== true) this.previewEnabled = true;
            this.setDirty(false);
            this.updateHighlighting();
            this.showTextViewer();
            this.syncPreviewMode();
            this.updatePreview();
            this.updatePermissionControls();
            this.setDownloadForPath(path);
            
            const title = document.getElementById('header-title');
            if (title) title.title = `Click to rename ${path}`;
            this.setHeaderFileInfo(path, data.mtime);
            document.title = `${path} - ${this.appTitle}`;
            this.updateUrlForFile(path, { replace: options.replaceUrl === true });
            
            this.selectFileInTrees(path);
            this.revealFileInTree(path, 'reader-file-tree');
            this.syncHeaderDatetimeVisibility();
            
        } catch (error) {
            console.error('Failed to load file:', error);
            this.updateStatus('Failed to load ' + path);
            const title = document.getElementById('header-title');
            if (title) {
                title.textContent = this.getDisplayTitle(path) || path;
                title.title = `Failed to load ${path}`;
            }
        }
    }

    updateHighlighting() {
        const editor = document.getElementById('editor');
        const backdrop = document.getElementById('editor-backdrop');
        let text = editor.value;
        
        let html = text
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/^(#{1,6}.*)$/gm, '<span class="hl-header">$1</span>')
            .replace(/(\*\*.*?\*\*)/g, '<span class="hl-bold">$1</span>')
            .replace(/(\*.*?\*)/g, '<span class="hl-italic">$1</span>')
            .replace(/^([\-\*\+]\s+)/gm, '<span class="hl-list">$1</span>')
            .replace(/(^```[\s\S]*?^```)/gm, '<span class="hl-codeblock">$1</span>')
            .replace(/`([^`\n]+)`/g, '<span class="hl-code">`$1`</span>');
            
        // Extra <br> allows proper scrolling for the last empty line
        if (text.endsWith('\n')) {
            html += '<br>';
        }
        
        backdrop.innerHTML = html;
    }

    async saveFile() {
        if (!this.currentFile || !this.isDirty) return;
        if (!this.canEditPath(this.currentFile)) {
            this.updateStatus('Edit not allowed');
            this.setDirty(false);
            return;
        }
        try {
            let content;
            if (this.currentFileKind === 'excalidraw' && this.excalidrawBridge && typeof this.excalidrawBridge.serialize === 'function') {
                content = this.excalidrawBridge.serialize();
            } else {
                content = document.getElementById('editor').value;
            }
            const response = await this.fetchApi('/api/file', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: this.currentFile, content: content })
            });
            if (response.ok) {
                this.setDirty(false);
                this.updateStatus('Saved');
            } else {
                throw new Error('Save failed');
            }
        } catch (error) {
            console.error('Failed to save file:', error);
            this.updateStatus('Failed to save');
        }
    }

    setDirty(dirty) {
        this.isDirty = dirty;
    }

    updateStatus(_text) {}

    setupAutoSave() {
        setInterval(() => { if (this.isDirty) this.saveFile(); }, 30000);
    }

    togglePreview() {
        this.previewEnabled = !this.previewEnabled;
        this.syncPreviewMode();
        if (this.previewEnabled) this.updatePreview();
    }

    updatePreview() {
        const content = document.getElementById('editor').value;
        const previewPane = document.getElementById('preview-pane');
        try {
            if (this.currentFile && this.currentFile.toLowerCase().endsWith('.canvas')) {
                previewPane.innerHTML = `
                    <div class="mb-4 text-xs uppercase tracking-widest opacity-60">Canvas preview is shown as raw data in this build.</div>
                    <pre class="whitespace-pre-wrap break-words">${this.escapeHtml(content)}</pre>
                `;
                return;
            }
            const markdown = this.parseMarkdown(this.stripMetadataTagBlocks(content));
            previewPane.innerHTML = `${markdown}${this.renderMetadataInlineFooter()}`;
            this.bindPreviewLinkHandlers(previewPane);
            this.renderPdfPreviews(previewPane);
        } catch (e) {
            previewPane.innerHTML = '<pre>' + this.escapeHtml(content) + '</pre>';
        }
    }

    stripMetadataTagBlocks(text) {
        if (!text) return '';
        const lines = text.split('\n');
        const output = [];
        let inCodeBlock = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const stripped = line.trim();
            if (stripped.startsWith('```')) {
                inCodeBlock = !inCodeBlock;
                output.push(line);
                continue;
            }
            if (!inCodeBlock && /^(?:#{1,6}\s*)?tags:?$/i.test(stripped)) {
                let next = i + 1;
                let consumed = false;
                while (next < lines.length && /^[-*+]\s+/.test(lines[next].trim())) {
                    next++;
                    consumed = true;
                }
                if (consumed) {
                    i = next;
                    if (i < lines.length && lines[i].trim() !== '') i--;
                    continue;
                }
            }
            if (!inCodeBlock && /^(?:#{1,6}\s*)?tags\s*[:\-]\s*\S+/i.test(stripped)) {
                continue;
            }
            output.push(line);
        }
        return output.join('\n').replace(/^\s+/, '');
    }

    parseMarkdown(text) {
        if (!text) return '';
        let html = text;
        const lines = html.split('\n');
        const output = [];
        let inCodeBlock = false;
        let inList = false;
        let listType = null;

        for (let line of lines) {
            if (line.startsWith('```')) {
                if (!inCodeBlock) {
                    if (inList) { output.push(`</${listType}>`); inList = false; }
                    output.push('<pre><code>');
                    inCodeBlock = true;
                } else {
                    output.push('</code></pre>');
                    inCodeBlock = false;
                }
                continue;
            }
            if (inCodeBlock) { output.push(this.escapeHtml(line)); continue; }

            const mediaOnly = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
            if (mediaOnly) {
                if (inList) { output.push(`</${listType}>`); inList = false; }
                output.push(this.renderMediaEmbed(mediaOnly[2], mediaOnly[1]));
                continue;
            }

            const pdfOnly = line.trim().match(/^\[([^\]]+)\]\(([^)]+\.pdf(?:#[^)]+)?)\)$/i);
            if (pdfOnly) {
                if (inList) { output.push(`</${listType}>`); inList = false; }
                output.push(this.renderMediaEmbed(pdfOnly[2], pdfOnly[1]));
                continue;
            }

            const headerMatch = line.match(/^(#{1,6})\s+(.*)/);
            if (headerMatch) {
                if (inList) { output.push(`</${listType}>`); inList = false; }
                const level = headerMatch[1].length;
                output.push(`<h${level}>${this.parseInlineMarkdown(headerMatch[2])}</h${level}>`);
                continue;
            }

            if (line.startsWith('>')) {
                if (inList) { output.push(`</${listType}>`); inList = false; }
                output.push(`<blockquote>${this.parseInlineMarkdown(line.substring(1).trim())}</blockquote>`);
                continue;
            }

            if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
                if (inList) { output.push(`</${listType}>`); inList = false; }
                output.push('<hr>');
                continue;
            }

            const ulMatch = line.match(/^[\-\*\+]\s+(.*)/);
            if (ulMatch) {
                if (!inList || listType !== 'ul') {
                    if (inList) output.push(`</${listType}>`);
                    output.push('<ul>'); inList = true; listType = 'ul';
                }
                output.push(`<li>${this.parseInlineMarkdown(ulMatch[1])}</li>`);
                continue;
            }

            if (line.trim() === '') {
                if (inList) { output.push(`</${listType}>`); inList = false; }
                continue;
            }

            if (inList) { output.push(`</${listType}>`); inList = false; }
            output.push(`<p>${this.parseInlineMarkdown(line)}</p>`);
        }
        if (inList) output.push(`</${listType}>`);
        return output.join('\n');
    }

    parseInlineMarkdown(text) {
        if (!text) return '';
        text = this.escapeHtml(text);
        text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
        text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        text = text.replace(/\*([^*]+?)\*/g, '<em>$1</em>');
        text = text.replace(/_([^_]+?)_/g, '<em>$1</em>');
        text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, label, href) => this.renderMediaEmbed(href, label));
        text = text.replace(/\[\[([^\]]+)\]\]/g, (match, raw) => {
            const target = raw.split('|', 1)[0].split('#', 1)[0].trim();
            const label = raw.includes('|') ? raw.split('|').slice(1).join('|').trim() : target;
            const resolved = this.currentResolvedLinks.get(target.toLowerCase()) || target;
            return `<a href="#" class="wiki-link" data-wiki-path="${this.escapeHtml(resolved)}">${this.escapeHtml(label)}</a>`;
        });
        text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, href) => {
            const safeHref = href.replace(/["'<>]/g, '');
            if (safeHref.startsWith('javascript:')) return this.escapeHtml(match);
            if (safeHref.toLowerCase().split('#', 1)[0].endsWith('.pdf')) return this.renderMediaEmbed(safeHref, label);
            return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${label}</a>`;
        });
        text = text.replace(/(^|[\s(])#([A-Za-z0-9][A-Za-z0-9_/-]*)\b/g, (match, prefix, tag) => {
            const query = this.formatTagQuery(tag);
            return `${prefix}<button type="button" class="wiki-link tag-inline-link" data-tag-query="${this.escapeHtml(query)}">${this.escapeHtml(query)}</button>`;
        });
        return text;
    }

    resolveAssetPath(href) {
        const raw = String(href || '').trim().replace(/^<|>$/g, '');
        if (!raw || /^(?:https?:|data:|blob:|mailto:|#)/i.test(raw)) return { external: true, href: raw };
        const [pathPart, hash = ''] = raw.split('#', 2);
        let normalized = pathPart.replace(/\\/g, '/').replace(/^\/+/, '');
        const currentFolder = (this.currentFile || '').split('/').slice(0, -1).join('/');
        const firstSegment = normalized.split('/', 1)[0] || '';
        const shouldResolveRelative = currentFolder && (
            normalized.startsWith('./')
            || normalized.startsWith('../')
            || !normalized.includes('/')
            || firstSegment.startsWith('_')
        );
        if (shouldResolveRelative) {
            const parts = `${currentFolder}/${normalized}`.split('/');
            const stack = [];
            parts.forEach(part => {
                if (!part || part === '.') return;
                if (part === '..') stack.pop();
                else stack.push(part);
            });
            normalized = stack.join('/');
        }
        return { external: false, path: normalized, href: `${normalized}${hash ? `#${hash}` : ''}` };
    }

    assetUrlForHref(href) {
        const resolved = this.resolveAssetPath(href);
        if (resolved.external) return resolved.href;
        const [pathPart, hash = ''] = resolved.href.split('#', 2);
        return `${this.apiFileUrl(pathPart)}${hash ? `#${this.escapeHtml(hash)}` : ''}`;
    }

    apiFileUrl(path, options = {}) {
        const params = new URLSearchParams({ path });
        const vaultId = options.vault || this.activeVault;
        if (vaultId) params.set('vault', vaultId);
        if (options.refresh) params.set('v', String(Date.now()));
        return `/api/file?${params.toString()}`;
    }

    renderMediaEmbed(href, label = '') {
        const resolved = this.resolveAssetPath(href);
        const path = resolved.external ? resolved.href.split('#', 1)[0] : resolved.path;
        const kind = this.getViewerKind(path);
        const url = this.assetUrlForHref(href);
        const title = this.escapeHtml(label || path.split('/').pop() || path);
        if (kind === 'image') {
            return `<figure class="media-embed image-embed"><img src="${url}" alt="${title}"><figcaption>${title}</figcaption></figure>`;
        }
        if (kind === 'pdf') {
            return this.renderPdfPreview(url, title);
        }
        return `<a href="${url}" target="_blank" rel="noopener noreferrer">${title}</a>`;
    }

    renderPdfPreview(url, title = '', options = {}) {
        const safeUrl = this.escapeHtml(url);
        const safeTitle = this.escapeHtml(title || 'PDF');
        const directClass = options.direct ? ' pdf-direct-preview' : '';
        return `
            <div class="media-embed pdf-overview${directClass}" data-pdf-url="${safeUrl}" data-pdf-title="${safeTitle}">
                <div class="pdf-overview-header">
                    <span>${safeTitle}</span>
                    <div class="pdf-overview-actions">
                        <span class="pdf-page-count">PDF</span>
                        <a href="${safeUrl}" target="_blank" rel="noopener noreferrer">OPEN PDF</a>
                    </div>
                </div>
                <div class="pdf-canvas-wrap">
                    <canvas class="pdf-preview-canvas"></canvas>
                    <div class="pdf-preview-status">Loading PDF preview...</div>
                </div>
            </div>
        `;
    }

    async renderPdfPreviews(container) {
        if (!container) return;
        const cards = [...container.querySelectorAll('.pdf-overview[data-pdf-url]:not([data-pdf-rendered])')];
        if (!cards.length) return;

        let pdfjs;
        try {
            pdfjs = await this.loadPdfJs();
        } catch (error) {
            console.error('Failed to load PDF.js:', error);
            cards.forEach(card => {
                card.dataset.pdfRendered = 'error';
                const status = card.querySelector('.pdf-preview-status');
                if (status) status.textContent = 'PDF renderer failed to load';
            });
            return;
        }

        cards.forEach(card => {
            card.dataset.pdfRendered = 'loading';
            this.renderPdfPreviewCard(pdfjs, card);
        });
    }

    async renderPdfPreviewCard(pdfjs, card) {
        const url = card.dataset.pdfUrl;
        const canvas = card.querySelector('.pdf-preview-canvas');
        const status = card.querySelector('.pdf-preview-status');
        const count = card.querySelector('.pdf-page-count');
        if (!url || !canvas) return;

        try {
            const loadingTask = pdfjs.getDocument({ url });
            const pdf = await loadingTask.promise;
            const page = await pdf.getPage(1);
            const baseViewport = page.getViewport({ scale: 1 });
            const wrap = card.querySelector('.pdf-canvas-wrap') || card;
            const availableWidth = Math.max(240, Math.min(wrap.clientWidth || baseViewport.width, 1100));
            const scale = Math.min(2, availableWidth / baseViewport.width);
            const viewport = page.getViewport({ scale });
            const outputScale = window.devicePixelRatio || 1;
            const context = canvas.getContext('2d');

            canvas.width = Math.floor(viewport.width * outputScale);
            canvas.height = Math.floor(viewport.height * outputScale);
            canvas.style.width = `${Math.floor(viewport.width)}px`;
            canvas.style.height = `${Math.floor(viewport.height)}px`;
            context.setTransform(outputScale, 0, 0, outputScale, 0, 0);

            await page.render({ canvasContext: context, viewport }).promise;
            card.dataset.pdfRendered = 'true';
            if (status) status.classList.add('hidden');
            if (count) count.textContent = `${pdf.numPages} page${pdf.numPages === 1 ? '' : 's'}`;
        } catch (error) {
            console.error('Failed to render PDF preview:', error);
            card.dataset.pdfRendered = 'error';
            if (status) status.textContent = 'PDF preview failed. Use OPEN PDF.';
        }
    }

    bindPreviewLinkHandlers(previewPane) {
        if (!previewPane) return;
        previewPane.onclick = async (event) => {
            const tag = event.target.closest('button[data-tag-query]');
            if (tag) {
                const query = tag.dataset.tagQuery;
                if (!query) return;
                event.preventDefault();
                await this.switchView('home');
                this.updateUrlForFile(null);
                this.applyHomeSearch(query);
                return;
            }

            const link = event.target.closest('a.wiki-link, button.reader-meta-chip[data-wiki-path]');
            if (!link) return;
            const target = link.dataset.wikiPath;
            if (!target) return;
            event.preventDefault();
            this.openFile(target);
        };
    }

    renderMetadataBlock() {
        const [tags = [], links = [], backlinks = []] = this.currentMetadata || [[], [], []];
        if (!tags.length && !links.length && !backlinks.length) return '';

        const renderChip = (label, path, kind = 'link') => `<button type="button" class="reader-meta-chip reader-meta-chip--${kind}" data-wiki-path="${this.escapeHtml(path)}">${this.escapeHtml(label)}</button>`;
        const renderRow = (label, itemsHtml) => `<div class="reader-meta-row"><div class="reader-meta-label">${label}</div><div class="reader-meta-items">${itemsHtml}</div></div>`;
        const tagsHtml = tags.map(tag => {
            const query = this.formatTagQuery(tag);
            return `<button type="button" class="reader-meta-chip reader-meta-chip--tag" data-tag-query="${this.escapeHtml(query)}">${this.escapeHtml(query)}</button>`;
        }).join('');
        const linksHtml = links.map(link => renderChip(link.label || link.path, link.path, 'link')).join('');
        const backlinksHtml = backlinks.map(link => renderChip(link.name || link.path, link.path, 'backlink')).join('');

        return `
            <div class="reader-meta-block">
                ${tags.length ? renderRow('Tags', tagsHtml) : ''}
                ${links.length ? renderRow('Links', linksHtml) : ''}
                ${backlinks.length ? renderRow('Backlinks', backlinksHtml) : ''}
            </div>
        `;
    }

    renderMetadataInlineFooter() {
        const markup = this.renderMetadataBlock();
        if (!markup) return '';
        return `
            <div class="reader-meta-inline mt-8 pt-4">
                ${markup}
            </div>
        `;
    }

    updateReaderMetadataPanel() {
        const panel = document.getElementById('reader-meta-panel');
        if (!panel) return;
        const shouldShow = this.viewMode === 'reader' && !!this.currentFile;
        const markup = shouldShow ? this.renderMetadataBlock() : '';
        if (!markup) {
            panel.innerHTML = '';
            panel.classList.add('hidden');
            return;
        }
        panel.innerHTML = markup;
        panel.classList.remove('hidden');
        this.bindPreviewLinkHandlers(panel);
    }

    escapeHtml(text) {
        return String(text ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    showNewFileModal(prefix = '') {
        let vaultId = this.activeVault;
        let permissions = this.permissions;
        if (this.viewMode === 'home') {
            const target = this.getHomeCreateTarget();
            if (!target) {
                this.updateStatus('Select one writable vault');
                return;
            }
            vaultId = target.vault.id;
            permissions = target.permissions;
        }
        if (!permissions.new_files) {
            this.updateStatus('Create not allowed');
            return;
        }
        this.newFileVault = vaultId;
        document.getElementById('new-file-modal').classList.remove('hidden');
        document.getElementById('new-file-path').value = prefix;
        document.getElementById('new-file-path').focus();
        document.getElementById('new-file-error').classList.add('hidden');
    }

    hideNewFileModal() {
        document.getElementById('new-file-modal').classList.add('hidden');
    }

    async createNewFile() {
        const input = document.getElementById('new-file-path');
        const error = document.getElementById('new-file-error');
        let path = input.value.trim();

        if (!path) {
            error.textContent = 'Please enter a file path';
            error.classList.remove('hidden');
            return;
        }
        const vaultId = this.newFileVault || this.activeVault;
        const permissions = this.permissionsForVault(vaultId);
        if (!this.getExtension(path)) path += this.defaultCreateExtension(permissions);
        if (!this.canCreatePath(path, permissions)) {
            error.textContent = 'File type is not allowed for this vault';
            error.classList.remove('hidden');
            return;
        }

        try {
            const response = await this.fetchApiForVault('/api/files', vaultId, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: path, content: '' })
            });

            if (response.ok) {
                this.hideNewFileModal();
                this.newFileVault = null;
                await this.openFile(path, { vault: vaultId });
            } else if (response.status === 409) {
                error.textContent = 'File already exists';
                error.classList.remove('hidden');
            } else {
                throw new Error('Create failed');
            }
        } catch (err) {
            error.textContent = 'Failed to create file';
            error.classList.remove('hidden');
        }
    }

    showRenameModal() {
        if (!this.currentFile) return;
        if (!this.canRenamePath(this.currentFile)) {
            this.updateStatus('Rename not allowed');
            return;
        }
        document.getElementById('rename-file-modal').classList.remove('hidden');
        const input = document.getElementById('rename-file-path');
        input.value = this.currentFile;
        input.focus();
        // Select just the filename without extension
        const lastSlash = this.currentFile.lastIndexOf('/');
        const lastDot = this.currentFile.lastIndexOf('.');
        const start = lastSlash !== -1 ? lastSlash + 1 : 0;
        const end = lastDot !== -1 && lastDot > start ? lastDot : this.currentFile.length;
        input.setSelectionRange(start, end);
        document.getElementById('rename-file-error').classList.add('hidden');
    }

    hideRenameModal() {
        document.getElementById('rename-file-modal').classList.add('hidden');
    }

    async executeRename() {
        const input = document.getElementById('rename-file-path');
        const error = document.getElementById('rename-file-error');
        let newPath = input.value.trim();

        if (!newPath || newPath === this.currentFile) {
            this.hideRenameModal();
            return;
        }
        if (!this.getExtension(newPath)) newPath += this.getExtension(this.currentFile) || this.defaultCreateExtension();
        const destinationFormats = [...(this.permissions.files_format_new || []), ...(this.permissions.files_format_edit || [])];
        if (!this.canRenamePath(this.currentFile) || !this.matchesAllowedFormat(newPath, destinationFormats)) {
            error.textContent = 'Destination file type is not allowed';
            error.classList.remove('hidden');
            return;
        }

        try {
            const response = await this.fetchApi('/api/rename', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ old_path: this.currentFile, new_path: newPath })
            });

            if (response.ok) {
                this.hideRenameModal();
                await this.loadFileTree('reader-file-tree');
                await this.loadFileTree('file-tree');
                await this.loadFile(newPath);
            } else {
                const resData = await response.json();
                error.textContent = resData.detail || 'Rename failed';
                error.classList.remove('hidden');
            }
        } catch (err) {
            error.textContent = 'Failed to rename/move file';
            error.classList.remove('hidden');
        }
    }

    async deleteFile(path, vaultId = this.activeVault) {
        const permissions = this.permissionsForVault(vaultId);
        if (!permissions.delete) {
            alert('Delete is not allowed for this vault.');
            return;
        }
        try {
            const res = await this.fetchApiForVault(`/api/file?path=${encodeURIComponent(path)}`, vaultId, { method: 'DELETE' });
            if (res.ok) {
                if (this.currentFile === path) {
                    this.switchView('home');
                }
                this.loadFileTree('file-tree');
                this.loadFileTree('reader-file-tree');
                this.loadRecentFiles();
            } else {
                const resData = await res.json();
                alert('Failed to delete: ' + (resData.detail || 'Unknown error'));
            }
        } catch (e) {
            alert('Failed to delete file.');
        }
    }

    // Config Methods — simplified VS Code / Obsidian model
    populateConfigUI() {
        document.getElementById('config-vault').value = this.activeVault;
        this.normalizeSelectedVaults();
        this.renderVaultOptions();
        document.getElementById('config-theme').value = this.themeConfig.theme || 'light';
        document.getElementById('config-font').value = this.themeConfig.font || 'font-mono-value';
        document.getElementById('config-size').value = this.themeConfig.size || '14px';
        document.getElementById('config-color-bg').value = this.themeConfig.bg || '#ffffff';
        document.getElementById('config-color-body').value = this.themeConfig.body || '#1a1c1c';
        document.getElementById('config-color-sidebar').value = this.themeConfig.sidebar || '#f5f5f5';
        document.getElementById('config-color-accent').value = this.themeConfig.accent || '#ff5c00';
        document.getElementById('config-color-header').value = this.themeConfig.header || '#ff5c00';
        document.getElementById('config-color-codebg').value = this.themeConfig.codebg || '#e4e4e7';
        document.getElementById('config-color-codetext').value = this.themeConfig.codetext || '#e01e5a';
        this.syncPalettePreview();
    }

    async saveConfig() {
        const checkedVaults = [...document.querySelectorAll('input[name="mdvr-vault"]:checked')].map(input => input.value);
        const nextSelected = checkedVaults.length ? checkedVaults : this.getSelectedVaultOptions().map(option => option.id);
        this.saveSelectedVaultIds(nextSelected);
        this.saveVaultAliases();
        if (!this.selectedVaultIds.includes(this.activeVault)) {
            this.activeVault = this.selectedVaultIds[0] || document.getElementById('config-vault').value;
        }
        localStorage.setItem('mdvr_vault', this.activeVault);
        localStorage.setItem('owr_vault', this.activeVault);

        this.themeConfig = {
            theme: document.getElementById('config-theme').value,
            font: document.getElementById('config-font').value,
            size: document.getElementById('config-size').value,
            bg: document.getElementById('config-color-bg').value,
            body: document.getElementById('config-color-body').value,
            sidebar: document.getElementById('config-color-sidebar').value,
            accent: document.getElementById('config-color-accent').value,
            header: document.getElementById('config-color-header').value,
            codebg: document.getElementById('config-color-codebg').value,
            codetext: document.getElementById('config-color-codetext').value
        };
        localStorage.setItem('mdvr_config', JSON.stringify(this.themeConfig));
        localStorage.setItem('owr_config', JSON.stringify(this.themeConfig));
        await this.saveAdminVaultConfigIfDirty();
        await this.loadVaults();
        this.applyConfig();
        await this.loadServerConfig();
    }

    applyThemePreset(theme) {
        // Simplified: bg, body, sidebar, accent, header, codebg, codetext
        const presets = {
            light:     { bg: '#ffffff', body: '#1a1c1c', sidebar: '#f5f5f5', accent: '#ff5c00', header: '#ff5c00', codebg: '#e4e4e7', codetext: '#e01e5a' },
            obsidian:  { bg: '#1e1e1e', body: '#dcddde', sidebar: '#161618', accent: '#7c3aed', header: '#a78bfa', codebg: '#242428', codetext: '#f59e0b' },
            neon:      { bg: '#0a0e12', body: '#66fcf1', sidebar: '#0b0c10', accent: '#ff003c', header: '#ff003c', codebg: '#1f2833', codetext: '#45a29e' },
            vscode:    { bg: '#1e1e1e', body: '#d4d4d4', sidebar: '#252526', accent: '#007acc', header: '#569cd6', codebg: '#2d2d2d', codetext: '#ce9178' },
            github:    { bg: '#ffffff', body: '#24292f', sidebar: '#f6f8fa', accent: '#2da44e', header: '#0969da', codebg: '#f6f8fa', codetext: '#24292f' },
            monokai:   { bg: '#272822', body: '#f8f8f2', sidebar: '#1e1f1c', accent: '#a6e22e', header: '#f92672', codebg: '#3e3d32', codetext: '#e6db74' },
            solarized: { bg: '#002b36', body: '#839496', sidebar: '#00212b', accent: '#b58900', header: '#cb4b16', codebg: '#073642', codetext: '#2aa198' },
            dracula:   { bg: '#282a36', body: '#f8f8f2', sidebar: '#21222c', accent: '#50fa7b', header: '#bd93f9', codebg: '#44475a', codetext: '#f1fa8c' }
        };
        const p = presets[theme];
        if (p) {
            document.getElementById('config-color-bg').value = p.bg;
            document.getElementById('config-color-body').value = p.body;
            document.getElementById('config-color-sidebar').value = p.sidebar;
            document.getElementById('config-color-accent').value = p.accent;
            document.getElementById('config-color-header').value = p.header;
            document.getElementById('config-color-codebg').value = p.codebg;
            document.getElementById('config-color-codetext').value = p.codetext;
            this.syncPalettePreview();
        }
    }

    syncPalettePreview() {
        const preview = document.getElementById('config-palette-preview');
        if (!preview) return;
        const ids = [
            'config-color-bg',
            'config-color-body',
            'config-color-sidebar',
            'config-color-accent',
            'config-color-header',
            'config-color-codebg',
            'config-color-codetext'
        ];
        preview.innerHTML = '';
        ids.forEach(id => {
            const swatch = document.createElement('span');
            swatch.style.background = document.getElementById(id)?.value || 'transparent';
            preview.appendChild(swatch);
        });
    }

    applyConfig() {
        const root = document.documentElement;
        const c = this.themeConfig;
        if (c.bg) root.style.setProperty('--c-bg', c.bg);
        if (c.body) root.style.setProperty('--c-body', c.body);
        if (c.sidebar) root.style.setProperty('--c-sidebar', c.sidebar);
        if (c.accent) root.style.setProperty('--c-accent', c.accent);
        if (c.header) root.style.setProperty('--c-header', c.header);
        if (c.codebg) root.style.setProperty('--c-codebg', c.codebg);
        if (c.codetext) root.style.setProperty('--c-codetext', c.codetext);
        
        if (c.size) {
            root.style.setProperty('--text-size', c.size);
            document.getElementById('editor').style.fontSize = c.size;
            document.getElementById('editor-backdrop').style.fontSize = c.size;
            document.getElementById('preview-pane').style.fontSize = c.size;
        }

        if (c.font) {
            const fontMap = {
                'font-mono-value': '"JetBrains Mono", monospace',
                'font-sans': '"Space Grotesk", sans-serif',
                'font-body': '"Inter", sans-serif',
                'font-mulish': '"Mulish", sans-serif',
                'font-courier': '"Courier New", monospace',
                'font-fira': '"Fira Code", monospace',
                'font-roboto': '"Roboto Mono", monospace'
            };
            const ff = fontMap[c.font];
            if (ff) {
                document.getElementById('editor').style.fontFamily = ff;
                document.getElementById('editor-backdrop').style.fontFamily = ff;
                document.getElementById('preview-pane').style.fontFamily = ff;
            }
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.obsidianReader = new ObsidianReader();
});
