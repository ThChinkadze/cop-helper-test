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

async function loadData() {
    const container = document.getElementById('articlesContainer');
    try {
        const response = await fetch(TIMEOUT_URL);
        if (!response.ok) {
            throw new Error(`Сервер ответил с ошибкой: ${response.status}`);
        }
        const text = await response.text();
        const json = JSON.parse(text.substring(text.indexOf("{"), text.lastIndexOf("}") + 1));
        const rows = json.table.rows;

        parsedDatabase = [];
        rows.forEach((row) => {
            if (!row.c) return;
            const cells = row.c;
            const getVal = (idx) => (cells[idx] && (cells[idx].f || cells[idx].v !== null)) ? String(cells[idx].f || cells[idx].v).trim() : "";

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
                tags: getVal(10)   
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
                    <button id="retryLoadBtn" class="tab-btn" style="margin-top: 12px; flex: none; padding: 10px 20px;">Повторить попытку</button>
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
        const response = await fetch(PK_URL);
        if (!response.ok) {
            throw new Error(`Сервер ответил с ошибкой: ${response.status}`);
        }
        const text = await response.text();
        const json = JSON.parse(text.substring(text.indexOf("{"), text.lastIndexOf("}") + 1));
        const rows = json.table.rows;

        proceduralData = [];
        rows.forEach((row) => {
            if (!row.c) return;
            const cells = row.c;
            const getVal = (idx) => (cells[idx] && (cells[idx].f || cells[idx].v !== null)) ? String(cells[idx].f || cells[idx].v).trim() : "";

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

    // Процессуальный кодекс — отдельный тип контента, без поиска и без плиток/списка.
    // Рендерится по своей логике, минуя весь пайплайн фильтрации/сортировки статей.
    if (currentCode === 'pk') {
        container.className = '';
        renderProceduralCards(container);
        return;
    }

    const filterText = document.getElementById('searchInput').value.toLowerCase().trim();
    const isSearching = filterText.length > 0;

    let searchWords = [];
    if (isSearching) {
        searchWords = filterText.split(/\s+/).filter(w => w.length > 1 || /^\d+$/.test(w));
    }

    let matchedArticles = [];

    parsedDatabase.forEach(article => {
        if (!isSearching && article.code !== currentCode) return;

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

// Отрисовка в виде плиток (карточек). Логика фильтрации/поиска/сортировки уже
// выполнена в renderArticles() — эта функция отвечает только за разметку.
function renderAsCards(container, matchedArticles, isSearching, searchWords) {
    matchedArticles.forEach(item => {
        const article = item.article;

        const card = document.createElement('div');
        card.className = `card ${article.code}`;

        const highlightedTitle = highlightMatches(escapeHtml(article.title), isSearching, searchWords);
        const highlightedNum = highlightMatches(escapeHtml(article.num), isSearching, searchWords);
        const highlightedDesc = highlightMatches(escapeHtml(article.desc), isSearching, searchWords).replace(/\n/g, '<br>');

        const typeHtml = buildTypeBadge(article);

        const safeFine = escapeHtml(article.fine);
        const safeStars = escapeHtml(article.stars);
        const safeArrest = escapeHtml(article.arrest);
        const safeFelony = escapeHtml(article.felony);
        const safeExtraMeasure = escapeHtml(article.extraMeasure);

        card.innerHTML = `
            <div class="card-header">
                <div class="title">${highlightedTitle}</div>
                <div class="card-header-right">${typeHtml}<div class="article-num">ст. ${highlightedNum}</div></div>
            </div>
            <div class="info-table">
                <div class="info-row"><div class="info-label">Штраф</div><div class="info-val">${safeFine || '—'}</div></div>
                <div class="info-row"><div class="info-label">Розыск</div><div class="info-val">${safeStars || '—'}</div></div>
                <div class="info-row"><div class="info-label">Арест</div><div class="info-val">${safeArrest || '—'}</div></div>
                <div class="info-row"><div class="info-label">Судимость</div><div class="info-val ${article.felony.toLowerCase().includes('судимость') ? 'danger' : ''}">${safeFelony || '—'}</div></div>
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

        const highlightedTitle = highlightMatches(escapeHtml(article.title), isSearching, searchWords);
        const highlightedNum = highlightMatches(escapeHtml(article.num), isSearching, searchWords);
        const highlightedDesc = highlightMatches(escapeHtml(article.desc), isSearching, searchWords).replace(/\n/g, '<br>');

        const typeHtml = buildTypeBadge(article, 'row-slot-type');

        // Левая часть строки: тип (только УК), номер статьи и заголовок.
        // row-slot-type/row-slot-num имеют фиксированную ширину, поэтому заголовок
        // всегда начинается в одной и той же позиции, независимо от длины тега типа/номера.
        const leftHtml = `
            ${typeHtml}
            <div class="row-num row-slot-num">ст. ${highlightedNum}</div>
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
            const hasFelony = article.felony.toLowerCase().includes('судимость');
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
// На этом этапе реализован только "steps" — остальные форматы (list/text/table)
// осознанно зарезервированы под будущее наполнение и пока используют safe-fallback.
const PK_TEMPLATES = {
    steps: renderPkSteps,
};

function renderPkSteps(content) {
    const steps = content.split('\n').map(s => s.trim()).filter(Boolean);
    const items = steps.map(step => `<li>${escapeHtml(step)}</li>`).join('');
    return `<ol class="pk-steps">${items}</ol>`;
}

// Safe-fallback: используется и для типов, для которых ещё не написан шаблон
// (list/text/table), и для опечаток/неизвестных значений в колонке "Тип" —
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

const DEFAULT_SEARCH_PLACEHOLDER = document.getElementById('searchInput').getAttribute('placeholder');
const PK_SEARCH_PLACEHOLDER = 'Поиск недоступен в этом разделе';

// Поиск не имеет смысла на вкладке «Процессуальный кодекс» — там нет полей для
// сопоставления (не статьи, а карточки-темы). Блокируем поле физически, а не
// просто визуально, чтобы туда нельзя было случайно начать печатать.
function updateSearchAvailability() {
    const searchInput = document.getElementById('searchInput');
    const isPk = currentCode === 'pk';
    searchInput.disabled = isPk;
    searchInput.placeholder = isPk ? PK_SEARCH_PLACEHOLDER : DEFAULT_SEARCH_PLACEHOLDER;
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
    updateSearchAvailability();
    renderArticles();
}));

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
