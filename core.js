// Общая часть памятки и быстрого окна программы для Windows: хранение, загрузка и разбор базы, поиск.
// Со страницей этот файл не работает — только с данными. Подключается перед script.js и перед quick.js.

// ===== Работа без интернета =====
// sw.js сохраняет файлы сайта и отдаёт их, когда сеть не отвечает; статьи хранит кэш данных ниже.
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {
        // Браузер запретил — сайт работает как раньше, только без запаса на случай без сети.
    });
}

// ===== Настройки сервера =====
const SHEET_ID = '1y4PKeW4sTxnQhJJ7nlO2coCZPdRbUKjC28KQkpMidrs';
const STORAGE_PREFIX = 'majestic_orlando_';

// ===== Память браузера =====
// При строгих настройках приватности браузер запрещает хранение, и обращение к localStorage бросает ошибку.
// Тогда сайт работает без сохранения: настройки и копия базы живут до закрытия вкладки.
function storeGet(key) {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function storeSet(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch {
        return false;
    }
}

function storeRemove(key) {
    try {
        localStorage.removeItem(key);
    } catch {
        // Хранение запрещено — убирать нечего.
    }
}

// Уборка за прежней версией сайта (сервер Portland): её сохранённые данные больше не читаются.
try {
    Object.keys(localStorage)
        .filter(key => key.startsWith('majestic_portland_'))
        .forEach(key => localStorage.removeItem(key));
} catch {
    // Хранение запрещено — убирать нечего.
}

// ===== Настройки Google Sheets =====
function sheetUrl(sheetName) {
    return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?sheet=${encodeURIComponent(sheetName)}&headers=0`;
}

const DATA_URL = sheetUrl('База данных');
const PK_URL = sheetUrl('Общая информация');
const META_URL = sheetUrl('Последняя редакция');

// ===== Состояние, общее для памятки и быстрого окна =====
let parsedDatabase = [];
// Открытый кодекс: при равном счёте поиск ставит его статьи выше. У быстрого окна кодекса нет.
let currentCode = "uk";

function articleId(article) {
    return `${article.code}::${article.num}`;
}

// ===== Недавно скопированные статьи: хранение =====
const RECENT_KEY = STORAGE_PREFIX + 'recent_copied';
const RECENT_LIMIT = 5;
let recentCopied = loadRecentCopied();

function loadRecentCopied() {
    try {
        const raw = JSON.parse(storeGet(RECENT_KEY));
        return Array.isArray(raw) ? raw.filter(id => typeof id === 'string').slice(0, RECENT_LIMIT) : [];
    } catch {
        return [];
    }
}

// Статья встаёт первой в списке недавних; список сохраняется.
function storeRecentCopied(article) {
    const id = articleId(article);
    recentCopied = [id, ...recentCopied.filter(other => other !== id)].slice(0, RECENT_LIMIT);
    storeSet(RECENT_KEY, JSON.stringify(recentCopied));
}

function dropRecentCopied() {
    recentCopied = [];
    storeRemove(RECENT_KEY);
}

// ===== Кодексы и колонки таблицы =====
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

// Код, набранный русскими буквами (УК, АК, ДК), читается так же: иначе строка молча пропала бы из списка.
const CODE_CYRILLIC = { 'У': 'U', 'А': 'A', 'Д': 'D', 'К': 'K' };

function readCode(raw) {
    return CODE_MAP[raw.toUpperCase().replace(/[УАДК]/g, ch => CODE_CYRILLIC[ch])];
}

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
    if (!storeSet(key, JSON.stringify({ data, savedAt: Date.now() }))) {
        console.warn('Не удалось сохранить локальный кэш данных');
    }
}

function loadCache(key) {
    try {
        const raw = storeGet(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.data)) return null;
        return parsed;
    } catch (e) {
        return null;
    }
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

// ===== Разбор листа «База данных» =====

function looksLikeArticlesSheet(rows) {
    const filled = rows.filter(row => row.c && getCellVal(row.c, 0) !== '');
    const withCode = filled.filter(row => readCode(getCellVal(row.c, COL.CODE)));
    return withCode.length > 0 && withCode.length >= filled.length / 2;
}

function parseArticleRows(rows) {
    const articles = [];
    rows.forEach((row) => {
        if (!row.c) return;
        const cells = row.c;
        const getVal = (idx) => getCellVal(cells, idx);

        const code = readCode(getVal(COL.CODE));
        if (!code) return;

        articles.push({
            code,
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

// Свежий список статей из таблицы; пустой ответ считается ошибкой.
async function fetchArticles() {
    const fresh = parseArticleRows(await fetchGvizRows(DATA_URL));
    if (fresh.length === 0) {
        throw new Error('Таблица вернула пустой список статей');
    }
    return fresh;
}

// ===== Текст в разметку =====
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

// ===== Части строки статьи, общие для памятки и быстрого окна =====

function hasFelonyRecord(article) {
    return article.felony.toLowerCase().includes('судимость');
}

// Звёзды розыска: пять мест; у диапазона места от минимума до максимума — бледные.
function buildStarsHtml(article) {
    const runs = article.stars.match(/★+/g);
    if (!runs) return escapeHtml(article.stars);
    const min = runs[0].length;
    const max = runs[runs.length - 1].length;
    let html = '<div class="stars">';
    for (let i = 1; i <= 5; i++) {
        html += `<i class="star${i <= min ? ' on' : i <= max ? ' maybe' : ''}"></i>`;
    }
    return html + '</div>';
}

// Значение переносится только перед указанным словом: срок — перед «или», штраф — перед «до».
function wrapBeforeWord(text, word) {
    return text.split(new RegExp(`\\s+(?=${word}\\s)`))
        .map(part => `<span class="nw">${escapeHtml(part)}</span>`).join(' ');
}
