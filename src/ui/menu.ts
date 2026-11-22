import { Container, Element, Label } from '@playcanvas/pcui';

import { Events } from '../events';
import { ExportChoices } from '../export-options';
import { requestNavigateHome } from '../iframe-api';
import { recentFiles, recentImports, RecentStore } from '../recent-files';
import { ShortcutManager } from '../shortcut-manager';
import { sectionShown, setSectionShown } from './collapsible';
import { i18n } from './localization';
import { MenuPanel, MenuItem } from './menu-panel';
import arrowSvg from './svg/arrow.svg';
import collapseSvg from './svg/collapse.svg';
import selectDelete from './svg/delete.svg';
import editRedo from './svg/edit-redo.svg';
import editUndo from './svg/edit-undo.svg';
import sceneExport from './svg/export.svg';
import sceneImport from './svg/import.svg';
import logoSvg from './svg/logo.svg';
import sceneNew from './svg/new.svg';
import sceneOpen from './svg/open.svg';
import scenePublish from './svg/publish.svg';
import sceneSave from './svg/save.svg';
import selectAll from './svg/select-all.svg';
import selectDuplicate from './svg/select-duplicate.svg';
import selectInverse from './svg/select-inverse.svg';
import selectLock from './svg/select-lock.svg';
import selectNone from './svg/select-none.svg';
import selectSeparate from './svg/select-separate.svg';
import selectUnlock from './svg/select-unlock.svg';

const createSvg = (svgString: string) => {
    const decodedStr = decodeURIComponent(svgString.substring('data:image/svg+xml,'.length));
    return new Element({
        dom: new DOMParser().parseFromString(decodedStr, 'image/svg+xml').documentElement
    });
};

// Rebuild a recent-entries submenu (one row per entry, then a clear action)
// when its parent menu opens. Returns whether there are any entries.
const refreshRecentMenu = async <T extends { name: string }>(panel: MenuPanel, store: RecentStore<T & { date: number }>, onSelect: (entry: T) => void, clearKey: string) => {
    try {
        const entries = await store.get();
        const items: MenuItem[] = entries.map((entry) => {
            return {
                text: entry.name,
                onSelect: () => onSelect(entry)
            };
        });

        if (items.length > 0) {
            items.push({}); // separator
            items.push({
                text: () => i18n.t(clearKey),
                icon: createSvg(selectDelete),
                onSelect: () => store.clear()
            });
        }

        panel.setItems(items);
        return items.length > 0;
    } catch (error) {
        console.error('Failed to load recent files:', error);
        return false;
    }
};

// roll-over explanations for menu rows, by item index (a panel has one row
// per item, separators included)
const tipRows = (panel: MenuPanel, tips: Record<number, string>) => {
    Object.entries(tips).forEach(([index, key]) => {
        i18n.bindDom(panel.dom.children.item(Number(index)) as HTMLElement, key, 'title');
    });
};

// publishing uploads to the PlayCanvas cloud and needs its login, which only
// exists on playcanvas.com - a local or installed editor hides the entry
const canPublish = () => /(?:^|\.)playcanvas\.com$/.test(location.hostname);

class Menu extends Container {
    constructor(events: Events, args = {}) {
        args = {
            ...args,
            id: 'menu'
        };

        super(args);

        const menubar = new Container({
            id: 'menu-bar'
        });

        menubar.dom.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });

        const scene = new Label({
            class: 'menu-option'
        });
        i18n.bindText(scene, 'menu.file');

        const edit = new Label({
            class: 'menu-option'
        });
        i18n.bindText(edit, 'menu.edit');

        const render = new Label({
            class: 'menu-option'
        });
        i18n.bindText(render, 'menu.render');

        const selection = new Label({
            class: 'menu-option'
        });
        i18n.bindText(selection, 'menu.select');

        const view = new Label({
            class: 'menu-option'
        });
        i18n.bindText(view, 'menu.view');

        const help = new Label({
            class: 'menu-option'
        });
        i18n.bindText(help, 'menu.help');

        const toggleCollapsed = () => {
            document.body.classList.toggle('collapsed');
        };

        // collapse menu on mobile
        if (document.body.clientWidth < 600) {
            toggleCollapsed();
        }

        const collapse = createSvg(collapseSvg);
        collapse.dom.classList.add('menu-icon');
        collapse.dom.setAttribute('id', 'menu-collapse');
        collapse.dom.addEventListener('click', toggleCollapsed);

        const arrow = createSvg(arrowSvg);
        arrow.dom.classList.add('menu-icon');
        arrow.dom.setAttribute('id', 'menu-arrow');
        arrow.dom.addEventListener('click', toggleCollapsed);
        i18n.bindDom(collapse.dom, 'menu.collapse-tip', 'title');
        i18n.bindDom(arrow.dom, 'menu.collapse-tip', 'title');

        // Splatmania home: leftmost, before File. Mark + wordmark; the
        // wordmark hides when the menubar is collapsed.
        const logo = createSvg(logoSvg);
        logo.dom.setAttribute('id', 'menu-logo');

        const wordmark = new Label({
            id: 'menu-wordmark',
            text: 'Splatmania'
        });

        const home = new Container({
            id: 'menu-home'
        });
        home.dom.setAttribute('role', 'link');
        home.dom.setAttribute('tabindex', '0');
        home.dom.setAttribute('aria-label', 'Splatmania');
        home.dom.setAttribute('title', 'Splatmania');
        home.dom.addEventListener('click', requestNavigateHome);
        home.dom.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                requestNavigateHome();
            }
        });
        home.append(logo);
        home.append(wordmark);

        const separator = new Element({ id: 'menu-separator' });

        const buttonsContainer = new Container({
            id: 'menu-bar-options'
        });
        buttonsContainer.append(home);
        buttonsContainer.append(separator);
        buttonsContainer.append(scene);
        buttonsContainer.append(edit);
        buttonsContainer.append(selection);
        buttonsContainer.append(render);
        buttonsContainer.append(view);
        buttonsContainer.append(help);
        buttonsContainer.append(collapse);
        buttonsContainer.append(arrow);

        menubar.append(buttonsContainer);

        // Get the shortcut manager for displaying keyboard shortcuts
        const shortcutManager: ShortcutManager = events.invoke('shortcutManager');

        // the last successful export, named by the re-export item
        let lastExport: { choices: ExportChoices } = null;
        events.on('scene.lastExport', (value: typeof lastExport) => {
            lastExport = value;
        });

        const exportMenuPanel = new MenuPanel([{
            text: 'PLY (.ply)...',
            icon: createSvg(sceneExport),
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: () => events.invoke('scene.export', 'ply')
        }, {
            text: 'SOG (.sog)...',
            icon: createSvg(sceneExport),
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: () => events.invoke('scene.export', 'sog')
        }, {
            text: 'SPZ (.spz)...',
            icon: createSvg(sceneExport),
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: () => events.invoke('scene.export', 'spz')
        }, {
            text: 'Splat (.splat)...',
            icon: createSvg(sceneExport),
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: () => events.invoke('scene.export', 'splat')
        }, {
            // separator
        }, {
            text: () => i18n.t('menu.file.export.viewer', { ellipsis: true }),
            icon: createSvg(sceneExport),
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: () => events.invoke('scene.export', 'viewer')
        }]);

        const openRecentMenuPanel = new MenuPanel([]);
        const importRecentMenuPanel = new MenuPanel([]);

        const fileMenuPanel = new MenuPanel([{
            text: () => i18n.t('menu.file.new'),
            icon: createSvg(sceneNew),
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: () => events.invoke('doc.new')
        }, {
            text: () => i18n.t('menu.file.open', { ellipsis: true }),
            icon: createSvg(sceneOpen),
            onSelect: async () => {
                await events.invoke('doc.open');
            }
        }, {
            text: () => i18n.t('menu.file.open-recent'),
            icon: createSvg(sceneOpen),
            subMenu: openRecentMenuPanel,
            isEnabled: () => refreshRecentMenu(openRecentMenuPanel, recentFiles, file => events.invoke('doc.openRecent', file.handle), 'menu.file.open-recent.clear')
        }, {
            // separator
        }, {
            text: () => i18n.t('menu.file.save'),
            icon: createSvg(sceneSave),
            isEnabled: () => events.invoke('doc.name'),
            onSelect: async () => await events.invoke('doc.save')
        }, {
            text: () => i18n.t('menu.file.save-as', { ellipsis: true }),
            icon: createSvg(sceneSave),
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: async () => await events.invoke('doc.saveAs')
        }, {
            // separator
        }, {
            text: () => i18n.t('menu.file.import', { ellipsis: true }),
            icon: createSvg(sceneImport),
            onSelect: async () => {
                await events.invoke('scene.import');
            }
        }, {
            text: () => i18n.t('menu.file.import-recent'),
            icon: createSvg(sceneImport),
            subMenu: importRecentMenuPanel,
            isEnabled: () => refreshRecentMenu(importRecentMenuPanel, recentImports, entry => events.invoke('scene.importRecent', entry), 'menu.file.import-recent.clear')
        }, {
            // separator
        }, {
            text: () => i18n.t('menu.file.export'),
            icon: createSvg(sceneExport),
            subMenu: exportMenuPanel
        }, {
            text: () => {
                return lastExport ?
                    i18n.t('menu.file.reexport-to', { filename: lastExport.choices.filename }) :
                    i18n.t('menu.file.reexport');
            },
            icon: createSvg(sceneExport),
            extra: shortcutManager.formatShortcut('scene.reexport'),
            isEnabled: () => !!lastExport && !events.invoke('scene.empty'),
            onSelect: () => events.fire('scene.reexport')
        }, {
            // separator
            isVisible: canPublish
        }, {
            text: () => i18n.t('menu.file.publish', { ellipsis: true }),
            icon: createSvg(scenePublish),
            isVisible: canPublish,
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: async () => await events.invoke('show.publishSettingsDialog')
        }]);

        // track undo/redo availability for menu item enablement
        let canUndo = false;
        let canRedo = false;
        events.on('edit.canUndo', (value: boolean) => {
            canUndo = value;
        });
        events.on('edit.canRedo', (value: boolean) => {
            canRedo = value;
        });

        const editMenuPanel = new MenuPanel([{
            text: () => i18n.t('menu.edit.undo'),
            icon: createSvg(editUndo),
            extra: shortcutManager.formatShortcut('edit.undo'),
            isEnabled: () => canUndo,
            onSelect: () => events.fire('edit.undo')
        }, {
            text: () => i18n.t('menu.edit.redo'),
            icon: createSvg(editRedo),
            extra: shortcutManager.formatShortcut('edit.redo'),
            isEnabled: () => canRedo,
            onSelect: () => events.fire('edit.redo')
        }, {
            // separator
        }, {
            text: () => i18n.t('menu.edit.duplicate'),
            icon: createSvg(selectDuplicate),
            isEnabled: () => events.invoke('selection.splats'),
            onSelect: () => events.fire('edit.duplicate')
        }, {
            text: () => i18n.t('menu.edit.separate'),
            icon: createSvg(selectSeparate),
            isEnabled: () => events.invoke('selection.splats'),
            onSelect: () => events.fire('edit.separate')
        }]);

        const selectionMenuPanel = new MenuPanel([{
            text: () => i18n.t('menu.select.all'),
            icon: createSvg(selectAll),
            extra: shortcutManager.formatShortcut('select.all'),
            onSelect: () => events.fire('select.all')
        }, {
            text: () => i18n.t('menu.select.none'),
            icon: createSvg(selectNone),
            extra: shortcutManager.formatShortcut('select.none'),
            onSelect: () => events.fire('select.none')
        }, {
            text: () => i18n.t('menu.select.invert'),
            icon: createSvg(selectInverse),
            extra: shortcutManager.formatShortcut('select.invert'),
            onSelect: () => events.fire('select.invert')
        }, {
            // separator
        }, {
            text: () => i18n.t('menu.select.lock'),
            icon: createSvg(selectLock),
            extra: shortcutManager.formatShortcut('select.hide'),
            isEnabled: () => events.invoke('selection.splats'),
            onSelect: () => events.fire('select.hide')
        }, {
            text: () => i18n.t('menu.select.unlock'),
            icon: createSvg(selectUnlock),
            extra: shortcutManager.formatShortcut('select.unhide'),
            onSelect: () => events.fire('select.unhide')
        }, {
            text: () => i18n.t('menu.select.delete'),
            icon: createSvg(selectDelete),
            extra: shortcutManager.formatShortcut('select.delete'),
            isEnabled: () => events.invoke('selection.splats'),
            onSelect: () => events.fire('select.delete')
        }, {
            text: () => i18n.t('menu.select.reset'),
            onSelect: () => events.fire('scene.reset')
        }]);

        const renderMenuPanel = new MenuPanel([{
            text: () => i18n.t('menu.render.image', { ellipsis: true }),
            icon: createSvg(sceneExport),
            onSelect: async () => await events.invoke('show.imageSettingsDialog')
        }, {
            text: () => i18n.t('menu.render.video', { ellipsis: true }),
            icon: createSvg(sceneExport),
            onSelect: async () => await events.invoke('show.videoSettingsDialog')
        }, {
            // the html player in a new tab, with its VR / AR buttons
            // (src/file-handler.ts viewer.preview)
            text: () => i18n.t('sm.player.open'),
            icon: createSvg(sceneExport),
            isEnabled: () => !events.invoke('scene.empty'),
            onSelect: () => {
                // opened inside the click so popup blockers allow it
                const target = window.open('', '_blank');
                target?.document.write(`<title>Splatmania</title><body style="background:#15121e;color:#ccc;font:14px sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">${i18n.t('sm.player.building')}</body>`);
                return events.invoke('viewer.preview', target);
            }
        }]);

        // View: which sections the scene panel shows (src/ui/collapsible.ts).
        // Grouped by what they belong to; a tick marks a shown section
        const viewSections: ([string, string] | null)[] = [
            ['objects', 'sm.objects.title'],
            null,
            ['transform', 'panel.scene.transform'],
            ['layerAnim', 'sm.anim.title'],
            ['transitions', 'sm.transitions.title'],
            ['pointCloud', 'sm.display.title'],
            ['cleanup', 'sm.cleanup.title'],
            ['colors', 'panel.colors'],
            null,
            ['cameras', 'sm.cameras.view-section'],
            ['cameras.props', 'sm.camera-props.title']
        ];
        const viewHeading = (key: string): MenuItem => ({ text: () => i18n.t(key), isEnabled: () => false });
        const viewItems: MenuItem[] = [viewHeading('sm.view.scene-list')];
        let group = 0;
        viewSections.forEach((entry) => {
            if (!entry) {
                viewItems.push({});
                viewItems.push(viewHeading(++group === 1 ? 'sm.view.splat-props' : 'sm.view.camera-props'));
                return;
            }
            const [key, title] = entry;
            viewItems.push({
                text: () => `${sectionShown(key) ? '☑' : '☐'}  ${i18n.t(title)}`,
                onSelect: () => setSectionShown(key, !sectionShown(key))
            });
        });
        viewItems.push({});
        viewItems.push({
            text: () => i18n.t('sm.view.show-all'),
            onSelect: () => viewSections.forEach(entry => entry && setSectionShown(entry[0], true))
        });
        const viewMenuPanel = new MenuPanel(viewItems);

        const videoTutorialsMenuPanel = new MenuPanel([{
            text: () => i18n.t('menu.help.video-tutorials.basics'),
            icon: 'E261',
            onSelect: () => window.open('https://youtu.be/MwzaEM2I55I', '_blank', 'noopener,noreferrer')
        }, {
            text: () => i18n.t('menu.help.video-tutorials.in-depth'),
            icon: 'E261',
            onSelect: () => window.open('https://youtu.be/J37rTieKgJ8', '_blank', 'noopener,noreferrer')
        }, {
            text: () => i18n.t('menu.help.video-tutorials.deleting-floaters'),
            icon: 'E261',
            onSelect: () => window.open('https://youtu.be/8qaLfwkkSdU', '_blank', 'noopener,noreferrer')
        }, {
            text: () => i18n.t('menu.help.video-tutorials.scaling'),
            icon: 'E261',
            onSelect: () => window.open('https://youtu.be/fRK1vVMg_EU', '_blank', 'noopener,noreferrer')
        }]);

        const helpMenuPanel = new MenuPanel([{
            text: () => i18n.t('menu.help.video-tutorials'),
            icon: 'E261',
            subMenu: videoTutorialsMenuPanel
        }, {
            text: () => i18n.t('sm.help.menu'),
            icon: 'E232',
            onSelect: () => events.fire('help.show')
        }, {
            text: () => i18n.t('menu.help.user-guide'),
            icon: 'E232',
            onSelect: () => window.open('https://developer.playcanvas.com/user-manual/gaussian-splatting/editing/supersplat/', '_blank', 'noopener,noreferrer')
        }, {
            text: () => i18n.t('menu.help.shortcuts'),
            icon: 'E136',
            onSelect: () => events.fire('show.shortcuts')
        }, {
            // separator
        }, {
            text: () => i18n.t('menu.help.github-repo'),
            icon: 'E259',
            onSelect: () => window.open('https://github.com/clarencedad-cloud/d4r-Splatmania', '_blank', 'noopener,noreferrer')
        }, {
            text: () => i18n.t('menu.help.log-issue'),
            icon: 'E336',
            onSelect: () => window.open('https://design4real.de/kontakt/', '_blank', 'noopener,noreferrer')
        }, {
            // separator
        }, {
            text: () => i18n.t('menu.help.design4real'),
            icon: 'E138',
            onSelect: () => window.open('https://design4real.de/', '_blank', 'noopener,noreferrer')
        }, {
            text: () => i18n.t('menu.help.imprint'),
            icon: 'E232',
            onSelect: () => window.open('https://design4real.de/impressum/', '_blank', 'noopener,noreferrer')
        }, {
            text: () => i18n.t('menu.help.privacy'),
            icon: 'E232',
            onSelect: () => window.open('https://design4real.de/privacy-policy/', '_blank', 'noopener,noreferrer')
        }, {
            // separator
        }, {
            text: () => i18n.t('menu.help.about'),
            icon: 'E138',
            onSelect: () => events.fire('show.about')
        }]);

        tipRows(exportMenuPanel, {
            0: 'menu.file.export.ply-tip',
            1: 'menu.file.export.sog-tip',
            2: 'menu.file.export.spz-tip',
            3: 'menu.file.export.splat-tip',
            5: 'menu.file.export.viewer-tip'
        });
        tipRows(fileMenuPanel, { 11: 'menu.file.reexport-tip' });
        tipRows(editMenuPanel, { 3: 'menu.edit.duplicate-tip', 4: 'menu.edit.separate-tip' });
        tipRows(selectionMenuPanel, {
            4: 'menu.select.lock-tip',
            5: 'menu.select.unlock-tip',
            6: 'menu.select.delete-tip',
            7: 'menu.select.reset-tip'
        });
        tipRows(renderMenuPanel, { 2: 'sm.player.open-tip' });

        this.append(menubar);
        this.append(fileMenuPanel);
        this.append(openRecentMenuPanel);
        this.append(importRecentMenuPanel);
        this.append(exportMenuPanel);
        this.append(editMenuPanel);
        this.append(selectionMenuPanel);
        this.append(renderMenuPanel);
        this.append(viewMenuPanel);
        this.append(videoTutorialsMenuPanel);
        this.append(helpMenuPanel);

        const options: { dom: HTMLElement, menuPanel: MenuPanel }[] = [{
            dom: scene.dom,
            menuPanel: fileMenuPanel
        }, {
            dom: edit.dom,
            menuPanel: editMenuPanel
        }, {
            dom: selection.dom,
            menuPanel: selectionMenuPanel
        }, {
            dom: render.dom,
            menuPanel: renderMenuPanel
        }, {
            dom: view.dom,
            menuPanel: viewMenuPanel
        }, {
            dom: help.dom,
            menuPanel: helpMenuPanel
        }];

        options.forEach((option) => {
            const activate = () => {
                option.menuPanel.position(option.dom, 'bottom', 2);
                options.forEach((opt) => {
                    opt.menuPanel.hidden = opt !== option;
                });
            };

            option.dom.addEventListener('pointerdown', (event: PointerEvent) => {
                if (!option.menuPanel.hidden) {
                    option.menuPanel.hidden = true;
                } else {
                    activate();
                }
            });

            option.dom.addEventListener('pointerenter', (event: PointerEvent) => {
                if (!options.every(opt => opt.menuPanel.hidden)) {
                    activate();
                }
            });
        });

        const checkEvent = (event: PointerEvent) => {
            if (!this.dom.contains(event.target as Node)) {
                options.forEach((opt) => {
                    opt.menuPanel.hidden = true;
                });
            }
        };

        window.addEventListener('pointerdown', checkEvent, true);
        window.addEventListener('pointerup', checkEvent, true);
    }
}

export { Menu };
