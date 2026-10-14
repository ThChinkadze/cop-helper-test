// ===== Версия страницы =====
// Браузер может несколько минут держать в памяти старый index.html, а этот файл всегда берётся свежим.
// Если страница старее, чем нужна скрипту, она один раз запрашивается заново в обход сохранённой копии.
// При правке разметки, от которой зависит скрипт, число увеличивается здесь и в data-page у <html>.
const PAGE_VERSION = '5';
const FRESH_PAGE_RE = /[?&]fresh=/;

if (document.documentElement.dataset.page !== PAGE_VERSION) {
    if (!FRESH_PAGE_RE.test(location.search)) {
        location.replace(`${location.pathname}?fresh=${Date.now()}`);
    } else {
        const box = document.getElementById('articlesContainer');
        if (box) box.textContent = 'Сайт обновляется. Обновите страницу через минуту.';
    }
    throw new Error('Страница старее скрипта');
}
if (FRESH_PAGE_RE.test(location.search)) history.replaceState(null, '', location.pathname);

// ===== Состояние приложения =====
let proceduralData = [];
let searchDebounceTimer;

// Во время поиска: кодекс, которым ограничена выдача (null — все кодексы).
let searchCodeFilter = null;

// Отмеченная статья — к ней относятся клавиши — и текст запроса, по которому построена выдача.
// Отметку ставят стрелки или курсор мыши; поставленная мышью следует за курсором и снимается, когда он уходит со списка.
let keyboardSelectedId = null;
let markerByMouse = false;
let renderedSearchText = '';
// Показана ли сейчас выдача поиска (а не обычный список статей кодекса).
let listShowsSearch = false;

// ===== Режим отображения (compact/full) =====
const DISPLAY_MODE_KEY = STORAGE_PREFIX + 'display_mode';
let currentDisplayMode = storeGet(DISPLAY_MODE_KEY) === 'full' ? 'full' : 'compact';

const ZOOM_KEY = STORAGE_PREFIX + 'zoom_level';
const ZOOM_MIN = 75;
const ZOOM_MAX = 130;
const ZOOM_STEP = 5;
const storedZoom = parseInt(storeGet(ZOOM_KEY), 10);
let currentZoom = (Number.isInteger(storedZoom) && storedZoom >= ZOOM_MIN && storedZoom <= ZOOM_MAX && storedZoom % ZOOM_STEP === 0)
    ? storedZoom
    : 100;

// ===== Сенсорный экран: клавиатуры и курсора нет =====
// Второй признак — грубый указатель (палец): часть телефонов на вопрос о курсоре отвечает неверно.
const touchQuery = window.matchMedia('(hover: none), (pointer: coarse)');

// ===== Дата последней редакции =====
const DB_DATE_SEEN_KEY = STORAGE_PREFIX + 'db_date_seen';

// ===== Пины статей =====
const PINNED_KEY = STORAGE_PREFIX + 'pinned_articles';
let pinnedArticles = new Set(loadPinnedArticles());

function loadPinnedArticles() {
    try {
        const raw = JSON.parse(storeGet(PINNED_KEY));
        return Array.isArray(raw) ? raw : [];
    } catch {
        return [];
    }
}

// ===== Недавно скопированные статьи =====
function rememberCopied(article) {
    storeRecentCopied(article);
    refreshRecentRow();
}

// Список недавних поменялся в другой вкладке или в быстром окне программы — строка обновляется сразу.
window.addEventListener('storage', (e) => {
    if (e.key !== RECENT_KEY && e.key !== null) return;
    recentCopied = loadRecentCopied();
    refreshRecentRow();
});

// ===== Появление и исчезновение строк шапки: «Найдено» и «Недавно скопированные» =====
// Обе стоят под вкладками на одном месте. Перерисовка идёт через updateHeaderRows: она сравнивает, какая строка
// была на экране и какая стала, и сама назначает движение — классом enter, grow или сворачивающейся копией.
// На первой отрисовке списка место считается занятым, чтобы страница не открывалась с движением шапки.
let headerRowsSeen = false;

function shownHeaderRow() {
    return ['foundRow', 'recentRow'].map(id => document.getElementById(id)).find(row => row.firstChild) || null;
}

function updateHeaderRows(draw) {
    const before = shownHeaderRow();
    // Содержимое прежней строки вынимается целиком: если место опустеет, оно уйдёт в сворачивающуюся копию.
    const oldContent = document.createDocumentFragment();
    if (before) oldContent.append(...before.childNodes);
    const slotWasFilled = Boolean(before) || !headerRowsSeen;

    draw();

    const after = shownHeaderRow();
    if (after && after !== before) {
        // Появилась на пустом месте — плавно раздвигает шапку; сменила соседнюю строку — только проявляется.
        after.classList.toggle('grow', !slotWasFilled);
        after.classList.toggle('enter', slotWasFilled);
    }
    if (!after && before) leaveHeaderRow(before, oldContent);
}

// Место под вкладками опустело: на месте строки остаётся её копия с прежним содержимым, которая плавно
// сворачивается и убирается. Копия ни на что не нажимается и в подсчётах не участвует.
function leaveHeaderRow(row, content) {
    const ghost = row.cloneNode(false);
    ghost.removeAttribute('id');
    ghost.classList.remove('enter', 'grow');
    ghost.classList.add('leave');
    ghost.inert = true;
    ghost.setAttribute('aria-hidden', 'true');
    ghost.append(content);
    row.before(ghost);

    // Движение отключено (настройка «уменьшить движение») — копия не нужна.
    const style = getComputedStyle(ghost);
    if (style.animationName === 'none') {
        ghost.remove();
        return;
    }
    const remove = () => ghost.remove();
    ghost.addEventListener('animationend', remove);
    // Запасной путь: на скрытой вкладке движение не идёт и о своём конце не сообщает.
    setTimeout(remove, parseFloat(style.animationDuration) * 2000);
}

// Класс движения снимается, когда оно закончилось: иначе оно могло бы повториться при следующей перерисовке.
['foundRow', 'recentRow'].forEach(id => {
    const row = document.getElementById(id);
    row.addEventListener('animationend', (e) => {
        if (e.target === row) row.classList.remove('enter', 'grow');
    });
});

// Перерисовка одной строки «Недавно скопированные» — после копирования, очистки и смены вида экрана.
function refreshRecentRow() {
    updateHeaderRows(renderRecentRow);
}

// Строка «Недавно скопированные» в шапке, под вкладками; при поиске, на «Общей информации» и на сенсорном экране её нет.
// Нажатие на номер копирует его снова, порядок в строке при этом не меняется.
function renderRecentRow() {
    const row = document.getElementById('recentRow');
    row.innerHTML = '';
    if (currentCode === 'pk' || articlesLoadState !== 'ready' || listShowsSearch || touchQuery.matches) return;

    const articles = recentArticles();
    if (articles.length === 0) return;

    row.innerHTML = '<span class="label"><span class="r-full">Недавно скопированные</span><span class="r-short">Недавние</span></span>';
    const chips = document.createElement('div');
    chips.className = 'chips';
    articles.forEach(article => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.textContent = articleCopyText(article);
        chip.title = `${article.title} — скопировать номер`;
        chip.addEventListener('click', () => copyArticleNumber(article, { remember: false }));
        chips.appendChild(chip);
    });
    row.appendChild(chips);

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'recent-clear';
    clear.title = 'Очистить недавние';
    clear.setAttribute('aria-label', 'Очистить недавние');
    clear.innerHTML = icon('i-x', 14);
    clear.addEventListener('click', clearRecentCopied);
    row.appendChild(clear);
}

// Кнопка с крестиком в конце строки: список недавних очищается целиком.
function clearRecentCopied() {
    dropRecentCopied();
    refreshRecentRow();
    showToast('Недавние очищены');
}

function isPinned(article) {
    return pinnedArticles.has(articleId(article));
}

function togglePinned(article) {
    const id = articleId(article);
    if (pinnedArticles.has(id)) {
        pinnedArticles.delete(id);
    } else {
        pinnedArticles.add(id);
    }
    storeSet(PINNED_KEY, JSON.stringify([...pinnedArticles]));
    renderArticles({ keepExpanded: true });
}

// ===== Баннер устаревших данных =====

// Источник данных -> время сохранения показанной копии.
const staleSources = new Map();

function removeStaleBanner() {
    const banner = document.getElementById('staleDataBanner');
    if (banner) banner.remove();
}

function updateStaleBanner() {
    removeStaleBanner();
    if (staleSources.size === 0) return;

    const savedAt = Math.min(...staleSources.values());
    const dateStr = new Date(savedAt).toLocaleString('ru-RU');
    const banner = document.createElement('div');
    banner.id = 'staleDataBanner';
    banner.className = 'stale';
    banner.innerHTML = `
        <span class="st-full">Не удалось обновить данные. Показана последняя сохранённая версия от ${dateStr}.</span>
        <span class="st-short" title="Показана последняя сохранённая версия от ${dateStr}">Данные не обновились</span>
        <button id="retryStaleBtn" class="btn" type="button">Обновить</button>
    `;
    document.querySelector('.top .wrap').appendChild(banner);
    document.getElementById('retryStaleBtn').addEventListener('click', reloadStaleSources);
}

function markStale(source, savedAt) {
    staleSources.set(source, savedAt);
    updateStaleBanner();
}

function markFresh(source) {
    staleSources.delete(source);
    updateStaleBanner();
}

function reloadStaleSources() {
    [...staleSources.keys()].forEach(source => DATA_LOADERS[source]());
}

// ===== Состояние загрузки =====

// 'loading' | 'ready' | 'error'
let articlesLoadState = 'loading';
let proceduralLoadState = 'loading';

function renderLoadState(container, state, errorText, onRetry) {
    container.className = '';
    if (state === 'loading') {
        container.innerHTML = `<div class="state-box"><div class="pulse"><i></i><i></i><i></i></div>Синхронизация данных...</div>`;
        return;
    }
    container.innerHTML = `
        <div class="state-box">
            <span>${errorText}</span>
            <button type="button" class="btn retry-btn">Повторить попытку</button>
        </div>
    `;
    container.querySelector('.retry-btn').addEventListener('click', onRetry);
}

function retryArticles() {
    articlesLoadState = 'loading';
    renderArticles();
    loadData();
}

function retryProcedural() {
    proceduralLoadState = 'loading';
    renderArticles();
    loadProceduralData();
}

// ===== Проверка листа =====
// При неверном имени листа Google молча отдаёт первый лист таблицы.

const PK_KNOWN_TYPES = ['steps', 'list', 'text'];

function looksLikeProceduralSheet(rows) {
    return rows.some(row => row.c && PK_KNOWN_TYPES.includes(getCellVal(row.c, 1).toLowerCase()));
}

// Сохранённая копия показывается сразу, свежие данные подменяют её после загрузки.
// quiet — обновление в фоне на открытой странице: его неудача не показывается.
async function loadData({ quiet = false } = {}) {
    const cached = loadCache(CACHE_KEY);
    if (cached && articlesLoadState !== 'ready') {
        parsedDatabase = cached.data;
        articlesLoadState = 'ready';
        renderArticles();
    }

    try {
        const fresh = await fetchArticles();

        saveCache(CACHE_KEY, fresh);
        const changed = articlesLoadState !== 'ready' || JSON.stringify(fresh) !== JSON.stringify(parsedDatabase);
        if (changed) {
            // Список уже на экране: выбор стрелками и раскрытые строки остаются на месте.
            const onScreen = articlesLoadState === 'ready';
            parsedDatabase = fresh;
            articlesLoadState = 'ready';
            renderArticles({ keepExpanded: onScreen });
        }
        markFresh('articles');
    } catch (e) {
        console.error(e);
        if (articlesLoadState === 'ready') {
            if (!quiet) markStale('articles', cached ? cached.savedAt : Date.now());
        } else {
            articlesLoadState = 'error';
            renderArticles();
        }
    }
}

// ===== Общая информация: загрузка данных =====

function parseProceduralRows(rows) {
    const items = [];
    rows.forEach((row) => {
        if (!row.c) return;
        const cells = row.c;
        const getVal = (idx) => getCellVal(cells, idx);

        const title = getVal(0);
        if (!title || title === "Заголовок") return; // пропускаем пустые строки и строку-заголовок таблицы

        items.push({
            title: title,
            type: getVal(1).toLowerCase(),
            content: getVal(2)
        });
    });
    return items;
}

// Отдельный лист, отдельная упрощённая структура полей — не смешивается с parsedDatabase.
async function loadProceduralData({ quiet = false } = {}) {
    const cached = loadCache(PK_CACHE_KEY);
    if (cached && proceduralLoadState !== 'ready') {
        proceduralData = cached.data;
        proceduralLoadState = 'ready';
        if (currentCode === 'pk') renderArticles();
    }

    try {
        const rows = await fetchGvizRows(PK_URL);
        if (looksLikeArticlesSheet(rows)) {
            throw new Error('Вместо листа "Общая информация" таблица вернула лист статей');
        }
        const fresh = parseProceduralRows(rows);
        if (fresh.length > 0 && fresh.every(item => item.content === '')) {
            throw new Error('Вместо листа "Общая информация" таблица вернула другой лист');
        }

        saveCache(PK_CACHE_KEY, fresh);
        const changed = proceduralLoadState !== 'ready' || JSON.stringify(fresh) !== JSON.stringify(proceduralData);
        if (changed) {
            proceduralData = fresh;
            proceduralLoadState = 'ready';
            if (currentCode === 'pk') renderArticles();
        }
        markFresh('procedural');
    } catch (e) {
        console.error('Не удалось загрузить данные раздела "Общая информация":', e);
        if (proceduralLoadState === 'ready') {
            if (!quiet) markStale('procedural', cached ? cached.savedAt : Date.now());
        } else {
            proceduralLoadState = 'error';
            if (currentCode === 'pk') renderArticles();
        }
    }
}

const DATA_LOADERS = {
    articles: loadData,
    procedural: loadProceduralData
};

// ===== Дата последней редакции: загрузка и уведомление =====

function showDbDate(dbDate) {
    document.querySelectorAll('.footer-meta-date').forEach(el => {
        el.textContent = `Последняя редакция: ${dbDate}`;
    });
}

// Лист "Последняя редакция": A1 — заголовок, A2 — дата (вписывается вручную).
async function loadMetaData() {
    const seenDate = storeGet(DB_DATE_SEEN_KEY);
    if (seenDate) showDbDate(seenDate);

    try {
        const rows = await fetchGvizRows(META_URL);
        if (looksLikeArticlesSheet(rows) || looksLikeProceduralSheet(rows)) {
            throw new Error('Вместо листа "Последняя редакция" таблица вернула другой лист');
        }
        for (const row of rows) {
            if (!row.c) continue;
            const value = getCellVal(row.c, 0);
            if (!value || value === 'Последняя редакция') continue;
            notifyDbDate(value);
            return;
        }
    } catch (e) {
        console.error('Не удалось загрузить дату последней редакции базы:', e);
    }
}

// Тост при первом заходе на сайт и при смене даты.
let notifiedDbDate = null;
function notifyDbDate(dbDate) {
    showDbDate(dbDate);

    if (storeGet(DB_DATE_SEEN_KEY) === dbDate || notifiedDbDate === dbDate) return;
    notifiedDbDate = dbDate;
    storeSet(DB_DATE_SEEN_KEY, dbDate);
    // Ждёт, пока скроется приветствие, — иначе заменит его на полуслове.
    setTimeout(() => showToast(`Последняя редакция: ${dbDate}`), Math.max(0, welcomeToastUntil - Date.now()));
}

// ===== Хелперы рендера строки статьи =====

// Ячейка типа статьи (Ф/Р и т.п.) с расшифровкой в title. Только для УК; пустая ячейка держит столбец.
function buildTypeCell(article) {
    const safeType = escapeHtml(article.type);
    if (!safeType || safeType === '-') return '<div class="cell cell-type"></div>';
    const typeLabel = TYPE_LABELS[article.type];
    return `<div class="cell cell-type"${typeLabel ? ` title="${escapeHtml(typeLabel)}"` : ''}>${safeType}</div>`;
}

// Ячейка кодекса (УК/АК/ДК) в цвет кодекса — только в результатах поиска.
function buildCodeCell(article) {
    return `<div class="cell code ${article.code}" title="${CODE_NAMES[article.code] || ''}">${CODE_LABELS[article.code] || ''}</div>`;
}

// Кнопка закрепления (иконка-булавка).
function buildPinButton(article) {
    const pinned = isPinned(article);
    const label = pinned ? 'Открепить статью' : 'Закрепить статью';
    return `<button type="button" class="pin" title="${label}" aria-label="${label}" aria-pressed="${pinned}">${icon('i-pin', 14)}</button>`;
}

// Обработчики строки: копирование номера, пин.
// stopPropagation нужен, потому что строка целиком кликабельна (раскрытие описания).
// На сенсорном экране номер не копируется: нажатие на него раскрывает описание, как и на остальную строку.
function attachArticleHandlers(row, article) {
    row.querySelector('.num').addEventListener('click', (e) => {
        if (touchQuery.matches) return;
        e.stopPropagation();
        copyArticleNumber(article, { cell: e.currentTarget });
    });

    row.querySelector('.pin').addEventListener('click', (e) => {
        e.stopPropagation();
        togglePinned(article);
    });
}

// ===== Toast-уведомления =====

// Переиспользует один DOM-элемент между вызовами.
const TOAST_DURATION_MS = 1800;
const WELCOME_TOAST_DURATION_MS = 3000;
let toastEl = null;
let toastHideTimer = null;
function showToast(message, duration = TOAST_DURATION_MS, strong = '') {
    if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.className = 'toast';
        toastEl.setAttribute('role', 'status');
        document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    // strong — вторая часть сообщения, жирным (номер скопированной статьи).
    if (strong) {
        const bold = document.createElement('b');
        bold.textContent = strong;
        toastEl.appendChild(bold);
    }

    clearTimeout(toastHideTimer);
    toastEl.classList.remove('on');
    // Форсируем reflow — иначе CSS-переход не перезапустится при быстром повторном клике.
    void toastEl.offsetWidth;
    toastEl.classList.add('on');

    toastHideTimer = setTimeout(() => {
        toastEl.classList.remove('on');
    }, duration);
}

// Приветствие — при каждом заходе на страницу.
let welcomeToastUntil = 0;
function showWelcomeToast() {
    welcomeToastUntil = Date.now() + WELCOME_TOAST_DURATION_MS + 300;
    showToast('Памятка по законодательной базе Orlando', WELCOME_TOAST_DURATION_MS);
}

// Ячейка номера ненадолго показывает «Скопировано»: надпись уже лежит в ячейке, класс copied меняет её с номером.
const COPIED_FLASH_MS = 1200;
function flashCopied(cell) {
    if (cell.classList.contains('copied')) return;
    cell.classList.add('copied');
    setTimeout(() => cell.classList.remove('copied'), COPIED_FLASH_MS);
}

// cell — ячейка номера в списке; при копировании из строки «Недавно скопированные» её нет.
function copyArticleNumber(article, { remember = true, cell = null } = {}) {
    const text = articleCopyText(article);

    const onFail = () => {
        console.warn('Не удалось скопировать номер статьи в буфер обмена');
        showToast('Не удалось скопировать');
    };

    if (!navigator.clipboard) {
        onFail();
        return;
    }

    navigator.clipboard.writeText(text)
        .then(() => {
            showToast('Скопировано:', TOAST_DURATION_MS, text);
            if (cell) flashCopied(cell);
            if (remember) rememberCopied(article);
        })
        .catch(onFail);
}

// ===== Основной рендер =====

// Строка «Найдено» в шапке, под вкладками: сколько статей в каждом кодексе и отбор по кодексу.
// Показывается, только когда найденное лежит в нескольких кодексах.
function renderFoundRow(counts) {
    const codes = Object.keys(CODE_LABELS).filter(code => counts[code]);
    if (codes.length < 2) return;

    const total = codes.reduce((sum, code) => sum + counts[code], 0);
    const row = document.getElementById('foundRow');
    row.innerHTML = '<span class="label">Найдено</span><div class="chips">'
        + `<button type="button" class="chip" data-code="" title="Показать всё найденное">Все ${total}</button>`
        + codes.map(code => `<button type="button" class="chip" data-code="${code}" title="Показать только найденное в ${CODE_LABELS[code]}"><i class="dot ${code}"></i>${CODE_LABELS[code]} ${counts[code]}</button>`).join('')
        + '</div><div class="keys"><kbd class="kbd">←</kbd><kbd class="kbd">→</kbd></div>';

    row.querySelectorAll('.chip').forEach(chip => {
        const code = chip.dataset.code || null;
        const isActive = code === searchCodeFilter;
        chip.classList.toggle('on', isActive);
        chip.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        chip.addEventListener('click', () => {
            if (code === searchCodeFilter) return;
            searchCodeFilter = code;
            renderArticles();
        });
    });
    syncSwitchHint();
}

// Подсказка «← → Сменить кодекс» скрыта, когда стрелкам нечего переключать: идёт поиск, а строки «Найдено» нет.
function syncSwitchHint() {
    const searching = document.getElementById('searchInput').value !== '';
    document.body.classList.toggle('no-switch', searching && !document.querySelector('#foundRow .chip'));
}

// Список перерисовывается в drawArticles; движение строк шапки при этом назначает updateHeaderRows.
function renderArticles(options) {
    const hadMouseMarker = markerByMouse;
    updateHeaderRows(() => drawArticles(options));
    // Отмеченной мышью статьи в новом списке нет: отметка переходит на ту, что теперь под курсором.
    if (hadMouseMarker && !keyboardSelectedId) {
        markerByMouse = false;
        if (hoverArmed && lastMouseX >= 0) markAt(document.elementFromPoint(lastMouseX, lastMouseY));
    }
}

function drawArticles({ keepExpanded = false } = {}) {
    const container = document.getElementById('articlesContainer');

    const rawQuery = document.getElementById('searchInput').value;
    renderedSearchText = rawQuery;
    listShowsSearch = false;
    if (!keepExpanded) keyboardSelectedId = null;
    syncKeyHintState();

    document.getElementById('foundRow').innerHTML = '';
    document.getElementById('recentRow').innerHTML = '';
    syncSwitchHint();

    const tabs = document.querySelector('.tabs');
    tabs.classList.remove('searching');

    // На вкладке "Общая информация" поиск идёт только по её карточкам.
    if (currentCode === 'pk') {
        const pkQuery = findWithFixes(rawQuery, { allowCodes: false },
            proceduralData, getProceduralSearchIndex, searchProceduralCards).query;
        container.className = '';
        renderProceduralCards(container, pkQuery.active ? pkQuery : null);
        return;
    }

    if (articlesLoadState !== 'ready') {
        renderLoadState(container, articlesLoadState,
            'Не удалось загрузить базу данных.<br>Проверьте интернет-соединение и попробуйте снова.', retryArticles);
        return;
    }

    const found = findWithFixes(rawQuery, {}, parsedDatabase, getArticleSearchIndex, searchArticles);
    const query = found.query.active ? found.query : null;
    listShowsSearch = Boolean(query);

    tabs.classList.toggle('searching', Boolean(query));

    // Сколько статей найдено в каждом кодексе; отбор по кодексу снимается, если в нём ничего не нашлось.
    const counts = {};
    if (query) found.results.forEach(({ article }) => { counts[article.code] = (counts[article.code] || 0) + 1; });
    if (!counts[searchCodeFilter]) searchCodeFilter = null;

    let matchedArticles = [];

    if (query) {
        matchedArticles = searchCodeFilter
            ? found.results.filter(({ article }) => article.code === searchCodeFilter)
            : found.results;
    } else {
        parsedDatabase.forEach(article => {
            if (article.code !== currentCode) return;
            if (currentDisplayMode === 'compact' && article.frequency === 'rare' && !isPinned(article)) return;
            matchedArticles.push({ article });
        });

        // Вне поиска — закреплённые статьи первыми (сортировка стабильна).
        matchedArticles.sort((a, b) => (isPinned(b.article) ? 1 : 0) - (isPinned(a.article) ? 1 : 0));
    }

    const expandedIds = new Set();
    // Части, вставленные под строку нажатием на плашку: после перерисовки возвращаются под ту же строку.
    const insertedParts = [];
    if (keepExpanded) {
        container.querySelectorAll('.row.open').forEach(row => expandedIds.add(row.dataset.articleId));
        container.querySelectorAll('.row[data-inserted="true"]').forEach(row => {
            let anchor = row.previousElementSibling;
            while (anchor && anchor.dataset.inserted === 'true') anchor = anchor.previousElementSibling;
            if (anchor) insertedParts.push({ id: row.dataset.articleId, anchorId: anchor.dataset.articleId });
        });
    }

    container.innerHTML = "";
    container.className = 'list';

    if (matchedArticles.length === 0) {
        const examplesHtml = query
            ? '<div class="loader-hint">Можно искать по номеру (12.8), по слову (кража) или по ситуации (угнал машину).</div>'
            : '';
        container.innerHTML = `<div class="loader">По запросу ничего не найдено. Попробуйте описать иначе.${examplesHtml}</div>`;
        return;
    }

    renderAsList(container, matchedArticles, query, expandedIds);
    insertedParts.forEach(({ id, anchorId }) => {
        const rows = articleElements();
        if (rows.some(row => row.dataset.articleId === id)) return;
        const anchor = rows.find(row => row.dataset.articleId === anchorId);
        if (anchor) insertArticlePart(anchor, id, query, expandedIds.has(id));
    });
    restoreKeyboardSelection();
    renderRecentRow();
    if (query) renderFoundRow(counts);
    headerRowsSeen = true;

    if (!query && currentDisplayMode === 'compact') {
        const total = parsedDatabase.filter(article => article.code === currentCode).length;
        if (matchedArticles.length < total) renderCompactHint(container, matchedArticles.length, total);
    }
}

// В режиме «Основные» под списком — сколько статей показано и кнопка «Показать все».
function renderCompactHint(container, shown, total) {
    const hint = document.createElement('div');
    hint.className = 'list-hint';
    hint.innerHTML = `Показаны основные статьи: ${shown} из ${total}. <button type="button" class="btn list-hint-btn">Показать все</button>`;
    hint.querySelector('.list-hint-btn').addEventListener('click', () => {
        setDisplayMode('full');
        scrollToListTop();
    });
    container.appendChild(hint);
}

// Склонение "звезда/звезды/звёзд" с учётом исключений 11-14.
function pluralizeStars(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return 'звезда';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'звезды';
    return 'звёзд';
}

function starsTitle(article) {
    const runs = article.stars.match(/★+/g);
    if (!runs) return 'Розыск';
    const count = runs[runs.length - 1].length;
    if (runs.length > 1) return `от ${runs[0].length} до ${count} звёзд`;
    return `${count} ${pluralizeStars(count)}`;
}

function buildHighlightedFields(article, query) {
    return {
        title: highlightText(article.title, query),
        num: highlightArticleNum(article.num, query),
        desc: highlightText(article.desc, query).replace(/\n/g, '<br>'),
    };
}

// ===== Другие части статьи =====

// Статьи с тем же номером до «ч.»: для «6.1 ч.1» это «6.1 ч.2» и «6.1 ч.3».
const articleGroupsCache = new WeakMap();

function articleBaseNum(article) {
    return (article.num.match(NUM_BASE_RE) || [''])[0];
}

function articleSiblings(article) {
    let groups = articleGroupsCache.get(parsedDatabase);
    if (!groups) {
        groups = new Map();
        parsedDatabase.forEach(item => {
            const key = `${item.code}::${articleBaseNum(item)}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(item);
        });
        articleGroupsCache.set(parsedDatabase, groups);
    }
    return (groups.get(`${article.code}::${articleBaseNum(article)}`) || []).filter(item => item !== article);
}

// Плашки других частей под описанием в раскрытой строке списка.
function buildPartsHtml(article) {
    const siblings = articleSiblings(article);
    if (siblings.length === 0) return '';
    const base = articleBaseNum(article);
    const pills = siblings.map(item => {
        const part = item.num.slice(base.length).trim() || `ст. ${item.num}`;
        return `<button type="button" class="part" data-part-id="${escapeHtml(articleId(item))}" title="ст. ${escapeHtml(item.num)} — ${escapeHtml(item.title)}"><b>${escapeHtml(part)}</b><span>${escapeHtml(item.title)}</span></button>`;
    }).join('');
    return `<div class="parts"><span class="label">Другие части</span><div class="parts-list">${pills}</div></div>`;
}

// Прокрутка к строке так, чтобы она не оказалась под закреплённой шапкой или под полосой подсказок.
function revealInList(el, smooth = false) {
    // На низком экране шапка не прилипает и строку не закрывает.
    const header = document.querySelector('.top');
    // Строка шапки ещё появляется — её движение завершается сразу, иначе высота шапки измерится неполной.
    header.getAnimations({ subtree: true }).forEach(animation => animation.finish());
    const sticky = getComputedStyle(header).position === 'sticky';
    el.style.scrollMarginTop = `${(sticky ? header.offsetHeight : 0) + 8}px`;
    el.style.scrollMarginBottom = `${document.querySelector('.keybar').offsetHeight + 12}px`;
    el.scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' });
}

// Строка части, которой нет в списке, вставляется под исходной строкой.
function insertArticlePart(fromRow, id, query, isExpanded = false) {
    const article = parsedDatabase.find(item => articleId(item) === id);
    if (!article) return null;
    const target = buildListRow(article, query, isExpanded);
    target.dataset.inserted = 'true';
    // Вставленные части идут под исходной строкой в порядке номеров.
    const order = el => parsedDatabase.findIndex(item => articleId(item) === el.dataset.articleId);
    let anchor = fromRow;
    while (anchor.nextElementSibling && anchor.nextElementSibling.dataset.inserted === 'true'
        && order(anchor.nextElementSibling) < order(target)) {
        anchor = anchor.nextElementSibling;
    }
    anchor.after(target);
    return target;
}

// Нажатие на плашку части: её строка раскрывается; если строки нет в списке — вставляется под текущей.
function openArticlePart(fromRow, id, query) {
    const rows = Array.from(fromRow.parentElement.querySelectorAll('.row'));
    let target = rows.find(item => item.dataset.articleId === id);
    if (!target) {
        target = insertArticlePart(fromRow, id, query);
        if (!target) return;
        void target.offsetWidth; // чтобы раскрытие вставленной строки было плавным
    }
    target.classList.add('open');
    target.querySelector('.grid').setAttribute('aria-expanded', 'true');
    revealInList(target, true);
}

// ===== Отрисовка: список =====

// Фильтрация/поиск/сортировка уже выполнены в renderArticles(). Строка кликабельна —
// раскрывает/скрывает полное описание.
function renderAsList(container, matchedArticles, query, expandedIds) {
    matchedArticles.forEach(({ article }) => {
        container.appendChild(buildListRow(article, query, expandedIds.has(articleId(article))));
    });
}

// Ширины столбцов строки в раскладке «таблица».
const ROW_COLS = {
    bar: '4px', code: '44px', num: '164px', type: '50px', title: 'minmax(0, 1fr)',
    extraUk: 'var(--w-extra-uk, 240px)', extra: '280px', fine: '208px', stars: '104px', term: '132px', chev: '40px'
};

function buildListRow(article, query, isExpanded) {
    const isUk = article.code === 'uk';
    const hasFelony = hasFelonyRecord(article);
    const { title: highlightedTitle, num: highlightedNum, desc: highlightedDesc } =
        buildHighlightedFields(article, query);

    const safeFine = escapeHtml(article.fine);
    const safeArrest = escapeHtml(article.arrest);
    const safeExtraMeasure = escapeHtml(article.extraMeasure);
    let arrestTitle = 'Арест';
    if (safeArrest) {
        arrestTitle = isUk ? `${safeArrest}, ${hasFelony ? 'судимость' : 'без судимости'}` : `Арест: ${safeArrest}`;
    }
    const extraHtml = `<div class="cell extra" title="${safeExtraMeasure}">${safeExtraMeasure}</div>`;

    const cells = {
        code: buildCodeCell(article),
        num: `<div class="cell num" title="Скопировать номер статьи"><span class="num-text">ст. ${highlightedNum}</span><span class="ico">${icon('i-copy', 14)}</span><span class="num-done">${icon('i-check', 14)}Скопировано</span></div>`,
        type: buildTypeCell(article),
        title: `<div class="cell cell-title">${buildPinButton(article)}<span title="${escapeHtml(article.title)}">${highlightedTitle}</span></div>`,
        extraUk: extraHtml,
        extra: extraHtml,
        fine: safeFine
            ? `<div class="cell fine money" title="Штраф: ${safeFine}"><span>${wrapBeforeWord(article.fine, 'до')}</span></div>`
            : '<div class="cell fine empty" title="Штраф">—</div>',
        stars: `<div class="cell" title="${starsTitle(article)}">${buildStarsHtml(article) || '<span class="empty">—</span>'}</div>`,
        term: safeArrest
            ? `<div class="cell term ${hasFelony ? 'felony' : ''}" title="${arrestTitle}"><span>${wrapBeforeWord(article.arrest, 'или')}</span>${hasFelony ? '<span class="fel-cap">судимость</span>' : ''}</div>`
            : `<div class="cell empty" title="${arrestTitle}">—</div>`
    };

    // УК — [доп. мера], штраф, звёзды, срок. АК и ДК — [звёзды, срок], [доп. мера], штраф.
    // Доп. мера, а у АК и ДК и звёзды со сроком — только если заполнены.
    const hasPenalty = Boolean(article.stars || article.arrest);
    const mainCols = [query && 'code', 'num', isUk && 'type', 'title'].filter(Boolean);
    const penCols = (isUk
        ? [article.extraMeasure && 'extraUk', 'fine', 'stars', 'term']
        : [hasPenalty && 'stars', hasPenalty && 'term', article.extraMeasure && 'extra', 'fine']).filter(Boolean);
    const cols = ['bar', ...mainCols, ...penCols, 'chev'].map(name => ROW_COLS[name]).join(' ');

    const row = document.createElement('div');
    row.className = `row ${article.code} ${penCols.length === 1 ? 'single' : ''} ${isPinned(article) ? 'pinned' : ''} ${isExpanded ? 'open' : ''}`;
    row.dataset.articleId = articleId(article);

    row.innerHTML = `
        <div class="grid" style="--cols: ${cols}" role="button" tabindex="0" aria-expanded="${isExpanded}">
            <div class="row-bar"></div>
            <div class="row-main">${mainCols.map(name => cells[name]).join('')}</div>
            <div class="row-pen">${penCols.map(name => cells[name]).join('')}</div>
            <div class="cell cell-chev">${icon('i-chev', 14)}</div>
        </div>
        <div class="row-body">
            <div class="row-body-in">
                <div class="row-body-pad">
                    <div class="row-desc">${highlightedDesc}</div>
                    ${buildPartsHtml(article)}
                </div>
            </div>
        </div>
    `;

    attachArticleHandlers(row, article);

    row.querySelectorAll('.part').forEach(btn => btn.addEventListener('click', () => {
        openArticlePart(row, btn.dataset.partId, query);
    }));

    const header = row.querySelector('.grid');
    const toggleExpanded = () => {
        const willExpand = !row.classList.contains('open');
        row.classList.toggle('open', willExpand);
        header.setAttribute('aria-expanded', String(willExpand));
    };
    header.addEventListener('click', toggleExpanded);
    header.addEventListener('keydown', (e) => {
        if (e.target.closest('.pin')) return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleExpanded();
        }
    });

    return row;
}

// ===== Общая информация: диспетчер шаблонов =====
const PK_TEMPLATES = {
    steps: renderPkSteps,
    list: renderPkList,
};

function buildPkItems(content, query) {
    return content.split('\n').map(s => s.trim()).filter(Boolean)
        .map(line => `<li><span>${highlightText(line, query)}</span></li>`).join('');
}

function renderPkSteps(content, query) {
    return `<ol>${buildPkItems(content, query)}</ol>`;
}

// Маркированный список — порядок пунктов не важен (в отличие от "steps")
function renderPkList(content, query) {
    return `<ul>${buildPkItems(content, query)}</ul>`;
}

// Safe-fallback для "text" и неизвестных значений — карточка не теряется молча.
function renderPkFallback(content, query) {
    return `<p>${highlightText(content, query).replace(/\n/g, '<br>')}</p>`;
}

function renderProceduralCardBody(item, query) {
    const renderer = PK_TEMPLATES[item.type];
    return renderer ? renderer(item.content, query) : renderPkFallback(item.content, query);
}

function renderProceduralCards(container, query = null) {
    if (proceduralLoadState !== 'ready') {
        renderLoadState(container, proceduralLoadState,
            'Не удалось загрузить раздел.<br>Проверьте интернет-соединение и попробуйте снова.', retryProcedural);
        return;
    }

    container.innerHTML = '';

    if (proceduralData.length === 0) {
        container.innerHTML = `<div class="loader">Раздел пока пуст.</div>`;
        return;
    }

    const items = query ? searchProceduralCards(query) : proceduralData;

    if (items.length === 0) {
        container.innerHTML = `<div class="loader">По запросу ничего не найдено. Попробуйте описать иначе.</div>`;
        return;
    }

    container.className = 'info';
    items.forEach(item => {
        const card = document.createElement('div');
        card.className = 'info-card';

        card.innerHTML = `
            <div class="info-title" title="${escapeHtml(item.title)}">${highlightText(item.title, query)}</div>
            <div class="info-body">${renderProceduralCardBody(item, query)}</div>
        `;
        container.appendChild(card);
    });
}

// Раскладка «карточки» (телефон) — при ширине страницы до 639 px, как в style.css.
function isCardsLayout() {
    return document.querySelector('.app').clientWidth <= 639;
}

const SEARCH_PLACEHOLDER_DEFAULT = document.getElementById('searchInput').placeholder;
const SEARCH_PLACEHOLDER_SHORT = 'Ситуация, слово или номер...';
const SEARCH_PLACEHOLDER_PK = 'Поиск по общей информации...';
// Самый узкий экран (до 359 px): подписи ещё короче, иначе они обрезаются.
const SEARCH_PLACEHOLDER_TINY = 'Ситуация или номер...';
const SEARCH_PLACEHOLDER_PK_TINY = 'Поиск по информации...';

function syncSearchPlaceholder() {
    const tiny = document.querySelector('.app').clientWidth <= 359;
    const narrow = isCardsLayout() ? SEARCH_PLACEHOLDER_SHORT : SEARCH_PLACEHOLDER_DEFAULT;
    const text = currentCode === 'pk'
        ? (tiny ? SEARCH_PLACEHOLDER_PK_TINY : SEARCH_PLACEHOLDER_PK)
        : (tiny ? SEARCH_PLACEHOLDER_TINY : narrow);
    document.getElementById('searchInput').placeholder = text;
}

document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', (e) => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('on'));
    e.currentTarget.classList.add('on');
    currentCode = e.currentTarget.getAttribute('data-code');

    clearTimeout(searchDebounceTimer);
    const searchInput = document.getElementById('searchInput');
    if (searchInput.value !== "") {
        searchInput.value = "";
    }
    syncSearchClearBtn();
    syncSearchPlaceholder();
    renderArticles();
    swapInList();
    scrollToListTop();
}));

// Список появляется коротким движением при смене вкладки или режима; при наборе запроса — нет.
function swapInList() {
    const container = document.getElementById('articlesContainer');
    container.classList.remove('swap');
    void container.offsetWidth;
    container.classList.add('swap');
}

// ===== Переключатель режима отображения =====

function syncModeToggleUI() {
    document.querySelectorAll('.mode-btn').forEach(btn => {
        const isActive = btn.getAttribute('data-mode') === currentDisplayMode;
        btn.classList.toggle('on', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

const DISPLAY_MODE_TOAST = {
    compact: 'Основные статьи',
    full: 'Все статьи'
};

function setDisplayMode(selectedMode) {
    if (selectedMode === currentDisplayMode) return;
    currentDisplayMode = selectedMode;
    storeSet(DISPLAY_MODE_KEY, currentDisplayMode);
    syncModeToggleUI();
    renderArticles();
    swapInList();
    showToast(DISPLAY_MODE_TOAST[currentDisplayMode]);
}

document.querySelectorAll('.mode-btn').forEach(btn => btn.addEventListener('click', (e) => {
    setDisplayMode(e.currentTarget.getAttribute('data-mode'));
}));

syncModeToggleUI();

// ===== Подсказки клавиш: полоса внизу и значки клавиш =====
const KEY_HINTS_KEY = STORAGE_PREFIX + 'key_hints';
let keyHintsOn = storeGet(KEY_HINTS_KEY) !== 'off';

function syncKeyHintsUI() {
    document.body.classList.toggle('keys-on', keyHintsOn && !touchQuery.matches);
    document.querySelectorAll('.hints-btn').forEach(btn => {
        const isActive = (btn.getAttribute('data-hints') === 'on') === keyHintsOn;
        btn.classList.toggle('on', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

document.querySelectorAll('.hints-btn').forEach(btn => btn.addEventListener('click', (e) => {
    keyHintsOn = e.currentTarget.getAttribute('data-hints') === 'on';
    storeSet(KEY_HINTS_KEY, keyHintsOn ? 'on' : 'off');
    syncKeyHintsUI();
}));

syncKeyHintsUI();

// ===== Масштаб страницы =====
function applyZoom() {
    document.documentElement.style.zoom = (touchQuery.matches ? 100 : currentZoom) + '%';
}

const zoomValue = document.getElementById('zoomValue');
const zoomMinusBtn = document.getElementById('zoomMinusBtn');
const zoomPlusBtn = document.getElementById('zoomPlusBtn');

function updateZoomUI() {
    zoomValue.textContent = currentZoom + '%';
    zoomMinusBtn.disabled = currentZoom <= ZOOM_MIN;
    zoomPlusBtn.disabled = currentZoom >= ZOOM_MAX;
}

function setZoom(newZoom) {
    newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoom));
    if (newZoom === currentZoom) return;
    currentZoom = newZoom;
    applyZoom();
    updateZoomUI();
    storeSet(ZOOM_KEY, String(currentZoom));
    fitSettingsPanel();
}

zoomMinusBtn.addEventListener('click', () => {
    setZoom(currentZoom - ZOOM_STEP);
});

zoomPlusBtn.addEventListener('click', () => {
    setZoom(currentZoom + ZOOM_STEP);
});

applyZoom();
updateZoomUI();

// ===== Сенсорный экран =====
// Подсказки клавиш, масштаб и копирование номера на нём не действуют.
function syncTouchMode() {
    document.body.classList.toggle('touch', touchQuery.matches);
    syncKeyHintsUI();
    applyZoom();
}

touchQuery.addEventListener('change', () => {
    syncTouchMode();
    refreshRecentRow();
});
syncTouchMode();

// ===== Панель настроек =====
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');

// Уведомление встаёт над открытым листом настроек, а не под ним: высота листа уходит в --sheet-h.
function syncSheetHeight() {
    const sheetOpen = settingsPanel.classList.contains('open') && settingsPanel.classList.contains('sheet');
    document.body.style.setProperty('--sheet-h', sheetOpen ? `${settingsPanel.offsetHeight}px` : '0px');
}

function closeSettingsPanel() {
    settingsPanel.classList.remove('open');
    settingsBtn.setAttribute('aria-expanded', 'false');
    syncSheetHeight();
}

// В раскладке «карточки» панель — лист у нижнего края окна. Лист переносится из шапки в конец страницы:
// внутри .app его position: fixed мог бы отсчитываться от страницы, а не от окна.
const settingsWrapper = settingsPanel.parentElement;

function placeSettingsPanel() {
    const asSheet = isCardsLayout();
    settingsPanel.classList.toggle('sheet', asSheet);
    (asSheet ? document.body : settingsWrapper).appendChild(settingsPanel);
}

// Панель не выходит за нижний край окна и не уходит под полосу подсказок клавиш:
// если она выше свободного места, её содержимое прокручивается.
function fitSettingsPanel() {
    settingsPanel.classList.remove('tight');
    settingsPanel.style.maxHeight = '';
    if (!settingsPanel.classList.contains('open')) return;
    const zoom = touchQuery.matches ? 1 : currentZoom / 100;
    const top = settingsPanel.classList.contains('sheet') ? 12 : settingsPanel.getBoundingClientRect().top;
    const keybar = document.querySelector('.keybar');
    const floor = keybar.offsetHeight ? keybar.getBoundingClientRect().top : window.innerHeight;
    const room = Math.floor((floor - top - 12) / zoom);
    if (settingsPanel.offsetHeight > room) {
        settingsPanel.classList.add('tight');
        settingsPanel.style.maxHeight = `${Math.max(140, room)}px`;
    }
}

function toggleSettingsPanel() {
    const willOpen = !settingsPanel.classList.contains('open');
    if (willOpen) placeSettingsPanel();
    settingsPanel.classList.toggle('open', willOpen);
    settingsBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    fitSettingsPanel();
    syncSheetHeight();
}

window.addEventListener('resize', fitSettingsPanel);

settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSettingsPanel();
});

settingsPanel.addEventListener('click', (e) => {
    e.stopPropagation();
});

document.getElementById('settingsCloseBtn').addEventListener('click', closeSettingsPanel);

document.addEventListener('click', () => {
    closeSettingsPanel();
});

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (settingsPanel.classList.contains('open')) {
        closeSettingsPanel();
    } else if (searchField.value !== '') {
        clearSearch();
    } else {
        // Поиск пуст: Esc снимает выбор статьи и возвращает курсор в поле поиска.
        // На низком экране шапка не прилипает: если поле ушло за край окна, страница прокручивается к нему.
        selectByKeyboard(null);
        const sticky = getComputedStyle(document.querySelector('.top')).position === 'sticky';
        searchField.focus({ preventScroll: sticky });
    }
});

// ===== Кнопка "наверх" =====
const SCROLL_TOP_THRESHOLD = 600;
const scrollTopBtn = document.getElementById('scrollTopBtn');
let scrollTicking = false;

function updateScrollTopVisibility() {
    scrollTopBtn.classList.toggle('on', window.scrollY > SCROLL_TOP_THRESHOLD);
    scrollTicking = false;
}

window.addEventListener('scroll', () => {
    if (!scrollTicking) {
        requestAnimationFrame(updateScrollTopVisibility);
        scrollTicking = true;
    }
});

function scrollToListTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

scrollTopBtn.addEventListener('click', scrollToListTop);

updateScrollTopVisibility();

// ===== Поле поиска: очистка =====
const searchField = document.getElementById('searchInput');
const searchClearBtn = document.getElementById('searchClearBtn');

// Пока в поле есть текст, видны крестик и значок Esc, а стрелки у вкладок скрыты.
function syncSearchClearBtn() {
    document.body.classList.toggle('has-query', searchField.value !== '');
    syncSwitchHint();
}

function clearSearch() {
    clearTimeout(searchDebounceTimer);
    searchField.value = '';
    syncSearchClearBtn();
    renderArticles();
    scrollToListTop();
    searchField.focus();
}

searchField.addEventListener('input', () => {
    syncSearchClearBtn();
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
        renderArticles();
        scrollToListTop();
    }, 150);
});

if (searchClearBtn) searchClearBtn.addEventListener('click', clearSearch);

// ===== Управление с клавиатуры: стрелки выбирают статью, Ctrl+C копирует её номер =====

function articleElements() {
    return Array.from(document.querySelectorAll('#articlesContainer [data-article-id]'));
}

// Полоса подсказок показывает клавиши по обстановке: выбрана ли статья, открыта ли «Общая информация».
function syncKeyHintState() {
    document.body.classList.toggle('is-selected', Boolean(keyboardSelectedId) && !markerByMouse);
    document.body.classList.toggle('on-info', currentCode === 'pk');
}

function selectByKeyboard(el) {
    document.querySelectorAll('#articlesContainer .selected').forEach(other => other.classList.remove('selected'));
    keyboardSelectedId = el ? el.dataset.articleId : null;
    markerByMouse = false;
    syncKeyHintState();
    if (!el) return;
    el.classList.add('selected');
    revealInList(el);
}

// Отметка переходит на статью под курсором мыши; страница при этом не прокручивается.
// Без статьи (id пуст) снимается только отметка, поставленная мышью: выбор стрелками уход курсора не трогает.
function markByMouse(id) {
    if (id ? (id === keyboardSelectedId && markerByMouse) : !markerByMouse) return;
    document.querySelectorAll('#articlesContainer .selected').forEach(other => other.classList.remove('selected'));
    keyboardSelectedId = id;
    markerByMouse = Boolean(id);
    const el = id ? articleElements().find(item => item.dataset.articleId === id) : null;
    if (el) el.classList.add('selected');
    syncKeyHintState();
}

// Что под курсором: статья — отметка на неё; промежуток между строками списка — отметка остаётся;
// всё остальное — отметка, поставленная мышью, снимается.
function markAt(node) {
    const id = articleIdAt(node);
    if (!id && node instanceof Element && node.closest('#articlesContainer.list')) return;
    hoverTargetId = id;
    markByMouse(id);
}

// После перерисовки без смены выдачи (например, закрепление) выбор остаётся на той же статье.
function restoreKeyboardSelection() {
    if (!keyboardSelectedId) return;
    const el = articleElements().find(item => item.dataset.articleId === keyboardSelectedId);
    if (el) el.classList.add('selected');
    else keyboardSelectedId = null;
    syncKeyHintState();
}

// Набранный запрос применяется сразу, без ожидания паузы после ввода: иначе клавиша сработала бы
// по прежнему списку, а через мгновение он бы сменился.
function applyPendingSearch() {
    clearTimeout(searchDebounceTimer);
    if (searchField.value !== renderedSearchText) renderArticles();
}

// Переход по кнопкам строки «Найдено» стрелками влево и вправо; после перехода выбрана первая статья выдачи.
// Возвращает false, если строки «Найдено» нет.
function shiftFoundCategory(step) {
    const chips = Array.from(document.querySelectorAll('#foundRow .chip'));
    if (chips.length === 0) return false;
    const next = chips[chips.findIndex(chip => chip.classList.contains('on')) + step];
    if (next) {
        searchCodeFilter = next.dataset.code || null;
        renderArticles();
        selectByKeyboard(articleElements()[0] || null);
        scrollToListTop();
    }
    return true;
}

// Переход на соседнюю вкладку стрелками влево и вправо, когда поиска нет.
function shiftTab(step) {
    const tabs = Array.from(document.querySelectorAll('.tab'));
    const next = tabs[tabs.findIndex(tab => tab.classList.contains('on')) + step];
    if (next) next.click();
}

// Раскрывает или сворачивает описание статьи, выбранной стрелками.
function toggleSelectedDescription() {
    const el = articleElements().find(item => item.dataset.articleId === keyboardSelectedId);
    if (!el) return;
    closeSettingsPanel();
    el.querySelector('.grid').click();
    setTimeout(() => revealInList(el, true), 230);
}

// Щелчок по полю поиска снимает выбор статьи: стрелки влево и вправо снова двигают курсор по тексту.
searchField.addEventListener('mousedown', () => {
    selectByKeyboard(null);
});

// ===== Статья под курсором мыши =====
// Ctrl+C и пробел действуют и на статью, на которую наведена мышь, — выбирать её стрелками не нужно.
// Наведение учитывается, только пока мышью пользовались позже, чем клавиатурой: во время набора запроса
// пробел остаётся пробелом, а после стрелок клавиши относятся к выбранной ими статье.
const HOVER_AFTER_KEY_MS = 400;
let hoverArmed = false;
let hoverTargetId = null;
// Положение прокрутки, при котором найдена статья под курсором. Если страница с тех пор прокручена,
// под курсором уже другая статья — какая, выясняется при нажатии клавиши.
let hoverScrollY = 0;
let lastMouseX = -1;
let lastMouseY = -1;
let lastTypedAt = 0;

function articleIdAt(node) {
    const el = node instanceof Element ? node.closest('#articlesContainer [data-article-id]') : null;
    return el ? el.dataset.articleId : null;
}

// Пока курсор над списком статей, полоса подсказок показывает клавиши для статьи под курсором.
function syncPointingState(node) {
    const overList = node instanceof Element && Boolean(node.closest('#articlesContainer.list'));
    document.body.classList.toggle('is-pointing', hoverArmed && overList);
}

function disarmHover() {
    hoverArmed = false;
    syncPointingState(null);
}

function trackMouse(e) {
    if (touchQuery.matches) return;
    const pressed = e.type === 'mousedown';
    // Страница сдвинулась под неподвижным курсором — это не движение мыши.
    if (!pressed && e.clientX === lastMouseX && e.clientY === lastMouseY) return;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    // Мышь задели во время набора запроса — клавиатура остаётся главной. Нажатие кнопки мыши случайным не считается.
    if (!pressed && !hoverArmed && Date.now() - lastTypedAt < HOVER_AFTER_KEY_MS) return;
    hoverArmed = true;
    markAt(e.target);
    hoverScrollY = window.scrollY;
    syncPointingState(e.target);
}

document.addEventListener('mousemove', trackMouse);
document.addEventListener('mousedown', trackMouse);

document.addEventListener('wheel', (e) => {
    if (touchQuery.matches || (!hoverArmed && Date.now() - lastTypedAt < HOVER_AFTER_KEY_MS)) return;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    hoverArmed = true;
    hoverScrollY = NaN;
    syncPointingState(e.target);
}, { passive: true });

document.documentElement.addEventListener('mouseleave', () => {
    lastMouseX = -1;
    lastMouseY = -1;
    markAt(null);
    hoverScrollY = window.scrollY;
    syncPointingState(null);
});

// Страница прокручивается под неподвижным курсором: отметка переходит на статью, которая оказалась под ним.
let markerScrollTicking = false;
window.addEventListener('scroll', () => {
    if (!hoverArmed || lastMouseX < 0 || markerScrollTicking) return;
    markerScrollTicking = true;
    requestAnimationFrame(() => {
        markerScrollTicking = false;
        if (!hoverArmed || lastMouseX < 0) return;
        markAt(document.elementFromPoint(lastMouseX, lastMouseY));
        hoverScrollY = window.scrollY;
    });
}, { passive: true });

// Строка статьи под курсором — если мышью пользовались последней.
function hoveredArticleEl() {
    if (!hoverArmed) return null;
    if (window.scrollY !== hoverScrollY) {
        hoverTargetId = lastMouseX < 0 ? null : articleIdAt(document.elementFromPoint(lastMouseX, lastMouseY));
        hoverScrollY = window.scrollY;
    }
    if (!hoverTargetId) return null;
    return articleElements().find(item => item.dataset.articleId === hoverTargetId) || null;
}

// Срабатывает раньше остальных обработчиков клавиш. Пробел по статье под курсором раскрывает её описание,
// как щелчок по строке: он не попадает в запрос и не нажимает кнопку, на которой стоит фокус.
// Любая другая клавиша, кроме Ctrl+C, возвращает управление клавиатуре.
document.addEventListener('keydown', (e) => {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

    if (e.key === ' ' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        const el = currentCode === 'pk' ? null : hoveredArticleEl();
        if (el) {
            e.preventDefault();
            e.stopPropagation();
            if (e.repeat) return;
            closeSettingsPanel();
            el.querySelector('.grid').click();
            return;
        }
    }

    if (e.code === 'KeyC' && e.ctrlKey && !e.altKey && !e.shiftKey) return;
    lastTypedAt = Date.now();
    // Отметку, поставленную мышью, стрелки вверх и вниз подхватывают и ведут дальше; любая другая клавиша её снимает.
    if (markerByMouse) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            markerByMouse = false;
            syncKeyHintState();
        } else {
            markByMouse(null);
        }
    }
    disarmHover();
}, true);

// Ctrl+C копирует номер статьи под курсором мыши, а если мышью не пользовались — выбранной стрелками.
// Если выделен текст — в поле поиска или на странице — копируется он, как обычно.
// Клавиша определяется по положению (KeyC), раскладка не важна.
document.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyC' || !e.ctrlKey || e.altKey || e.shiftKey) return;
    applyPendingSearch();
    const el = hoveredArticleEl() || articleElements().find(item => item.dataset.articleId === keyboardSelectedId);
    if (!el) return;
    if (document.activeElement === searchField && searchField.selectionStart !== searchField.selectionEnd) return;
    if (String(window.getSelection()) !== '') return;
    const article = parsedDatabase.find(item => articleId(item) === el.dataset.articleId);
    if (!article) return;
    e.preventDefault();
    closeSettingsPanel();
    copyArticleNumber(article, { cell: el.querySelector('.num') });
});

// Щелчок мышью не оставляет фокус на кнопке или строке: иначе следующий пробел или Enter нажал бы её ещё раз,
// а первая же клавиша нарисовала бы вокруг неё рамку фокуса. Переход клавишей Tab работает как обычно:
// у нажатия с клавиатуры detail равен нулю.
document.addEventListener('click', (e) => {
    if (e.detail === 0) return;
    const active = document.activeElement;
    if (!active || active === document.body || active.closest('input, textarea, select, [contenteditable]')) return;
    active.blur();
});

// Печать где угодно попадает в поиск: курсор переходит в поле, и набранный знак вводится уже в него.
// Так же работает Backspace, пока в запросе есть что стирать.
document.addEventListener('keydown', (e) => {
    const typing = e.key.length === 1 && e.key !== ' ';
    const erasing = e.key === 'Backspace' && searchField.value !== '';
    if ((!typing && !erasing) || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) return;
    closeSettingsPanel();
    searchField.focus({ preventScroll: true });
    searchField.setSelectionRange(searchField.value.length, searchField.value.length);
});

// Клавиши слушаются на всей странице: стрелки работают и после нажатия на вкладку, настройки или строку списка.
document.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) return;
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;

    const inSearch = e.target === searchField;
    if (!inSearch && e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) return;

    applyPendingSearch();

    // Фокус уходит с кнопки или строки, чтобы следующий пробел раскрыл описание, а не нажал её.
    const releaseFocus = () => {
        if (!inSearch && document.activeElement !== document.body) document.activeElement.blur();
    };

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const step = e.key === 'ArrowRight' ? 1 : -1;
        // В открытых настройках стрелки влево и вправо меняют масштаб.
        if (settingsPanel.classList.contains('open')) {
            e.preventDefault();
            setZoom(currentZoom + step * ZOOM_STEP);
            return;
        }

        // В поле поиска эти стрелки двигают курсор по тексту. Списку они достаются, когда статья уже выбрана
        // стрелками или когда курсору некуда двигаться в эту сторону (поле пустое, курсор на краю текста).
        const caretAtEdge = step === 1
            ? searchField.selectionStart === searchField.value.length
            : searchField.selectionEnd === 0;
        if (inSearch && !keyboardSelectedId && !caretAtEdge) return;

        // Без поиска — соседняя вкладка, при поиске — соседний кодекс в строке «Найдено».
        // Удержание клавиши не считается, чтобы не проскочить несколько вкладок подряд.
        if (e.repeat) return;
        if (searchField.value === '') {
            e.preventDefault();
            releaseFocus();
            shiftTab(step);
        } else if (currentCode !== 'pk' && shiftFoundCategory(step)) {
            e.preventDefault();
            releaseFocus();
        }
        return;
    }

    // Пробел вне поля поиска, когда раскрывать нечего: продолжает запрос, а при пустом запросе ничего не делает.
    // Без этого браузер прокручивал бы страницу на целый экран.
    if (e.key === ' ' && e.target === document.body && (currentCode === 'pk' || !keyboardSelectedId)) {
        if (searchField.value === '') {
            e.preventDefault();
            return;
        }
        closeSettingsPanel();
        searchField.focus({ preventScroll: true });
        searchField.setSelectionRange(searchField.value.length, searchField.value.length);
        return;
    }

    if (currentCode === 'pk') return;

    // Пробел раскрывает описание, когда статья выбрана стрелками в списке; иначе это обычный пробел в запросе.
    if (e.key === ' ') {
        if (!keyboardSelectedId || (!inSearch && e.target !== document.body)) return;
        e.preventDefault();
        if (!e.repeat) toggleSelectedDescription();
        return;
    }

    const items = articleElements();
    if (items.length === 0) return;
    e.preventDefault();
    // Открытые настройки закрываются: стрелки относятся к списку статей.
    closeSettingsPanel();
    releaseFocus();

    const step = e.key === 'ArrowDown' ? 1 : -1;
    const current = items.find(item => item.dataset.articleId === keyboardSelectedId);
    let next;
    if (!current) next = step === 1 ? items[0] : null;
    else next = items[items.indexOf(current) + step];
    // Вниз с последней статьи — выбор остаётся; вверх с первой — выбор снимается.
    if (!next && step === 1) next = current || null;
    selectByKeyboard(next || null);
    if (!next) scrollToListTop();
});

// Ширина страницы изменилась: подпись в поле поиска — по раскладке; открытые настройки закрываются,
// если их вид (панель или лист) перестал подходить.
new ResizeObserver(() => {
    syncSearchPlaceholder();
    if (settingsPanel.classList.contains('open') && settingsPanel.classList.contains('sheet') !== isCardsLayout()) {
        closeSettingsPanel();
    }
}).observe(document.querySelector('.app'));

syncSearchPlaceholder();
syncSearchClearBtn();
// На сенсорном экране курсор в поле не ставится: выехала бы клавиатура и закрыла экран.
if (!touchQuery.matches) searchField.focus();
showWelcomeToast();
loadData();
loadProceduralData();
loadMetaData();

// ===== Обновление данных на открытой странице =====
// Вкладку держат открытой часами: данные перечитываются раз в REFRESH_EVERY_MS, пока вкладка на экране,
// и при возврате на неё. Выбор и раскрытые строки при этом остаются на месте.
const REFRESH_EVERY_MS = 15 * 60 * 1000;
let lastRefreshAt = Date.now();

function refreshIfDue() {
    if (document.visibilityState !== 'visible' || Date.now() - lastRefreshAt < REFRESH_EVERY_MS) return;
    lastRefreshAt = Date.now();
    loadData({ quiet: true });
    loadProceduralData({ quiet: true });
    loadMetaData();
}

document.addEventListener('visibilitychange', refreshIfDue);
setInterval(refreshIfDue, 60 * 1000);
