import { Container, Label } from '@playcanvas/pcui';

import { i18n } from './localization';

// open/closed state of every collapsible section and sub-group, per user
const storageKey = 'splatmania.ui.sections';
// sections switched off in the View menu, per user
const offKey = 'splatmania.ui.sections-off';

const loadOff = (): string[] => {
    try {
        const list = JSON.parse(localStorage.getItem(offKey) ?? '[]');
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
};

const off = new Set<string>(loadOff());
const registry = new Map<string, CollapsibleSection[]>();

// is a section shown (View menu)?
const sectionShown = (key: string) => !off.has(key);

const setSectionShown = (key: string, shown: boolean) => {
    if (shown) off.delete(key);
    else off.add(key);
    try {
        localStorage.setItem(offKey, JSON.stringify([...off]));
    } catch {
        // storage unavailable: the choice holds for this session only
    }
    registry.get(key)?.forEach(section => section.class[shown ? 'remove' : 'add']('section-off'));
};

const loadStates = (): Record<string, boolean> => {
    try {
        return JSON.parse(localStorage.getItem(storageKey) ?? '{}') ?? {};
    } catch {
        return {};
    }
};

const saveState = (key: string, open: boolean) => {
    try {
        const states = loadStates();
        states[key] = open;
        localStorage.setItem(storageKey, JSON.stringify(states));
    } catch {
        // storage unavailable (private window etc.): state just doesn't persist
    }
};

type CollapsibleOptions = {
    // storage key of the open state
    key: string,
    // i18n key of the title
    title: string,
    // pc-icon glyph shown before the title
    icon?: string,
    // or an svg icon element
    iconElement?: Element,
    // default when nothing is stored
    open?: boolean,
    // header buttons right of the title (clicks on them don't toggle)
    actions?: HTMLElement[],
    // sub-group look: smaller header, indented body
    sub?: boolean,
    bodyClass?: string
};

/**
 * Uniform collapsible section for the scene panel: header with arrow, title,
 * an optional short info on the right and optional buttons. A click anywhere
 * on the header toggles; the state is stored per section.
 */
class CollapsibleSection extends Container {
    readonly header: Container;
    readonly body: Container;
    private infoLabel: Label;
    private key: string;

    constructor(options: CollapsibleOptions) {
        super({ class: ['collapsible-section', ...(options.sub ? ['collapsible-sub'] : [])] });

        this.key = options.key;

        this.header = new Container({ class: options.sub ? 'collapsible-sub-header' : ['panel-header', 'collapsible-header'] });
        const arrow = new Label({ text: '▸', class: 'collapsible-arrow' });
        this.header.append(arrow);
        if (options.icon !== undefined && !options.sub) {
            this.header.append(new Label({ text: options.icon, class: 'panel-header-icon' }));
        } else if (options.iconElement) {
            const icon = new Label({ class: ['panel-header-icon', 'collapsible-svg-icon'] });
            icon.dom.appendChild(options.iconElement);
            this.header.append(icon);
        }
        const titleLabel = new Label({ class: options.sub ? 'collapsible-sub-label' : 'panel-header-label' });
        i18n.bindText(titleLabel, options.title);
        this.header.append(titleLabel);
        this.infoLabel = new Label({ text: '', class: 'collapsible-info' });
        this.header.append(this.infoLabel);
        options.actions?.forEach((action) => {
            action.addEventListener('click', event => event.stopPropagation());
            this.header.dom.appendChild(action);
        });

        this.body = new Container({ class: ['collapsible-body', ...(options.bodyClass ? [options.bodyClass] : [])] });

        this.append(this.header);
        this.append(this.body);

        // the header acts as a button, also from the keyboard
        this.header.dom.setAttribute('role', 'button');
        this.header.dom.setAttribute('tabindex', '0');
        this.header.dom.addEventListener('click', () => this.setOpen(!this.open, true));
        this.header.dom.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.setOpen(!this.open, true);
            }
        });

        this.setOpen(loadStates()[this.key] ?? options.open ?? false, false);

        if (!options.sub) {
            registry.set(this.key, [...(registry.get(this.key) ?? []), this]);
            if (off.has(this.key)) this.class.add('section-off');
        }
    }

    get open() {
        return this.class.contains('open');
    }

    setOpen(open: boolean, store: boolean) {
        this.class[open ? 'add' : 'remove']('open');
        this.body.hidden = !open;
        this.header.dom.setAttribute('aria-expanded', String(open));
        if (store) saveState(this.key, open);
    }

    // short info right in the header, e.g. "3 Keys"
    setInfo(text: string) {
        this.infoLabel.text = text;
    }
}

// "Erweitert" sub-group for rarely used parameters, closed by default;
// returns its body
const advancedGroup = (parent: Container, key: string, title = 'sm.common.advanced') => {
    const group = new CollapsibleSection({ key, title, sub: true });
    parent.append(group);
    return group.body;
};

export { CollapsibleSection, advancedGroup, sectionShown, setSectionShown };
