import React from 'https://esm.sh/react@18.3.1';
import { createRoot } from 'https://esm.sh/react-dom@18.3.1/client';
import { Excalidraw, restore, serializeAsJSON } from 'https://esm.sh/@excalidraw/excalidraw@0.18.1?deps=react@18.3.1,react-dom@18.3.1';

const SOURCE = 'mdvr';
const ROOTS = new WeakMap();
const DEFAULT_SCENE = Object.freeze({
    type: 'excalidraw',
    version: 2,
    source: SOURCE,
    elements: [],
    appState: {
        viewBackgroundColor: null,
    },
    files: {},
});

function cloneDefaultScene() {
    return {
        type: DEFAULT_SCENE.type,
        version: DEFAULT_SCENE.version,
        source: DEFAULT_SCENE.source,
        elements: [],
        appState: { ...DEFAULT_SCENE.appState },
        files: {},
    };
}

function sanitizeAppState(appState) {
    const next = appState && typeof appState === 'object' ? { ...appState } : {};
    delete next.collaborators;
    return next;
}

export function parseExcalidrawScene(content) {
    if (!content || !String(content).trim()) {
        return cloneDefaultScene();
    }

    try {
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === 'object') {
            const restored = restore({
                elements: Array.isArray(parsed.elements) ? parsed.elements : [],
                appState: parsed.appState && typeof parsed.appState === 'object' ? parsed.appState : {},
                files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {},
            }, null, null);
            return {
                type: parsed.type || 'excalidraw',
                version: parsed.version || 2,
                source: parsed.source || SOURCE,
                elements: restored.elements,
                appState: sanitizeAppState(restored.appState),
                files: restored.files,
                libraryItems: Array.isArray(parsed.libraryItems) ? parsed.libraryItems : undefined,
                scrollToContent: parsed.scrollToContent,
            };
        }
    } catch (_) {}

    return cloneDefaultScene();
}

export function mountExcalidraw(container, options = {}) {
    if (!container) {
        throw new Error('Excalidraw container is missing');
    }

    const existing = ROOTS.get(container);
    if (existing) {
        existing.root.unmount();
        ROOTS.delete(container);
    }

    const root = createRoot(container);
    const state = {
        scene: parseExcalidrawScene(options.content || ''),
        api: null,
    };

    const handleChange = (elements, appState, files) => {
        const sanitizedAppState = sanitizeAppState(appState);
        state.scene = {
            type: 'excalidraw',
            version: 2,
            source: SOURCE,
            elements,
            appState: sanitizedAppState,
            files,
        };
        if (typeof options.onChange === 'function') {
            options.onChange(state.scene);
        }
    };

    const handleApi = (api) => {
        state.api = api;
        if (typeof options.onApi === 'function') {
            options.onApi(api);
        }
    };

    root.render(
        React.createElement(Excalidraw, {
            initialData: state.scene,
            excalidrawAPI: handleApi,
            onChange: handleChange,
            theme: options.theme || 'light',
            name: options.name || 'OWR Excalidraw',
        })
    );

    const bridge = {
        getScene() {
            return state.scene;
        },
        getAPI() {
            return state.api;
        },
        serialize() {
            const appState = sanitizeAppState(state.scene.appState);
            return serializeAsJSON(
                Array.isArray(state.scene.elements) ? state.scene.elements : [],
                appState,
                state.scene.files && typeof state.scene.files === 'object' ? state.scene.files : {},
                'local'
            );
        },
        destroy() {
            root.unmount();
            ROOTS.delete(container);
        },
    };

    ROOTS.set(container, { root, bridge });
    return bridge;
}

export function unmountExcalidraw(container) {
    const existing = ROOTS.get(container);
    if (!existing) return;
    existing.root.unmount();
    ROOTS.delete(container);
}
