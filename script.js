const SHEET_ID = '1ECGNHLbqR8KuPV_QH1E0SO8mGUOm4WIYP-hWWR5PZ-U'; 
const SHEET_NAME = encodeURIComponent('База данных'); 
const TIMEOUT_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?sheet=${SHEET_NAME}&headers=0`;

const SHEET_NAME_PK = encodeURIComponent('Процессуальный кодекс');
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

const TYPE_LABELS = {
    'F': 'Федеральная',
    'R': 'Региональная',
    'F/R': 'Федеральная/Региональная',
    'FIN': 'Финансовая',
    'R/FIN': 'Региональная/Финансовая'
};

// Стоп-лист коротких служебных слов (предлоги, союзы, частицы, местоимения) —
// исключаются из поисковых слов, чтобы не давать ложных совпадений почти
// в каждой статье (например: "не показал права" раньше давало 204 совпадения
// из-за одного слова "не", встречающегося как подстрока почти везде).
const STOP_WORDS = new Set(`
в во на за из изо к ко до от ото по под подо над о об обо при про для без безо
через чрез у с со между среди перед передо ради сквозь вдоль вокруг около кроме
и а но да или либо что чтобы как когда если хотя пока потому поэтому также тоже
не ни бы же ли вот вон это эта этот эти тот та то те
он она оно они я ты мы вы его её их ему ей им меня тебя нас вас себя
свой своя своё свои мой моя моё мои твой твоя твоё твои наш наша наше наши ваш ваша ваше ваши
`.split(/\s+/).filter(Boolean));

// ===== Грубый стемминг словоформ (Этап 1 улучшения поиска) =====
// Не претендует на лингвистическую точность (полноценный морфологический разбор
// не нужен для наших целей) — задача уже: свести словоформы одного слова к общей
// основе, чтобы "избил"/"избила"/"украли" пересекались в поиске, даже если в тексте
// статьи стоит другая форма того же слова. НЕ решает случаи словообразования
// между частями речи (например "угнал" -> "угонщик"/"угон") — это осознанно
// оставлено вне рамок стемминга, такие случаи закрываются точечным словарём
// (следующий этап), а не попыткой дотянуть стеммер до словообразовательного анализа.
//
// Снимается ОДИН, самый длинный подходящий суффикс — без каскада через несколько
// групп правил подряд (первая версия так и делала, из-за чего слово переотсекалось
// сильнее, чем нужно: "избил" через два последовательных отсечения превращался
// в "изб", а "избиение" — только в "избиен", то есть слова расходились ещё больше).
//
// Минимальная длина слова для входа в стемминг и минимальная длина остатка после
// отсечения (5 и 3) — намеренно консервативные. Пробовали поднимать до 6/4, чтобы
// не схлопывать короткие многозначные корни (пример: "права" -> "прав" совпадает
// заодно с "правая сторона" и "лишение прав" в другом смысле) — но это заодно
// вырубило стемминг для нужных 5-буквенных слов вроде "избил"/"угнал" и не решило
// саму коллизию. Такие случаи короткой многозначности — известное ограничение,
// сознательно оставленное на откуп ранжированию (Этап 2), а не стеммеру.
const SUFFIXES = [
    'ировать', 'ироваться', 'ываться', 'иваться', 'оваться', 'еваться',
    'ившись', 'ывшись', 'ующая', 'ующее', 'ующие', 'ующий',
    'ивший', 'ывший', 'ённый', 'анный', 'янный', 'енный',
    'ывать', 'ивать', 'овать', 'евать',
    'ущий', 'ющий', 'ащий', 'ящий', 'емый', 'имый',
    'ими', 'ыми', 'его', 'ого', 'ему', 'ому', 'ует', 'уют', 'ают', 'яют',
    'ать', 'ять', 'еть', 'ить', 'уть', 'ешь', 'ишь', 'ете', 'ите',
    'ла', 'ло', 'ли', 'на', 'но', 'ны', 'ть', 'ся', 'сь',
    'ых', 'их', 'ую', 'юю', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие',
    'ой', 'ий', 'ый', 'ым', 'им', 'ом', 'ем', 'ей', 'ою', 'ею',
    'ам', 'ям', 'ах', 'ях', 'ов', 'ев', 'ье', 'ью', 'ия', 'ья',
    'ит', 'ат', 'ят', 'ут', 'ют', 'ен',
    'ы', 'и', 'а', 'я', 'у', 'ю', 'о', 'е', 'й', 'л', 'ь'
].sort((a, b) => b.length - a.length); // длинные суффиксы проверяем раньше коротких

function stemWord(word) {
    if (!word || word.length < 5) return word; // на совсем коротких словах отсечение слишком рискованно

    for (const suf of SUFFIXES) {
        if (word.endsWith(suf)) {
            const stripped = word.slice(0, word.length - suf.length);
            if (stripped.length >= 3) return stripped;
            break; // короче нельзя — дальше суффиксы только длиннее не станут
        }
    }
    return word;
}

// Собирает множество стеммированных слов из текста статьи. Считается один раз
// при загрузке данных (см. attachSearchIndex), а не при каждом нажатии клавиши —
// токенизация и стемминг по тексту всех статей на каждый keystroke были бы заметно
// дороже, чем разовый проход при загрузке.
function buildStemSet(text) {
    const words = text.split(/[^а-яёa-z0-9]+/).filter(Boolean);
    const set = new Set();
    words.forEach(w => set.add(stemWord(w)));
    return set;
}

// Готовит поисковый индекс статьи: searchableText — та же строка, что раньше
// пересобиралась на лету в renderArticles() при каждом поиске (вынесено сюда ради
// производительности), и stemSet — набор словоформ, приведённых к основе.
// Вызывается ПОСЛЕ saveCache() намеренно: stemSet — это Set, он не сериализуется
// в JSON корректно, да и незачем тащить его в офлайн-кэш — дешевле пересчитать
// при следующей загрузке, чем усложнять формат кэша.
function attachSearchIndex(articles) {
    articles.forEach(article => {
        article.searchableText = `${article.num} ${article.title} ${article.desc} ${article.tags}`.toLowerCase();
        article.stemSet = buildStemSet(article.searchableText);
    });
}

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
// (статьи кодексов и Процессуальный кодекс). Обработка ошибок и раскладка строк по
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
        attachSearchIndex(parsedDatabase);
        removeStaleBanner();
        renderArticles();
    } catch (e) {
        console.error(e);
        const cached = loadCache();
        if (cached) {
            parsedDatabase = cached.data;
            attachSearchIndex(parsedDatabase);
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

function renderArticles() {
    const container = document.getElementById('articlesContainer');

    const filterText = document.getElementById('searchInput').value.toLowerCase().trim();
    const isSearching = filterText.length > 0;

    // Процессуальный кодекс — отдельный тип контента, без плиток/списка и своей
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
        // Отсекаем короткие служебные слова (см. STOP_WORDS) — без этого
        // одно случайное совпадение предлога/частицы почти в любой статье
        // забивало реальную релевантность результатов.
        searchWords = filterText.split(/\s+/).filter(w => {
            if (/^\d+$/.test(w)) return true;
            if (w.length <= 1) return false;
            return !STOP_WORDS.has(w);
        });
    }

    let matchedArticles = [];

    parsedDatabase.forEach(article => {
        if (!isSearching && article.code !== currentCode) return;
        if (!isSearching && currentDisplayMode === 'compact' && article.frequency === 'rare') return;

        let matchScore = 0;

        if (isSearching) {
            // Гибрид: точное вхождение подстроки (как в Этапе 0 — важно для номеров
            // статей вроде "5.3", "17.6", которые при токенизации по словам развалились
            // бы на отдельные куски) ИЛИ совпадение по стеммированной основе слова
            // (Этап 1 — ловит словоформы, которых нет буквально в тексте статьи).
            // Слово засчитывается один раз, даже если совпало обоими способами.
            searchWords.forEach(word => {
                const matchedSubstring = article.searchableText.includes(word);
                const matchedStem = article.stemSet.has(stemWord(word));
                if (matchedSubstring || matchedStem) {
                    matchScore += 1;
                }
            });

            // Если не нашлось ни одного слова — игнорируем
            if (matchScore === 0) return;
        }

        matchedArticles.push({ article, matchScore });
    });

    // Сортируем: те, где нашлось больше слов — выше
    matchedArticles.sort((a, b) => b.matchScore - a.matchScore);

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
        card.className = `card ${article.code}`;

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
                <div class="title">${highlightedTitle}</div>
                <div class="card-header-right">${typeHtml}<div class="badge-num">ст. ${highlightedNum}</div></div>
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
        row.className = `row ${article.code}`;

        const { title: highlightedTitle, num: highlightedNum, desc: highlightedDesc } =
            buildHighlightedFields(article, isSearching, searchWords);

        const typeHtml = buildTypeBadge(article, 'row-slot-type');

        // Левая часть строки: тип (только УК), номер статьи и заголовок.
        // row-slot-type/row-slot-num имеют фиксированную ширину, поэтому заголовок
        // всегда начинается в одной и той же позиции, независимо от длины тега типа/номера.
        const leftHtml = `
            ${typeHtml}
            <div class="badge-num row-num row-slot-num">ст. ${highlightedNum}</div>
            <div class="row-title">${highlightedTitle}</div>
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
            const arrestTitle = hasFelony ? `${escapeHtml(article.arrest)}, судимость` : 'Арест';

            rightHtml = `
                <div class="row-tag row-slot-fine ${safeFine ? 'row-fine' : ''}" title="Штраф">${safeFine || '—'}</div>
                <div class="row-tag row-slot-stars" title="Розыск">${safeStars || '—'}</div>
                <div class="row-tag row-slot-arrest ${hasFelony ? 'row-danger' : ''}" title="${arrestTitle}">${safeArrest || '—'}</div>
            `;
        } else {
            const safeExtraMeasure = escapeHtml(article.extraMeasure);
            const safeFine = escapeHtml(article.fine);
            const hasExtraMeasure = Boolean(article.extraMeasure);

            rightHtml = `
                <div class="row-tag row-slot-extra ${hasExtraMeasure ? '' : 'row-hidden'}" title="${hasExtraMeasure ? safeExtraMeasure : ''}">${safeExtraMeasure}</div>
                <div class="row-tag row-slot-fine ${safeFine ? 'row-fine' : ''}" title="Штраф">${safeFine || '—'}</div>
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

        const header = row.querySelector('.row-header');
        const toggleExpanded = () => {
            const willExpand = !row.classList.contains('expanded');
            row.classList.toggle('expanded', willExpand);
            header.setAttribute('aria-expanded', String(willExpand));
        };
        header.addEventListener('click', toggleExpanded);
        header.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleExpanded();
            }
        });

        container.appendChild(row);
    });
}

// ===== Процессуальный кодекс: диспетчер шаблонов =====
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

document.querySelectorAll('.mode-btn').forEach(btn => btn.addEventListener('click', (e) => {
    const selectedMode = e.currentTarget.getAttribute('data-mode');
    if (selectedMode === currentDisplayMode) return;
    currentDisplayMode = selectedMode;
    localStorage.setItem(DISPLAY_MODE_KEY, currentDisplayMode);
    syncModeToggleUI();
    renderArticles();
}));

syncModeToggleUI();

function syncViewToggleUI() {
    document.querySelectorAll('.view-btn').forEach(btn => {
        const isActive = btn.getAttribute('data-view') === currentView;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}

document.querySelectorAll('.view-btn').forEach(btn => btn.addEventListener('click', (e) => {
    const selectedView = e.currentTarget.getAttribute('data-view');
    if (selectedView === currentView) return;
    currentView = selectedView;
    localStorage.setItem(VIEW_KEY, currentView);
    syncViewToggleUI();
    renderArticles();
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
