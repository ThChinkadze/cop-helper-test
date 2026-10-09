// ===== Настройки сервера =====
const SHEET_ID = '1y4PKeW4sTxnQhJJ7nlO2coCZPdRbUKjC28KQkpMidrs';
const STORAGE_PREFIX = 'majestic_orlando_';

// Уборка за прежней версией сайта (сервер Portland): её сохранённые данные больше не читаются.
Object.keys(localStorage)
    .filter(key => key.startsWith('majestic_portland_'))
    .forEach(key => localStorage.removeItem(key));

// ===== Настройки Google Sheets =====
function sheetUrl(sheetName) {
    return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?sheet=${encodeURIComponent(sheetName)}&headers=0`;
}

const DATA_URL = sheetUrl('База данных');
const PK_URL = sheetUrl('Общая информация');
const META_URL = sheetUrl('Последняя редакция');

// ===== Состояние приложения =====
let parsedDatabase = [];
let proceduralData = [];
let currentCode = "uk";
let searchDebounceTimer;

// Во время поиска: кодекс, которым ограничена выдача (null — все кодексы).
let searchCodeFilter = null;

// Статья, выбранная стрелками с клавиатуры, и текст запроса, по которому построена выдача.
let keyboardSelectedId = null;
let renderedSearchText = '';
// Показана ли сейчас выдача поиска (а не обычный список статей кодекса).
let listShowsSearch = false;
// В плитках: стрелки влево и вправо заняты строкой «Найдено», хотя статья не выбрана.
let foundRowKeysActive = false;

// ===== Вид отображения (плитки/список) =====
const VIEW_KEY = STORAGE_PREFIX + 'view_mode';
let currentView = localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list';

// ===== Режим отображения (compact/full) =====
const DISPLAY_MODE_KEY = STORAGE_PREFIX + 'display_mode';
let currentDisplayMode = localStorage.getItem(DISPLAY_MODE_KEY) === 'full' ? 'full' : 'compact';

const ZOOM_KEY = STORAGE_PREFIX + 'zoom_level';
const ZOOM_MIN = 75;
const ZOOM_MAX = 130;
const ZOOM_STEP = 5;
const storedZoom = parseInt(localStorage.getItem(ZOOM_KEY), 10);
let currentZoom = (Number.isInteger(storedZoom) && storedZoom >= ZOOM_MIN && storedZoom <= ZOOM_MAX && storedZoom % ZOOM_STEP === 0)
    ? storedZoom
    : 100;

// ===== Дата последней редакции =====
const DB_DATE_SEEN_KEY = STORAGE_PREFIX + 'db_date_seen';

// ===== Пины статей =====
const PINNED_KEY = STORAGE_PREFIX + 'pinned_articles';
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

// ===== Недавно скопированные статьи =====
const RECENT_KEY = STORAGE_PREFIX + 'recent_copied';
const RECENT_LIMIT = 5;
let recentCopied = loadRecentCopied();

function loadRecentCopied() {
    try {
        const raw = JSON.parse(localStorage.getItem(RECENT_KEY));
        return Array.isArray(raw) ? raw.filter(id => typeof id === 'string').slice(0, RECENT_LIMIT) : [];
    } catch {
        return [];
    }
}

function rememberCopied(article) {
    const id = articleId(article);
    recentCopied = [id, ...recentCopied.filter(other => other !== id)].slice(0, RECENT_LIMIT);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentCopied));
    renderRecentRow();
}

// Строка «Недавно скопированные» над списком статей; при поиске и на «Общей информации» её нет.
// Нажатие на номер копирует его снова, порядок в строке при этом не меняется.
function renderRecentRow() {
    const container = document.getElementById('articlesContainer');
    const old = container.querySelector('.recent-row');
    if (old) old.remove();
    if (currentCode === 'pk' || articlesLoadState !== 'ready' || listShowsSearch) return;

    const articles = recentCopied
        .map(id => parsedDatabase.find(article => articleId(article) === id))
        .filter(Boolean);
    if (articles.length === 0) return;

    const row = document.createElement('div');
    row.className = 'recent-row';
    row.innerHTML = '<span class="recent-label">Недавно скопированные:</span>';
    articles.forEach(article => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'badge-num recent-chip';
        chip.textContent = `ст. ${article.num} ${CODE_LABELS[article.code] || ''}`.trim();
        chip.title = `${article.title} — скопировать номер`;
        chip.addEventListener('click', () => copyArticleNumber(article, { remember: false }));
        row.appendChild(chip);
    });
    container.prepend(row);
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
    renderArticles({ keepExpanded: true });
}

const CODE_NAMES = {
    'uk': 'Уголовный кодекс',
    'ak': 'Административный кодекс',
    'dk': 'Дорожный кодекс'
};

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
    FREQUENCY: 11
};

// ===== Локальный кэш данных =====
const CACHE_KEY = STORAGE_PREFIX + 'pravovaya_baza_cache_v1';
const PK_CACHE_KEY = STORAGE_PREFIX + 'pk_cache_v1';

function saveCache(key, data) {
    try {
        localStorage.setItem(key, JSON.stringify({ data, savedAt: Date.now() }));
    } catch (e) {
        console.warn('Не удалось сохранить локальный кэш данных', e);
    }
}

function loadCache(key) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.data)) return null;
        return parsed;
    } catch (e) {
        return null;
    }
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
    banner.className = 'stale-banner';
    banner.innerHTML = `
        Не удалось обновить данные. Показана последняя сохранённая версия от ${dateStr}.
        <button id="retryStaleBtn">Обновить</button>
    `;
    document.querySelector('.controls-container').appendChild(banner);
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
        container.innerHTML = `<div class="loader">Синхронизация данных...</div>`;
        return;
    }
    container.innerHTML = `
        <div class="loader">
            ${errorText}<br>
            <button class="tab-btn retry-btn">Повторить попытку</button>
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

// ===== Загрузка данных с Google Sheets =====

const FETCH_TIMEOUT_MS = 8000;

// Общий запрос+разбор gviz-ответа. Обработка ошибок — отдельно в каждом загрузчике.
async function fetchGvizRows(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            throw new Error(`Сервер ответил с ошибкой: ${response.status}`);
        }
        const text = await response.text();
        const json = JSON.parse(text.substring(text.indexOf("{"), text.lastIndexOf("}") + 1));
        return json.table.rows;
    } finally {
        clearTimeout(timer);
    }
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

// Звёзды в таблице можно писать цифрой от 1 до 5 — в памятке она показывается символами ★.
function normalizeStars(raw) {
    return raw.replace(/\b[1-5]\b/g, (digit) => '★'.repeat(Number(digit)));
}

// ===== Проверка листа =====
// При неверном имени листа Google молча отдаёт первый лист таблицы.

const PK_KNOWN_TYPES = ['steps', 'list', 'text'];

function looksLikeArticlesSheet(rows) {
    const filled = rows.filter(row => row.c && getCellVal(row.c, 0) !== '');
    const withCode = filled.filter(row => CODE_MAP[getCellVal(row.c, COL.CODE).toUpperCase()]);
    return withCode.length > 0 && withCode.length >= filled.length / 2;
}

function looksLikeProceduralSheet(rows) {
    return rows.some(row => row.c && PK_KNOWN_TYPES.includes(getCellVal(row.c, 1).toLowerCase()));
}

function parseArticleRows(rows) {
    const articles = [];
    rows.forEach((row) => {
        if (!row.c) return;
        const cells = row.c;
        const getVal = (idx) => getCellVal(cells, idx);

        let rawCode = getVal(COL.CODE).toUpperCase();
        if (rawCode === "КОДЕКС" || !CODE_MAP[rawCode]) return;

        articles.push({
            code: CODE_MAP[rawCode],
            num: getVal(COL.NUM),
            title: getVal(COL.TITLE) || (getVal(COL.DESC).split(/[.\n]/)[0].trim() + '.'),
            desc: getVal(COL.DESC) || getVal(COL.TITLE),
            stars: normalizeStars(getVal(COL.STARS)),
            extraMeasure: getVal(COL.EXTRA_MEASURE),
            fine: getVal(COL.FINE),
            arrest: getVal(COL.ARREST),
            felony: getVal(COL.FELONY),
            type: getVal(COL.TYPE),
            tags: getVal(COL.TAGS),
            frequency: normalizeFrequency(getVal(COL.FREQUENCY))
        });
    });
    return articles;
}

// Сохранённая копия показывается сразу, свежие данные подменяют её после загрузки.
async function loadData() {
    const cached = loadCache(CACHE_KEY);
    if (cached && articlesLoadState !== 'ready') {
        parsedDatabase = cached.data;
        articlesLoadState = 'ready';
        renderArticles();
    }

    try {
        const fresh = parseArticleRows(await fetchGvizRows(DATA_URL));
        if (fresh.length === 0) {
            throw new Error('Таблица вернула пустой список статей');
        }

        saveCache(CACHE_KEY, fresh);
        const changed = articlesLoadState !== 'ready' || JSON.stringify(fresh) !== JSON.stringify(parsedDatabase);
        if (changed) {
            parsedDatabase = fresh;
            articlesLoadState = 'ready';
            renderArticles();
        }
        markFresh('articles');
    } catch (e) {
        console.error(e);
        if (articlesLoadState === 'ready') {
            markStale('articles', cached ? cached.savedAt : Date.now());
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
async function loadProceduralData() {
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
            markStale('procedural', cached ? cached.savedAt : Date.now());
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
    const seenDate = localStorage.getItem(DB_DATE_SEEN_KEY);
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
function notifyDbDate(dbDate) {
    showDbDate(dbDate);

    if (localStorage.getItem(DB_DATE_SEEN_KEY) === dbDate) return;
    localStorage.setItem(DB_DATE_SEEN_KEY, dbDate);
    // Ждёт, пока скроется приветствие, — иначе заменит его на полуслове.
    setTimeout(() => showToast(`Последняя редакция: ${dbDate}`), Math.max(0, welcomeToastUntil - Date.now()));
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

// ===== Поиск: разбор запроса =====

const SEARCH_WORD_RE = /[a-zа-я0-9]+/g;

const SEARCH_STOP_WORDS = new Set([
    'в', 'во', 'на', 'по', 'не', 'ни', 'с', 'со', 'к', 'ко', 'у', 'о', 'об', 'от', 'до', 'за', 'из',
    'и', 'а', 'но', 'или', 'ли', 'же', 'бы', 'то', 'что', 'как', 'это', 'при', 'для', 'без', 'под',
    'над', 'про', 'он', 'она', 'они', 'его', 'ее', 'их', 'был', 'была', 'было', 'были', 'нет', 'да',
    'мы', 'ты', 'вы', 'меня', 'мне', 'ст', 'статья', 'статьи', 'статью', 'статье'
]);

const SEARCH_CODE_ALIASES = { 'ук': 'uk', 'ак': 'ak', 'дк': 'dk', 'uk': 'uk', 'ak': 'ak', 'dk': 'dk' };

const SEARCH_ENDINGS = [
    'иваться', 'ываться', 'ениями', 'аниями', 'остью', 'анием', 'ением',
    'ться', 'ется', 'ится', 'ются', 'ятся', 'ался', 'ился', 'ение', 'ения', 'ению', 'ание', 'ания',
    'анию', 'ании', 'ении', 'ости', 'ость', 'ного', 'ному', 'ными', 'ской', 'ских', 'ским', 'ского',
    'алась', 'ались', 'илась', 'ились',
    'ами', 'ями', 'ыми', 'ими', 'ого', 'его', 'ому', 'ему', 'ать', 'ять', 'ить', 'еть', 'уть',
    'ала', 'али', 'ало', 'ила', 'или', 'ило', 'ела', 'ели', 'ешь',
    'ах', 'ях', 'ов', 'ев', 'ей', 'ой', 'ий', 'ый', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ую', 'юю',
    'ом', 'ем', 'ам', 'ям', 'ым', 'им', 'ых', 'их', 'ал', 'ил', 'ел', 'ет', 'ут', 'ют', 'ит', 'ат', 'ят',
    'ла', 'ли', 'ло', 'ть',
    'а', 'я', 'о', 'е', 'ы', 'и', 'у', 'ю', 'ь', 'й', 'л'
].sort((a, b) => b.length - a.length);

const SEARCH_MIN_STEM = 3;

function normalizeSearchText(str) {
    return String(str).toLowerCase().replace(/ё/g, 'е');
}

function splitSearchWords(str) {
    return normalizeSearchText(str).match(SEARCH_WORD_RE) || [];
}

function cutSearchEnding(word, minStem) {
    for (const ending of SEARCH_ENDINGS) {
        if (word.endsWith(ending) && word.length - ending.length >= minStem) {
            return word.slice(0, -ending.length);
        }
    }
    return null;
}

// stem — основа слова: по возможности от четырёх букв («избил» — «изби», а не «изб»).
// short — запасная, более короткая основа: ловит чередования («превысил» — «превышение», «курил» — «курение»).
function searchStems(word) {
    if (word.length <= SEARCH_MIN_STEM || /\d/.test(word)) return { stem: word, short: '' };
    const long = cutSearchEnding(word, SEARCH_MIN_STEM + 1);
    const any = cutSearchEnding(word, SEARCH_MIN_STEM);
    const stem = long || any || word;
    let short = '';
    if (long && any && any.length < long.length) short = any;
    else if (stem.length >= 5) short = stem.slice(0, -1);
    return { stem, short };
}

// words — слова, numbers — номера статей, parts — "ч.N", codes — фильтр по кодексу.
function parseSearchQuery(raw, { allowCodes = true } = {}) {
    const query = { words: [], numbers: [], parts: [], codes: [], total: 0, active: false };

    const text = normalizeSearchText(raw)
        .replace(/част[ьи]\s*(\d+)/g, 'ч.$1')
        .replace(/(\d)(ч\.)/g, '$1 $2')
        .replace(/(^|[^a-zа-я0-9])ч\.?\s*(\d+)/g, '$1ч.$2');

    // «не» перед словом запоминается: «не остановился» находит и «неостановка».
    let afterNot = false;
    text.split(/[\s,;]+/).forEach(chunk => {
        const token = chunk.replace(/^[^a-zа-я0-9]+|[^a-zа-я0-9]+$/g, '');
        if (!token) return;

        if (/^\d+(\.\d+)*$/.test(token)) {
            if (!query.numbers.includes(token)) query.numbers.push(token);
            afterNot = false;
            return;
        }
        if (/^ч\.\d+$/.test(token)) {
            if (!query.parts.includes(token)) query.parts.push(token);
            afterNot = false;
            return;
        }

        (token.match(SEARCH_WORD_RE) || []).forEach(piece => {
            const negated = afterNot;
            afterNot = piece === 'не';
            if (allowCodes && SEARCH_CODE_ALIASES[piece]) {
                const code = SEARCH_CODE_ALIASES[piece];
                if (!query.codes.includes(code)) query.codes.push(code);
                return;
            }
            if (SEARCH_STOP_WORDS.has(piece)) return;
            if (/^\d+$/.test(piece)) {
                if (!query.numbers.includes(piece)) query.numbers.push(piece);
                return;
            }
            if (piece.length < 2) return;
            if (query.words.some(w => w.full === piece)) return;
            query.words.push({ full: piece, ...searchStems(piece), negated, minLevel: 1 });
        });
    });

    query.total = query.words.length + query.numbers.length + query.parts.length;
    query.active = query.total > 0 || query.codes.length > 0;
    return query;
}

// ===== Поиск: сопоставление и сортировка =====

// 0 — нет совпадения, 1 — родственное слово, 2 — то же слово в другой форме.
function searchWordLevel(word, token) {
    const stem = token.stem;
    if (stem.length < SEARCH_MIN_STEM) return word === token.full ? 2 : 0;
    const at = word.indexOf(stem);
    if (at !== -1) {
        const tail = word.length - at - stem.length;
        const shortTail = tail <= Math.max(5, stem.length);
        // Основа из трёх букв считается тем же словом только при коротком окончании: «дал» — не «дальний».
        if (at === 0) return (shortTail && (stem.length > SEARCH_MIN_STEM || tail <= 3)) ? 2 : 1;
        if (stem.length >= 4 && at <= 3 && shortTail) return 1;
    }
    const short = token.short;
    if (short && word.startsWith(short) && word.length - short.length <= Math.max(6, short.length + 1)) return 1;
    return 0;
}

// Слово с приставкой «не»: «неостановка» для запроса «не остановился».
function isNegatedWord(word, token) {
    return word.startsWith('не' + (token.short || token.stem));
}

function bestWordLevel(words, token) {
    let best = 0;
    for (const word of words) {
        const level = searchWordLevel(word, token);
        if (level > best) best = level;
        if (best === 2) break;
    }
    return best;
}

// Вес совпадения по уровням [0, 1, 2] для каждого поля.
const SEARCH_WEIGHTS = {
    title: [0, 6, 10],
    tags: [0, 4, 7],
    desc: [0, 2, 5]
};
// Номер статьи весит больше любого слова.
const SEARCH_NUM_EXACT = 1000;
const SEARCH_NUM_CHILD = 600;
const SEARCH_NUM_PART = 500;
const SEARCH_NUM_IN_TEXT = 2;

// Редкое слово запроса весит больше частого: вес = (число записей / число записей со словом) в этой степени.
const SEARCH_RARITY_POWER = 0.35;
// Слову с основой из трёх букв вес редкости ограничен: такие совпадения часто случайны.
const SEARCH_SHORT_STEM_WEIGHT = 2;
// Слово с «не» («неостановка» для «не остановился») ценится в полтора раза выше обычного совпадения.
const SEARCH_NEGATED_BOOST = 1.5;
// Надбавка каждому слову запроса, если несколько слов нашлись в одном теге («езда без прав»).
const SEARCH_PHRASE_BONUS = 3;
// Статья, где нашлись не все слова, показывается рядом с полными совпадениями, если набрала такую долю лучшего счёта.
const SEARCH_PARTIAL_SHARE = 0.8;

// Родственные слова учитываются, только если само слово встречается реже этого числа записей.
const SEARCH_RELATED_LIMIT = 3;

const NUM_BASE_RE = /^\d+(\.\d+)*/;

const searchIndexCache = new WeakMap();

function getArticleSearchIndex(article) {
    let index = searchIndexCache.get(article);
    if (!index) {
        const num = normalizeSearchText(article.num).replace(/ч\.\s+/g, 'ч.');
        index = {
            num,
            numBase: (num.match(NUM_BASE_RE) || [''])[0],
            title: splitSearchWords(article.title),
            tags: splitSearchWords(article.tags),
            tagGroups: String(article.tags).split(',').map(splitSearchWords).filter(group => group.length > 1),
            desc: splitSearchWords(article.desc)
        };
        searchIndexCache.set(article, index);
    }
    return index;
}

function getProceduralSearchIndex(item) {
    let index = searchIndexCache.get(item);
    if (!index) {
        index = {
            num: '',
            numBase: '',
            title: splitSearchWords(item.title),
            tags: [],
            tagGroups: [],
            desc: splitSearchWords(item.content)
        };
        searchIndexCache.set(item, index);
    }
    return index;
}

function numberScore(index, number, allowInText) {
    if (index.numBase === number) return SEARCH_NUM_EXACT;
    if (index.numBase.startsWith(number + '.')) return SEARCH_NUM_CHILD;
    if (allowInText && !number.includes('.') &&
        (index.title.includes(number) || index.desc.includes(number) || index.tags.includes(number))) {
        return SEARCH_NUM_IN_TEXT;
    }
    return 0;
}

// Надбавка за фразу: несколько слов запроса в одном теге.
function phraseBonus(index, words, weights) {
    let best = 0;
    index.tagGroups.forEach(group => {
        let count = 0;
        let sum = 0;
        words.forEach((token, i) => {
            if (bestWordLevel(group, token) === 2) { count += 1; sum += weights[i]; }
        });
        if (count >= 2 && sum > best) best = sum;
    });
    return best * SEARCH_PHRASE_BONUS;
}

// entries: [{ item, index, tie }]. Порядок — по счёту: редкое слово запроса весит больше частого.
// Показываются записи со всеми словами запроса и близкие к лучшей по счёту; если полных нет — все найденные.
function rankBySearch(entries, query) {
    const levels = entries.map(entry => query.words.map(token => [
        bestWordLevel(entry.index.title, token),
        bestWordLevel(entry.index.tags, token),
        bestWordLevel(entry.index.desc, token)
    ]));

    // Если самого слова нет ни в одной записи, родственные слова засчитываются как оно само.
    const onlyRelated = [];
    const weights = query.words.map((token, i) => {
        const exactCount = levels.filter(entryLevels => Math.max(...entryLevels[i]) === 2).length;
        token.minLevel = exactCount < SEARCH_RELATED_LIMIT ? 1 : 2;
        onlyRelated[i] = exactCount === 0;
        const found = exactCount || levels.filter(entryLevels => Math.max(...entryLevels[i]) === 1).length || 1;
        const weight = Math.pow(entries.length / found, SEARCH_RARITY_POWER);
        return token.stem.length <= SEARCH_MIN_STEM ? Math.min(weight, SEARCH_SHORT_STEM_WEIGHT) : weight;
    });

    const numberInText = query.numbers.map(number =>
        query.words.length > 0 || !entries.some(entry => numberScore(entry.index, number, false) > 0));

    const results = [];
    entries.forEach((entry, order) => {
        const index = entry.index;
        let matched = 0;
        let score = 0;

        query.numbers.forEach((number, i) => {
            const value = numberScore(index, number, numberInText[i]);
            if (value) { matched += 1; score += value; }
        });

        query.parts.forEach(part => {
            if (` ${index.num} `.includes(` ${part} `)) { matched += 1; score += SEARCH_NUM_PART; }
        });

        query.words.forEach((token, i) => {
            const [title, tags, desc] = levels[order][i].map(level =>
                (level < token.minLevel ? 0 : (onlyRelated[i] && level ? 2 : level)));
            let value = Math.max(SEARCH_WEIGHTS.title[title], SEARCH_WEIGHTS.tags[tags], SEARCH_WEIGHTS.desc[desc]);
            if (token.negated) {
                const field = ['title', 'tags', 'desc'].find(name => index[name].some(word => isNegatedWord(word, token)));
                if (field) value = Math.max(value, SEARCH_WEIGHTS[field][2] * SEARCH_NEGATED_BOOST);
            }
            if (value) { matched += 1; score += value * weights[i]; }
        });

        if (query.total > 0 && matched === 0) return;
        if (query.words.length > 1) score += phraseBonus(index, query.words, weights);
        results.push({ item: entry.item, matched, score, order, tie: entry.tie });
    });

    const hasComplete = results.some(r => r.matched === query.total);
    const top = results.reduce((max, r) => Math.max(max, r.score), 0);
    return results
        .filter(r => !hasComplete || r.matched === query.total || r.score >= top * SEARCH_PARTIAL_SHARE)
        .sort((x, y) => (y.score - x.score) || (x.tie - y.tie) || (x.order - y.order))
        .map(r => r.item);
}

function searchArticles(query) {
    const entries = parsedDatabase
        .filter(article => !query.codes.length || query.codes.includes(article.code))
        .map(article => ({
            item: article,
            index: getArticleSearchIndex(article),
            tie: article.code === currentCode ? 0 : 1
        }));
    return rankBySearch(entries, query).map(article => ({ article }));
}

function searchProceduralCards(query) {
    const entries = proceduralData.map(item => ({ item, index: getProceduralSearchIndex(item), tie: 0 }));
    return rankBySearch(entries, query);
}

// ===== Поиск: опечатки и раскладка клавиатуры =====

// Клавиши английской раскладки и русские буквы на тех же клавишах.
const LAYOUT_EN = "`qwertyuiop[]asdfghjkl;'zxcvbnm,.{}:\"<>~";
const LAYOUT_RU = "ёйцукенгшщзхъфывапролджэячсмитьбюхъжэбюё";

// Перевод в другую раскладку — только для кусков, где есть буквы исходной: «12.8» не трогается.
function swapLayout(text, from, to) {
    const letters = from === LAYOUT_EN ? /[a-z]/ : /[а-яё]/;
    return text.split(/(\s+)/).map(chunk => {
        if (!letters.test(chunk)) return chunk;
        return Array.from(chunk, ch => {
            const at = from.indexOf(ch);
            return at === -1 ? ch : to[at];
        }).join('');
    }).join('');
}

// Слова запроса короче TYPO_MIN_LENGTH не исправляются («торт» не должен стать «торсом»);
// от TYPO_LONG_WORD букв допускаются две ошибки вместо одной. Основы сравниваются от TYPO_MIN_STEM букв:
// на четырёх буквах разные слова слишком похожи («рация» становилась «ранил»).
const TYPO_MIN_LENGTH = 5;
const TYPO_MIN_STEM = 5;
const TYPO_LONG_WORD = 8;

// Словарь слов базы: слово → основа и число записей с ним; fixes — уже найденные исправления.
// Пересоздаётся при обновлении данных.
const searchVocabCache = new WeakMap();

function getSearchVocab(items, getIndex) {
    let vocab = searchVocabCache.get(items);
    if (!vocab) {
        vocab = { words: new Map(), fixes: new Map() };
        items.forEach(item => {
            const index = getIndex(item);
            new Set([...index.title, ...index.tags, ...index.desc]).forEach(word => {
                const entry = vocab.words.get(word);
                if (entry) entry.count += 1;
                else vocab.words.set(word, { stem: searchStems(word).stem, count: 1 });
            });
        });
        searchVocabCache.set(items, vocab);
    }
    return vocab;
}

// Число правок между словами: вставка, удаление, замена, перестановка соседних букв. Больше max — не считается.
function editDistance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev2 = null;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const row = [i];
        let best = i;
        for (let j = 1; j <= b.length; j++) {
            let value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            if (prev2 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                value = Math.min(value, prev2[j - 2] + 1);
            }
            row.push(value);
            if (value < best) best = value;
        }
        if (best > max) return max + 1;
        prev2 = prev;
        prev = row;
    }
    return prev[b.length];
}

// Ближайшее слово базы для слова запроса, которого в базе нет ни в каком виде: «крожа» → «кража».
function findTypoFix(token, vocab) {
    if (token.full.length < TYPO_MIN_LENGTH || /\d/.test(token.full) || vocab.words.has(token.full)) return null;
    if (vocab.fixes.has(token.full)) return vocab.fixes.get(token.full);

    let known = false;
    for (const word of vocab.words.keys()) {
        if (searchWordLevel(word, token) > 0) { known = true; break; }
    }

    let best = null;
    if (!known) {
        const max = token.full.length >= TYPO_LONG_WORD ? 2 : 1;
        vocab.words.forEach((entry, word) => {
            if (word.length < TYPO_MIN_LENGTH - 1 || /\d/.test(word) || word[0] !== token.full[0]) return;
            let distance = editDistance(token.full, word, max);
            if (token.stem.length >= TYPO_MIN_STEM && entry.stem.length >= TYPO_MIN_STEM) {
                distance = Math.min(distance, editDistance(token.stem, entry.stem, max));
            }
            if (distance > max) return;
            if (!best || distance < best.distance || (distance === best.distance && entry.count > best.count)) {
                best = { word, distance, count: entry.count };
            }
        });
    }

    const fix = best ? best.word : null;
    vocab.fixes.set(token.full, fix);
    return fix;
}

function fixQueryTypos(query, vocab) {
    const fixed = [];
    query.words.forEach(token => {
        const fix = findTypoFix(token, vocab);
        const result = fix ? { ...token, full: fix, ...searchStems(fix) } : token;
        if (!fixed.some(other => other.full === result.full)) fixed.push(result);
    });
    query.words = fixed;
    query.total = query.words.length + query.numbers.length + query.parts.length;
}

// Поиск с запасными попытками: сначала исправляются опечатки, при пустой выдаче пробуется другая раскладка.
function findWithFixes(raw, parseOptions, items, getIndex, search) {
    const attempt = text => {
        const query = parseSearchQuery(text, parseOptions);
        if (query.words.length) fixQueryTypos(query, getSearchVocab(items, getIndex));
        return { query, results: query.active ? search(query) : [] };
    };

    const first = attempt(raw);
    if (!first.query.active || first.results.length) return first;

    const text = String(raw).toLowerCase();
    for (const [from, to] of [[LAYOUT_EN, LAYOUT_RU], [LAYOUT_RU, LAYOUT_EN]]) {
        const swapped = swapLayout(text, from, to);
        if (swapped === text) continue;
        const next = attempt(swapped);
        // Начало русского слова не должно превращаться в обозначение кодекса («вл» → «dk»).
        if (to === LAYOUT_EN && next.query.total === 0) continue;
        if (next.results.length) return next;
    }
    return first;
}

// ===== Поиск: подсветка =====

function wrapHighlightRanges(text, ranges) {
    let html = '';
    let last = 0;
    ranges.sort((a, b) => a[0] - b[0]).forEach(([start, end]) => {
        if (end <= last) return;
        const from = Math.max(start, last);
        html += escapeHtml(text.slice(last, from));
        html += `<span class="highlight">${escapeHtml(text.slice(from, end))}</span>`;
        last = end;
    });
    return html + escapeHtml(text.slice(last));
}

function highlightText(text, query) {
    if (!query) return escapeHtml(text);
    const normalized = normalizeSearchText(text);
    if (normalized.length !== text.length) return escapeHtml(text);

    const ranges = [];
    for (const match of normalized.matchAll(SEARCH_WORD_RE)) {
        const word = match[0];
        const isHit = query.numbers.includes(word) ||
            query.words.some(token => searchWordLevel(word, token) >= token.minLevel ||
                (token.negated && isNegatedWord(word, token)));
        if (isHit) ranges.push([match.index, match.index + word.length]);
    }
    return wrapHighlightRanges(text, ranges);
}

function highlightArticleNum(num, query) {
    if (!query) return escapeHtml(num);
    const normalized = normalizeSearchText(num);
    if (normalized.length !== num.length) return escapeHtml(num);

    const ranges = [];
    const base = (normalized.match(NUM_BASE_RE) || [''])[0];
    query.numbers.forEach(number => {
        if (base === number || base.startsWith(number + '.')) ranges.push([0, number.length]);
    });
    query.parts.forEach(part => {
        const match = normalized.match(new RegExp(`ч\\.\\s*${part.slice(2)}(?!\\d)`));
        if (match) ranges.push([match.index, match.index + match[0].length]);
    });
    return wrapHighlightRanges(num, ranges);
}

// ===== Хелперы рендера статей (общие для карточек и списка) =====

// Бейдж типа статьи (Ф/Р и т.п.) с расшифровкой в title. Только для УК.
function buildTypeBadge(article, extraClass = '') {
    if (article.code !== 'uk') return '';
    const safeType = escapeHtml(article.type);
    if (!safeType || safeType === '-') return '';
    const typeLabel = TYPE_LABELS[article.type] || '';
    return `<div class="article-type ${extraClass}" title="${escapeHtml(typeLabel)}">${safeType}</div>`;
}

// Плашка кодекса (УК/АК/ДК) в цвет кодекса — только в результатах поиска.
function buildCodeBadge(article, query, extraClass = '') {
    const label = CODE_LABELS[article.code];
    if (!query || !label) return '';
    return `<div class="article-type article-code ${article.code} ${extraClass}" title="${CODE_NAMES[article.code] || ''}">${label}</div>`;
}

// Кнопка закрепления (иконка-булавка). size=15 в карточках, size=14 в списке.
function buildPinButton(article, size) {
    const pinned = isPinned(article);
    const label = pinned ? 'Открепить статью' : 'Закрепить статью';
    return `<button class="pin-btn" title="${label}" aria-label="${label}" aria-pressed="${pinned}"><svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 4V11L6 15V17H18V15L15 11V4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 17V21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7 4H17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>`;
}

// Общие обработчики карточки/строки: копирование номера, пин.
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
}

// ===== Toast-уведомления =====

// Переиспользует один DOM-элемент между вызовами.
const TOAST_DURATION_MS = 1800;
const WELCOME_TOAST_DURATION_MS = 3000;
let toastEl = null;
let toastHideTimer = null;
function showToast(message, duration = TOAST_DURATION_MS) {
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
    }, duration);
}

// Приветствие — при каждом заходе на страницу.
let welcomeToastUntil = 0;
function showWelcomeToast() {
    welcomeToastUntil = Date.now() + WELCOME_TOAST_DURATION_MS + 300;
    showToast('Памятка по законодательной базе Orlando', WELCOME_TOAST_DURATION_MS);
}

function copyArticleNumber(article, { remember = true } = {}) {
    const codeLabel = CODE_LABELS[article.code] || '';
    const text = `ст. ${article.num} ${codeLabel}`.trim();

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
            showToast(`Скопировано: ${text}`);
            if (remember) rememberCopied(article);
        })
        .catch(onFail);
}

// ===== Основной рендер =====

// Строка «Найдено» над выдачей поиска: сколько статей в каждом кодексе и отбор по кодексу.
// Показывается, только когда найденное лежит в нескольких кодексах.
function renderFoundRow(container, counts) {
    const codes = Object.keys(CODE_LABELS).filter(code => counts[code]);
    if (codes.length < 2) return;

    const total = codes.reduce((sum, code) => sum + counts[code], 0);
    const row = document.createElement('div');
    row.className = 'found-row';
    row.innerHTML = '<span class="found-label">Найдено:</span>'
        + `<button type="button" class="found-chip" data-code="" title="Показать всё найденное">Все ${total}</button>`
        + codes.map(code => `<button type="button" class="found-chip" data-code="${code}" title="Показать только найденное в ${CODE_LABELS[code]}"><span class="found-code ${code}">${CODE_LABELS[code]}</span>${counts[code]}</button>`).join('');

    row.querySelectorAll('.found-chip').forEach(chip => {
        const code = chip.dataset.code || null;
        const isActive = code === searchCodeFilter;
        chip.classList.toggle('active', isActive);
        chip.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        chip.addEventListener('click', () => {
            if (code === searchCodeFilter) return;
            searchCodeFilter = code;
            renderArticles();
        });
    });
    container.prepend(row);
}

function renderArticles({ keepExpanded = false } = {}) {
    const container = document.getElementById('articlesContainer');

    const rawQuery = document.getElementById('searchInput').value;
    renderedSearchText = rawQuery;
    listShowsSearch = false;
    if (!keepExpanded) {
        keyboardSelectedId = null;
        foundRowKeysActive = false;
    }

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
            'Не удалось загрузить базу данных. Проверьте интернет-соединение и попробуйте снова.', retryArticles);
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
    if (keepExpanded) {
        container.querySelectorAll('.row.expanded').forEach(row => expandedIds.add(row.dataset.articleId));
    }

    container.innerHTML = "";
    container.className = currentView === 'list' ? 'list-view' : '';

    if (matchedArticles.length === 0) {
        const examplesHtml = query
            ? '<div class="loader-hint">Можно искать по номеру (12.8), по слову (кража) или по ситуации (угнал машину).</div>'
            : '';
        container.innerHTML = `<div class="loader">По запросу ничего не найдено. Попробуйте описать иначе.${examplesHtml}</div>`;
        return;
    }

    if (currentView === 'list') {
        renderAsList(container, matchedArticles, query, expandedIds);
    } else {
        renderAsCards(container, matchedArticles, query);
    }
    restoreKeyboardSelection();
    renderRecentRow();
    if (query) renderFoundRow(container, counts);

    if (!query && currentDisplayMode === 'compact') {
        const total = parsedDatabase.filter(article => article.code === currentCode).length;
        if (matchedArticles.length < total) renderCompactHint(container, matchedArticles.length, total);
    }
}

// В режиме «Основные» под списком — сколько статей показано и кнопка «Показать все».
function renderCompactHint(container, shown, total) {
    const hint = document.createElement('div');
    hint.className = 'list-hint';
    hint.innerHTML = `Показаны основные статьи: ${shown} из ${total}. <button type="button" class="list-hint-btn">Показать все</button>`;
    hint.querySelector('.list-hint-btn').addEventListener('click', () => {
        setDisplayMode('full');
        scrollToListTop();
    });
    container.appendChild(hint);
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
    const runs = article.stars.match(/★+/g);
    if (!runs) return 'Розыск';
    const count = runs[runs.length - 1].length;
    if (runs.length > 1) return `от ${runs[0].length} до ${count} звёзд`;
    return `${count} ${pluralizeStars(count)}`;
}

// В списке диапазон звёзд показывается коротко: «★★–★★★».
function starsShort(stars) {
    const runs = stars.match(/★+/g);
    return runs && runs.length > 1 ? `${runs[0]}–${runs[runs.length - 1]}` : stars;
}

function buildStarsTag(article) {
    const short = starsShort(article.stars);
    const rangeClass = short !== article.stars ? 'row-stars-range' : '';
    return `<div class="row-tag row-slot-stars ${rangeClass}" title="${starsTitle(article)}">${escapeHtml(short) || '—'}</div>`;
}

function buildHighlightedFields(article, query) {
    return {
        title: highlightText(article.title, query),
        num: highlightArticleNum(article.num, query),
        desc: highlightText(article.desc, query).replace(/\n/g, '<br>'),
    };
}

// ===== Отрисовка: карточки =====

// Фильтрация/поиск/сортировка уже выполнены в renderArticles() — здесь только разметка.
function renderAsCards(container, matchedArticles, query) {
    matchedArticles.forEach(item => {
        const article = item.article;

        const card = document.createElement('div');
        card.className = `card ${article.code} ${isPinned(article) ? 'pinned' : ''}`;
        card.dataset.articleId = articleId(article);

        const { title: highlightedTitle, num: highlightedNum, desc: highlightedDesc } =
            buildHighlightedFields(article, query);

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
                    <div class="title" title="${escapeHtml(article.title)}">${highlightedTitle}</div>
                </div>
                <div class="card-header-right">${buildCodeBadge(article, query)}${typeHtml}<div class="badge-num">ст. ${highlightedNum}</div></div>
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

        attachArticleHandlers(card, article);

        container.appendChild(card);
    });
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
        return `<button type="button" class="row-part" data-part-id="${escapeHtml(articleId(item))}" title="ст. ${escapeHtml(item.num)} — ${escapeHtml(item.title)}"><span class="row-part-num">${escapeHtml(part)}</span><span class="row-part-title">${escapeHtml(item.title)}</span></button>`;
    }).join('');
    return `<div class="row-parts"><span class="row-parts-label">Другие части статьи:</span>${pills}</div>`;
}

// Прокрутка к строке или плитке так, чтобы она не оказалась под закреплённой шапкой.
function revealInList(el, smooth = false) {
    el.style.scrollMarginTop = `${document.querySelector('.controls-container').offsetHeight}px`;
    el.style.scrollMarginBottom = '12px';
    el.scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' });
}

// Нажатие на плашку части: её строка раскрывается; если строки нет в списке — вставляется под текущей.
function openArticlePart(fromRow, id, query) {
    const rows = Array.from(fromRow.parentElement.querySelectorAll('.row'));
    let target = rows.find(item => item.dataset.articleId === id);
    if (!target) {
        const article = parsedDatabase.find(item => articleId(item) === id);
        if (!article) return;
        target = buildListRow(article, query, false);
        target.dataset.inserted = 'true';
        // Вставленные части идут под исходной строкой в порядке номеров.
        const order = el => parsedDatabase.findIndex(item => articleId(item) === el.dataset.articleId);
        let anchor = fromRow;
        while (anchor.nextElementSibling && anchor.nextElementSibling.dataset.inserted === 'true'
            && order(anchor.nextElementSibling) < order(target)) {
            anchor = anchor.nextElementSibling;
        }
        anchor.after(target);
        void target.offsetWidth; // чтобы раскрытие вставленной строки было плавным
    }
    target.classList.add('expanded');
    target.querySelector('.row-header').setAttribute('aria-expanded', 'true');
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

function buildListRow(article, query, isExpanded) {
    const row = document.createElement('div');
    row.className = `row ${article.code} ${isPinned(article) ? 'pinned' : ''} ${isExpanded ? 'expanded' : ''}`;
    row.dataset.articleId = articleId(article);

    const { title: highlightedTitle, num: highlightedNum, desc: highlightedDesc } =
        buildHighlightedFields(article, query);

    const typeHtml = buildTypeBadge(article, 'row-slot-type');

    // row-slot-* — фиксированная ширина, заголовок начинается в одной позиции.
    const leftHtml = `
        ${buildCodeBadge(article, query, 'row-slot-code')}
        ${typeHtml}
        <div class="badge-num row-num row-slot-num">ст. ${highlightedNum}</div>
        <div class="row-title" title="${escapeHtml(article.title)}">${buildPinButton(article, 14)}${highlightedTitle}</div>
    `;

    // УК — штраф/звёзды/арест, доп. мера — только если заполнена.
    // АК и ДК — доп. мера/штраф, звёзды и арест — только если заполнены. row-slot-* держат ширину.
    let rightHtml = '';
    if (article.code === 'uk') {
        const safeFine = escapeHtml(article.fine);
        const safeArrest = escapeHtml(article.arrest);
        const hasFelony = hasFelonyRecord(article);
        const arrestTitle = safeArrest
            ? `${safeArrest}, ${hasFelony ? 'судимость' : 'без судимости'}`
            : 'Арест';
        // Доп. мера у статьи УК: плашка слева от штрафа, остальные колонки не сдвигаются.
        const safeExtraMeasure = escapeHtml(article.extraMeasure);
        const extraHtml = safeExtraMeasure
            ? `<div class="row-tag row-slot-extra" title="${safeExtraMeasure}">${safeExtraMeasure}</div>`
            : '';

        rightHtml = `
            ${extraHtml}
            <div class="row-tag row-slot-fine ${safeFine ? 'row-fine' : ''}" title="${safeFine ? `Штраф: ${safeFine}` : 'Штраф'}">${safeFine || '—'}</div>
            ${buildStarsTag(article)}
            <div class="row-tag row-slot-arrest ${hasFelony ? 'row-danger' : ''}" title="${arrestTitle}">${safeArrest || '—'}</div>
        `;
    } else {
        const safeExtraMeasure = escapeHtml(article.extraMeasure);
        const safeFine = escapeHtml(article.fine);
        const hasExtraMeasure = Boolean(article.extraMeasure);
        let extraHtml = `<div class="row-tag row-slot-extra ${hasExtraMeasure ? '' : 'row-hidden'}" title="${hasExtraMeasure ? safeExtraMeasure : ''}">${safeExtraMeasure}</div>`;
        // Звёзды и арест у статьи АК или ДК: плашки встают на место пустой доп. меры, вплотную к штрафу.
        const safeArrest = escapeHtml(article.arrest);
        const penaltyHtml = (article.stars ? buildStarsTag(article) : '')
            + (safeArrest ? `<div class="row-tag row-slot-arrest" title="Арест: ${safeArrest}">${safeArrest}</div>` : '');
        if (penaltyHtml) {
            extraHtml = hasExtraMeasure
                ? penaltyHtml + extraHtml
                : `<div class="row-slot-holder">${penaltyHtml}</div>`;
        }

        rightHtml = `
            ${extraHtml}
            <div class="row-tag row-slot-fine ${safeFine ? 'row-fine' : ''}" title="${safeFine ? `Штраф: ${safeFine}` : 'Штраф'}">${safeFine || '—'}</div>
        `;
    }

    const partsHtml = buildPartsHtml(article);

    row.innerHTML = `
        <div class="row-header" role="button" tabindex="0" aria-expanded="${isExpanded}">
            <div class="row-left">${leftHtml}</div>
            <div class="row-right">${rightHtml}</div>
            <svg class="row-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
        </div>
        <div class="row-desc-wrapper">
            <div class="row-desc-inner">
                <div class="row-desc ${partsHtml ? 'row-desc-with-parts' : ''}">${highlightedDesc}</div>
                ${partsHtml}
            </div>
        </div>
    `;

    attachArticleHandlers(row, article, { stopPropagation: true });

    row.querySelectorAll('.row-part').forEach(btn => btn.addEventListener('click', () => {
        openArticlePart(row, btn.dataset.partId, query);
    }));

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

    return row;
}

// ===== Общая информация: диспетчер шаблонов =====
const PK_TEMPLATES = {
    steps: renderPkSteps,
    list: renderPkList,
};

function buildPkItems(content, query) {
    return content.split('\n').map(s => s.trim()).filter(Boolean)
        .map(line => `<li>${highlightText(line, query)}</li>`).join('');
}

function renderPkSteps(content, query) {
    return `<ol class="pk-steps">${buildPkItems(content, query)}</ol>`;
}

// Маркированный список — порядок пунктов не важен (в отличие от "steps")
function renderPkList(content, query) {
    return `<ul class="pk-list">${buildPkItems(content, query)}</ul>`;
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
            'Не удалось загрузить раздел. Проверьте интернет-соединение и попробуйте снова.', retryProcedural);
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

    items.forEach(item => {
        const card = document.createElement('div');
        card.className = 'card pk';

        card.innerHTML = `
            <div class="card-header">
                <div class="title" title="${escapeHtml(item.title)}">${highlightText(item.title, query)}</div>
            </div>
            <div class="pk-body">${renderProceduralCardBody(item, query)}</div>
        `;
        container.appendChild(card);
    });
}

const SEARCH_PLACEHOLDER_DEFAULT = document.getElementById('searchInput').placeholder;
const SEARCH_PLACEHOLDER_PK = 'Поиск по общей информации...';

document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', (e) => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    e.currentTarget.classList.add('active');
    currentCode = e.currentTarget.getAttribute('data-code');
    
    clearTimeout(searchDebounceTimer);
    const searchInput = document.getElementById('searchInput');
    if (searchInput.value !== "") {
        searchInput.value = "";
    }
    syncSearchClearBtn();
    searchInput.placeholder = currentCode === 'pk' ? SEARCH_PLACEHOLDER_PK : SEARCH_PLACEHOLDER_DEFAULT;
    renderArticles();
    scrollToListTop();
}));

// ===== Переключатели: режим отображения и вид =====

function syncToggleUI(selector, attribute, value) {
    document.querySelectorAll(selector).forEach(btn => {
        const isActive = btn.getAttribute(attribute) === value;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

function syncModeToggleUI() {
    syncToggleUI('.mode-btn', 'data-mode', currentDisplayMode);
}

const DISPLAY_MODE_TOAST = {
    compact: 'Основные статьи',
    full: 'Все статьи'
};

function setDisplayMode(selectedMode) {
    if (selectedMode === currentDisplayMode) return;
    currentDisplayMode = selectedMode;
    localStorage.setItem(DISPLAY_MODE_KEY, currentDisplayMode);
    syncModeToggleUI();
    renderArticles();
    showToast(DISPLAY_MODE_TOAST[currentDisplayMode]);
}

document.querySelectorAll('.mode-btn').forEach(btn => btn.addEventListener('click', (e) => {
    setDisplayMode(e.currentTarget.getAttribute('data-mode'));
}));

syncModeToggleUI();

function syncViewToggleUI() {
    syncToggleUI('.view-btn', 'data-view', currentView);
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
    showToast(VIEW_TOAST[currentView]);
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
        selectByKeyboard(null);
        searchField.focus({ preventScroll: true });
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

function scrollToListTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

scrollTopBtn.addEventListener('click', scrollToListTop);

updateScrollTopVisibility();

// ===== Поле поиска: очистка =====
const searchField = document.getElementById('searchInput');
const searchClearBtn = document.getElementById('searchClearBtn');

function syncSearchClearBtn() {
    if (!searchClearBtn) return;
    searchClearBtn.classList.toggle('visible', searchField.value !== '');
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

function selectByKeyboard(el) {
    document.querySelectorAll('#articlesContainer .kbd-selected').forEach(other => other.classList.remove('kbd-selected'));
    keyboardSelectedId = el ? el.dataset.articleId : null;
    if (!el) return;
    el.classList.add('kbd-selected');
    revealInList(el);
}

// После перерисовки без смены выдачи (например, закрепление) выбор остаётся на той же статье.
function restoreKeyboardSelection() {
    if (!keyboardSelectedId) return;
    const el = articleElements().find(item => item.dataset.articleId === keyboardSelectedId);
    if (el) el.classList.add('kbd-selected');
    else keyboardSelectedId = null;
}

// Набранный запрос применяется сразу, без ожидания паузы после ввода: иначе клавиша сработала бы
// по прежнему списку, а через мгновение он бы сменился.
function applyPendingSearch() {
    clearTimeout(searchDebounceTimer);
    if (searchField.value !== renderedSearchText) renderArticles();
}

// Переход по кнопкам строки «Найдено» стрелками влево и вправо; после перехода выбрана первая статья выдачи.
// В плитках статья не выбирается: иначе следующая стрелка досталась бы плиткам, а не строке «Найдено».
// Возвращает false, если строки «Найдено» нет.
function shiftFoundCategory(step) {
    const chips = Array.from(document.querySelectorAll('#articlesContainer .found-chip'));
    if (chips.length === 0) return false;
    const next = chips[chips.findIndex(chip => chip.classList.contains('active')) + step];
    if (next) {
        searchCodeFilter = next.dataset.code || null;
        renderArticles();
        if (currentView === 'grid') foundRowKeysActive = true;
        else selectByKeyboard(articleElements()[0] || null);
        scrollToListTop();
    }
    return true;
}

// Переход на соседнюю вкладку стрелками влево и вправо, когда поиска нет.
function shiftTab(step) {
    const tabs = Array.from(document.querySelectorAll('.tab-btn'));
    const next = tabs[tabs.findIndex(tab => tab.classList.contains('active')) + step];
    if (next) next.click();
}

// В плитках стрелки вверх и вниз переходят в соседний ряд, на плитку в той же колонке.
function gridNeighbor(items, current, step) {
    const from = current.getBoundingClientRect();
    const boxes = items.map(el => ({ el, box: el.getBoundingClientRect() }))
        .filter(({ box }) => (step > 0 ? box.top > from.top + 1 : box.top < from.top - 1));
    if (boxes.length === 0) return null;
    const tops = boxes.map(({ box }) => box.top);
    const rowTop = step > 0 ? Math.min(...tops) : Math.max(...tops);
    return boxes.filter(({ box }) => Math.abs(box.top - rowTop) < 2)
        .reduce((best, item) => (Math.abs(item.box.left - from.left) < Math.abs(best.box.left - from.left) ? item : best)).el;
}

// Раскрывает или сворачивает описание статьи, выбранной стрелками (в плитках оно видно всегда).
function toggleSelectedDescription() {
    const el = articleElements().find(item => item.dataset.articleId === keyboardSelectedId);
    if (!el) return;
    closeSettingsPanel();
    el.querySelector('.row-header').click();
    setTimeout(() => revealInList(el, true), 280);
}

searchField.title = '↑ ↓ — выбрать статью, Ctrl+C — скопировать номер, пробел — описание, ← → — кодекс';
zoomMinusBtn.title = 'Уменьшить (←)';
zoomPlusBtn.title = 'Увеличить (→)';

// Щелчок по полю поиска снимает выбор статьи: стрелки влево и вправо снова двигают курсор по тексту.
searchField.addEventListener('mousedown', () => {
    selectByKeyboard(null);
    foundRowKeysActive = false;
});

// Ctrl+C копирует номер статьи, выбранной стрелками. Если выделен текст — в поле поиска или на странице —
// копируется он, как обычно. Клавиша определяется по положению (KeyC), раскладка не важна.
document.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyC' || !e.ctrlKey || e.altKey || e.shiftKey) return;
    applyPendingSearch();
    if (!keyboardSelectedId) return;
    if (document.activeElement === searchField && searchField.selectionStart !== searchField.selectionEnd) return;
    if (String(window.getSelection()) !== '') return;
    const article = parsedDatabase.find(item => articleId(item) === keyboardSelectedId);
    if (!article) return;
    e.preventDefault();
    closeSettingsPanel();
    copyArticleNumber(article);
});

// Печать где угодно попадает в поиск: курсор переходит в поле, и набранный знак вводится уже в него.
document.addEventListener('keydown', (e) => {
    if (e.key.length !== 1 || e.key === ' ' || e.ctrlKey || e.altKey || e.metaKey) return;
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
        if (inSearch && !keyboardSelectedId && !foundRowKeysActive && !caretAtEdge) return;

        // В плитках, когда плитка выбрана стрелками, влево и вправо переходят на соседнюю плитку.
        // Пока выбора нет, они переключают вкладки и кодексы, как в списке.
        if (currentView === 'grid' && currentCode !== 'pk') {
            const items = articleElements();
            const at = items.findIndex(item => item.dataset.articleId === keyboardSelectedId);
            if (at !== -1) {
                e.preventDefault();
                releaseFocus();
                selectByKeyboard(items[Math.min(Math.max(at + step, 0), items.length - 1)]);
                return;
            }
        }

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

    if (currentCode === 'pk') return;

    // Пробел раскрывает описание, когда статья выбрана стрелками в списке; иначе это обычный пробел в запросе.
    if (e.key === ' ') {
        if (!keyboardSelectedId || currentView !== 'list' || (!inSearch && e.target !== document.body)) return;
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
    else if (currentView === 'grid') next = gridNeighbor(items, current, step);
    else next = items[items.indexOf(current) + step];
    // Вниз с последней статьи — выбор остаётся; вверх с первой — выбор снимается.
    if (!next && step === 1) next = current || null;
    selectByKeyboard(next || null);
    if (!next) scrollToListTop();
});

syncSearchClearBtn();
searchField.focus();
showWelcomeToast();
loadData();
loadProceduralData();
loadMetaData();
