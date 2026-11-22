import { Container, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { i18n } from './localization';

// In-app help for the Splatmania tools: a "?" button in every tool panel opens
// a short step-by-step guide for that tool; Help > "Splatmania tools explained"
// opens the overview. Texts live in the locales under sm.help.<topic>.*
// (title, intro, steps and tips; steps and tips are lines separated by "\n").

const HELP_TOPICS = [
    'aiShots',
    'cameras',
    'export',
    'look',
    'titles',
    'light',
    'layerAnim',
    'transitions',
    'pointCloud',
    'cleanup',
    'depthFilter',
    'align',
    'compose',
    'quality',
    'section'
] as const;

type HelpTopic = typeof HELP_TOPICS[number];

// a missing key comes back as the key itself
const lines = (key: string) => {
    const text = i18n.t(key);
    if (!text || text === key) return [];
    return text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
};

class HelpPopup extends Container {
    private body: Container;

    private titleLabel: Label;

    private backButton: Label;

    private topic: HelpTopic | null = null;

    constructor() {
        super({
            id: 'help-popup',
            class: 'blocks-shortcuts',
            hidden: true,
            tabIndex: -1
        });

        // keep the editor shortcuts out while the help is open
        this.dom.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape') this.hidden = true;
            e.stopPropagation();
        });
        this.on('click', () => {
            this.hidden = true;
        });

        const dialog = new Container({ class: 'help-dialog' });
        dialog.on('click', (event: MouseEvent) => event.stopPropagation());

        const header = new Container({ class: 'help-header' });
        this.backButton = new Label({ class: 'help-back' });
        this.backButton.dom.setAttribute('role', 'button');
        i18n.bindText(this.backButton, () => `‹ ${i18n.t('sm.help.all-tools')}`);
        this.backButton.on('click', () => this.show());
        this.titleLabel = new Label({ class: 'help-title' });
        const close = new Label({ class: 'help-close', text: '✕' });
        close.dom.setAttribute('role', 'button');
        i18n.bindDom(close.dom, 'sm.help.close', 'title');
        close.on('click', () => {
            this.hidden = true;
        });
        header.append(this.backButton);
        header.append(this.titleLabel);
        header.append(close);

        this.body = new Container({ class: 'help-body' });

        dialog.append(header);
        dialog.append(this.body);
        this.append(dialog);

        i18n.onChange(() => {
            if (!this.hidden) this.render();
        }, this);
    }

    show(topic?: HelpTopic) {
        this.topic = topic && HELP_TOPICS.includes(topic) ? topic : null;
        this.render();
        this.hidden = false;
    }

    private render() {
        this.body.clear();
        this.body.dom.scrollTop = 0;
        const { topic } = this;
        this.backButton.hidden = !topic;

        if (!topic) {
            this.titleLabel.text = i18n.t('sm.help._overview.title');
            this.addText('help-intro', i18n.t('sm.help._overview.intro'));
            const list = new Container({ class: 'help-topics' });
            for (const id of HELP_TOPICS) {
                const item = new Container({ class: 'help-topic' });
                item.dom.setAttribute('role', 'button');
                item.dom.tabIndex = 0;
                const name = new Label({ class: 'help-topic-title', text: i18n.t(`sm.help.${id}.title`) });
                const intro = new Label({ class: 'help-topic-intro', text: i18n.t(`sm.help.${id}.intro`) });
                item.append(name);
                item.append(intro);
                item.on('click', () => this.show(id));
                item.dom.addEventListener('keydown', (e: KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === ' ') this.show(id);
                });
                list.append(item);
            }
            this.body.append(list);
            return;
        }

        const base = `sm.help.${topic}`;
        this.titleLabel.text = i18n.t(`${base}.title`);
        this.addText('help-intro', i18n.t(`${base}.intro`));

        const steps = lines(`${base}.steps`);
        if (steps.length) {
            this.addText('help-heading', i18n.t('sm.help.steps'));
            const ol = document.createElement('ol');
            ol.classList.add('help-steps');
            for (const step of steps) {
                const li = document.createElement('li');
                li.textContent = step;
                ol.appendChild(li);
            }
            this.body.dom.appendChild(ol);
        }

        const tips = lines(`${base}.tips`);
        if (tips.length) {
            this.addText('help-heading', i18n.t('sm.help.tips'));
            const ul = document.createElement('ul');
            ul.classList.add('help-tips');
            for (const tip of tips) {
                const li = document.createElement('li');
                li.textContent = tip;
                ul.appendChild(li);
            }
            this.body.dom.appendChild(ul);
        }
    }

    private addText(cls: string, text: string) {
        if (!text) return;
        this.body.append(new Label({ class: cls, text }));
    }

    set hidden(value: boolean) {
        super.hidden = value;
        if (!value) this.dom.focus();
    }

    get hidden(): boolean {
        return super.hidden;
    }
}

// small "?" button for panel headers; clicks don't reach the header
// (dragging, collapsing)
const helpButton = (events: Events, topic: HelpTopic) => {
    const button = document.createElement('span');
    button.classList.add('help-button');
    button.textContent = '?';
    button.setAttribute('role', 'button');
    button.tabIndex = 0;
    i18n.bindDom(button, 'sm.help.button', 'title');
    const open = (e: Event) => {
        e.stopPropagation();
        e.preventDefault();
        events.fire('help.show', topic);
    };
    button.addEventListener('pointerdown', e => e.stopPropagation());
    button.addEventListener('mousedown', e => e.stopPropagation());
    button.addEventListener('dblclick', e => e.stopPropagation());
    button.addEventListener('click', open);
    button.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') open(e);
    });
    return button;
};

const registerHelp = (events: Events, parent: Container) => {
    const popup = new HelpPopup();
    parent.append(popup);
    events.on('help.show', (topic?: HelpTopic) => popup.show(topic));
};

export { HELP_TOPICS, type HelpTopic, helpButton, registerHelp };
