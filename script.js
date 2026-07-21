// ===== Настройки Google Sheets =====
const SHEET_ID = '1ECGNHLbqR8KuPV_QH1E0SO8mGUOm4WIYP-hWWR5PZ-U'; 
const SHEET_NAME = encodeURIComponent('База данных'); 
const TIMEOUT_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?sheet=${SHEET_NAME}&headers=0`;

const SHEET_NAME_PK = encodeURIComponent('Общая информация');
const PK_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?sheet=${SHEET_NAME_PK}&headers=0`;

const SHEET_NAME_META = encodeURIComponent('Последняя редакция');
const META_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?sheet=${SHEET_NAME_META}&headers=0`;

// ===== Состояние приложения =====
let parsedDatabase = [];
let proceduralData = [];
let currentCode = "uk";
let searchDebounceTimer;

// ===== Вид отображения (плитки/список) =====
const VIEW_KEY = 'majestic_portland_view_mode';
let currentView = localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list';

// ===== Режим отображения (compact/full) =====
const DISPLAY_MODE_KEY = 'majestic_portland_display_mode';
let currentDisplayMode = localStorage.getItem(DISPLAY_MODE_KEY) === 'full' ? 'full' : 'compact';

const ZOOM_KEY = 'majestic_portland_zoom_level';
const ZOOM_MIN = 75;
const ZOOM_MAX = 130;
const ZOOM_STEP = 5;
const storedZoom = parseInt(localStorage.getItem(ZOOM_KEY), 10);
let currentZoom = (Number.isInteger(storedZoom) && storedZoom >= ZOOM_MIN && storedZoom <= ZOOM_MAX && storedZoom % ZOOM_STEP === 0)
    ? storedZoom
    : 100;

// ===== Дата последней редакции =====
const DB_DATE_SEEN_KEY = 'majestic_portland_db_date_seen';
const DB_DATE_TOAST_DAY_KEY = 'majestic_portland_db_date_toast_day';

// ===== Уведомления тумблеров =====
const NOTIFICATIONS_KEY = 'majestic_portland_toggle_notifications';
let toggleNotificationsEnabled = localStorage.getItem(NOTIFICATIONS_KEY) !== 'false';

// ===== Пины статей =====
const PINNED_KEY = 'majestic_portland_pinned_articles';
let pinnedArticles = new Set(loadPinnedArticles());

function loadPinnedArticles() {
    try {
        const raw = JSON.parse(localStorage.getItem(PINNED_KEY));
        return Array.isArray(raw) ? raw : [];
    } catch {
        return [];
    }
}

function articleId(article) {
    return `${article.code}::${article.num}`;
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
    localStorage.setItem(PINNED_KEY, JSON.stringify([...pinnedArticles]));
    renderArticles();
}

const CODE_LABELS = {
    'uk': 'УК',
    'ak': 'АК',
    'dk': 'ДК'
};

// Код кодекса из таблицы (UK/AK/DK) -> внутренний нижний регистр
const CODE_MAP = {'UK':'uk','AK':'ak','DK':'dk'};

const TYPE_LABELS = {
    'Ф': 'Федеральная',
    'Р': 'Региональная',
    'Ф/Р': 'Федеральная/Региональная',
    'ФИН': 'Финансовая',
    'Р/ФИН': 'Региональная/Финансовая',
    'В': 'Военная'
};

// Индексы колонок листа "База данных" — только для loadData()
const COL = {
    CODE: 0,
    NUM: 1,
    TITLE: 2,
    DESC: 3,
    STARS: 4,
    EXTRA_MEASURE: 5,
    FINE: 6,
    ARREST: 7,
    FELONY: 8,
    TYPE: 9,
    TAGS: 10,
    FREQUENCY: 11,
    FORUM_URL: 12
};

const CACHE_KEY = 'majestic_portland_pravovaya_baza_cache_v1';

function saveCache(data) {
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ data, savedAt: Date.now() }));
    } catch (e) {
        console.warn('Не удалось сохранить локальный кэш данных', e);
    }
}

function loadCache() {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.data)) return null;
        return parsed;
    } catch (e) {
        return null;
    }
}

function removeStaleBanner() {
    const banner = document.getElementById('staleDataBanner');
    if (banner) banner.remove();
}

function showStaleBanner(savedAt) {
    removeStaleBanner();
    const dateStr = new Date(savedAt).toLocaleString('ru-RU');
    const banner = document.createElement('div');
    banner.id = 'staleDataBanner';
    banner.className = 'stale-banner';
    banner.innerHTML = `
        Не удалось обновить данные. Показана последняя сохранённая версия от ${dateStr}.
        <button id="retryStaleBtn">Обновить</button>
    `;
    document.querySelector('.controls-container').appendChild(banner);
    document.getElementById('retryStaleBtn').addEventListener('click', loadData);
}

// ===== Загрузка данных с Google Sheets =====

// Общий запрос+разбор gviz-ответа. Обработка ошибок — отдельно в каждом загрузчике.
async function fetchGvizRows(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Сервер ответил с ошибкой: ${response.status}`);
    }
    const text = await response.text();
    const json = JSON.parse(text.substring(text.indexOf("{"), text.lastIndexOf("}") + 1));
    return json.table.rows;
}

// Приоритет f (форматированное) -> v (сырое) -> "" — порядок важен, не менять.
function getCellVal(cells, idx) {
    const cell = cells[idx];
    if (!cell) return "";
    if (cell.f) return String(cell.f).trim();
    if (cell.v !== null) return String(cell.v).trim();
    return "";
}

// Всё, кроме точного "частая", считается 'rare' — так неразмеченные строки
// не попадают по умолчанию в compact.
function normalizeFrequency(raw) {
    return raw.trim().toLowerCase() === 'частая' ? 'frequent' : 'rare';
}

async function loadData() {
    const container = document.getElementById('articlesContainer');
    try {
        const rows = await fetchGvizRows(TIMEOUT_URL);

        parsedDatabase = [];
        rows.forEach((row) => {
            if (!row.c) return;
            const cells = row.c;
            const getVal = (idx) => getCellVal(cells, idx);

            let rawCode = getVal(COL.CODE).toUpperCase();
            if (rawCode === "КОДЕКС" || !CODE_MAP[rawCode]) return;

            parsedDatabase.push({
                code: CODE_MAP[rawCode],
                num: getVal(COL.NUM),
                title: getVal(COL.TITLE) || (getVal(COL.DESC).split(/[.\n]/)[0].trim() + '.'),
                desc: getVal(COL.DESC) || getVal(COL.TITLE),
                stars: getVal(COL.STARS),
                extraMeasure: getVal(COL.EXTRA_MEASURE),
                fine: getVal(COL.FINE),
                arrest: getVal(COL.ARREST),
                felony: getVal(COL.FELONY),
                type: getVal(COL.TYPE),   
                tags: getVal(COL.TAGS),
                frequency: normalizeFrequency(getVal(COL.FREQUENCY)),
                forumUrl: getVal(COL.FORUM_URL)
            });
        });
        saveCache(parsedDatabase);
        removeStaleBanner();
        renderArticles();
    } catch (e) {
        console.error(e);
        const cached = loadCache();
        if (cached) {
            parsedDatabase = cached.data;
            renderArticles();
            showStaleBanner(cached.savedAt);
        } else {
            container.innerHTML = `
                <div class="loader">
                    Не удалось загрузить базу данных. Проверьте интернет-соединение и попробуйте снова.<br>
                    <button id="retryLoadBtn" class="tab-btn retry-btn">Повторить попытку</button>
                </div>
            `;
            const retryBtn = document.getElementById('retryLoadBtn');
            if (retryBtn) {
                retryBtn.addEventListener('click', () => {
                    container.innerHTML = `<div class="loader">Синхронизация данных...</div>`;
                    loadData();
                });
            }
        }
    }
}

// ===== Общая информация: загрузка данных =====

// Отдельный лист, отдельная упрощённая структура полей — не смешивается с parsedDatabase.
async function loadProceduralData() {
    try {
        const rows = await fetchGvizRows(PK_URL);

        proceduralData = [];
        rows.forEach((row) => {
            if (!row.c) return;
            const cells = row.c;
            const getVal = (idx) => getCellVal(cells, idx);

            const title = getVal(0);
            if (!title || title === "Заголовок") return; // пропускаем пустые строки и строку-заголовок таблицы

            proceduralData.push({
                title: title,
                type: getVal(1).toLowerCase(),
                content: getVal(2)
            });
        });
    } catch (e) {
        console.error('Не удалось загрузить данные Процессуального кодекса:', e);
    }
}

// ===== Дата последней редакции: загрузка и уведомление =====

// Лист "Последняя редакция": A1 — заголовок, A2 — дата (вписывается вручную).
async function loadMetaData() {
    try {
        const rows = await fetchGvizRows(META_URL);
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

// Тост сразу, если дата отличается от увиденной раньше; иначе не чаще раза в день.
function notifyDbDate(dbDate) {
    document.querySelectorAll('.settings-meta-date').forEach(el => {
        el.textContent = `Последняя редакция: ${dbDate}`;
    });

    const today = new Date().toDateString();
    const seenDate = localStorage.getItem(DB_DATE_SEEN_KEY);

    if (seenDate !== dbDate) {
        localStorage.setItem(DB_DATE_SEEN_KEY, dbDate);
        localStorage.setItem(DB_DATE_TOAST_DAY_KEY, today);
        showToast(`Последняя редакция: ${dbDate}`);
        return;
    }

    if (localStorage.getItem(DB_DATE_TOAST_DAY_KEY) !== today) {
        localStorage.setItem(DB_DATE_TOAST_DAY_KEY, today);
        showToast(`Последняя редакция: ${dbDate}`);
    }
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ===== Хелперы рендера статей (общие для карточек и списка) =====

function highlightMatches(text, isSearching, searchWords) {
    if (!isSearching) return text;
    let result = text;
    searchWords.forEach(word => {
        const regex = new RegExp(`(${escapeRegex(word)})`, 'gi');
        result = result.replace(regex, '<span class="highlight">$1</span>');
    });
    return result;
}

// Бейдж типа статьи (Ф/Р и т.п.) с расшифровкой в title. Только для УК.
function buildTypeBadge(article, extraClass = '') {
    if (article.code !== 'uk') return '';
    const safeType = escapeHtml(article.type);
    if (!safeType || safeType === '-') return '';
    const typeLabel = TYPE_LABELS[article.type] || '';
    return `<div class="article-type ${extraClass}" title="${escapeHtml(typeLabel)}">${safeType}</div>`;
}

// Кнопка закрепления (иконка-булавка). size=15 в карточках, size=14 в списке.
function buildPinButton(article, size) {
    const pinned = isPinned(article);
    const label = pinned ? 'Открепить статью' : 'Закрепить статью';
    return `<button class="pin-btn" title="${label}" aria-label="${label}" aria-pressed="${pinned}"><svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 4V11L6 15V17H18V15L15 11V4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 17V21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7 4H17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>`;
}

// ВАЖНО: href не пишется прямо в разметку (в ссылке вида "#:~:text=..." могут
// быть спецсимволы) — рендерится пустой якорь, href проставляется отдельно
// через element.href после вставки в DOM (см. attachForumLinks).
function buildForumLinkIcon(article) {
    if (!article.forumUrl) return '';
    return `<a class="desc-forum-link" target="_blank" rel="noopener" title="Открыть статью на форуме" aria-label="Открыть статью на форуме"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 18L18 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M8 6H18V16" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></a>`;
}

// Проставляет href иконкам-ссылкам на форум внутри карточки/строки — см. buildForumLinkIcon.
function attachForumLinks(root, article) {
    root.querySelectorAll('.desc-forum-link').forEach(link => {
        link.href = article.forumUrl;
    });
}

// Общие обработчики карточки/строки: копирование номера, пин, ссылки на форум.
// stopPropagation нужен для списка — строка целиком кликабельна (раскрытие описания).
function attachArticleHandlers(root, article, { stopPropagation = false } = {}) {
    const numBadge = root.querySelector('.badge-num');
    numBadge.title = 'Скопировать номер статьи';
    numBadge.addEventListener('click', (e) => {
        if (stopPropagation) e.stopPropagation();
        copyArticleNumber(article);
    });

    const pinBtn = root.querySelector('.pin-btn');
    pinBtn.addEventListener('click', (e) => {
        if (stopPropagation) e.stopPropagation();
        togglePinned(article);
    });

    attachForumLinks(root, article);
}

// ===== Toast-уведомления =====

// Переиспользует один DOM-элемент между вызовами.
let toastEl = null;
let toastHideTimer = null;
function showToast(message) {
    if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.className = 'toast';
        document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;

    clearTimeout(toastHideTimer);
    toastEl.classList.remove('toast-visible');
    // Форсируем reflow — иначе CSS-переход не перезапустится при быстром повторном клике.
    void toastEl.offsetWidth;
    toastEl.classList.add('toast-visible');

    toastHideTimer = setTimeout(() => {
        toastEl.classList.remove('toast-visible');
    }, 1800);
}

function copyArticleNumber(article) {
    const codeLabel = CODE_LABELS[article.code] || '';
    const text = `ст. ${article.num} ${codeLabel}`.trim();

    navigator.clipboard.writeText(text)
        .then(() => showToast('Скопировано'))
        .catch(() => console.warn('Не удалось скопировать номер статьи в буфер обмена'));
}

// ===== Основной рендер =====

function renderArticles() {
    const container = document.getElementById('articlesContainer');

    const filterText = document.getElementById('searchInput').value.toLowerCase().trim();
    const isSearching = filterText.length > 0;

    // При активном поиске ПК не рендерится отдельно — показываются обычные
    // результаты по УК/АК/ДК, как с любой другой вкладки.
    if (currentCode === 'pk' && !isSearching) {
        container.className = '';
        renderProceduralCards(container);
        return;
    }

    let searchWords = [];
    if (isSearching) {
        searchWords = filterText.split(/\s+/).filter(w => w.length > 1 || /^\d+$/.test(w));
    }

    let matchedArticles = [];

    parsedDatabase.forEach(article => {
        if (!isSearching && article.code !== currentCode) return;
        if (!isSearching && currentDisplayMode === 'compact' && article.frequency === 'rare') return;

        let matchScore = 0;

        if (isSearching) {
            const searchableText = `${article.num} ${article.title} ${article.desc} ${article.tags}`.toLowerCase();
            
            searchWords.forEach(word => {
                if (searchableText.includes(word)) {
                    matchScore += 1;
                }
            });

            if (matchScore === 0) return;
        }

        matchedArticles.push({ article, matchScore });
    });

    // Вне поиска — закреплённые статьи первыми (сортировка стабильна).
    // При поиске пины игнорируются, работает только релевантность.
    matchedArticles.sort((a, b) => {
        if (isSearching) return b.matchScore - a.matchScore;
        return (isPinned(b.article) ? 1 : 0) - (isPinned(a.article) ? 1 : 0);
    });

    container.innerHTML = "";
    container.className = currentView === 'list' ? 'list-view' : '';

    if (matchedArticles.length === 0) {
        container.innerHTML = `<div class="loader">По запросу ничего не найдено. Попробуйте описать иначе.</div>`;
        return;
    }

    if (currentView === 'list') {
        renderAsList(container, matchedArticles, isSearching, searchWords);
    } else {
        renderAsCards(container, matchedArticles, isSearching, searchWords);
    }
}

function hasFelonyRecord(article) {
    return article.felony.toLowerCase().includes('судимость');
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
    const count = article.stars.length;
    if (!count) return 'Розыск';
    return `${count} ${pluralizeStars(count)}`;
}

function buildHighlightedFields(article, isSearching, searchWords) {
    return {
        title: highlightMatches(escapeHtml(article.title), isSearching, searchWords),
        num: highlightMatches(escapeHtml(article.num), isSearching, searchWords),
        desc: highlightMatches(escapeHtml(article.desc), isSearching, searchWords).replace(/\n/g, '<br>'),
    };
}

// ===== Отрисовка: карточки =====

// Фильтрация/поиск/сортировка уже выполнены в renderArticles() — здесь только разметка.
function renderAsCards(container, matchedArticles, isSearching, searchWords) {
    matchedArticles.forEach(item => {
        const article = item.article;

        const card = document.createElement('div');
        card.className = `card ${article.code} ${isPinned(article) ? 'pinned' : ''}`;

        const { title: highlightedTitle, num: highlightedNum, desc: highlightedDesc } =
            buildHighlightedFields(article, isSearching, searchWords);

        const typeHtml = buildTypeBadge(article);

        const safeFine = escapeHtml(article.fine);
        const safeStars = escapeHtml(article.stars);
        const safeArrest = escapeHtml(article.arrest);
        const safeFelony = escapeHtml(article.felony);
        const safeExtraMeasure = escapeHtml(article.extraMeasure);

        card.innerHTML = `
            <div class="card-header">
                <div class="title-row">
                    ${buildPinButton(article, 15)}
                    <div class="title">${highlightedTitle}</div>
                </div>
                <div class="card-header-right">${typeHtml}<div class="badge-num">ст. ${highlightedNum}</div></div>
            </div>
            <div class="info-table">
                <div class="info-row"><div class="info-label">Штраф</div><div class="info-val">${safeFine || '—'}</div></div>
                <div class="info-row"><div class="info-label">Розыск</div><div class="info-val">${safeStars || '—'}</div></div>
                <div class="info-row"><div class="info-label">Арест</div><div class="info-val">${safeArrest || '—'}</div></div>
                <div class="info-row"><div class="info-label">Судимость</div><div class="info-val ${hasFelonyRecord(article) ? 'danger' : ''}">${safeFelony || '—'}</div></div>
                <div class="info-row"><div class="info-label">Доп. мера</div><div class="info-val">${safeExtraMeasure || '—'}</div></div>
            </div>
            <div class="desc">${highlightedDesc}${buildForumLinkIcon(article)}</div>
        `;

        attachArticleHandlers(card, article);

        container.appendChild(card);
    });
}

// ===== Отрисовка: список =====

// Фильтрация/поиск/сортировка уже выполнены в renderArticles(). Строка кликабельна —
// раскрывает/скрывает полное описание.
function renderAsList(container, matchedArticles, isSearching, searchWords) {
    matchedArticles.forEach(item => {
        const article = item.article;

        const row = document.createElement('div');
        row.className = `row ${article.code} ${isPinned(article) ? 'pinned' : ''}`;

        const { title: highlightedTitle, num: highlightedNum, desc: highlightedDesc } =
            buildHighlightedFields(article, isSearching, searchWords);

        const typeHtml = buildTypeBadge(article, 'row-slot-type');

        // row-slot-* — фиксированная ширина, заголовок начинается в одной позиции.
        const leftHtml = `
            ${typeHtml}
            <div class="badge-num row-num row-slot-num">ст. ${highlightedNum}</div>
            <div class="row-title">${buildPinButton(article, 14)}${highlightedTitle}</div>
        `;

        // УК — звёзды/штраф/арест; АК и ДК — доп. мера/штраф. row-slot-* держат ширину.
        let rightHtml = '';
        if (article.code === 'uk') {
            const safeStars = escapeHtml(article.stars);
            const safeFine = escapeHtml(article.fine);
            const safeArrest = escapeHtml(article.arrest);
            const hasFelony = hasFelonyRecord(article);
            const arrestTitle = safeArrest
                ? `${safeArrest}, ${hasFelony ? 'судимость' : 'без судимости'}`
                : 'Арест';

            rightHtml = `
                <div class="row-tag row-slot-fine ${safeFine ? 'row-fine' : ''}" title="${safeFine ? `Штраф: ${safeFine}` : 'Штраф'}">${safeFine || '—'}</div>
                <div class="row-tag row-slot-stars" title="${starsTitle(article)}">${safeStars || '—'}</div>
                <div class="row-tag row-slot-arrest ${hasFelony ? 'row-danger' : ''}" title="${arrestTitle}">${safeArrest || '—'}</div>
            `;
        } else {
            const safeExtraMeasure = escapeHtml(article.extraMeasure);
            const safeFine = escapeHtml(article.fine);
            const hasExtraMeasure = Boolean(article.extraMeasure);

            rightHtml = `
                <div class="row-tag row-slot-extra ${hasExtraMeasure ? '' : 'row-hidden'}" title="${hasExtraMeasure ? safeExtraMeasure : ''}">${safeExtraMeasure}</div>
                <div class="row-tag row-slot-fine ${safeFine ? 'row-fine' : ''}" title="${safeFine ? `Штраф: ${safeFine}` : 'Штраф'}">${safeFine || '—'}</div>
            `;
        }

        row.innerHTML = `
            <div class="row-header" role="button" tabindex="0" aria-expanded="false">
                <div class="row-left">${leftHtml}</div>
                <div class="row-right">${rightHtml}</div>
                <svg class="row-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
            </div>
            <div class="row-desc-wrapper">
                <div class="row-desc-inner">
                    <div class="row-desc">${highlightedDesc}${buildForumLinkIcon(article)}</div>
                </div>
            </div>
        `;

        attachArticleHandlers(row, article, { stopPropagation: true });

        const header = row.querySelector('.row-header');
        const toggleExpanded = () => {
            const willExpand = !row.classList.contains('expanded');
            row.classList.toggle('expanded', willExpand);
            header.setAttribute('aria-expanded', String(willExpand));
        };
        header.addEventListener('click', toggleExpanded);
        header.addEventListener('keydown', (e) => {
            if (e.target.closest('.pin-btn')) return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleExpanded();
            }
        });

        container.appendChild(row);
    });
}

// ===== Общая информация: диспетчер шаблонов =====
// "text" и "table" пока не реализованы — добавим по необходимости.
const PK_TEMPLATES = {
    steps: renderPkSteps,
    list: renderPkList,
};

function renderPkSteps(content) {
    const steps = content.split('\n').map(s => s.trim()).filter(Boolean);
    const items = steps.map(step => `<li>${escapeHtml(step)}</li>`).join('');
    return `<ol class="pk-steps">${items}</ol>`;
}

// Маркированный список — порядок пунктов не важен (в отличие от "steps")
function renderPkList(content) {
    const points = content.split('\n').map(s => s.trim()).filter(Boolean);
    const items = points.map(point => `<li>${escapeHtml(point)}</li>`).join('');
    return `<ul class="pk-list">${items}</ul>`;
}

// Safe-fallback для "text" и неизвестных значений — карточка не теряется молча.
function renderPkFallback(content) {
    return `<p>${escapeHtml(content).replace(/\n/g, '<br>')}</p>`;
}

function renderProceduralCardBody(item) {
    const renderer = PK_TEMPLATES[item.type];
    return renderer ? renderer(item.content) : renderPkFallback(item.content);
}

function renderProceduralCards(container) {
    container.innerHTML = '';

    if (proceduralData.length === 0) {
        container.innerHTML = `<div class="loader">Раздел пока пуст.</div>`;
        return;
    }

    proceduralData.forEach(item => {
        const card = document.createElement('div');
        card.className = 'card pk';

        card.innerHTML = `
            <div class="card-header">
                <div class="title">${escapeHtml(item.title)}</div>
            </div>
            <div class="pk-body">${renderProceduralCardBody(item)}</div>
        `;
        container.appendChild(card);
    });
}

document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', (e) => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    currentCode = e.target.getAttribute('data-code');
    
    clearTimeout(searchDebounceTimer);
    const searchInput = document.getElementById('searchInput');
    if (searchInput.value !== "") {
        searchInput.value = "";
    }
    renderArticles();
}));

// ===== Переключатели: режим отображения и вид =====

function syncModeToggleUI() {
    document.querySelectorAll('.mode-btn').forEach(btn => {
        const isActive = btn.getAttribute('data-mode') === currentDisplayMode;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

const DISPLAY_MODE_TOAST = {
    compact: 'Основные статьи',
    full: 'Все статьи'
};

document.querySelectorAll('.mode-btn').forEach(btn => btn.addEventListener('click', (e) => {
    const selectedMode = e.currentTarget.getAttribute('data-mode');
    if (selectedMode === currentDisplayMode) return;
    currentDisplayMode = selectedMode;
    localStorage.setItem(DISPLAY_MODE_KEY, currentDisplayMode);
    syncModeToggleUI();
    renderArticles();
    if (toggleNotificationsEnabled) showToast(DISPLAY_MODE_TOAST[currentDisplayMode]);
}));

syncModeToggleUI();

function syncViewToggleUI() {
    document.querySelectorAll('.view-btn').forEach(btn => {
        const isActive = btn.getAttribute('data-view') === currentView;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

const VIEW_TOAST = {
    grid: 'Вид: плитки',
    list: 'Вид: список'
};

document.querySelectorAll('.view-btn').forEach(btn => btn.addEventListener('click', (e) => {
    const selectedView = e.currentTarget.getAttribute('data-view');
    if (selectedView === currentView) return;
    currentView = selectedView;
    localStorage.setItem(VIEW_KEY, currentView);
    syncViewToggleUI();
    renderArticles();
    if (toggleNotificationsEnabled) showToast(VIEW_TOAST[currentView]);
}));

syncViewToggleUI();

// ===== Масштаб страницы =====
function applyZoom() {
    document.documentElement.style.zoom = currentZoom + '%';
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
    localStorage.setItem(ZOOM_KEY, String(currentZoom));
}

zoomMinusBtn.addEventListener('click', () => {
    setZoom(currentZoom - ZOOM_STEP);
});

zoomPlusBtn.addEventListener('click', () => {
    setZoom(currentZoom + ZOOM_STEP);
});

applyZoom();
updateZoomUI();

// ===== Панель настроек (шестерёнка) =====
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');

function closeSettingsPanel() {
    settingsPanel.classList.remove('open');
    settingsBtn.setAttribute('aria-expanded', 'false');
}

function toggleSettingsPanel() {
    const willOpen = !settingsPanel.classList.contains('open');
    settingsPanel.classList.toggle('open', willOpen);
    settingsBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
}

settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSettingsPanel();
});

settingsPanel.addEventListener('click', (e) => {
    e.stopPropagation();
});

// ===== Настройка "Уведомления тумблеров" =====
const notificationsToggle = document.getElementById('notificationsToggle');
notificationsToggle.checked = toggleNotificationsEnabled;
notificationsToggle.addEventListener('change', () => {
    toggleNotificationsEnabled = notificationsToggle.checked;
    localStorage.setItem(NOTIFICATIONS_KEY, String(toggleNotificationsEnabled));
});

document.addEventListener('click', () => {
    closeSettingsPanel();
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeSettingsPanel();
    }
});

// ===== Кнопка "наверх" =====
const SCROLL_TOP_THRESHOLD = 600;
const scrollTopBtn = document.getElementById('scrollTopBtn');
let scrollTicking = false;

function updateScrollTopVisibility() {
    scrollTopBtn.classList.toggle('visible', window.scrollY > SCROLL_TOP_THRESHOLD);
    scrollTicking = false;
}

window.addEventListener('scroll', () => {
    if (!scrollTicking) {
        requestAnimationFrame(updateScrollTopVisibility);
        scrollTicking = true;
    }
});

scrollTopBtn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
});

updateScrollTopVisibility();

document.getElementById('searchInput').addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(renderArticles, 150);
});
loadData();
loadProceduralData();
loadMetaData();
