class ObsidianReader {
    constructor() {
        this.currentFile = null;
        this.isDirty = false;
        this.expandedFolders = new Set();
        this.viewMode = 'home'; // home, reader
        this.previewEnabled = true;
        this.activeVault = localStorage.getItem('owr_vault') || '';
        this.themeConfig = JSON.parse(localStorage.getItem('owr_config') || '{}');
        this.appTitle = 'OWS Obsidian Web Reader';
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
        await this.loadVaultName();
        if (deepLink.path) {
            await this.openDeepLink(deepLink.path);
        } else {
            await this.switchView('home');
            this.updateUrlForFile(null, { replace: true });
        }
        this.setupAutoSave();
        this.connectWebSocket();
    }

    getDeepLink() {
        const params = new URLSearchParams(window.location.search);
        let path = (params.get('path') || params.get('file') || params.get('note') || '').trim();
        const vaultParam = params.has('vault') ? (params.get('vault') || '').trim() : null;
        const vault = vaultParam === null ? null : (vaultParam === '/' ? '' : vaultParam.replace(/^\/+|\/+$/g, ''));

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
                    path = pathname === 'obsidian' ? '' : pathname.slice(prefix.length);
                    try {
                        path = decodeURIComponent(path);
                    } catch (_) {}
                }
            }
        }

        return { path: path.replace(/^\/+/, ''), vault };
    }

    async openDeepLink(path) {
        await this.switchView('reader');
        await this.loadFile(path, { replaceUrl: true });
    }

    encodePathSegments(path) {
        return path
            .split('/')
            .filter(Boolean)
            .map(segment => encodeURIComponent(segment))
            .join('/');
    }

    getDeepLinkUrl(path) {
        // Canonical deep link: /obsidian/Research/note.md, optionally with ?vault=Work.
        const url = new URL(window.location.origin);
        url.pathname = `/obsidian/${this.encodePathSegments(path)}`;
        if (this.activeVault) url.searchParams.set('vault', this.activeVault);
        return url.toString();
    }

    isVisibleFile(path) {
        const lowerPath = (path || '').toLowerCase();
        return lowerPath.endsWith('.md') || lowerPath.endsWith('.canvas');
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
    }

    updateUrlForFile(path, options = {}) {
        const url = path
            ? this.getDeepLinkUrl(path)
            : (window.location.pathname.startsWith('/obsidian/') ? '/obsidian/' : '/');
        const method = options.replace ? 'replaceState' : 'pushState';
        window.history[method]({}, '', url);
    }

    setupViewportHeight() {
        const setVh = () => {
            document.documentElement.style.setProperty('--vh', `${window.innerHeight}px`);
        };
        setVh();
        window.addEventListener('resize', setVh);
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
                        this.loadFile(this.currentFile);
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
        options.headers = Object.assign({}, options.headers || {}, {
            'X-Vault-Path': this.activeVault
        });
        return fetch(url, options);
    }

    bindEvents() {
        // Return to home via home button
        document.getElementById('sidebar-home-btn').addEventListener('click', () => {
            document.getElementById('reader-sidebar').classList.add('-translate-x-full');
            document.getElementById('sidebar-overlay').classList.add('hidden');
            this.switchView('home');
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

        // Config buttons
        const showConfig = async () => {
            document.getElementById('reader-sidebar').classList.add('-translate-x-full');
            document.getElementById('sidebar-overlay').classList.add('hidden');
            this.switchView('config');
            this.populateConfigUI();
        };
        document.getElementById('header-config-btn').addEventListener('click', showConfig);
        document.getElementById('sidebar-config-btn').addEventListener('click', showConfig);

        document.getElementById('config-cancel-btn').addEventListener('click', () => {
            this.switchView('home');
            this.updateUrlForFile(null);
        });
        document.getElementById('config-save-btn').addEventListener('click', () => {
            this.saveConfig();
            this.switchView('home');
            this.updateUrlForFile(null);
            // Reload all content to reflect new vault
            this.loadVaultName();
            this.loadRecentFiles();
            this.loadFileTree('file-tree');
        });

        // Theme presets
        document.getElementById('config-theme').addEventListener('change', (e) => this.applyThemePreset(e.target.value));

        document.getElementById('sidebar-overlay').addEventListener('click', () => {
            document.getElementById('reader-sidebar').classList.add('-translate-x-full');
            document.getElementById('sidebar-overlay').classList.add('hidden');
        });

        // Click on reading area to hide sidebar
        document.getElementById('reading-area').addEventListener('click', () => {
            const sidebar = document.getElementById('reader-sidebar');
            if (!sidebar.classList.contains('-translate-x-full')) {
                sidebar.classList.add('-translate-x-full');
                document.getElementById('sidebar-overlay').classList.add('hidden');
            }
        });

        // Search in Home
        document.getElementById('home-search').addEventListener('input', (e) => {
            this.filterFiles(e.target.value, 'recent-files-grid');
            this.filterFiles(e.target.value, 'file-tree');
        });
        
        // Search in Sidebar
        document.getElementById('sidebar-search').addEventListener('input', (e) => {
            this.filterFiles(e.target.value, 'reader-file-tree');
        });

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
        });
        document.getElementById('cm-open').addEventListener('click', () => {
            if (this.contextMenuPath) {
                this.switchView('reader');
                this.loadFile(this.contextMenuPath);
            }
        });
        document.getElementById('cm-rename').addEventListener('click', () => {
            if (this.contextMenuPath) {
                this.currentFile = this.contextMenuPath;
                this.showRenameModal();
            }
        });
        document.getElementById('cm-new-here').addEventListener('click', () => {
            if (this.contextMenuPath) {
                let folder = this.contextMenuPath;
                // If it's a file, use its parent folder
                if (folder.includes('.')) folder = folder.substring(0, folder.lastIndexOf('/')) || '';
                this.showNewFileModal(folder ? folder + '/' : '');
            }
        });
        document.getElementById('cm-delete').addEventListener('click', () => {
            if (this.contextMenuPath && confirm(`Delete ${this.contextMenuPath}?`)) {
                this.deleteFile(this.contextMenuPath);
            }
        });
        
        // Editor
        const editor = document.getElementById('editor');
        const backdrop = document.getElementById('editor-backdrop');
        
        editor.addEventListener('input', () => {
            this.setDirty(true);
            this.updateHighlighting();
            if (this.previewEnabled) this.updatePreview();
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
        
        if (view === 'reader') {
            menuBtn.classList.remove('hidden');
            previewBtn.classList.remove('hidden');
            configBtn.classList.add('hidden');
            document.getElementById('header-datetime').classList.remove('hidden');
            await this.loadFileTree('reader-file-tree');
        } else {
            menuBtn.classList.add('hidden');
            previewBtn.classList.add('hidden');
            document.getElementById('header-datetime').classList.add('hidden');
            if (view === 'home') {
                configBtn.classList.remove('hidden');
                await Promise.all([
                    this.loadRecentFiles(),
                    this.loadFileTree('file-tree')
                ]);
            } else if (view === 'config') {
                configBtn.classList.add('hidden');
            }
            document.getElementById('header-title').textContent = `${this.appTitle} - ${this.vaultName || 'Vault'}`;
            document.getElementById('header-title').title = this.appTitle;
            document.title = this.appTitle;
        }
    }

    async loadVaults() {
        try {
            const res = await this.fetchApi('/api/vaults');
            const data = await res.json();
            const select = document.getElementById('config-vault');
            select.innerHTML = '';
            data.vaults.forEach(v => {
                const opt = document.createElement('option');
                opt.value = v;
                opt.textContent = v === '/' ? 'Root (Vault)' : v;
                select.appendChild(opt);
            });
        } catch(e) {}
    }

    async loadVaultName() {
        try {
            const response = await this.fetchApi('/api/vault-name');
            const data = await response.json();
            this.vaultName = data.name;
            document.getElementById('header-title').textContent = `${this.appTitle} - ${this.vaultName}`;
            document.getElementById('header-title').title = this.appTitle;
        } catch (error) {
            console.error('Failed to load vault name:', error);
            this.vaultName = 'Obsidian Vault';
        }
    }

    async loadRecentFiles() {
        try {
            const response = await this.fetchApi('/api/recent');
            const data = await response.json();
            const grid = document.getElementById('recent-files-grid');
            grid.innerHTML = '';

            data.files
                .filter(file => this.isVisibleFile(file.path))
                .slice(0, 5)
                .forEach(file => {
                const date = new Date(file.mtime * 1000);
                const dateStr = date.toISOString().split('T')[0];
                const timeStr = date.toTimeString().split(' ')[0].substring(0, 5);
                const title = file.name.replace(/\.(md|canvas)$/i, '');
                
                const folderPath = file.path.substring(0, file.path.lastIndexOf('/'));

                const card = document.createElement('div');
                card.className = 'border border-outline-variant p-3 hover:opacity-90 transition-colors cursor-pointer file-card shadow-sm rounded-sm mechanical-button h-28 flex flex-col';
                card.style.backgroundColor = 'var(--c-sidebar)';
                card.dataset.path = file.path;
                
                const inner = document.createElement('div');
                inner.className = 'flex-grow flex flex-col overflow-hidden';
                
                // Row 1: Title (left) + Timestamp (right)
                const topRow = document.createElement('div');
                topRow.className = 'flex items-center justify-between gap-2 mb-1';
                const h3 = document.createElement('h3');
                h3.className = 'font-mono-value font-bold text-sm truncate';
                h3.style.color = 'var(--c-body)';
                h3.textContent = title;
                const ts = document.createElement('span');
                ts.className = 'font-mono-label text-[9px] flex-shrink-0 opacity-50';
                ts.style.color = 'var(--c-body)';
                ts.textContent = `${dateStr} ${timeStr}`;
                topRow.appendChild(h3);
                topRow.appendChild(ts);
                inner.appendChild(topRow);
                
                // Row 2: Path
                if (folderPath) {
                    const fp = document.createElement('div');
                    fp.className = 'font-mono-label text-[9px] uppercase mb-1 truncate';
                    fp.style.color = 'var(--c-accent)';
                    fp.textContent = folderPath;
                    inner.appendChild(fp);
                }
                
                // Row 3: Excerpt
                const p = document.createElement('p');
                p.className = 'font-body text-xs mt-1 line-clamp-2 leading-snug break-words whitespace-normal opacity-60';
                p.style.color = 'var(--c-body)';
                p.textContent = file.excerpt || '';
                inner.appendChild(p);
                
                card.appendChild(inner);
                card.addEventListener('click', () => {
                    this.switchView('reader');
                    this.loadFile(file.path);
                });
                grid.appendChild(card);
            });
        } catch (error) {
            console.error('Failed to load recent files:', error);
            this.updateStatus('Failed to load recent files');
        }
    }

    async loadFileTree(containerId) {
        try {
            const response = await this.fetchApi('/api/files');
            const data = await response.json();
            this.renderFileTree(data.files, document.getElementById(containerId));
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

            const fileElement = document.createElement('div');
            fileElement.className = `file-item ${file.is_dir ? 'folder' : 'file'}`;
            fileElement.dataset.path = file.path;

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
                fileName.title = file.path;
                fileName.textContent = file.name;
                fileElement.appendChild(fileIcon);
                fileElement.appendChild(fileName);
                fileElement.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.switchView('reader');
                    this.loadFile(file.path);
                    
                    const sidebar = document.getElementById('reader-sidebar');
                    if (!sidebar.classList.contains('-translate-x-full')) {
                        sidebar.classList.add('-translate-x-full');
                        document.getElementById('sidebar-overlay').classList.add('hidden');
                    }
                });
            }

            // Context menu — right-click (desktop) + long press (mobile)
            const showCtx = (x, y) => {
                this.contextMenuPath = file.path;
                this.contextMenuIsDir = file.is_dir;
                const menu = document.getElementById('context-menu');
                menu.style.left = `${x}px`;
                menu.style.top = `${y}px`;
                menu.classList.remove('hidden');
            };
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
            document.querySelectorAll(`.file-item[data-path="${CSS.escape(this.currentFile)}"]`).forEach(el => el.classList.add('selected'));
        }
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
        }
    }

    filterFiles(query, containerId) {
        query = query.toLowerCase();
        if (containerId === 'recent-files-grid') {
            const cards = document.querySelectorAll('.file-card');
            cards.forEach(card => {
                const name = card.querySelector('h3').textContent.toLowerCase();
                if (name.includes(query)) card.style.display = '';
                else card.style.display = 'none';
            });
        } else {
            const container = document.getElementById(containerId);
            if (!container) return;
            const fileItems = container.querySelectorAll('.file-item');
            
            fileItems.forEach(item => {
                const fileName = item.textContent.toLowerCase();
                if (query === '' || fileName.includes(query)) {
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

                    let parent = item.parentElement;
                    while (parent && parent.classList.contains('folder-children')) {
                        parent.classList.remove('hidden');
                        parent = parent.parentElement;
                        if (parent && parent.classList.contains('file-item')) {
                            const icon = parent.querySelector('.folder-icon');
                            if (icon) {
                                icon.textContent = '▼';
                                this.expandedFolders.add(parent.dataset.path);
                            }
                        }
                    }
                } else {
                    item.style.display = 'none';
                }
            });

            container.querySelectorAll('.folder-children').forEach(cont => {
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
            
            document.getElementById('editor').value = data.content;
            this.currentFile = path;
            this.previewEnabled = true;
            this.setDirty(false);
            this.updateHighlighting();
            this.syncPreviewMode();
            this.updatePreview();
            
            const title = document.getElementById('header-title');
            title.textContent = path;
            title.title = `Click to rename ${path}`;
            document.title = `${path} - ${this.appTitle}`;
            this.updateUrlForFile(path, { replace: options.replaceUrl === true });
            
            document.querySelectorAll('.file-item').forEach(item => item.classList.remove('selected'));
            document.querySelectorAll(`.file-item[data-path="${CSS.escape(path)}"]`).forEach(el => el.classList.add('selected'));
            
            // Populate Header Datetime
            const dtEl = document.getElementById('header-datetime');
            if (data.mtime && dtEl) {
                const date = new Date(data.mtime * 1000);
                const dtStr = date.toISOString().split('T')[0] + ' ' + date.toTimeString().split(' ')[0].substring(0, 5);
                dtEl.textContent = dtStr;
            }
            
        } catch (error) {
            console.error('Failed to load file:', error);
            this.updateStatus('Failed to load ' + path);
            const title = document.getElementById('header-title');
            title.textContent = path;
            title.title = `Failed to load ${path}`;
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
        try {
            const content = document.getElementById('editor').value;
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
        const ind = document.getElementById('save-indicator');
        if (dirty) {
            ind.classList.remove('hidden');
            ind.textContent = '[MODIFIED]';
        } else {
            ind.textContent = '[SAVED]';
            setTimeout(() => { if (!this.isDirty) ind.classList.add('hidden'); }, 2000);
        }
    }

    updateStatus(text) {
        const statusElement = document.getElementById('header-status');
        if (!statusElement) return;
        statusElement.textContent = text;
        setTimeout(() => { statusElement.textContent = ''; }, 3000);
    }

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
            previewPane.innerHTML = this.parseMarkdown(content);
        } catch (e) {
            previewPane.innerHTML = '<pre>' + this.escapeHtml(content) + '</pre>';
        }
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
        text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, href) => {
            const safeHref = href.replace(/["'<>]/g, '');
            if (safeHref.startsWith('javascript:')) return this.escapeHtml(match);
            return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${label}</a>`;
        });
        return text;
    }

    escapeHtml(text) {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    showNewFileModal(prefix = '') {
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
        if (!/\.(md|canvas)$/i.test(path)) path += '.md';

        try {
            const response = await this.fetchApi('/api/files', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: path, content: '' })
            });

            if (response.ok) {
                this.hideNewFileModal();
                this.switchView('reader');
                await this.loadFileTree('reader-file-tree');
                await this.loadFile(path);
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
        if (!/\.(md|canvas)$/i.test(newPath)) newPath += '.md';

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

    async deleteFile(path) {
        try {
            const res = await this.fetchApi(`/api/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
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
    }

    saveConfig() {
        this.activeVault = document.getElementById('config-vault').value;
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
        localStorage.setItem('owr_config', JSON.stringify(this.themeConfig));
        this.applyConfig();
    }

    applyThemePreset(theme) {
        // Simplified: bg, body, sidebar, accent, header, codebg, codetext
        const presets = {
            light:     { bg: '#ffffff', body: '#1a1c1c', sidebar: '#f5f5f5', accent: '#ff5c00', header: '#ff5c00', codebg: '#e4e4e7', codetext: '#e01e5a' },
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
        }
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
