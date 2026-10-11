import { ButtonComponent, requireApiVersion } from 'obsidian';

import PDFPlus from 'main';
import { PDFPlusModal } from './base-modal';
import { getInstallerVersion, isVersionOlderThan } from 'utils';
import { t } from 'lang';


// See https://github.com/RyotaUshio/obsidian-pdf-plus/issues/395#issuecomment-2680378913
const minInstallerVersion = '1.6.5';

export class InstallerVersionModal extends PDFPlusModal {
    static openIfNecessary(plugin: PDFPlus) {
        const installerVersion = getInstallerVersion();
        if (installerVersion && isVersionOlderThan(installerVersion, minInstallerVersion)) {
            plugin.app.workspace.onLayoutReady(() => {
                new InstallerVersionModal(plugin).open();
            });
        }
    }

    onOpen() {
        super.onOpen();

        const name = this.plugin.manifest.name;
        this.setTitle(t('modalsInstallerVersionModal.obsidian-installer-update-is-required.title', { name: name }));
        this.contentEl.createEl('p', {
            text: t('modalsInstallerVersionModal.your-obsidian-installer-is-outdated', { v0: getInstallerVersion(), plugin: name }),
        });

        if (!requireApiVersion(minInstallerVersion)) {
            this.contentEl.createEl('p', {
                text: t('modalsInstallerVersionModal.min-installer-version-required', { v0: minInstallerVersion, plugin: name }),
            });
        }

        this.contentEl.createDiv('modal-button-container', (el) => {
            const downloadUrl = 'https://obsidian.md/download';
            new ButtonComponent(el)
                .setButtonText(t('modalsInstallerVersionModal.get-installer-from-obsidian-md'))
                .setTooltip(downloadUrl)
                .setCta()
                .onClick(() => {
                    window.open(downloadUrl);
                });

            const helpUrl = 'https://help.obsidian.md/Getting+started/Update+Obsidian#Installer%20updates';
            new ButtonComponent(el)
                .setButtonText(t('modalsInstallerVersionModal.what-is-installer-update-help-obsidian-md.button'))
                .setTooltip(helpUrl)
                .onClick(() => {
                    window.open(helpUrl);
                });
        });
    }
}
