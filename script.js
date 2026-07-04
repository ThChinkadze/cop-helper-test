const SHEET_ID = '1ECGNHLbqR8KuPV_QH1E0SO8mGUOm4WIYP-hWWR5PZ-U';
const SHEET_NAME = encodeURIComponent('База данных');
const TIMEOUT_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?sheet=${SHEET_NAME}&headers=0`;

let parsedDatabase = [];
let filteredCache = [];
let currentCode = "uk";

const searchInput = document.getElementById('searchInput');
const container = document.getElementById('articlesContainer');

/* ---------------------------
   1. SAFE FETCH + PARSE
----------------------------*/
async function loadData() {
    try {
        const response = await fetch(TIMEOUT_URL);
        const text = await response.text();

        const jsonStart = text.indexOf('{');
        const jsonEnd = text.lastIndexOf('}');

        if (jsonStart === -1 || jsonEnd === -1) {
            throw new Error('Invalid Google Sheets response');
        }

        const json = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
        const rows = json?.table?.rows || [];

        parsedDatabase = rows
            .filter(row => row?.c)
            .map(row => {
                const cells = row.c;

                const get = (i) =>
                    (cells[i]?.f ?? cells[i]?.v ?? "")
                        .toString()
                        .trim();

                const rawCode = get(0).toUpperCase();

                const map = { UK: "uk", AK: "ak", DK: "dk" };
                const code = map[rawCode];

                if (!code) return null;

                const title = get(2) || (get(3).split(/[.\n]/)[0].trim() + '.');
                const desc = get(3) || get(2);

                return {
                    code,
                    num: get(1),
                    title,
                    desc,
                    stars: get(4),
                    extraMeasure: get(5),
                    fine: get(6),
                    arrest: get(7),
                    felony: get(8),
                    type: get(9),
                    tags: get(10),

                    // precomputed field for search speed
                    searchText: `${get(1)} ${title} ${desc} ${get(10)}`.toLowerCase()
                };
            })
            .filter(Boolean);

        applyFilters();
    } catch (e) {
        console.error("Load error:", e);
        container.innerHTML = `<div class="loader">Ошибка загрузки данных</div>`;
    }
}

/* ---------------------------
   2. SEARCH / FILTER ENGINE
----------------------------*/
function getSearchWords(text) {
    return text
        .toLowerCase()
        .trim()
        .split(/\s+/)
        .filter(w => w.length > 1);
}

function scoreArticle(article, words) {
    let score = 0;

    for (const w of words) {
        if (article.searchText.includes(w)) score++;
    }

    return score;
}

function applyFilters() {
    const query = searchInput.value.trim();
    const isSearch = query.length > 0;

    const words = isSearch ? getSearchWords(query) : [];

    let list = parsedDatabase;

    // tab filter first (cheap operation)
    if (!isSearch) {
        list = list.filter(a => a.code === currentCode);
    }

    // scoring only if search active
    if (isSearch) {
        list = list
            .map(a => ({ article: a, score: scoreArticle(a, words) }))
            .filter(x => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .map(x => x.article);
    }

    filteredCache = list;
    render(list, words, isSearch);
}

/* ---------------------------
   3. RENDER (ONLY UI)
----------------------------*/
function render(list, words, isSearch) {
    container.innerHTML = "";

    if (!list.length) {
        container.innerHTML = `<div class="loader">Ничего не найдено</div>`;
        return;
    }

    const highlight = (text) => {
        if (!isSearch) return text;

        let result = text;

        for (const w of words) {
            const safe = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`(${safe})`, 'gi');
            result = result.replace(regex, '<span class="highlight">$1</span>');
        }

        return result;
    };

    const frag = document.createDocumentFragment();

    for (const article of list) {
        const card = document.createElement('div');
        card.className = `card ${article.code}`;

        const felonySafe = (article.felony || "").toLowerCase();

        card.innerHTML = `
            <div class="card-header">
                <div class="title">${highlight(article.title)}</div>
                <div class="card-header-right">
                    ${article.type && article.type !== '-' && article.code === 'uk'
                        ? `<div class="article-type">${article.type}</div>` : ''}
                    <div class="article-num">ст. ${highlight(article.num)}</div>
                </div>
            </div>

            <div class="info-table">
                <div class="info-row"><div class="info-label">Штраф</div><div class="info-val">${article.fine || '—'}</div></div>
                <div class="info-row"><div class="info-label">Розыск</div><div class="info-val">${article.stars || '—'}</div></div>
                <div class="info-row"><div class="info-label">Арест</div><div class="info-val">${article.arrest || '—'}</div></div>
                <div class="info-row">
                    <div class="info-label">Судимость</div>
                    <div class="info-val ${felonySafe.includes('судимость') ? 'danger' : ''}">
                        ${article.felony || '—'}
                    </div>
                </div>
                <div class="info-row"><div class="info-label">Доп. мера</div><div class="info-val">${article.extraMeasure || '—'}</div></div>
            </div>

            <div class="desc">${highlight(article.desc).replace(/\n/g, '<br>')}</div>
        `;

        frag.appendChild(card);
    }

    container.appendChild(frag);
}

/* ---------------------------
   4. DEBOUNCE INPUT
----------------------------*/
function debounce(fn, delay = 250) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), delay);
    };
}

/* ---------------------------
   5. EVENTS
----------------------------*/
searchInput.addEventListener('input', debounce(applyFilters, 200));

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');

        currentCode = e.target.dataset.code;

        searchInput.value = "";
        applyFilters();
    });
});

/* ---------------------------
   INIT
----------------------------*/
loadData();
