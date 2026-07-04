
const SHEET_ID = '1ECGNHLbqR8KuPV_QH1E0SO8mGUOm4WIYP-hWWR5PZ-U';
const SHEET_NAME = encodeURIComponent('База данных');
const DATA_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?sheet=${SHEET_NAME}&headers=0`;

let parsedDatabase = [];
let currentCode = "uk";
let viewMode = "cards"; // cards | lines

const container = document.getElementById("articlesContainer");
const searchInput = document.getElementById("searchInput");

/* -------------------------
   LOAD DATA
--------------------------*/

async function loadData() {
    try {
        const res = await fetch(DATA_URL);
        const text = await res.text();

        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");

        if (start === -1 || end === -1) {
            throw new Error("Bad Google Sheets response");
        }

        const json = JSON.parse(text.slice(start, end + 1));
        const rows = json?.table?.rows || [];

        parsedDatabase = rows
            .filter(r => r?.c)
            .map(r => {
                const c = r.c;

                const get = (i) =>
                    (c[i]?.v ?? c[i]?.f ?? "")
                        .toString()
                        .trim();

                const rawCode = (get(0) || "").toUpperCase();

                const map = {
                    UK: "uk",
                    AK: "ak",
                    DK: "dk"
                };

                const code = map[rawCode];
                if (!code) return null;

                const title = get(2) || get(3)?.split(".")[0];
                const desc = get(3) || "";

                return {
                    code,
                    num: get(1),
                    title,
                    desc,
                    stars: get(4),
                    extra: get(5),
                    fine: get(6),
                    arrest: get(7),
                    felony: get(8),
                    type: get(9),
                    tags: get(10),

                    searchText: `${get(1)} ${title} ${desc} ${get(10)}`.toLowerCase()
                };
            })
            .filter(Boolean);

        applyFilters();

    } catch (err) {
        console.error(err);
        container.innerHTML = `<div class="loader">Ошибка загрузки данных</div>`;
    }
}

/* -------------------------
   SEARCH HELPERS
--------------------------*/

function getWords(str) {
    return str
        .toLowerCase()
        .trim()
        .split(/\s+/)
        .filter(Boolean);
}

function score(item, words) {
    let s = 0;
    for (const w of words) {
        if (item.searchText.includes(w)) s++;
    }
    return s;
}

/* -------------------------
   FILTER ENGINE
--------------------------*/

function applyFilters() {
    const query = searchInput.value.trim();
    const isSearch = query.length > 0;
    const words = isSearch ? getWords(query) : [];

    let list = parsedDatabase;

    // tab filter only when no search
    if (!isSearch) {
        list = list.filter(a => a.code === currentCode);
    }

    // search mode
    if (isSearch) {
        list = list
            .map(i => ({ item: i, score: score(i, words) }))
            .filter(x => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .map(x => x.item);
    }

    render(list, words, isSearch);
}

/* -------------------------
   RENDER CONTROLLER
--------------------------*/

function render(list, words, isSearch) {
    container.innerHTML = "";

    if (!list.length) {
        container.innerHTML = `<div class="loader">Ничего не найдено</div>`;
        return;
    }

    const frag = document.createDocumentFragment();

    for (const item of list) {
        const el = document.createElement("div");
        el.className = `card ${item.code}`;

        el.innerHTML =
            viewMode === "lines"
                ? renderLine(item, words, isSearch)
                : renderCard(item, words, isSearch);

        frag.appendChild(el);
    }

    container.appendChild(frag);
}

/* -------------------------
   CARD MODE
--------------------------*/

function renderCard(a, words, isSearch) {

    const hl = (t = "") => {
        if (!isSearch) return t;
        let r = t;

        for (const w of words) {
            const safe = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            r = r.replace(new RegExp(`(${safe})`, "gi"), "<span class='highlight'>$1</span>");
        }

        return r;
    };

    return `
        <div class="card-header">
            <div class="title">${hl(a.title)}</div>
            <div class="article-num">ст. ${hl(a.num)}</div>
        </div>

        <div class="info-table">
            <div class="info-row"><div class="info-label">Штраф</div><div>${a.fine || "—"}</div></div>
            <div class="info-row"><div class="info-label">Розыск</div><div>${a.stars || "—"}</div></div>
            <div class="info-row"><div class="info-label">Арест</div><div>${a.arrest || "—"}</div></div>
            <div class="info-row"><div class="info-label">Судимость</div><div>${a.felony || "—"}</div></div>
            <div class="info-row"><div class="info-label">Доп.</div><div>${a.extra || "—"}</div></div>
        </div>

        <div class="desc">${(a.desc || "").replace(/\n/g, "<br>")}</div>
    `;
}

/* -------------------------
   LINE MODE
--------------------------*/

function renderLine(a, words, isSearch) {

    const hl = (t = "") => {
        if (!isSearch) return t;
        let r = t;

        for (const w of words) {
            const safe = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            r = r.replace(new RegExp(`(${safe})`, "gi"), "<span class='highlight'>$1</span>");
        }

        return r;
    };

    const isUK = a.code === "uk";

    const left = isUK
        ? `
            <div class="line-left">
                <div class="article-type">${a.type || ""}</div>
                <div class="article-num">ст. ${hl(a.num)}</div>
                <div class="title">${hl(a.title)}</div>
            </div>
        `
        : `
            <div class="line-left">
                <div class="article-num">ст. ${hl(a.num)}</div>
                <div class="title">${hl(a.title)}</div>
            </div>
        `;

    const right = isUK
        ? `
            <div class="line-right">
                <div>⭐ ${a.stars || "—"}</div>
                <div>🚔 ${a.arrest || "—"}</div>
                <div>⚖ ${a.felony || "—"}</div>
            </div>
        `
        : `
            <div class="line-right">
                <div>💰 ${a.fine || "—"}</div>
                <div>📦 ${a.extra || "—"}</div>
            </div>
        `;

    return `
        ${left}
        ${right}

        <div class="line-desc">
            ${(a.desc || "").replace(/\n/g, "<br>")}
        </div>
    `;
}

/* -------------------------
   TOGGLES
--------------------------*/

document.getElementById("cardView").addEventListener("click", () => {
    viewMode = "cards";

    document.getElementById("cardView").classList.add("active");
    document.getElementById("lineView").classList.remove("active");

    container.removeAttribute("id");
    applyFilters();
});

document.getElementById("lineView").addEventListener("click", () => {
    viewMode = "lines";

    document.getElementById("lineView").classList.add("active");
    document.getElementById("cardView").classList.remove("active");

    container.id = "line-mode";
    applyFilters();
});

/* -------------------------
   LINE EXPAND
--------------------------*/

container.addEventListener("click", (e) => {
    if (viewMode !== "lines") return;

    const card = e.target.closest(".card");
    if (!card) return;

    card.classList.toggle("line-expanded");
});

/* -------------------------
   DEBOUNCE SEARCH
--------------------------*/

function debounce(fn, ms = 200) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

searchInput.addEventListener("input", debounce(applyFilters, 200));

/* -------------------------
   TAB SWITCH (existing UI)
--------------------------*/

document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
        document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
        e.target.classList.add("active");

        currentCode = e.target.dataset.code;
        searchInput.value = "";

        applyFilters();
    });
});

/* -------------------------
   INIT
--------------------------*/

loadData();
