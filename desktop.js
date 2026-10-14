// Памятка и программа Cop Helper для Windows: ссылка на программу в браузере и связь страницы с программой,
// когда памятка открыта внутри неё. Подключается после script.js; в обычном браузере работает только ссылка.

// ===== Связь с программой =====
// Страница открыта внутри программы Cop Helper: в настройках появляются сочетание клавиш быстрого поиска,
// запуск вместе с Windows и удаление программы.
// Страница показывает сочетание и окно его выбора. Проверяет, называет и хранит сочетание программа:
// только она знает, не занято ли оно другой программой.
// Странице от программы: hotkey — действующее сочетание; hotkeyAsk — открыть окно (первый запуск);
// hotkeyTried — как называется нажатое сочетание и чем оно не подходит; autostart — включён ли запуск с Windows;
// can — что умеет эта версия программы (старые версии умеют не всё).
// Программе от страницы: ready, hotkeyOpen, hotkeyTry, hotkeySave, hotkeyCancel, autostartSet, uninstall.
const desktopApp = window.chrome && window.chrome.webview;

// Ссылка «скачать программу» показывается только на Windows (в самой программе её прячут стили)
if (/Win/.test(navigator.platform)) document.documentElement.classList.add('windows');

if (desktopApp) {
    const hotkeyBtn = document.getElementById('hotkeyBtn');
    const hotkeyDialog = document.getElementById('hotkeyDialog');
    const hotkeyCombo = document.getElementById('hotkeyCombo');
    const hotkeyNote = document.getElementById('hotkeyNote');
    const hotkeySaveBtn = document.getElementById('hotkeySaveBtn');
    let currentHotkey = '';

    const showTriedHotkey = (text, problem) => {
        hotkeyCombo.textContent = text || 'Нажмите сочетание…';
        hotkeyCombo.classList.toggle('empty', !text);
        hotkeyNote.textContent = problem;
        hotkeySaveBtn.disabled = !text || Boolean(problem);
    };

    const openHotkeyDialog = () => {
        if (hotkeyDialog.classList.contains('open')) return;
        showTriedHotkey(currentHotkey, '');
        hotkeyDialog.classList.add('open');
        desktopApp.postMessage({ type: 'hotkeyOpen' });
    };

    const closeHotkeyDialog = (save) => {
        hotkeyDialog.classList.remove('open');
        desktopApp.postMessage({ type: save ? 'hotkeySave' : 'hotkeyCancel' });
    };

    document.documentElement.classList.add('desktop');
    desktopApp.addEventListener('message', (e) => {
        const message = e.data || {};
        if (message.type === 'hotkey') {
            currentHotkey = message.text;
            hotkeyBtn.textContent = currentHotkey || 'Выбрать';
        } else if (message.type === 'hotkeyAsk') {
            openHotkeyDialog();
        } else if (message.type === 'hotkeyTried') {
            showTriedHotkey(message.text, message.problem);
        } else if (message.type === 'can' && message.what === 'uninstall') {
            // Программа умеет удалять себя: в настройках появляется строка удаления
            document.documentElement.classList.add('can-uninstall');
        } else if (message.type === 'autostart') {
            // Включён ли запуск, знает программа: кнопки показывают её ответ
            const isOn = message.on === '1';
            document.querySelectorAll('.autostart-btn').forEach(btn => {
                const isActive = (btn.dataset.autostart === 'on') === isOn;
                btn.classList.toggle('on', isActive);
                btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
            });
        }
    });

    document.querySelectorAll('.autostart-btn').forEach(btn => btn.addEventListener('click', () => {
        desktopApp.postMessage({ type: 'autostartSet', on: btn.dataset.autostart === 'on' });
    }));

    hotkeyBtn.addEventListener('click', openHotkeyDialog);
    hotkeySaveBtn.addEventListener('click', () => closeHotkeyDialog(true));
    document.getElementById('hotkeyCancelBtn').addEventListener('click', () => closeHotkeyDialog(false));

    // Удаление программы: страница только спрашивает подтверждение, удаляет программа
    const uninstallDialog = document.getElementById('uninstallDialog');
    const closeUninstallDialog = () => uninstallDialog.classList.remove('open');

    document.getElementById('uninstallBtn').addEventListener('click', () => uninstallDialog.classList.add('open'));
    document.getElementById('uninstallCancelBtn').addEventListener('click', closeUninstallDialog);
    document.getElementById('uninstallConfirmBtn').addEventListener('click', () => {
        closeUninstallDialog();
        desktopApp.postMessage({ type: 'uninstall' });
    });

    // Щелчок в окне не закрывает панель настроек под ним: после окна человек возвращается в настройки
    [hotkeyDialog, uninstallDialog].forEach(dialog => dialog.addEventListener('click', e => e.stopPropagation()));

    // Пока окно открыто, все клавиши достаются ему: остальная страница на них не отзывается
    document.addEventListener('keydown', (e) => {
        if (uninstallDialog.classList.contains('open')) {
            // Удаление подтверждается только кнопкой; Esc закрывает окно
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.key === 'Escape') closeUninstallDialog();
            return;
        }
        if (!hotkeyDialog.classList.contains('open')) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
        if (e.key === 'Escape') { closeHotkeyDialog(false); return; }
        if (e.key === 'Enter') { if (!hotkeySaveBtn.disabled) closeHotkeyDialog(true); return; }
        desktopApp.postMessage({ type: 'hotkeyTry', ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, vk: e.keyCode });
    }, true);

    desktopApp.postMessage({ type: 'ready' });
}
