const SHEET_ID = '1ECGNHLbqR8KuPV_QH1E0SO8mGUOm4WIYP-hWWR5PZ-U';
const SHEET_NAME = encodeURIComponent('База данных');
const TIMEOUT_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?sheet=${SHEET_NAME}&headers=0`;

let parsedDatabase = [];
let currentCode = "uk";
let viewMode = "card";

const searchInput = document.getElementById('searchInput');
const container = document.getElementById('articlesContainer');

/* LOAD DATA */
async function loadData() {
    const res = await fetch(TIMEOUT_URL);
    const text = await res.text();

    const json = JSON.parse(
        text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
    );

    parsedDatabase = (json?.table?.rows || [])
        .map(row => {
            const c = row.c || [];

            const get = i => (c[i]?.v ?? c[i]?.f ?? "").toString().trim();

            const codeMap = { UK: "uk", AK: "ak", DK: "dk" };
            const code = codeMap[get(0).toUpperCase()];

            if (!code) return null;

            const title = get(2);
            const desc = get(3);

            return {
                code,
                num: get(1),
                title,
                desc,
                stars: get(4),
                fine: get(6),
                arrest: get(7),
                felony: get(8),
                type: get(9),
                extra: get(5),
                searchText: (get(1) + " " + title + " " + desc).toLowerCase()
            };
        })
        .filter(Boolean);

    render();
}

/* FILTER */
function filterData() {
    const q = searchInput.value.toLowerCase().trim();
    const words = q ? q.split(/\s+/) : [];

    let data = parsedDatabase.filter(x => x.code === currentCode);

    if (words.length) {
        data = data
            .map(a => ({
                a,
                score: words.filter(w => a.searchText.includes(w)).length
            }))
            .filter(x => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .map(x => x.a);
    }

    return data;
}

/* RENDER */
function render() {
    const data = filterData();
    container.innerHTML = "";

    if (!data.length) {
        container.innerHTML = "Ничего не найдено";
        return;
    }

    for (const a of data) {
        if (viewMode === "card") {
            container.appendChild(renderCard(a));
        } else {
            container.appendChild(renderRow(a));
        }
    }
}

/* CARD */
function renderCard(a) {
    const div = document.createElement("div");
    div.className = `card ${a.code}`;

    div.innerHTML = `
        <div class="title">${a.title}</div>
        <div>Ст. ${a.num}</div>
        <div>Штраф: ${a.fine || "—"}</div>
        <div>Арест: ${a.arrest || "—"}</div>
        <div>Судимость: ${a.felony || "—"}</div>
    `;

    return div;
}

/* COMPACT ROW */
function renderRow(a) {
    const wrapper = document.createElement("div");

    const row = document.createElement("div");
    row.className = `compact-row ${a.code}`;

    const isUK = a.code === "uk";

    row.innerHTML = isUK
        ? `
            <span>${a.num}</span>
            <span>${a.title}</span>
            <span>${a.stars || "—"}</span>
            <span>${a.fine || "—"}</span>
            <span>${a.arrest || "—"}</span>
            <span>${a.felony || "—"}</span>
        `
        : `
            <span>${a.num}</span>
            <span>${a.title}</span>
            <span>${a.extra || "—"}</span>
            <span>${a.fine || "—"}</span>
        `;

    const desc = document.createElement("div");
    desc.className = "compact-desc";
    desc.textContent = a.desc;

    row.onclick = () => {
        desc.style.display = desc.style.display === "block" ? "none" : "block";
    };

    wrapper.appendChild(row);
    wrapper.appendChild(desc);

    return wrapper;
}

/* EVENTS */
searchInput.addEventListener("input", debounce(render, 200));

document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.onclick = () => {
        document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");

        currentCode = btn.dataset.code;
        render();
    };
});

document.getElementById("toggleView").onclick = () => {
    viewMode = viewMode === "card" ? "compact" : "card";
    render();
};

/* DEBOUNCE */
function debounce(fn, t) {
    let id;
    return (...args) => {
        clearTimeout(id);
        id = setTimeout(() => fn(...args), t);
    };
}

/* INIT */
loadData();
