import { Container } from '@playcanvas/pcui';

import { i18n } from './localization';

// position and minimized state of the floating viewport panels, per user
const storageKey = 'splatmania.ui.floating';

type FloatingState = { x?: number, y?: number, collapsed?: boolean };

const loadStates = (): Record<string, FloatingState> => {
    try {
        return JSON.parse(localStorage.getItem(storageKey) ?? '{}') ?? {};
    } catch {
        return {};
    }
};

const saveState = (key: string, state: FloatingState) => {
    try {
        const states = loadStates();
        states[key] = state;
        localStorage.setItem(storageKey, JSON.stringify(states));
    } catch {
        // storage unavailable: position just doesn't persist
    }
};

type FloatingOptions = {
    key: string,
    // i18n key of the title
    title: string,
    // controls kept in the title bar (stay visible when minimized)
    extras?: HTMLElement[]
};

/**
 * Turns an absolutely positioned overlay panel into a floating window: a title
 * bar to drag it by (always kept inside the viewport, also after a resize), a
 * minimize button that folds it to the title bar, and a stored position and
 * state. Double-clicking the title bar puts it back to its default place.
 * Returns setInfo for a short text in the title bar (e.g. "0–3 m").
 */
const makeFloating = (panel: Container, options: FloatingOptions) => {
    const dom = panel.dom;
    const state: FloatingState = { ...loadStates()[options.key] };

    const header = document.createElement('div');
    header.classList.add('floating-header');
    const toggle = document.createElement('span');
    toggle.classList.add('floating-toggle');
    i18n.bindDom(toggle, 'sm.floating.toggle', 'title');
    const title = document.createElement('span');
    title.classList.add('floating-title');
    i18n.bindDom(title, options.title);
    const info = document.createElement('span');
    info.classList.add('floating-info');
    header.append(toggle, title, info);
    options.extras?.forEach((extra) => {
        extra.classList.add('floating-extra');
        header.appendChild(extra);
    });
    i18n.bindDom(header, 'sm.floating.header', 'title');
    dom.classList.add('floating-panel');
    dom.insertBefore(header, dom.firstChild);

    const setCollapsed = (collapsed: boolean) => {
        dom.classList.toggle('floating-collapsed', collapsed);
        toggle.textContent = collapsed ? '▸' : '▾';
    };
    setCollapsed(!!state.collapsed);

    const parentRect = () => (dom.offsetParent as HTMLElement | null)?.getBoundingClientRect() ?? null;

    // a resize of the viewport or of the panel (shown, collapsed, grown)
    // re-clamps it. Hidden panels have no offset parent yet, so the viewport
    // is observed once the panel first shows
    let parentObserved = false;
    const observer = new ResizeObserver(() => clamp());

    // keep the whole panel inside its container (the viewport)
    function clamp() {
        if (!parentObserved && dom.offsetParent) {
            parentObserved = true;
            observer.observe(dom.offsetParent);
        }
        if (state.x === undefined || state.y === undefined) return;
        const parent = parentRect();
        if (!parent || dom.offsetWidth === 0) return;
        const x = Math.max(0, Math.min(state.x, parent.width - dom.offsetWidth));
        const y = Math.max(0, Math.min(state.y, parent.height - dom.offsetHeight));
        dom.style.left = `${x}px`;
        dom.style.top = `${y}px`;
        dom.style.right = 'auto';
        dom.style.transform = 'none';
    }

    const reset = () => {
        delete state.x;
        delete state.y;
        dom.style.left = dom.style.top = dom.style.right = dom.style.transform = '';
        saveState(options.key, state);
    };

    toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        state.collapsed = !dom.classList.contains('floating-collapsed');
        setCollapsed(state.collapsed);
        saveState(options.key, state);
        clamp();
    });

    // drag by the title bar (not by its controls)
    let drag: { dx: number, dy: number, id: number } | null = null;
    header.addEventListener('pointerdown', (event: PointerEvent) => {
        if (event.button !== 0 || event.target !== header && event.target !== title && event.target !== info) return;
        const rect = dom.getBoundingClientRect();
        drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, id: event.pointerId };
        header.setPointerCapture(event.pointerId);
        header.classList.add('dragging');
        event.preventDefault();
    });
    header.addEventListener('pointermove', (event: PointerEvent) => {
        if (!drag || event.pointerId !== drag.id) return;
        const parent = parentRect();
        if (!parent) return;
        state.x = event.clientX - parent.left - drag.dx;
        state.y = event.clientY - parent.top - drag.dy;
        clamp();
    });
    const endDrag = (event: PointerEvent) => {
        if (!drag || event.pointerId !== drag.id) return;
        drag = null;
        header.classList.remove('dragging');
        header.releasePointerCapture(event.pointerId);
        // store what the clamp actually allowed
        state.x = parseFloat(dom.style.left) || 0;
        state.y = parseFloat(dom.style.top) || 0;
        saveState(options.key, state);
    };
    header.addEventListener('pointerup', endDrag);
    header.addEventListener('pointercancel', endDrag);
    header.addEventListener('dblclick', (event) => {
        if (event.target === header || event.target === title || event.target === info) reset();
    });

    // restore the stored position right away (the clamp needs a layout,
    // which may come later)
    if (state.x !== undefined && state.y !== undefined) {
        dom.style.left = `${state.x}px`;
        dom.style.top = `${state.y}px`;
        dom.style.right = 'auto';
        dom.style.transform = 'none';
    }
    observer.observe(dom);
    window.addEventListener('resize', () => clamp());
    requestAnimationFrame(clamp);

    return {
        setInfo: (text: string) => {
            info.textContent = text;
        }
    };
};

export { makeFloating };
