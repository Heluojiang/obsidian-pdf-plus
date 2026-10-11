import { ButtonComponent, Notice } from 'obsidian';

import { PDFPlusModal } from './base-modal';
import { t } from 'lang';


export class RestoreDefaultModal extends PDFPlusModal {
    onOpen(): void {
        super.onOpen();
        this.containerEl.addClass('pdf-plus-restore-default-modal');
        this.titleEl.setText(t('modalsRestoreDefaultModal.restore-default-settings.title', { plugin: this.plugin.manifest.name }));
        this.contentEl.createEl('p', {
            text: t('modalsRestoreDefaultModal.this-operation-will-overwrite-your-config', {
                v0: (
                    this.plugin.manifest.dir
                    ?? (this.app.vault.configDir + '/plugins/' + this.plugin.manifest.id)
                ) + '/data.json'
            }),
        });

        this.contentEl.createDiv('modal-button-container', (el) => {
            new ButtonComponent(el)
                .setButtonText(t('modalsRestoreDefaultModal.i-understand-restore-default-settings.button'))
                .setWarning()
                .onClick(async () => {
                    await this.plugin.restoreDefaultSettings();
                    this.close();
                    new Notice(t('modalsRestoreDefaultModal.default-setting-restored-note-that-some-opti.notice', { plugin: this.plugin.manifest.name }), 6000);
                });
            new ButtonComponent(el)
                .setButtonText(t('modalsRestoreDefaultModal.cancel'))
                .onClick(() => {
                    this.close();
                });
        });

        setTimeout(() => {
            const activeEl = this.containerEl.doc.activeElement;
            if (activeEl && activeEl.instanceOf(HTMLButtonElement) && this.containerEl.contains(activeEl)) {
                // Avoid an accidental press of the button
                activeEl.blur();
            }
        });
    }
}
