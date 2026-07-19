const SHEET_ID = '1ECGNHLbqR8KuPV_QH1E0SO8mGUOm4WIYP-hWWR5PZ-U'; 
const SHEET_NAME = encodeURIComponent('База данных'); 
const TIMEOUT_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?sheet=${SHEET_NAME}&headers=0`;

const SHEET_NAME_PK = encodeURIComponent('Общая информация');
const PK_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?sheet=${SHEET_NAME_PK}&headers=0`;

let parsedDatabase = [];
let proceduralData = [];
let currentCode = "uk";
let searchDebounceTimer;

const VIEW_KEY = 'majestic_portland_view_mode';
let currentView = localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';

// Режим отображения по частоте статей: 'compact' (только частые) — дефолт,
// или 'full' (все статьи). Общий для УК/АК/ДК, не зависит от currentCode.
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

// Настройка "Уведомления тумблеров" в панели настроек — включает/выключает
// показ toast-уведомлений при переключении режима отображения и вида
// (compact/full, плитки/список). Не влияет на уведомление "Скопировано".
const NOTIFICATIONS_KEY = 'majestic_portland_toggle_notifications';
let toggleNotificationsEnabled = localStorage.getItem(NOTIFICATIONS_KEY) !== 'false';

// Закреплённые статьи (только УК/АК/ДК — "Общая информация" не участвует).
// Идентификатор статьи — связка кода кодекса и номера статьи, этого достаточно
// для уникальности в пределах базы. Храним как Set в памяти для быстрой проверки
// isPinned() при рендере каждой карточки/строки, персистим как JSON-массив.
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

// Переключает закрепление статьи, сохраняет в localStorage и перерисовывает
// список — закреплённая статья должна сразу подняться в начало своей категории.
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

const TYPE_LABELS = {
    'Ф': 'Федеральная',
    'Р': 'Региональная',
    'Ф/Р': 'Федеральная/Региональная',
    'ФИН': 'Финансовая',
    'Р/ФИН': 'Региональная/Финансовая',
    'В': 'Военная'
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

// Общий запрос+разбор gviz-ответа Google Sheets — используется обоими загрузчиками
// (статьи кодексов и Общая информация). Обработка ошибок и раскладка строк по
// полям намеренно остаются в каждом загрузчике отдельно (у loadData есть офлайн-кэш
// и баннер, у loadProceduralData — нет), сюда вынесена только общая часть
// "получить ответ и распарсить его в массив строк".
async function fetchGvizRows(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Сервер ответил с ошибкой: ${response.status}`);
    }
    const text = await response.text();
    const json = JSON.parse(text.substring(text.indexOf("{"), text.lastIndexOf("}") + 1));
    return json.table.rows;
}

// Достаёт значение ячейки gviz-таблицы по индексу: приоритет — форматированное
// значение (f), затем сырое (v), иначе пустая строка. Общая для обоих листов
// (статьи и ПК). Написано явными шагами вместо свёрнутого тернарника — так проще
// увидеть порядок приоритета f -> v -> "" и не перепутать его при будущих правках.
function getCellVal(cells, idx) {
    const cell = cells[idx];
    if (!cell) return "";
    if (cell.f) return String(cell.f).trim();
    if (cell.v !== null) return String(cell.v).trim();
    return "";
}

// Нормализует значение колонки "Частота" к двум состояниям: 'frequent' | 'rare'.
// Любое значение, кроме точного "частая" (без учёта регистра и лишних пробелов),
// считается редкой статьёй — так пустые/ещё неразмеченные строки не попадают
// по умолчанию в компактный режим отображения.
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

            let rawCode = getVal(0).toUpperCase();
            if (rawCode === "КОДЕКС" || !{'UK':'uk','AK':'ak','DK':'dk'}[rawCode]) return;

            parsedDatabase.push({
                code: {'UK':'uk','AK':'ak','DK':'dk'}[rawCode],
                num: getVal(1),
                title: getVal(2) || (getVal(3).split(/[.\n]/)[0].trim() + '.'),
                desc: getVal(3) || getVal(2),
                stars: getVal(4),
                extraMeasure: getVal(5),
                fine: getVal(6),
                arrest: getVal(7),
                felony: getVal(8),
                type: getVal(9),   
                tags: getVal(10),
                frequency: normalizeFrequency(getVal(11))
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

// Загрузка данных Процессуального кодекса — отдельный лист, отдельная (упрощённая)
// структура полей. Сознательно не смешивается с parsedDatabase/loadData, так как
// у этого раздела совсем другой набор полей (нет штрафа/ареста/звёзд и т.д.).
// Обработка ошибок/офлайн-кэш для этого раздела — вне рамок текущего этапа,
// добавим при необходимости позже.
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

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Подсвечивает совпадения поисковых слов в уже экранированном тексте.
// Общая логика для карточек и списка — раньше была продублирована в обеих функциях отрисовки.
function highlightMatches(text, isSearching, searchWords) {
    if (!isSearching) return text;
    let result = text;
    searchWords.forEach(word => {
        const regex = new RegExp(`(${escapeRegex(word)})`, 'gi');
        result = result.replace(regex, '<span class="highlight">$1</span>');
    });
    return result;
}

// Строит бейдж типа статьи (F/R и т.п.) с подсказкой-расшифровкой. Показывается только для УК.
// Общая логика для карточек и списка — раньше была продублирована в обеих функциях отрисовки.
function buildTypeBadge(article, extraClass = '') {
    if (article.code !== 'uk') return '';
    const safeType = escapeHtml(article.type);
    if (!safeType || safeType === '-') return '';
    const typeLabel = TYPE_LABELS[article.type] || '';
    return `<div class="article-type ${extraClass}" title="${escapeHtml(typeLabel)}">${safeType}</div>`;
}

// Показывает короткое всплывающее уведомление внизу экрана. Переиспользует один
// и тот же DOM-элемент между вызовами, чтобы повторное копирование корректно
// перезапускало анимацию, а не плодило уведомления одно поверх другого.
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
    // Форсируем reflow, чтобы сброс и повторное добавление класса гарантированно
    // перезапускали CSS-переход при быстром повторном клике.
    void toastEl.offsetWidth;
    toastEl.classList.add('toast-visible');

    toastHideTimer = setTimeout(() => {
        toastEl.classList.remove('toast-visible');
    }, 1800);
}

// Копирует номер статьи в формате "ст. <номер> <УК/АК/ДК>" в буфер обмена
// и показывает уведомление об успехе.
function copyArticleNumber(article) {
    const codeLabel = CODE_LABELS[article.code] || '';
    const text = `ст. ${article.num} ${codeLabel}`.trim();

    navigator.clipboard.writeText(text)
        .then(() => showToast('Скопировано'))
        .catch(() => console.warn('Не удалось скопировать номер статьи в буфер обмена'));
}

function renderArticles() {
    const container = document.getElementById('articlesContainer');

    const filterText = document.getElementById('searchInput').value.toLowerCase().trim();
    const isSearching = filterText.length > 0;

    // Общая информация — отдельный тип контента, без плиток/списка и своей
    // логикой рендера. Но пока идёт поиск (в том числе начатый на этой вкладке),
    // показываем не карточки ПК, а обычные результаты по УК/АК/ДК — так же, как
    // при поиске с любой другой вкладки. proceduralData в эту выдачу не попадает,
    // так как поиск ниже работает только по parsedDatabase.
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
            
            // Теперь считаем сколько слов из запроса нашлось в тексте
            searchWords.forEach(word => {
                if (searchableText.includes(word)) {
                    matchScore += 1;
                }
            });

            // Если не нашлось ни одного слова — игнорируем
            if (matchScore === 0) return;
        }

        matchedArticles.push({ article, matchScore });
    });

    // Вне поиска — закреплённые статьи поднимаются в начало (внутри своего режима
    // отображения: закрепление внутри compact "видит" только частые статьи, так
    // как редкие уже отфильтрованы выше), остальной порядок не меняется благодаря
    // стабильной сортировке. При активном поиске закрепление игнорируется —
    // работает только сортировка по релевантности.
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

// Определяет, есть ли у статьи признак судимости по тексту поля "felony".
// Общая логика для карточек и списка — раньше проверка была продублирована:
// один раз инлайн прямо в шаблонной строке карточки, второй раз отдельной
// переменной в списке — с риском разойтись при будущей правке критерия.
function hasFelonyRecord(article) {
    return article.felony.toLowerCase().includes('судимость');
}

// Склоняет слово "звезда" по числу (1 звезда / 2-4 звезды / 5+ звёзд) с учётом
// исключений на 11-14. Считает количество звёзд по длине строки article.stars
// (значение хранится как повторяющиеся символы "★").
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

// Готовит подсвеченные (уже экранированные) поля статьи — заголовок, номер,
// описание. Общая логика для карточек и списка: раньше этот блок был дословно
// продублирован в начале renderAsCards и renderAsList.
function buildHighlightedFields(article, isSearching, searchWords) {
    return {
        title: highlightMatches(escapeHtml(article.title), isSearching, searchWords),
        num: highlightMatches(escapeHtml(article.num), isSearching, searchWords),
        desc: highlightMatches(escapeHtml(article.desc), isSearching, searchWords).replace(/\n/g, '<br>'),
    };
}

// Отрисовка в виде плиток (карточек). Логика фильтрации/поиска/сортировки уже
// выполнена в renderArticles() — эта функция отвечает только за разметку.
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
                    <button class="pin-btn" title="${isPinned(article) ? 'Открепить статью' : 'Закрепить статью'}" aria-label="${isPinned(article) ? 'Открепить статью' : 'Закрепить статью'}" aria-pressed="${isPinned(article)}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 4V11L6 15V17H18V15L15 11V4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 17V21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7 4H17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
                    <div class="title">${highlightedTitle}</div>
                </div>
                <div class="card-header-right">${typeHtml}<div class="badge-num"><span class="badge-num-text">ст. ${highlightedNum}</span><svg class="badge-copy-icon" width="8" height="8" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="9" y="9" width="12" height="12" rx="2" stroke="currentColor" stroke-width="2.5"/><path d="M15 9V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" stroke="currentColor" stroke-width="2.5"/></svg></div></div>
            </div>
            <div class="info-table">
                <div class="info-row"><div class="info-label">Штраф</div><div class="info-val">${safeFine || '—'}</div></div>
                <div class="info-row"><div class="info-label">Розыск</div><div class="info-val">${safeStars || '—'}</div></div>
                <div class="info-row"><div class="info-label">Арест</div><div class="info-val">${safeArrest || '—'}</div></div>
                <div class="info-row"><div class="info-label">Судимость</div><div class="info-val ${hasFelonyRecord(article) ? 'danger' : ''}">${safeFelony || '—'}</div></div>
                <div class="info-row"><div class="info-label">Доп. мера</div><div class="info-val">${safeExtraMeasure || '—'}</div></div>
            </div>
            <div class="desc">${highlightedDesc}</div>
        `;

        const numBadge = card.querySelector('.badge-num');
        numBadge.title = 'Скопировать номер статьи';
        numBadge.addEventListener('click', () => copyArticleNumber(article));

        const pinBtn = card.querySelector('.pin-btn');
        pinBtn.addEventListener('click', () => togglePinned(article));

        container.appendChild(card);
    });
}

// Отрисовка в виде компактного списка (строк). Логика фильтрации/поиска/сортировки уже
// выполнена в renderArticles() — эта функция отвечает только за разметку.
// Каждая строка кликабельна: раскрывает/скрывает блок с полным описанием статьи.
function renderAsList(container, matchedArticles, isSearching, searchWords) {
    matchedArticles.forEach(item => {
        const article = item.article;

        const row = document.createElement('div');
        row.className = `row ${article.code} ${isPinned(article) ? 'pinned' : ''}`;

        const { title: highlightedTitle, num: highlightedNum, desc: highlightedDesc } =
            buildHighlightedFields(article, isSearching, searchWords);

        const typeHtml = buildTypeBadge(article, 'row-slot-type');

        // Левая часть строки: тип (только УК), номер статьи и заголовок.
        // row-slot-type/row-slot-num имеют фиксированную ширину, поэтому заголовок
        // всегда начинается в одной и той же позиции, независимо от длины тега типа/номера.
        const leftHtml = `
            ${typeHtml}
            <div class="badge-num row-num row-slot-num"><span class="badge-num-text">ст. ${highlightedNum}</span><svg class="badge-copy-icon" width="8" height="8" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="9" y="9" width="12" height="12" rx="2" stroke="currentColor" stroke-width="2.5"/><path d="M15 9V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" stroke="currentColor" stroke-width="2.5"/></svg></div>
            <div class="row-title"><button class="pin-btn" title="${isPinned(article) ? 'Открепить статью' : 'Закрепить статью'}" aria-label="${isPinned(article) ? 'Открепить статью' : 'Закрепить статью'}" aria-pressed="${isPinned(article)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 4V11L6 15V17H18V15L15 11V4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 17V21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7 4H17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>${highlightedTitle}</div>
        `;

        // Правая часть строки: для УК — звёзды/штраф/арест (арест краснеет при судимости),
        // для АК и ДК — доп. мера/штраф. Каждый параметр всегда занимает свой слот
        // фиксированной ширины (row-slot-*), чтобы колонки не "гуляли".
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
                    <div class="row-desc">${highlightedDesc}</div>
                </div>
            </div>
        `;

        const numBadge = row.querySelector('.badge-num');
        numBadge.title = 'Скопировать номер статьи';
        numBadge.addEventListener('click', (e) => {
            e.stopPropagation();
            copyArticleNumber(article);
        });

        const pinBtn = row.querySelector('.pin-btn');
        pinBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePinned(article);
        });

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
// Каждая карточка сама решает, каким шаблоном рендериться (поле "Тип" из таблицы).
// "text" и "table" пока не реализованы — не встречались в реальном контенте, добавим по необходимости.
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

// Safe-fallback: используется и для типов, для которых ещё не написан шаблон
// (сейчас это "text"), и для опечаток/неизвестных значений в колонке "Тип" —
// карточка не "теряется" молча, а просто показывается обычным текстом.
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

function syncModeToggleUI() {
    document.querySelectorAll('.mode-btn').forEach(btn => {
        const isActive = btn.getAttribute('data-mode') === currentDisplayMode;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

// Короткие описания сути режима — показываются во всплывающем уведомлении
// при переключении тумблера, чтобы пользователь понимал, что именно изменилось.
const DISPLAY_MODE_TOAST = {
    compact: 'Компактный режим — только частые статьи',
    full: 'Полный режим — показаны все статьи'
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

// Короткие описания сути вида отображения — та же логика, что и для
// DISPLAY_MODE_TOAST выше.
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

document.getElementById('searchInput').addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(renderArticles, 150);
});
loadData();
loadProceduralData();
