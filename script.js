const SHEET_ID = '1ECGNHLbqR8KuPV_QH1E0SO8mGUOm4WIYP-hWWR5PZ-U'; 
const SHEET_NAME = encodeURIComponent('База данных'); 
const TIMEOUT_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?sheet=${SHEET_NAME}&headers=0`;

let parsedDatabase = [];
let currentCode = "uk";
let searchDebounceTimer;

const VIEW_KEY = 'majestic_portland_view_mode';
let currentView = localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';

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

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function renderArticles() {
    const container = document.getElementById('articlesContainer');
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

    if (matchedArticles.length === 0) {
        container.innerHTML = `<div class="loader">По запросу ничего не найдено. Попробуйте описать иначе.</div>`;
        return;
    }

    renderAsCards(container, matchedArticles, isSearching, searchWords);
}

// Отрисовка в виде плиток (карточек). Логика фильтрации/поиска/сортировки уже
// выполнена в renderArticles() — эта функция отвечает только за разметку.
function renderAsCards(container, matchedArticles, isSearching, searchWords) {
    matchedArticles.forEach(item => {
        const article = item.article;

        const card = document.createElement('div');
        card.className = `card ${article.code}`;
        
        // Подсветка слов (работает поверх уже экранированного текста)
        const highlightText = (text) => {
            if (!isSearching) return text;
            let result = text;
            searchWords.forEach(word => {
                const regex = new RegExp(`(${escapeRegex(word)})`, 'gi');
                result = result.replace(regex, '<span class="highlight">$1</span>');
            });
            return result;
        };

        const highlightedTitle = highlightText(escapeHtml(article.title));
        const highlightedNum = highlightText(escapeHtml(article.num));
        const highlightedDesc = highlightText(escapeHtml(article.desc)).replace(/\n/g, '<br>');

        const safeType = escapeHtml(article.type);
        const typeLabel = TYPE_LABELS[article.type] || '';
        let typeHtml = (article.code === 'uk' && safeType && safeType !== '-') ? `<div class="article-type" title="${escapeHtml(typeLabel)}">${safeType}</div>` : '';

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
// На этом этапе строка не раскрывается по клику (см. Этап 5) и функция ещё не подключена
// к тумблеру вида (см. Этап 6) — это отдельные шаги плана.
function renderAsList(container, matchedArticles, isSearching, searchWords) {
    matchedArticles.forEach(item => {
        const article = item.article;

        const row = document.createElement('div');
        row.className = `row ${article.code}`;

        // Подсветка слов (та же логика, что и в renderAsCards)
        const highlightText = (text) => {
            if (!isSearching) return text;
            let result = text;
            searchWords.forEach(word => {
                const regex = new RegExp(`(${escapeRegex(word)})`, 'gi');
                result = result.replace(regex, '<span class="highlight">$1</span>');
            });
            return result;
        };

        const highlightedTitle = highlightText(escapeHtml(article.title));
        const highlightedNum = highlightText(escapeHtml(article.num));

        const safeType = escapeHtml(article.type);
        const typeLabel = TYPE_LABELS[article.type] || '';
        const typeHtml = (article.code === 'uk' && safeType && safeType !== '-')
            ? `<div class="row-type row-slot-type" title="${escapeHtml(typeLabel)}">${safeType}</div>`
            : '';

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
                <div class="row-tag row-slot-stars" title="Розыск">${safeStars || '—'}</div>
                <div class="row-tag row-slot-fine ${safeFine ? 'row-fine' : ''}" title="Штраф">${safeFine || '—'}</div>
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
            <div class="row-left">${leftHtml}</div>
            <div class="row-right">${rightHtml}</div>
        `;

        container.appendChild(row);
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

document.getElementById('searchInput').addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(renderArticles, 150);
});
loadData();
