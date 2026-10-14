// Быстрое окно программы для Windows: поле поиска и выдача поверх игры.
// База, поиск и подсветка — из core.js, те же, что у памятки. Здесь только само окно.

// У быстрого окна открытого кодекса нет: при равном счёте поиск не отдаёт предпочтения ни одному.
currentCode = null;

const desktopApp = window.chrome && window.chrome.webview;
const quick = document.getElementById('quick');
const input = document.getElementById('searchInput');
const list = document.getElementById('results');
const strip = document.getElementById('recentRow');
const thumb = document.getElementById('thumb');

// Ширины столбцов. Наказания стоят в трёх постоянных местах — у любого кодекса на одной линии;
// единственный штраф занимает все три.
const ROW_COLS = {
    bar: '4px', num: '124px', type: '44px', title: 'minmax(0, 1fr)',
    fine: '112px', stars: '96px', term: '116px', fineOnly: '324px', chev: '32px'
};
// Сколько «Скопировано» остаётся на экране перед закрытием окна
const CLOSE_AFTER_COPY_MS = 450;
// Длительность исчезновения окна — та же, что в quick.css у .quick.leaving
const LEAVE_MS = 160;
// Как часто перечитывается база, пока программа работает
const REFRESH_EVERY_MS = 15 * 60 * 1000;

// Что под полем: 'idle' — поле пустое, только строка недавних; 'recent' — недавние статьями; 'search' — результаты
let mode = 'idle';
// Пробел раскрывает описание, только когда статья выбрана стрелками; иначе он печатается в поле
let markedByArrows = false;
// Статьи, показанные сейчас в списке, — в том же порядке, что строки
let shownArticles = [];

// ===== База =====
// Сохранённая копия (общая с памяткой) берётся сразу; свежая подменяет её после загрузки.
let lastRefreshAt = 0;

let savedArticlesAt = 0;

// Памятка могла обновить сохранённую копию, пока окно было скрыто: тогда берётся она
function loadSavedArticles() {
    const cached = loadCache(CACHE_KEY);
    if (!cached || cached.savedAt === savedArticlesAt) return;
    savedArticlesAt = cached.savedAt;
    parsedDatabase = cached.data;
}

async function refreshArticles() {
    lastRefreshAt = Date.now();
    try {
        const fresh = await fetchArticles();
        saveCache(CACHE_KEY, fresh);
        const firstLoad = parsedDatabase.length === 0;
        parsedDatabase = fresh;
        if (firstLoad) draw();
    } catch (e) {
        console.error(e);
    }
}

// ===== Строка статьи =====

// Значок из набора в quick.html
const icon = id => `<svg width="14" height="14" aria-hidden="true"><use href="#${id}"/></svg>`;

function buildRow(article, query, index) {
    const isUk = article.code === 'uk';
    const has = { fine: article.fine, stars: article.stars, term: article.arrest };
    const onlyFine = has.fine && !has.stars && !has.term;
    const names = ['bar', 'num', isUk && 'type', 'title', ...(onlyFine ? ['fineOnly'] : ['fine', 'stars', 'term']), 'chev'].filter(Boolean);
    const extra = escapeHtml(article.extraMeasure);
    const felony = hasFelonyRecord(article);
    const type = escapeHtml(article.type);

    // Отметка «есть доп. мера» — под штрафом; сама мера — в описании
    const cap = extra ? '<span class="pen-cap">+ доп. мера</span>' : '';
    const fineCell = `<div class="cell fine money${extra ? ' with-cap' : ''}"><span>${wrapBeforeWord(article.fine, 'до')}</span>${cap}</div>`;
    // У статьи УК все три ячейки стоят всегда, пустая — с прочерком. У АК и ДК пустого места не видно
    const none = (filler) => isUk || filler
        ? `<div class="cell empty${filler ? ' with-cap' : ''}">${filler || '—'}</div>`
        : '<div class="cell pen-none"></div>';

    const cells = {
        bar: '<div class="row-bar"></div>',
        num: `<div class="cell num" title="Скопировать номер статьи"><span class="num-text">ст. ${highlightArticleNum(article.num, query)}</span>`
            + `<span class="ico">${icon('i-copy')}</span><span class="num-done">${icon('i-check')}Скопировано</span></div>`,
        type: `<div class="cell cell-type">${type === '-' ? '' : type}</div>`,
        title: `<div class="cell cell-title"><span>${highlightText(article.title, query)}</span></div>`,
        fineOnly: fineCell,
        fine: has.fine ? fineCell : none(cap),
        stars: has.stars ? `<div class="cell">${buildStarsHtml(article)}</div>` : none(''),
        term: has.term
            ? `<div class="cell term ${felony ? 'felony' : ''}"><span>${wrapBeforeWord(article.arrest, 'или')}</span>${felony ? '<span class="fel-cap">судимость</span>' : ''}</div>`
            : none(''),
        // Стрелка у правого края: у статьи есть описание, оно раскрывается
        chev: `<div class="cell cell-chev">${icon('i-chev')}</div>`
    };

    return `<div class="row ${article.code}${index === 0 ? ' selected' : ''}" data-index="${index}">
        <div class="grid" style="--cols: ${names.map(name => ROW_COLS[name]).join(' ')}">${names.map(name => cells[name]).join('')}</div>
        <div class="row-body">
            <div class="row-body-in">
                <div class="row-body-pad">
                    <div class="row-desc">${highlightText(article.desc, query).replace(/\n/g, '<br>')}</div>
                    ${extra ? `<div class="parts"><span class="label">Доп. мера</span><span class="desc-extra">${extra}</span></div>` : ''}
                </div>
            </div>
        </div>
    </div>`;
}

// ===== Отрисовка =====

function recentArticles() {
    return recentCopied
        .map(id => parsedDatabase.find(article => articleId(article) === id))
        .filter(Boolean);
}

function draw() {
    const recent = recentArticles();
    let query = null;
    let note = '';
    shownArticles = [];

    if (mode === 'search') {
        if (parsedDatabase.length === 0) {
            note = 'База ещё не загружена. Проверьте подключение к интернету.';
        } else {
            const found = findWithFixes(input.value, {}, parsedDatabase, getArticleSearchIndex, searchArticles);
            if (found.query.active) {
                query = found.query;
                shownArticles = found.results.map(result => result.article);
                if (shownArticles.length === 0) note = 'Ничего не найдено. Попробуйте описать иначе.';
            }
        }
    } else if (mode === 'recent') {
        shownArticles = recent;
    }

    list.innerHTML = note
        ? `<div class="quick-note">${note}</div>`
        : shownArticles.map((article, index) => buildRow(article, query, index)).join('');
    list.hidden = !note && shownArticles.length === 0;
    list.scrollTop = 0;

    strip.hidden = mode !== 'idle' || recent.length === 0;
    strip.innerHTML = '<span class="label">Недавние</span><div class="chips">'
        + recent.map((article, index) => `<button type="button" class="chip" data-index="${index}" title="${escapeHtml(article.title)} — скопировать номер">${escapeHtml(copyText(article))}</button>`).join('')
        + `</div><button type="button" class="recent-clear" title="Очистить недавние" aria-label="Очистить недавние">${icon('i-x')}</button><kbd class="kbd">↓</kbd>`;

    quick.classList.toggle('has-query', input.value !== '');
    quick.classList.toggle('has-panel', !list.hidden || !strip.hidden);
    placeThumb();
}

// Метка прокрутки: высота и положение — по доле видимой части списка
function placeThumb() {
    const share = list.hidden ? 1 : list.clientHeight / list.scrollHeight;
    thumb.hidden = share >= 1;
    const track = list.clientHeight - 16;
    thumb.style.height = Math.round(track * share) + 'px';
    thumb.style.top = 8 + Math.round(track * list.scrollTop / list.scrollHeight) + 'px';
}

list.addEventListener('scroll', placeThumb);

input.addEventListener('input', () => {
    mode = input.value.trim() ? 'search' : 'idle';
    markedByArrows = false;
    draw();
});

// ===== Отметка, описание, копирование =====

const markedRow = () => list.querySelector('.row.selected');

// Стрелки переносят отметку; список прокручивается, когда она уходит за край
function moveMark(step) {
    const rows = [...list.querySelectorAll('.row')];
    if (rows.length === 0) return;
    markedByArrows = true;
    const next = Math.min(rows.length - 1, Math.max(0, rows.indexOf(markedRow()) + step));
    rows.forEach((row, index) => row.classList.toggle('selected', index === next));
    reveal(rows[next]);
}

// Строка целиком в видимой части списка; если она выше списка — видно её начало
function reveal(row) {
    const top = row.offsetTop - 8;
    const bottom = row.offsetTop + row.offsetHeight + 8;
    if (top < list.scrollTop || bottom - top > list.clientHeight) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}

// Описание раскрывается щелчком по статье или пробелом у отмеченной; отметка переходит на раскрытую
function toggleRow(row) {
    list.querySelectorAll('.row').forEach(other => other.classList.toggle('selected', other === row));
    row.classList.toggle('open');
}

// Что уходит в буфер обмена — как в памятке: «ст. 6.1 ч.1 УК»
const copyText = article => `ст. ${article.num} ${CODE_LABELS[article.code] || ''}`.trim();

// Номер — в буфер обмена, статья встаёт первой в недавних, место нажатия (ячейка номера или номер в недавних)
// становится зелёным, и через мгновение окно закрывается
function copyArticle(article, place) {
    if (place.classList.contains('copied')) return;

    const text = copyText(article);
    const done = () => {
        storeRecentCopied(article);
        place.classList.add('copied');
        setTimeout(closeQuick, CLOSE_AFTER_COPY_MS);
    };
    // Если страница не может писать в буфер обмена сама, это делает программа
    const viaApp = () => {
        if (!desktopApp) return;
        desktopApp.postMessage({ type: 'copy', text });
        done();
    };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done).catch(viaApp);
    else viaApp();
}

const copyRow = row => copyArticle(shownArticles[Number(row.dataset.index)], row.querySelector('.num'));

list.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row || !e.target.closest('.grid')) return;
    if (e.target.closest('.num')) copyRow(row);
    else toggleRow(row);
    input.focus();
});

// Курсор мыши переносит отметку на статью под ним — как в памятке; у отмеченной виден значок копирования.
// Считается только настоящее движение мыши: под неподвижным курсором список может прокручиваться стрелками
let lastMouseX = -1;
let lastMouseY = -1;
list.addEventListener('mousemove', (e) => {
    if (e.clientX === lastMouseX && e.clientY === lastMouseY) return;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    const row = e.target.closest('.row');
    if (!row || row === markedRow()) return;
    list.querySelectorAll('.row').forEach(other => other.classList.toggle('selected', other === row));
});

// Недавние: щелчок по номеру копирует его, крестик очищает список
strip.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) {
        copyArticle(recentArticles()[Number(chip.dataset.index)], chip);
    } else if (e.target.closest('.recent-clear')) {
        dropRecentCopied();
        draw();
    }
    input.focus();
});

// Когда описание раздвинулось, оно показывается целиком, а метка прокрутки встаёт по новой высоте списка
list.addEventListener('transitionend', (e) => {
    const row = e.target.closest('.row.open');
    if (row && e.target.classList.contains('row-body')) reveal(row);
    placeThumb();
});

// ===== Появление и исчезновение окна =====
// Показывает и прячет окно программа; страница готовит его к показу и просит закрыть.

function openQuick() {
    quick.classList.remove('leaving');
    recentCopied = loadRecentCopied();
    loadSavedArticles();
    if (Date.now() - lastRefreshAt >= REFRESH_EVERY_MS) refreshArticles();
    input.value = '';
    mode = 'idle';
    markedByArrows = false;
    draw();
    input.focus();
}

function closeQuick() {
    if (quick.classList.contains('leaving')) return;
    quick.classList.add('leaving');
    // Таймер, а не событие окончания: при отключённом движении и в скрытом окне событие не приходит
    setTimeout(() => {
        if (desktopApp) desktopApp.postMessage({ type: 'quickClose' });
        else openQuick();
    }, LEAVE_MS);
}

document.addEventListener('keydown', (e) => {
    if (quick.classList.contains('leaving')) return;
    const marked = markedRow();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        // При пустом поле стрелка вниз разворачивает недавние в статьи
        if (mode === 'idle') {
            if (e.key === 'ArrowDown' && recentArticles().length) { mode = 'recent'; markedByArrows = true; draw(); }
        } else {
            moveMark(e.key === 'ArrowDown' ? 1 : -1);
        }
    } else if (marked && (e.key === 'Enter' || (e.key === ' ' && markedByArrows))) {
        // Enter раскрывает описание отмеченной статьи всегда. Пробел — только после стрелок:
        // сразу после набора он нужен в поле, чтобы писать запрос из нескольких слов
        e.preventDefault();
        toggleRow(marked);
    } else if (e.ctrlKey && e.code === 'KeyC' && marked && input.selectionStart === input.selectionEnd && !String(getSelection())) {
        // Если в поле или в описании выделен текст, Ctrl + C копирует его, как обычно
        e.preventDefault();
        copyRow(marked);
    } else if (e.key === 'Escape') {
        // Esc очищает поиск, а при пустом поле закрывает окно
        e.preventDefault();
        if (mode === 'idle') { closeQuick(); return; }
        input.value = '';
        mode = 'idle';
        markedByArrows = false;
        draw();
    }
});

if (desktopApp) {
    desktopApp.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'quickShow') openQuick();
    });
}

openQuick();
