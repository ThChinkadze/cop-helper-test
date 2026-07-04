const GOOGLE_SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vT84FsXQ5VFSFjp5GqXOMpyEjXOzVXUopS_Zl27jcNdpLEOPKKp1OZ8_OZ2wLQbU4FAOjKm8WoUAdxU/pub?gid=1208463204&single=true&output=csv';

const STORAGE_KEYS = {
    compactMode: 'lawBaseCompactMode'
};

const CODE_LABELS = {
    uk: 'УК',
    ak: 'АК',
    dk: 'ДК'
};

const synonymsDictionary = {
    штраф: ['штраф', 'деньги', 'выплата', 'оплата', 'санкция'],
    арест: ['арест', 'задержание', 'тюрьма', 'заключение'],
    розыск: ['розыск', 'поиск', 'ориентировка'],
    оружие: ['оружие', 'пистолет', 'автомат', 'винтовка', 'патроны'],
    наркотики: ['наркотики', 'нарко', 'вещества', 'запрещенка'],
    угон: ['угон', 'кража авто', 'похищение авто', 'машина'],
    убийство: ['убийство', 'убить', 'смерть', 'ликвидация'],
    нападение: ['нападение', 'атака', 'избиение', 'драка'],
    взятка: ['взятка', 'подкуп', 'коррупция'],
    судимость: ['судимость', 'felony', 'запись']
};

let allArticles = [];
let currentCode = 'uk';
let isCompactMode = false;

const searchInput = document.getElementById('searchInput');
const articlesContainer = document.getElementById('articlesContainer');
const tabButtons = document.querySelectorAll('.tab-btn');
const viewToggle = document.getElementById('viewToggle');

document.addEventListener('DOMContentLoaded', init);

async function init() {
    isCompactMode = localStorage.getItem(STORAGE_KEYS.compactMode) === 'true';

    applyCompactModeState();

    bindEvents();

    try {
        allArticles = await loadArticles();
        renderArticles();
    } catch (error) {
        console.error(error);
        articlesContainer.innerHTML = `
            <div class="loader">
                Не удалось загрузить базу данных. Проверьте ссылку на Google Таблицу в script.js.
            </div>
        `;
    }
}

function bindEvents() {
    searchInput.addEventListener('input', renderArticles);

    tabButtons.forEach((button) => {
        button.addEventListener('click', () => {
            tabButtons.forEach((btn) => btn.classList.remove('active'));
            button.classList.add('active');

            currentCode = button.dataset.code;
            renderArticles();
        });
    });

    viewToggle.addEventListener('click', () => {
        isCompactMode = !isCompactMode;
        localStorage.setItem(STORAGE_KEYS.compactMode, String(isCompactMode));

        applyCompactModeState();
        renderArticles();
    });

    articlesContainer.addEventListener('click', (event) => {
        const summary = event.target.closest('.compact-summary');

        if (!summary) {
            return;
        }

        const article = summary.closest('.compact-article');

        if (!article) {
            return;
        }

        article.classList.toggle('open');
    });
}

function applyCompactModeState() {
    viewToggle.classList.toggle('active', isCompactMode);
    viewToggle.setAttribute('aria-pressed', String(isCompactMode));

    articlesContainer.classList.toggle('compact-mode', isCompactMode);
}

async function loadArticles() {
    if (!GOOGLE_SHEET_CSV_URL || GOOGLE_SHEET_CSV_URL === 'https://docs.google.com/spreadsheets/d/e/2PACX-1vT84FsXQ5VFSFjp5GqXOMpyEjXOzVXUopS_Zl27jcNdpLEOPKKp1OZ8_OZ2wLQbU4FAOjKm8WoUAdxU/pub?gid=1208463204&single=true&output=csv') {
        throw new Error('Не указана ссылка на Google Таблицу.');
    }

    const response = await fetch(GOOGLE_SHEET_CSV_URL);

    if (!response.ok) {
        throw new Error(`Ошибка загрузки таблицы: ${response.status}`);
    }

    const csvText = await response.text();
    const rows = parseCSV(csvText);

    if (rows.length < 2) {
        return [];
    }

    const headers = rows[0].map((header) => normalizeKey(header));

    return rows.slice(1)
        .map((row) => normalizeArticleRow(headers, row))
        .filter((article) => article.code && article.num && article.title);
}

function normalizeArticleRow(headers, row) {
    const raw = {};

    headers.forEach((header, index) => {
        raw[header] = cleanValue(row[index]);
    });

    return {
        code: getValue(raw, ['code', 'кодекс', 'kodeks', 'typecode']).toLowerCase(),
        num: getValue(raw, ['num', 'номер', 'article', 'статья', 'ст']),
        type: getValue(raw, ['type', 'тип', 'категория']),
        title: getValue(raw, ['title', 'название', 'заголовок', 'name']),
        desc: getValue(raw, ['desc', 'description', 'описание', 'текст']),
        fine: getValue(raw, ['fine', 'штраф']),
        stars: getValue(raw, ['stars', 'розыск', 'wanted']),
        arrest: getValue(raw, ['arrest', 'арест']),
        felony: getValue(raw, ['felony', 'судимость']),
        additional: getValue(raw, ['additional', 'дополнительно', 'мера', 'допмера', 'extra']),
        tags: getValue(raw, ['tags', 'теги', 'ключи'])
    };
}

function getValue(source, keys) {
    for (const key of keys) {
        const normalizedKey = normalizeKey(key);

        if (source[normalizedKey]) {
            return source[normalizedKey];
        }
    }

    return '';
}

function normalizeKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '')
        .replace(/[№#]/g, 'num');
}

function cleanValue(value) {
    return String(value || '')
        .replace(/\r/g, '')
        .trim();
}

function renderArticles() {
    const searchQuery = searchInput.value.trim();
    const searchWords = getSearchWords(searchQuery);

    const filteredArticles = allArticles
        .filter((article) => article.code === currentCode)
        .map((article) => ({
            article,
            relevance: getArticleRelevance(article, searchWords)
        }))
        .filter((item) => {
            if (!searchWords.length) {
                return true;
            }

            return item.relevance > 0;
        })
        .sort((a, b) => {
            if (searchWords.length && b.relevance !== a.relevance) {
                return b.relevance - a.relevance;
            }

            return compareArticleNumbers(a.article.num, b.article.num);
        })
        .map((item) => item.article);

    articlesContainer.classList.toggle('compact-mode', isCompactMode);

    if (!filteredArticles.length) {
        articlesContainer.innerHTML = `
            <div class="loader">
                Ничего не найдено
            </div>
        `;
        return;
    }

    articlesContainer.innerHTML = filteredArticles
        .map((article) => {
            return isCompactMode
                ? renderCompactArticle(article, searchWords)
                : renderCardArticle(article, searchWords);
        })
        .join('');
}

function renderCardArticle(article, searchWords) {
    const codeClass = escapeHTML(article.code);
    const title = highlightText(article.title, searchWords);
    const num = highlightText(article.num, searchWords);
    const desc = highlightText(article.desc, searchWords);
    const type = highlightText(article.type, searchWords);

    return `
        <article class="card ${codeClass}">
            <div class="card-header">
                <div class="title">${title}</div>

                <div class="card-header-right">
                    ${article.type ? `<div class="article-type">${type}</div>` : ''}
                    <div class="article-num">${CODE_LABELS[article.code] || article.code} ${num}</div>
                </div>
            </div>

            <div class="info-table">
                ${renderInfoRow('Штраф', article.fine, searchWords)}
                ${renderInfoRow('Розыск', article.stars, searchWords, 'danger')}
                ${renderInfoRow('Арест', article.arrest, searchWords, 'danger')}
                ${renderInfoRow('Судимость', article.felony, searchWords, 'danger')}
                ${renderInfoRow('Доп. мера', article.additional, searchWords)}
            </div>

            <div class="desc">${desc || 'Описание отсутствует'}</div>
        </article>
    `;
}

function renderCompactArticle(article, searchWords) {
    const codeClass = escapeHTML(article.code);
    const codeLabel = CODE_LABELS[article.code] || article.code.toUpperCase();

    const num = highlightText(article.num, searchWords);
    const title = highlightText(article.title, searchWords);
    const type = highlightText(article.type, searchWords);
    const desc = highlightText(article.desc, searchWords);
    const tags = highlightText(article.tags, searchWords);

    const metaItems = [];

    if (article.fine) {
        metaItems.push(renderCompactPill('Штраф', article.fine, searchWords));
    }

    if (article.code === 'uk') {
        if (article.stars) {
            metaItems.push(renderCompactPill('Розыск', article.stars, searchWords, 'danger'));
        }

        if (article.arrest) {
            metaItems.push(renderCompactPill('Арест', article.arrest, searchWords, 'danger'));
        }

        if (article.felony) {
            metaItems.push(renderCompactPill('Судимость', article.felony, searchWords, 'danger'));
        }
    }

    if (article.additional) {
        metaItems.push(renderCompactPill('Доп.', article.additional, searchWords));
    }

    return `
        <article class="compact-article ${codeClass}">
            <button class="compact-summary" type="button">
                <div class="compact-num">${codeLabel} ${num}</div>

                <div class="compact-main">
                    <div class="compact-title">${title}</div>
                    ${article.type ? `<div class="compact-type">${type}</div>` : ''}
                </div>

                <div class="compact-meta">
                    ${metaItems.join('')}
                </div>
            </button>

            <div class="compact-details">
                <div class="compact-desc">
                    ${desc || 'Описание отсутствует'}

                    ${article.tags ? `
                        <div class="compact-tags">
                            Теги: ${tags}
                        </div>
                    ` : ''}
                </div>
            </div>
        </article>
    `;
}

function renderInfoRow(label, value, searchWords, extraClass = '') {
    if (!value) {
        return '';
    }

    return `
        <div class="info-row">
            <div class="info-label">${escapeHTML(label)}</div>
            <div class="info-val ${extraClass}">${highlightText(value, searchWords)}</div>
        </div>
    `;
}

function renderCompactPill(label, value, searchWords, extraClass = '') {
    return `
        <div class="compact-pill ${extraClass}">
            <span>${escapeHTML(label)}:</span>
            ${highlightText(value, searchWords)}
        </div>
    `;
}

function getSearchWords(query) {
    if (!query) {
        return [];
    }

    const baseWords = query
        .toLowerCase()
        .split(/\s+/)
        .map((word) => word.trim())
        .filter(Boolean);

    const expandedWords = new Set(baseWords);

    baseWords.forEach((word) => {
        Object.entries(synonymsDictionary).forEach(([mainWord, synonyms]) => {
            const normalizedMainWord = mainWord.toLowerCase();
            const normalizedSynonyms = synonyms.map((synonym) => synonym.toLowerCase());

            if (word === normalizedMainWord || normalizedSynonyms.includes(word)) {
                expandedWords.add(normalizedMainWord);
                normalizedSynonyms.forEach((synonym) => expandedWords.add(synonym));
            }
        });
    });

    return Array.from(expandedWords);
}

function getArticleRelevance(article, searchWords) {
    if (!searchWords.length) {
        return 0;
    }

    const searchableText = [
        article.num,
        article.type,
        article.title,
        article.desc,
        article.fine,
        article.stars,
        article.arrest,
        article.felony,
        article.additional,
        article.tags
    ].join(' ').toLowerCase();

    return searchWords.reduce((score, word) => {
        if (!word) {
            return score;
        }

        const escapedWord = escapeRegExp(word);
        const matches = searchableText.match(new RegExp(escapedWord, 'gi'));

        return score + (matches ? matches.length : 0);
    }, 0);
}

function highlightText(text, searchWords) {
    const safeText = escapeHTML(text);

    if (!safeText || !searchWords.length) {
        return safeText;
    }

    const words = searchWords
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)
        .map(escapeRegExp);

    if (!words.length) {
        return safeText;
    }

    const regex = new RegExp(`(${words.join('|')})`, 'gi');

    return safeText.replace(regex, '<span class="highlight">$1</span>');
}

function compareArticleNumbers(a, b) {
    const first = parseFloat(String(a).replace(',', '.'));
    const second = parseFloat(String(b).replace(',', '.'));

    if (!Number.isNaN(first) && !Number.isNaN(second)) {
        return first - second;
    }

    return String(a).localeCompare(String(b), 'ru', {
        numeric: true,
        sensitivity: 'base'
    });
}

function parseCSV(text) {
    const rows = [];
    let currentRow = [];
    let currentValue = '';
    let insideQuotes = false;

    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        const nextChar = text[i + 1];

        if (char === '"' && insideQuotes && nextChar === '"') {
            currentValue += '"';
            i += 1;
            continue;
        }

        if (char === '"') {
            insideQuotes = !insideQuotes;
            continue;
        }

        if (char === ',' && !insideQuotes) {
            currentRow.push(currentValue);
            currentValue = '';
            continue;
        }

        if ((char === '\n' || char === '\r') && !insideQuotes) {
            if (char === '\r' && nextChar === '\n') {
                i += 1;
            }

            currentRow.push(currentValue);

            if (currentRow.some((value) => value.trim() !== '')) {
                rows.push(currentRow);
            }

            currentRow = [];
            currentValue = '';
            continue;
        }

        currentValue += char;
    }

    currentRow.push(currentValue);

    if (currentRow.some((value) => value.trim() !== '')) {
        rows.push(currentRow);
    }

    return rows;
}

function escapeHTML(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
