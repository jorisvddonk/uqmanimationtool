/*
 * Small Swing-flavoured modal dialogs (TextDialog.java and JOptionPane
 * replacements) plus a toast helper.
 */

let openDialogs = 0;

function buildDialog({ title, className = '', icon = null }) {
    const dialog = document.createElement('dialog');
    dialog.className = `dialog ${className}`.trim();

    const titlebar = document.createElement('div');
    titlebar.className = 'dialog-titlebar';

    if (icon) {
        const img = document.createElement('img');
        img.src = icon;
        img.alt = '';
        titlebar.appendChild(img);
    }

    const titleText = document.createElement('span');
    titleText.className = 'dialog-title';
    titleText.textContent = title;
    titlebar.appendChild(titleText);

    const closeButton = document.createElement('button');
    closeButton.className = 'dialog-x';
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Close');
    closeButton.textContent = '✕';
    titlebar.appendChild(closeButton);

    const body = document.createElement('div');
    body.className = 'dialog-body';

    const footer = document.createElement('div');
    footer.className = 'dialog-footer';

    dialog.append(titlebar, body, footer);

    const close = () => {
        if (dialog.open) {
            dialog.close();
        }
    };
    closeButton.addEventListener('click', close);

    document.body.appendChild(dialog);
    openDialogs++;

    dialog.addEventListener('close', () => {
        openDialogs--;
        dialog.remove();
    }, { once: true });

    return { dialog, titlebar, body, footer, close };
}

function addButton(footer, label, { primary = false, onClick } = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `btn${primary ? ' btn-primary' : ''}`;
    button.textContent = label;
    if (onClick) {
        button.addEventListener('click', onClick);
    }
    footer.appendChild(button);
    return button;
}

/** Port of TextDialog: a scrollable text area with an OK button and wrap toggle. */
export function showTextDialog({ title = 'Text', text = '', wrap = false, width = 760 } = {}) {
    return new Promise((resolve) => {
        const { dialog, body, footer, close } = buildDialog({ title, className: 'dialog-text' });
        dialog.style.width = `min(${width}px, calc(100vw - 40px))`;

        const textarea = document.createElement('textarea');
        textarea.className = 'text-dialog-area';
        textarea.readOnly = true;
        textarea.value = text;
        textarea.wrap = wrap ? 'soft' : 'off';
        textarea.rows = 18;
        body.appendChild(textarea);

        const wrapLabel = document.createElement('label');
        wrapLabel.className = 'checkbox';
        const wrapCheckbox = document.createElement('input');
        wrapCheckbox.type = 'checkbox';
        wrapCheckbox.checked = wrap;
        wrapCheckbox.addEventListener('change', () => {
            textarea.wrap = wrapCheckbox.checked ? 'soft' : 'off';
        });
        wrapLabel.append(wrapCheckbox, document.createTextNode('Wrap words'));
        footer.appendChild(wrapLabel);

        addButton(footer, 'OK', { primary: true, onClick: close });

        dialog.addEventListener('close', () => resolve(), { once: true });
        dialog.showModal();
        textarea.scrollTop = 0;
    });
}

/** JOptionPane.showInputDialog replacement. Resolves to the string or null. */
export function promptDialog({ title = 'Input', label = '', value = '', placeholder = '', okLabel = 'OK' } = {}) {
    return new Promise((resolve) => {
        const { dialog, body, footer, close } = buildDialog({ title, className: 'dialog-prompt' });

        const labelElement = document.createElement('label');
        labelElement.className = 'field';
        const labelText = document.createElement('span');
        labelText.textContent = label;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = value;
        input.placeholder = placeholder;
        labelElement.append(labelText, input);
        body.appendChild(labelElement);

        let result = null;
        const accept = () => {
            result = input.value;
            close();
        };
        const cancel = () => {
            result = null;
            close();
        };

        addButton(footer, 'Cancel', { onClick: cancel });
        addButton(footer, okLabel, { primary: true, onClick: accept });

        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                accept();
            }
        });
        dialog.addEventListener('close', () => resolve(result), { once: true });
        dialog.showModal();
        input.focus();
        input.select();
    });
}

/** JOptionPane.showConfirmDialog / YES_NO replacement. */
export function confirmDialog({ title = 'Question', message = '', yesLabel = 'Yes', noLabel = 'No' } = {}) {
    return new Promise((resolve) => {
        const { dialog, body, footer, close } = buildDialog({ title, className: 'dialog-confirm' });
        const paragraph = document.createElement('p');
        paragraph.className = 'dialog-message';
        paragraph.textContent = message;
        body.appendChild(paragraph);

        let result = false;
        addButton(footer, noLabel, { onClick: () => { result = false; close(); } });
        addButton(footer, yesLabel, { primary: true, onClick: () => { result = true; close(); } });

        dialog.addEventListener('close', () => resolve(result), { once: true });
        dialog.showModal();
    });
}

/** List chooser, used when a folder/zip contains more than one .ani file. */
export function chooseDialog({ title = 'Choose', message = '', options = [] } = {}) {
    return new Promise((resolve) => {
        const { dialog, body, footer, close } = buildDialog({ title, className: 'dialog-choose' });

        if (message) {
            const paragraph = document.createElement('p');
            paragraph.className = 'dialog-message';
            paragraph.textContent = message;
            body.appendChild(paragraph);
        }

        const list = document.createElement('div');
        list.className = 'choose-list';
        let selected = options.length === 1 ? options[0] : null;

        for (const option of options) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'choose-item';
            item.textContent = option.label;
            item.addEventListener('click', () => {
                selected = option;
                for (const child of list.children) {
                    child.classList.toggle('selected', child === item);
                }
            });
            item.addEventListener('dblclick', () => {
                selected = option;
                close();
            });
            list.appendChild(item);
        }
        body.appendChild(list);

        let result = null;
        addButton(footer, 'Cancel', { onClick: () => { result = null; close(); } });
        addButton(footer, 'Open', {
            primary: true,
            onClick: () => {
                result = selected;
                close();
            },
        });

        dialog.addEventListener('close', () => resolve(result), { once: true });
        dialog.showModal();
        if (list.firstChild) {
            list.firstChild.classList.toggle('selected', selected === options[0]);
            list.firstChild.focus();
        }
    });
}

/**
 * Generic form dialog (text / number / checkbox fields).
 * Resolves to an object of values, or null when cancelled.
 */
export function formDialog({
    title = 'Options',
    description = '',
    fields = [],
    submitLabel = 'OK',
    cancelLabel = 'Cancel',
} = {}) {
    return new Promise((resolve) => {
        const { dialog, body, footer, close } = buildDialog({ title, className: 'dialog-form' });

        if (description) {
            const paragraph = document.createElement('p');
            paragraph.className = 'dialog-message';
            paragraph.textContent = description;
            body.appendChild(paragraph);
        }

        const inputs = new Map();

        for (const field of fields) {
            if (field.type === 'checkbox') {
                const label = document.createElement('label');
                label.className = 'checkbox';
                const input = document.createElement('input');
                input.type = 'checkbox';
                input.checked = Boolean(field.value);
                label.append(input, document.createTextNode(field.label));
                body.appendChild(label);
                inputs.set(field.name, { input, field });
                continue;
            }

            const label = document.createElement('label');
            label.className = 'field';
            const caption = document.createElement('span');
            caption.textContent = field.label;
            const input = document.createElement('input');
            input.type = field.type === 'number' ? 'number' : 'text';
            input.value = field.value ?? '';
            if (field.placeholder) {
                input.placeholder = field.placeholder;
            }
            if (field.type === 'number') {
                input.step = field.step ?? '1';
                if (field.min !== undefined) {
                    input.min = String(field.min);
                }
            }
            label.append(caption, input);
            if (field.help) {
                const help = document.createElement('small');
                help.className = 'field-help';
                help.textContent = field.help;
                label.appendChild(help);
            }
            body.appendChild(label);
            inputs.set(field.name, { input, field });
        }

        let result = null;
        const accept = () => {
            const values = {};
            for (const [name, { input, field }] of inputs) {
                if (field.type === 'checkbox') {
                    values[name] = input.checked;
                } else if (field.type === 'number') {
                    const value = Number(input.value);
                    values[name] = Number.isFinite(value) ? value : Number(field.value) || 0;
                } else {
                    values[name] = input.value;
                }
            }
            result = values;
            close();
        };

        addButton(footer, cancelLabel, { onClick: () => { result = null; close(); } });
        addButton(footer, submitLabel, { primary: true, onClick: accept });

        dialog.addEventListener('close', () => resolve(result), { once: true });
        dialog.showModal();
        const firstInput = body.querySelector('input');
        if (firstInput) {
            firstInput.focus();
            firstInput.select();
        }
    });
}

/** Small colour picker (JColorChooser replacement). Resolves to "#rrggbb" or null. */
export function colorDialog({ title = 'Choose a color', value = '#ff0000' } = {}) {
    return new Promise((resolve) => {
        const { dialog, body, footer, close } = buildDialog({ title, className: 'dialog-color' });

        const row = document.createElement('div');
        row.className = 'color-row';

        const picker = document.createElement('input');
        picker.type = 'color';
        picker.value = /^#[0-9a-f]{6}$/i.test(value) ? value : '#ff0000';

        const hex = document.createElement('input');
        hex.type = 'text';
        hex.className = 'color-hex';
        hex.value = picker.value;
        hex.spellcheck = false;

        picker.addEventListener('input', () => {
            hex.value = picker.value;
        });
        hex.addEventListener('input', () => {
            if (/^#[0-9a-f]{6}$/i.test(hex.value)) {
                picker.value = hex.value;
            }
        });

        const label = document.createElement('span');
        label.textContent = 'Hotspot colour:';
        row.append(label, picker, hex);
        body.appendChild(row);

        let result = null;
        addButton(footer, 'Cancel', { onClick: () => { result = null; close(); } });
        addButton(footer, 'OK', {
            primary: true,
            onClick: () => {
                result = picker.value;
                close();
            },
        });

        dialog.addEventListener('close', () => resolve(result), { once: true });
        dialog.showModal();
        picker.focus();
    });
}

/** Non-blocking notification in the corner of the screen. */
export function toast(message, { type = 'info', duration = 4200 } = {}) {
    let container = document.getElementById('toasts');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toasts';
        document.body.appendChild(container);
    }
    const element = document.createElement('div');
    element.className = `toast toast-${type}`;
    element.textContent = message;
    container.appendChild(element);

    const remove = () => {
        element.classList.add('toast-out');
        setTimeout(() => element.remove(), 200);
    };
    const timer = setTimeout(remove, duration);
    element.addEventListener('click', () => {
        clearTimeout(timer);
        remove();
    });
}

export function isDialogOpen() {
    return openDialogs > 0;
}
