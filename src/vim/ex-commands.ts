import { normalizePath } from 'obsidian';

import { VimBindings } from './vim';
import { VimHintTarget } from './hint';
import { UserScriptContext } from 'user-script/context';
import { MarkdownModal } from 'modals/markdown-modal';
import { t } from 'lang';


export type ExCommand = { id: string, minNargs?: number, description?: string, pattern?: RegExp, func: (...args: string[]) => any };

export const exCommands = (vim: VimBindings): ExCommand[] => {
    /***************************************************************
     * The full list of the default Ex commands supported by PDF++ *
     ***************************************************************/
    return [
        { id: 'nextpage', func: () => vim.pdfViewer?.nextPage() },
        { id: 'prevpage', func: () => vim.pdfViewer?.previousPage() },
        { id: '0', description: t('vimExCommands.go-to-the-first-page.help'), func: () => vim.pdfViewer && (vim.pdfViewer.currentPageNumber = 1) },
        { id: '$', description: t('vimExCommands.go-to-the-last-page.help'), func: () => vim.pdfViewer && (vim.pdfViewer.currentPageNumber = vim.pdfViewer.pagesCount) },
        {
            id: 'gotopage',
            pattern: /^go(to(page)?)?$/,
            description: t('vimExCommands.go-to-page.help'),
            minNargs: 1,
            func: async (page) => {
                if (vim.pdfViewer) {
                    const pageLabels = await vim.pdfViewer.pdfDocument.getPageLabels();
                    if (pageLabels) {
                        const index = pageLabels.indexOf(page);
                        if (index !== -1) {
                            const pageNumber = index + 1;
                            vim.pdfViewer.currentPageNumber = pageNumber;
                            return;
                        }
                    }
                    vim.pdfViewer.currentPageNumber = +page;
                }
            }
        },
        { id: 'pagetop', func: () => vim.scroll.scrollToTop() },
        { id: 'pagebottom', func: () => vim.scroll.scrollToBottom() },
        { id: 'searchforward', pattern: /^search(f(orward)?)?$/, func: () => setTimeout(() => vim.search.start(true)) },
        { id: 'searchbackward', pattern: /^searchb(ackward)?$/, func: () => setTimeout(() => vim.search.start(false)) },
        { id: 'findnext', func: () => vim.search.findNext() },
        { id: 'findprev', func: () => vim.search.findPrevious() },
        { id: 'zoom', description: t('vimExCommands.zoom.help'), minNargs: 1, func: (level) => vim.pdfViewer && (vim.pdfViewer.currentScale = 0.01 * +level) },
        { id: 'zoomin', func: () => vim.obsidianViewer?.zoomIn() },
        { id: 'zoomout', func: () => vim.obsidianViewer?.zoomOut() },
        { id: 'zoomreset', func: () => vim.obsidianViewer?.zoomReset() },
        { id: 'rotate', func: () => vim.obsidianViewer?.rotatePages(90) },
        {
            id: 'yank',
            pattern: /^y(ank)?$/,
            func: () => {
                const selection = vim.doc.getSelection();
                if (selection) {
                    const text = selection.toString();
                    if (text) navigator.clipboard.writeText(text);
                    vim.enterNormalMode();
                }
            }
        },
        { id: 'outline', pattern: /^(outline)|(toc)$/, description: t('vimExCommands.outline.help'), func: () => vim.lib.commands.showOutline(false) },
        { id: 'thumbnail', pattern: /^thumb(nail)?$/, description: t('vimExCommands.thumbnail.help'), func: () => vim.lib.commands.showThumbnail(false) },
        { id: 'closesidebar', func: () => vim.lib.commands.closeSidebar(false) },
        {
            id: 'help', pattern: /^h(elp)?$/, func: (arg) => {
                if (arg && arg.startsWith(':')) {
                    const excmdName = arg.slice(1).split(' ')[0];
                    const excmd = vim.commandLineMode.findCommand(excmdName);
                    if (excmd && excmd.description) {
                        MarkdownModal.renderAsModal(vim.plugin, lint(excmd.description));
                        return;
                    }
                }
                vim.plugin.openSettingTab().scrollToHeading('vim');
            },
        },
        { id: 'map', minNargs: 2, func: (from, ...to) => vim.map(['normal', 'visual', 'outline'], from, to.join(' ')), description: mapDesc('map', ['normal', 'visual', 'outline']) },
        { id: 'noremap', pattern: /^no(remap)$/, minNargs: 2, func: (from, ...to) => vim.noremap(['normal', 'visual', 'outline'], from, to.join(' ')), description: mapDesc('no[remap]', ['normal', 'visual', 'outline'], true) },
        { id: 'nmap', pattern: /^nm(ap)?$/, minNargs: 2, func: (from, ...to) => vim.map(['normal'], from, to.join(' ')), description: mapDesc('nm[ap]', ['normal']) },
        { id: 'nnoremap', pattern: /^nn(oremap)?$/, minNargs: 2, func: (from, ...to) => vim.noremap(['normal', 'visual', 'outline'], from, to.join(' ')), description: mapDesc('nn[oremap]', ['normal'], true) },
        { id: 'vmap', pattern: /^vm(ap)?$/, minNargs: 2, func: (from, ...to) => vim.map(['visual'], from, to.join(' ')), description: mapDesc('vm[ap]', ['visual']) },
        { id: 'vnoremap', pattern: /^vn(oremap)?$/, minNargs: 2, func: (from, ...to) => vim.noremap(['visual'], from, to.join(' ')), description: mapDesc('vn[oremap]', ['visual'], true) },
        { id: 'omap', pattern: /^om(ap)?$/, minNargs: 2, func: (from, ...to) => vim.map(['outline'], from, to.join(' ')), description: mapDesc('om[ap]', ['outline']) },
        { id: 'onoremap', pattern: /^ono(remap)?$/, minNargs: 2, func: (from, ...to) => vim.noremap(['outline'], from, to.join(' ')), description: mapDesc('ono[remap]', ['outline'], true) },
        { id: 'unmap', pattern: /^unm(ap)?$/, minNargs: 1, func: (key) => vim.vimScope.unmap(['normal', 'visual', 'outline'], [key]), description: t('vimExCommands.unmap.help') },
        { id: 'nunmap', pattern: /^nun(map)?$/, minNargs: 1, func: (key) => vim.vimScope.unmap(['normal'], [key]), description: t('vimExCommands.nunmap.help') },
        { id: 'vunmap', pattern: /^vu(nmap)?$/, minNargs: 1, func: (key) => vim.vimScope.unmap(['visual'], [key]), description: t('vimExCommands.vunmap.help') },
        { id: 'ounmap', pattern: /^ou(nmap)?$/, minNargs: 1, func: (key) => vim.vimScope.unmap(['outline'], [key]), description: t('vimExCommands.ounmap.help') },
        { id: 'js', pattern: /^js(command)?$/, minNargs: 1, func: (...code) => vim.evalUserScript(code.join(' ')), description: t('vimExCommands.javascript.help', { v0: UserScriptContext.name }) },
        {
            id: 'jsfile',
            minNargs: 1,
            func: async (...splitPath) => {
                const path = normalizePath(splitPath.join(' '));
                const jsCode = await vim.app.vault.adapter.read(vim.app.metadataCache.getFirstLinkpathDest(path, '')?.path ?? path);
                return await vim.evalUserScript(jsCode);
            },
            description: t('vimExCommands.javascript-file.help', { v0: UserScriptContext.name })
        },
        {
            id: 'obcommand',
            description: t('vimExCommands.obcommand.help'),
            minNargs: 1,
            func: (cmd) => vim.app.commands.executeCommandById(cmd)
        },
        {
            id: 'hint',
            description: t('vimExCommands.hint.help'),
            func: (...targets) => {
                if (targets.length === 0) targets = vim.settings.vimHintArgs.trim().split(/\s+/);
                if (targets.includes('all')) targets = ['link', 'annot', 'backlink'];
                vim.hintMode.setTarget(...targets.map((target) => {
                    switch (target) {
                        case 'link': return VimHintTarget.Link;
                        case 'annot': return VimHintTarget.NonLinkAnnot;
                        case 'backlink': return VimHintTarget.BacklinkHighlight;
                        default: throw Error(`Unknown hint target: ${target}`);
                    }
                }));
                // Avoid re-entering normal mode after command execution (see commandLineMode.submitCommand()
                setTimeout(() => vim.enterHintMode());
            }
        }
    ];
};


const lint = (str: string, indentSize = 12, escapeAngleBrackets = true) => {
    str = str
        .replace(new RegExp(`^ {${indentSize}}`, 'gm'), '') // remove indentation
        .replace(/^\s*/, ''); // remove leading whitespaces and newlines
    return escapeAngleBrackets ? str.replace(/([<>])/g, '\\$1') : str;
};

const mapDesc = (signature: string, modes: string[], noremap = false) => {
    // The list of modes is generated from `modes` and is kept untranslated: these are the
    // mode names used by the `:map` family of Ex commands themselves.
    if (modes.length > 1) {
        const modeList = modes.slice(0, -1).join(', ') + ' and ' + modes.at(-1)!;
        return t('vimExCommands.map-command.multiple-modes.help', {
            signature,
            v0: noremap ? t('vimExCommands.map-command.non-recursively') : '',
            v1: modeList,
        });
    }
    return t('vimExCommands.map-command.single-mode.help', {
        signature,
        v0: noremap ? t('vimExCommands.map-command.non-recursively') : '',
        v1: modes[0],
    });
};
