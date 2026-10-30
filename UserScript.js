// ==UserScript==
// @name         Amazon自然位/广告位查询 + Listing关键词搜索·全站版
// @namespace    http://tampermonkey.net/
// @version      5.2
// @description  搜索页查 ASIN 自然位或广告位并跳转高亮；Listing 页搜索标题/五点/描述/A+ 中的关键词
// @author       https://github.com/Duckyal
// @include      /^https?:\/\/(www\.|smile\.)?amazon\.[a-z.]+\//
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const DEFAULT_MAX_PAGES = 5;
    const FETCH_STAGGER = 50;
    const STAGGER_TOTAL_BUDGET = 800;
    const STORAGE_KEY = 'amz_rank_jump_target';
    const ASIN_HISTORY_KEY = 'amz_rank_asin_history';
    const ASIN_HISTORY_MAX = 10;
    const BTN_POS_KEY = 'amz_btn_pos';
    const MAX_PAGES_KEY = 'amz_max_pages';
    const QUERY_MODE_KEY = 'amz_query_mode';
    const FLOAT_BTN_ID = 'amz-rank-float-btn';

    const COLOR_CHIP_BG = '#e8f1fb';
    const COLOR_CHIP_BG_HOVER = '#d2e4f8';
    const COLOR_CHIP_MATCH = '#ffd8a8';
    const COLOR_CHIP_MATCH_HOVER = '#ffc078';
    const COLOR_CHIP_TEXT = '#1a3b5c';
    const COLOR_CHIP_MATCH_TEXT = '#6b3b00';

    const HIGHLIGHT_NATURAL = { main: '#ff9900', text: '#111', glow: 'rgba(255,153,0,0.65)' };
    const HIGHLIGHT_AD = { main: '#7c3aed', text: '#fff', glow: 'rgba(124,58,237,0.65)' };

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    // ---------- 站点识别 ----------
    function getSiteKey() {
        const m = (location.hostname || '').match(/amazon\.(.+)$/i);
        return m ? m[1].toLowerCase() : 'unknown';
    }

    function historyKey() {
        return ASIN_HISTORY_KEY + ':' + getSiteKey();
    }

    function migrateLegacyHistory() {
        try {
            const legacy = GM_getValue(ASIN_HISTORY_KEY, null);
            if (!legacy) return;
            const k = historyKey();
            const existing = GM_getValue(k, null);
            if (!existing) {
                GM_setValue(k, legacy);
                console.log('[Amazon查自然位] 已将旧全局历史迁移到站点:', getSiteKey());
            } else {
                console.log('[Amazon查自然位] 当前站点已有历史，跳过迁移旧全局历史');
            }
            GM_deleteValue(ASIN_HISTORY_KEY);
        } catch (e) {
            console.warn('[Amazon查自然位] 迁移历史失败:', e);
        }
    }

    // ---------- 查询模式记忆 ----------
    function loadQueryMode() {
        const v = GM_getValue(QUERY_MODE_KEY, 'natural');
        return (v === 'ad' || v === 'natural') ? v : 'natural';
    }
    function saveQueryMode(v) {
        if (v === 'ad' || v === 'natural') GM_setValue(QUERY_MODE_KEY, v);
    }

    // ---------- 页面类型检测（支持双段语言前缀） ----------
    function detectPageType() {
        const path = location.pathname;
        const url = new URL(location.href);

        // 搜索结果页
        if (path === '/s' || path.startsWith('/s/') || path === '/b' || path.startsWith('/gp/search')) {
            if (url.searchParams.has('k') || url.searchParams.has('i') ||
                url.searchParams.has('rh') || url.searchParams.has('node') ||
                url.searchParams.has('me') || url.searchParams.has('crid') ||
                url.searchParams.has('ds') || url.searchParams.has('bbn')) {
                return 'search';
            }
        }

        // Listing 详情页：普通结构 + /-/en/dp/、/-/es-ES/dp/、/-/en-GB/gp/product/ 等语言前缀
        if (/\/dp\/[A-Z0-9]{10}/i.test(path) ||
            /\/gp\/product\/[A-Z0-9]{10}/i.test(path) ||
            /\/gp\/aw\/d\/[A-Z0-9]{10}/i.test(path) ||
            /\/-\/[a-z]{2}(-[a-z]{2})?\/dp\/[A-Z0-9]{10}/i.test(path) ||
            /\/-\/[a-z]{2}(-[a-z]{2})?\/gp\/product\/[A-Z0-9]{10}/i.test(path) ||
            /\/-\/[a-z]{2}(-[a-z]{2})?\/gp\/aw\/d\/[A-Z0-9]{10}/i.test(path)) {
            return 'listing';
        }

        return null;
    }

    // ---------- 查询页数记忆 ----------
    function loadMaxPages() {
        const v = parseInt(GM_getValue(MAX_PAGES_KEY, String(DEFAULT_MAX_PAGES)), 10);
        return (Number.isFinite(v) && v >= 1) ? v : DEFAULT_MAX_PAGES;
    }
    function saveMaxPages(v) {
        const n = parseInt(v, 10);
        if (Number.isFinite(n) && n >= 1) {
            GM_setValue(MAX_PAGES_KEY, String(n));
        }
    }

    // ---------- 最大页数解析 ----------
    function parseMaxPageFromDoc(doc) {
        let max = 0;
        const items = doc.querySelectorAll('.s-pagination-item');
        items.forEach(el => {
            if (el.classList.contains('s-pagination-next')) return;
            if (el.classList.contains('s-pagination-previous')) return;
            const t = (el.textContent || '').trim();
            if (/^\d+$/.test(t)) {
                const n = parseInt(t, 10);
                if (Number.isFinite(n) && n > max) max = n;
            }
        });
        if (max > 0) return max;

        const links = doc.querySelectorAll('a[href*="page="]');
        links.forEach(a => {
            const href = a.getAttribute('href') || '';
            const m = href.match(/[?&]page=(\d+)/);
            if (m) {
                const n = parseInt(m[1], 10);
                if (Number.isFinite(n) && n > max) max = n;
            }
        });
        return max;
    }

    let cachedMaxPages = 0;

    function buildPageUrl(pageNum) {
        const url = new URL(location.href);
        if (pageNum === 1) {
            url.searchParams.delete('page');
        } else {
            url.searchParams.set('page', pageNum);
        }
        return url.toString();
    }

    async function fetchPageDoc(pageNum) {
        const resp = await fetch(buildPageUrl(pageNum), {
            credentials: 'include',
            headers: { 'User-Agent': navigator.userAgent },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const html = await resp.text();
        return new DOMParser().parseFromString(html, 'text/html');
    }

    async function ensureMaxPages() {
        if (cachedMaxPages > 0) return cachedMaxPages;
        const local = parseMaxPageFromDoc(document);
        if (local > 0) {
            cachedMaxPages = local;
            return local;
        }
        try {
            const doc = await fetchPageDoc(1);
            const n = parseMaxPageFromDoc(doc);
            if (n > 0) cachedMaxPages = n;
        } catch (e) {
            console.warn('获取最大页数失败:', e);
        }
        return cachedMaxPages;
    }

    // ---------- toast ----------
    let currentToastCleanup = null;
    function showToast(lines) {
        if (currentToastCleanup) {
            currentToastCleanup();
            currentToastCleanup = null;
        }

        const text = Array.isArray(lines) ? lines.join('\n') : String(lines);
        const toast = document.createElement('div');
        toast.textContent = text;
        toast.title = '点击关闭';
        toast.style.cssText = `
            position: fixed; top: 20px; right: 20px;
            z-index: 2147483647;
            background: rgba(33,33,33,0.96);
            color: #fff;
            padding: 14px 44px 14px 20px;
            border-radius: 10px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            font-size: 13px;
            line-height: 1.7;
            box-shadow: 0 8px 30px rgba(0,0,0,0.35);
            max-width: min(400px, 90vw);
            white-space: pre-wrap;
            word-break: break-word;
            opacity: 0;
            transform: translateX(20px);
            transition: opacity .25s ease, transform .25s ease;
            cursor: pointer;
            user-select: none;
            pointer-events: auto;
        `;

        const closeMark = document.createElement('span');
        closeMark.textContent = '×';
        closeMark.style.cssText = `
            position: absolute; top: 8px; right: 10px;
            width: 22px; height: 22px; line-height: 22px;
            text-align: center; border-radius: 50%;
            font-size: 16px; color: #bbb;
            pointer-events: none;
        `;
        toast.appendChild(closeMark);

        let removed = false;
        function remove() {
            if (removed) return;
            removed = true;
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(20px)';
            setTimeout(() => { toast.remove(); }, 260);
            if (currentToastCleanup === remove) currentToastCleanup = null;
        }
        currentToastCleanup = remove;

        toast.addEventListener('click', remove);
        document.body.appendChild(toast);

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                toast.style.opacity = '1';
                toast.style.transform = 'translateX(0)';
            });
        });

        return remove;
    }

    function getCurrentPage() {
        const v = parseInt(new URL(location.href).searchParams.get('page') || '1', 10);
        return (v >= 1) ? v : 1;
    }

    function waitForCards(timeout = 15000) {
        const sel = '[data-component-type="s-search-result"]';
        return new Promise(resolve => {
            if (document.querySelector(sel)) return resolve(true);

            let rafId = null;
            let done = false;

            const check = () => {
                rafId = null;
                if (done) return;
                if (document.querySelector(sel)) {
                    done = true;
                    observer.disconnect();
                    clearTimeout(timer);
                    resolve(true);
                }
            };

            const observer = new MutationObserver(() => {
                if (rafId !== null) return;
                rafId = requestAnimationFrame(check);
            });

            observer.observe(document.body || document.documentElement, {
                childList: true,
                subtree: true,
            });

            const timer = setTimeout(() => {
                if (done) return;
                done = true;
                observer.disconnect();
                if (rafId !== null) cancelAnimationFrame(rafId);
                resolve(false);
            }, timeout);
        });
    }

    // ---------- ASIN 历史记录（分站点） ----------
    function loadAsinHistory() {
        try {
            const raw = JSON.parse(GM_getValue(historyKey(), '[]'));
            if (!Array.isArray(raw)) return [];
            return raw.map(item => {
                if (typeof item === 'string') return { asin: item, name: '' };
                if (item && typeof item.asin === 'string') {
                    return {
                        asin: item.asin,
                        name: typeof item.name === 'string' ? item.name : ''
                    };
                }
                return null;
            }).filter(Boolean);
        } catch { return []; }
    }

    function saveAsinHistory(list) {
        GM_setValue(historyKey(), JSON.stringify(list.slice(0, ASIN_HISTORY_MAX)));
    }

    function pushAsinHistory(asin) {
        const list = loadAsinHistory();
        const existing = list.find(x => x.asin === asin);
        const filtered = list.filter(x => x.asin !== asin);
        filtered.unshift({ asin, name: existing ? existing.name : '' });
        saveAsinHistory(filtered);
    }

    function removeAsinHistory(asin) {
        saveAsinHistory(loadAsinHistory().filter(x => x.asin !== asin));
    }

    function renameAsinHistory(asin, name) {
        const list = loadAsinHistory();
        const target = list.find(x => x.asin === asin);
        if (!target) return;
        target.name = name || '';
        saveAsinHistory(list);
    }

    function clearAsinHistory() {
        saveAsinHistory([]);
    }

    // 提取 ASIN 已兼容 /-/es-ES/dp/、/-/en-GB/gp/product/ 等前缀
    function normalizeAsinInput(raw) {
        const s = String(raw || '').trim();
        const m =
            s.match(/\/dp\/([A-Z0-9]{10})/i) ||
            s.match(/\/gp\/product\/([A-Z0-9]{10})/i) ||
            s.match(/\/gp\/aw\/d\/([A-Z0-9]{10})/i) ||
            s.match(/\/product\/([A-Z0-9]{10})/i) ||
            s.match(/\b([A-Z0-9]{10})\b/i);
        return m ? m[1].toUpperCase() : s.toUpperCase();
    }

    // ---------- Listing 关键词搜索 ----------
    const LISTING_SECTIONS = [
        { key: 'title', name: '标题', selectors: ['#productTitle'] },
        { key: 'bullets', name: '五点描述', selectors: ['#feature-bullets', '#featurebullets_feature_div'] },
        { key: 'description', name: '商品描述', selectors: ['#productDescription', '#productDescription_feature_div'] },
        { key: 'aplus', name: 'A+ 内容', selectors: ['#aplus', '#aplus_feature_div', '.aplus-v2'] },
        {
            key: 'details',
            name: '商品详情',
            selectors: [
                '#detailBullets_feature_div',
                '#productDetails_detailBullets_sections1',
                '#productDetails_techSpec_section_1',
                '#productDetails_db_sections',
            ],
        },
        { key: 'brand', name: '品牌/店铺', selectors: ['#bylineInfo'] },
    ];

    function findSectionElement(sec) {
        for (const sel of sec.selectors) {
            const el = document.querySelector(sel);
            if (el) return el;
        }
        return null;
    }

    function getVisibleText(el) {
        if (!el) return '';
        if (typeof el.innerText === 'string') return el.innerText;
        return el.textContent || '';
    }

    function searchListing(keywords) {
        const lowered = keywords.map(k => k.toLowerCase());
        return LISTING_SECTIONS.map(sec => {
            const el = findSectionElement(sec);
            if (!el) {
                return { ...sec, found: false, hits: [], el: null, reason: '区域未找到' };
            }
            const text = getVisibleText(el).toLowerCase();
            const hits = [];
            for (let i = 0; i < keywords.length; i++) {
                if (text.includes(lowered[i])) hits.push(keywords[i]);
            }
            return { ...sec, found: hits.length > 0, hits, el };
        });
    }

    function scrollAndHighlight(el) {
        if (!el) return;
        const prevOutline = el.style.outline;
        const prevOffset = el.style.outlineOffset;
        el.style.outline = '3px solid #ff9900';
        el.style.outlineOffset = '3px';
        el.scrollIntoView({ behavior: 'auto', block: 'start' });
        setTimeout(() => {
            el.style.outline = prevOutline;
            el.style.outlineOffset = prevOffset;
        }, 3000);
    }

    // ---------- 判断广告卡 ----------
    function isAdCard(card) {
        if (!card) return false;
        if (card.classList.contains('AdHolder')) return true;
        if (card.querySelector('.puis-sponsored-label-text')) return true;
        if (card.querySelector('[data-component-type="s-sponsored-label"]')) return true;
        return false;
    }

    // ---------- 核心查找（双模式） ----------
    function findNaturalInDocument(doc, targetAsin) {
        const cards = doc.querySelectorAll(
            '[data-component-type="s-search-result"]:not(.AdHolder)'
        );
        if (!cards.length) return null;

        let targetCard = null;
        for (let i = 0; i < cards.length; i++) {
            const asin = cards[i].getAttribute('data-asin');
            if (asin && asin.toUpperCase() === targetAsin) {
                if (isAdCard(cards[i])) continue;
                targetCard = cards[i];
                break;
            }
        }
        if (!targetCard) return null;

        let pos = 0;
        for (let i = 0; i < cards.length; i++) {
            const card = cards[i];
            if (card === targetCard) return { position: pos + 1, card };
            if (!card.getAttribute('data-asin')) continue;
            if (isAdCard(card)) continue;
            pos++;
        }
        return null;
    }

    function findAdInDocument(doc, targetAsin) {
        const cards = doc.querySelectorAll('[data-component-type="s-search-result"]');
        if (!cards.length) return null;

        let targetCard = null;
        for (let i = 0; i < cards.length; i++) {
            const card = cards[i];
            const asin = card.getAttribute('data-asin');
            if (asin && asin.toUpperCase() === targetAsin && isAdCard(card)) {
                targetCard = card;
                break;
            }
        }
        if (!targetCard) return null;

        let adPos = 0;
        for (let i = 0; i < cards.length; i++) {
            const card = cards[i];
            if (card === targetCard) return { position: adPos + 1, card };
            if (!card.getAttribute('data-asin')) continue;
            if (isAdCard(card)) adPos++;
        }
        return null;
    }

    function findInDocument(doc, targetAsin, mode) {
        return mode === 'ad'
            ? findAdInDocument(doc, targetAsin)
            : findNaturalInDocument(doc, targetAsin);
    }

    function extractCardInfo(card) {
        const imgEl = card.querySelector('.s-image');
        const priceEl = card.querySelector('.a-price .a-offscreen');
        const titleEl = card.querySelector('h2 span');
        return {
            image: imgEl ? imgEl.src : '',
            price: priceEl ? priceEl.textContent.trim() : '',
            title: titleEl ? titleEl.textContent.trim() : '',
        };
    }

    async function findInOtherPages(targetAsin, maxPages, excludePage, mode) {
        const pages = [];
        for (let p = 1; p <= maxPages; p++) {
            if (p === excludePage) continue;
            pages.push(p);
        }
        if (!pages.length) return null;

        const stagger = Math.min(
            FETCH_STAGGER,
            STAGGER_TOTAL_BUDGET / Math.max(1, pages.length - 1)
        );

        const promises = pages.map((p, idx) => (async () => {
            if (idx > 0) await sleep(idx * stagger);
            try {
                const doc = await fetchPageDoc(p);
                return { page: p, hit: findInDocument(doc, targetAsin, mode) };
            } catch (e) {
                console.warn(`获取第 ${p} 页失败:`, e);
                return { page: p, hit: null };
            }
        })());

        for (const p of promises) {
            const r = await p;
            if (r && r.hit) return r;
        }
        return null;
    }

    async function findRank(targetAsin, maxPages, mode) {
        const curPage = getCurrentPage();
        const hitCur = findInDocument(document, targetAsin, mode);
        if (hitCur) {
            return { page: curPage, position: hitCur.position, card: hitCur.card };
        }
        const other = await findInOtherPages(targetAsin, maxPages, curPage, mode);
        if (other) {
            return { page: other.page, position: other.hit.position, card: null };
        }
        return null;
    }

    // ---------- 高亮 & 滚动（搜索页） ----------
    function highlightCard(card, page, position, mode) {
        if (!card) return;
        const scheme = mode === 'ad' ? HIGHLIGHT_AD : HIGHLIGHT_NATURAL;
        const label = mode === 'ad' ? '广告位' : '自然位';

        if (getComputedStyle(card).position === 'static') {
            card.style.position = 'relative';
        }
        card.style.outline = `3px solid ${scheme.main}`;
        card.style.outlineOffset = '2px';
        card.style.boxShadow = `0 0 20px ${scheme.glow}`;

        const badge = document.createElement('div');
        badge.textContent = `${label} ${page}-${position}`;
        badge.style.cssText = `
            position: absolute; top: 0; left: 0; z-index: 9999;
            background: ${scheme.main}; color: ${scheme.text}; font-weight: bold;
            padding: 6px 14px; border-radius: 0 0 10px 0;
            font-size: 14px; font-family: -apple-system, sans-serif;
            box-shadow: 0 2px 6px rgba(0,0,0,0.2);
        `;
        card.appendChild(badge);

        card.scrollIntoView({ behavior: 'auto', block: 'center' });
    }

    function buildResultToast(page, position, asin, info, mode) {
        const label = mode === 'ad' ? '广告位' : '自然位';
        const shortTitle = info.title.length > 60
            ? info.title.slice(0, 60) + '...'
            : info.title;
        return [
            `✅ 找到${label}：${page}-${position}`,
            `ASIN：${asin}`,
            `标题：${shortTitle}`,
            `价格：${info.price}`
        ];
    }

    function checkPendingJump() {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        if (!raw) return false;
        let data;
        try { data = JSON.parse(raw); } catch { return false; }
        sessionStorage.removeItem(STORAGE_KEY);

        if (getCurrentPage() !== data.page) return false;

        const mode = data.mode === 'ad' ? 'ad' : 'natural';
        const label = mode === 'ad' ? '广告位' : '自然位';

        waitForCards().then(loaded => {
            if (!loaded) { showToast('⚠️ 页面加载超时，无法定位商品。'); return; }
            const hit = findInDocument(document, data.asin, mode);
            if (hit) {
                highlightCard(hit.card, data.page, hit.position, mode);
                const info = extractCardInfo(hit.card);
                showToast(buildResultToast(data.page, hit.position, data.asin, info, mode));
            } else {
                showToast(`⚠️ 已跳到目标页，但未能定位到该${label}（可能结果排序发生变化）。`);
            }
        });
        return true;
    }

    // ---------- 通用：胶囊配色 ----------
    function applyChipStyle(chip, matched, hovered) {
        chip.style.background = matched
            ? (hovered ? COLOR_CHIP_MATCH_HOVER : COLOR_CHIP_MATCH)
            : (hovered ? COLOR_CHIP_BG_HOVER : COLOR_CHIP_BG);
        chip.style.color = matched ? COLOR_CHIP_MATCH_TEXT : COLOR_CHIP_TEXT;
    }

    // ---------- ASIN 输入面板 ----------
    function askAsin() {
        return new Promise(resolve => {
            const history = loadAsinHistory();
            const last = history[0] ? history[0].asin : '';
            let submitted = false;
            let closed = false;
            let knownMaxPages = cachedMaxPages;
            let currentMode = loadQueryMode();
            const siteKey = getSiteKey();

            const overlay = document.createElement('div');
            overlay.style.cssText = `
                position: fixed; inset: 0; z-index: 999999;
                background: rgba(0,0,0,0.45);
                display: flex; align-items: center; justify-content: center;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                will-change: opacity;
                contain: layout paint;
            `;

            const panel = document.createElement('div');
            panel.style.cssText = `
                position: relative;
                background: #fff; border-radius: 12px; padding: 20px;
                width: 440px; max-width: 92vw; box-shadow: 0 10px 40px rgba(0,0,0,0.3);
            `;

            const titleRow = document.createElement('div');
            titleRow.style.cssText =
                'display:flex; justify-content:space-between; align-items:center; margin-bottom: 14px;';

            const title = document.createElement('div');
            title.textContent = '🔍 查 ASIN 排名';
            title.style.cssText = 'font-size: 16px; font-weight: bold; color:#111;';

            const closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.textContent = '×';
            closeBtn.title = '关闭（Esc）';
            closeBtn.setAttribute('aria-label', '关闭');
            closeBtn.style.cssText = `
                display: inline-flex; align-items: center; justify-content: center;
                width: 30px; height: 30px; border-radius: 50%;
                font-size: 18px; line-height: 1; color: #999;
                background: transparent; border: none; padding: 0; margin: 0;
                cursor: pointer; user-select: none;
                touch-action: manipulation;
                -webkit-tap-highlight-color: transparent;
                outline: none;
            `;
            closeBtn.addEventListener('mouseenter', () => {
                closeBtn.style.background = '#f2f2f2';
                closeBtn.style.color = '#333';
            });
            closeBtn.addEventListener('mouseleave', () => {
                closeBtn.style.background = 'transparent';
                closeBtn.style.color = '#999';
            });

            const doClose = () => {
                if (closed || submitted) return;
                closed = true;
                cleanup();
                resolve(null);
            };

            closeBtn.addEventListener('pointerdown', e => {
                if (e.pointerType === 'mouse' && e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                doClose();
            });
            if (!window.PointerEvent) {
                closeBtn.addEventListener('mousedown', e => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    doClose();
                });
            }
            closeBtn.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    doClose();
                }
            });

            titleRow.appendChild(title);
            titleRow.appendChild(closeBtn);

            // ---- 查询类型切换 ----
            const modeRow = document.createElement('div');
            modeRow.style.cssText = 'display:flex; gap:8px; margin-bottom:12px;';

            const naturalBtn = document.createElement('button');
            naturalBtn.type = 'button';
            naturalBtn.textContent = '📍 自然位';

            const adBtn = document.createElement('button');
            adBtn.type = 'button';
            adBtn.textContent = '📢 广告位';

            [naturalBtn, adBtn].forEach(btn => {
                btn.style.cssText = `
                    flex: 1;
                    padding: 8px 12px;
                    border-radius: 8px;
                    cursor: pointer;
                    font-size: 13px;
                    font-family: -apple-system, sans-serif;
                    border: 2px solid transparent;
                    transition: background .15s, color .15s, border-color .15s;
                `;
            });

            function refreshModeButtons() {
                const isNatural = currentMode === 'natural';
                const isAd = currentMode === 'ad';

                naturalBtn.style.background = isNatural ? HIGHLIGHT_NATURAL.main : '#f2f2f2';
                naturalBtn.style.color = isNatural ? HIGHLIGHT_NATURAL.text : '#666';
                naturalBtn.style.borderColor = isNatural ? HIGHLIGHT_NATURAL.main : 'transparent';
                naturalBtn.style.fontWeight = isNatural ? 'bold' : 'normal';

                adBtn.style.background = isAd ? HIGHLIGHT_AD.main : '#f2f2f2';
                adBtn.style.color = isAd ? HIGHLIGHT_AD.text : '#666';
                adBtn.style.borderColor = isAd ? HIGHLIGHT_AD.main : 'transparent';
                adBtn.style.fontWeight = isAd ? 'bold' : 'normal';
            }

            naturalBtn.addEventListener('click', () => {
                currentMode = 'natural';
                refreshModeButtons();
                input.focus();
            });
            adBtn.addEventListener('click', () => {
                currentMode = 'ad';
                refreshModeButtons();
                input.focus();
            });

            modeRow.appendChild(naturalBtn);
            modeRow.appendChild(adBtn);
            refreshModeButtons();

            // ---- ASIN 输入 ----
            const input = document.createElement('input');
            input.type = 'text';
            input.value = last;
            input.placeholder = 'ASIN 或粘贴商品链接';
            input.style.cssText = `
                width: 100%; box-sizing: border-box; padding: 10px 12px;
                border: 2px solid #ddd; border-radius: 8px; font-size: 15px;
                outline: none; transition: border-color .15s; letter-spacing: .5px;
            `;
            input.addEventListener('focus', () => input.style.borderColor = '#ff9900');
            input.addEventListener('blur', () => input.style.borderColor = '#ddd');

            // ---- 查询页数行 ----
            const pageRow = document.createElement('div');
            pageRow.style.cssText =
                'display:flex; align-items:center; gap:8px; margin-top:12px; font-size:13px; color:#555;';

            const pageLabel1 = document.createElement('span');
            pageLabel1.textContent = '查询前';
            pageLabel1.style.cssText = 'color:#555;';

            const pageInput = document.createElement('input');
            pageInput.type = 'number';
            pageInput.min = '1';
            pageInput.step = '1';
            pageInput.value = String(loadMaxPages());
            pageInput.style.cssText = `
                width: 64px; padding: 4px 8px; text-align: center;
                border: 1.5px solid #ddd; border-radius: 6px;
                font-size: 13px; outline: none;
                transition: border-color .15s;
                -moz-appearance: textfield;
            `;
            pageInput.addEventListener('focus', () => pageInput.style.borderColor = '#ff9900');
            pageInput.addEventListener('blur', () => pageInput.style.borderColor = '#ddd');

            const pageLabel2 = document.createElement('span');
            pageLabel2.textContent = '页';
            pageLabel2.style.cssText = 'color:#555;';

            const pageHint = document.createElement('span');
            pageHint.style.cssText = 'color:#aaa; font-size:11px; margin-left:auto;';

            function refreshPageHint() {
                if (knownMaxPages > 0) {
                    pageHint.textContent = `（共 ${knownMaxPages} 页）`;
                    pageInput.max = String(knownMaxPages);
                    let v = parseInt(pageInput.value, 10);
                    if (!Number.isFinite(v) || v < 1) v = DEFAULT_MAX_PAGES;
                    if (v > knownMaxPages) v = knownMaxPages;
                    pageInput.value = String(v);
                } else {
                    pageHint.textContent = `（正整数，默认 ${DEFAULT_MAX_PAGES}）`;
                    pageInput.removeAttribute('max');
                }
            }

            if (knownMaxPages > 0) {
                refreshPageHint();
            } else {
                pageHint.textContent = '（获取页数中…）';
            }

            pageRow.appendChild(pageLabel1);
            pageRow.appendChild(pageInput);
            pageRow.appendChild(pageLabel2);
            pageRow.appendChild(pageHint);

            // ---- 历史记录（显示站点） ----
            const histHeader = document.createElement('div');
            histHeader.style.cssText =
                'display:flex; justify-content:space-between; align-items:center; margin: 14px 0 8px;';

            const histLabel = document.createElement('div');
            histLabel.textContent = `历史记录 · ${siteKey}（点击填入 · ✎ 改名 · × 删除）`;
            histLabel.style.cssText = 'font-size: 12px; color:#888;';

            const clearAllBtn = document.createElement('span');
            clearAllBtn.textContent = '清空全部';
            clearAllBtn.title = `清空 ${siteKey} 站点的所有历史记录`;
            clearAllBtn.style.cssText = `
                font-size: 12px; color:#999; cursor: pointer;
                padding: 2px 6px; border-radius: 6px;
                transition: background .15s, color .15s; user-select:none;
            `;
            clearAllBtn.addEventListener('mouseenter', () => {
                clearAllBtn.style.background = '#ffe4b3';
                clearAllBtn.style.color = '#b36b00';
            });
            clearAllBtn.addEventListener('mouseleave', () => {
                clearAllBtn.style.background = 'transparent';
                clearAllBtn.style.color = '#999';
            });
            clearAllBtn.addEventListener('click', () => {
                if (!loadAsinHistory().length) return;
                if (!confirm(`确定清空 ${siteKey} 站点的全部历史记录？`)) return;
                clearAsinHistory();
                renderHistory();
            });

            histHeader.appendChild(histLabel);
            histHeader.appendChild(clearAllBtn);

            const histBox = document.createElement('div');
            histBox.style.cssText =
                'display:flex; flex-wrap:wrap; gap:6px; min-height: 24px; max-height: 160px; overflow-y:auto;';

            function makeIcon(char, color, bgOnHover, title) {
                const el = document.createElement('span');
                el.textContent = char;
                el.title = title;
                el.style.cssText = `
                    display:inline-flex; align-items:center; justify-content:center;
                    width: 18px; height: 18px; border-radius: 50%;
                    color:#8aa0b5; font-size: ${char === '×' ? '14px' : '12px'}; line-height: 1;
                    transition: background .12s, color .12s;
                    flex-shrink: 0;
                    cursor: pointer;
                `;
                el.addEventListener('mouseenter', () => {
                    el.style.background = bgOnHover;
                    el.style.color = color;
                });
                el.addEventListener('mouseleave', () => {
                    el.style.background = 'transparent';
                    el.style.color = '#8aa0b5';
                });
                return el;
            }

            function highlightHistory(rawValue) {
                const normalized = rawValue ? normalizeAsinInput(rawValue) : '';
                histBox.querySelectorAll('[data-asin]').forEach(chip => {
                    const isMatch = normalized && chip.dataset.asin === normalized;
                    chip.dataset.highlighted = isMatch ? '1' : '0';
                    applyChipStyle(chip, isMatch, chip.dataset.hovered === '1');
                });
            }

            function renderHistory() {
                histBox.innerHTML = '';
                const list = loadAsinHistory();

                if (!list.length) {
                    clearAllBtn.style.display = 'none';
                    const empty = document.createElement('span');
                    empty.textContent = `暂无 ${siteKey} 站点的历史记录`;
                    empty.style.cssText = 'font-size:12px;color:#bbb;';
                    histBox.appendChild(empty);
                    return;
                }
                clearAllBtn.style.display = '';

                list.forEach(item => {
                    const { asin, name } = item;

                    const chip = document.createElement('span');
                    chip.dataset.asin = asin;
                    chip.dataset.highlighted = '0';
                    chip.dataset.hovered = '0';
                    chip.style.cssText = `
                        display: inline-flex; align-items: center; gap: 6px;
                        border-radius: 12px;
                        padding: 5px 8px 5px 12px; font-size: 12px;
                        cursor: pointer; user-select:none;
                        transition: background .15s, color .15s;
                        max-width: 100%;
                    `;
                    applyChipStyle(chip, false, false);

                    const label = document.createElement('span');
                    label.style.cssText =
                        'display:flex; flex-direction:column; line-height:1.25; min-width:0;';

                    const primary = document.createElement('span');
                    primary.textContent = name || asin;
                    primary.style.cssText = `
                        font-size: 12px;
                        white-space: nowrap; overflow: hidden;
                        text-overflow: ellipsis; max-width: 240px;
                    `;
                    label.appendChild(primary);

                    if (name) {
                        const secondary = document.createElement('span');
                        secondary.textContent = asin;
                        secondary.style.cssText =
                            'font-size: 10px; opacity: .65; letter-spacing: .3px;';
                        label.appendChild(secondary);
                    }

                    chip.appendChild(label);

                    const actions = document.createElement('span');
                    actions.style.cssText =
                        'display:inline-flex; align-items:center; gap:2px; margin-left:2px;';

                    const editIcon = makeIcon('✎', '#fff', '#ff9900', '重命名');
                    editIcon.addEventListener('click', e => {
                        e.stopPropagation();
                        e.preventDefault();
                        const cur = name || '';
                        const newName = prompt(
                            `为 ${asin} 命名（留空则清除名称）：`,
                            cur
                        );
                        if (newName === null) return;
                        renameAsinHistory(asin, newName.trim());
                        renderHistory();
                        highlightHistory(input.value);
                    });
                    actions.appendChild(editIcon);

                    const delIcon = makeIcon('×', '#fff', '#ff6b6b', '删除这条记录');
                    delIcon.addEventListener('click', e => {
                        e.stopPropagation();
                        e.preventDefault();
                        const display = name ? `${name}（${asin}）` : asin;
                        if (!confirm(`确定删除历史记录「${display}」？`)) return;
                        removeAsinHistory(asin);
                        if (input.value.trim().toUpperCase() === asin) input.value = '';
                        renderHistory();
                        highlightHistory(input.value);
                    });
                    actions.appendChild(delIcon);

                    chip.appendChild(actions);

                    chip.addEventListener('mouseenter', () => {
                        chip.dataset.hovered = '1';
                        applyChipStyle(chip, chip.dataset.highlighted === '1', true);
                    });
                    chip.addEventListener('mouseleave', () => {
                        chip.dataset.hovered = '0';
                        applyChipStyle(chip, chip.dataset.highlighted === '1', false);
                    });
                    chip.addEventListener('click', () => {
                        input.value = asin;
                        input.focus();
                        input.setSelectionRange(asin.length, asin.length);
                        highlightHistory(asin);
                    });

                    histBox.appendChild(chip);
                });

                highlightHistory(input.value);
            }

            input.addEventListener('input', () => highlightHistory(input.value));

            renderHistory();

            // ---- 底部按钮 ----
            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex; justify-content:flex-end; gap:10px; margin-top:20px;';

            const okBtn = document.createElement('button');
            okBtn.textContent = '查询';
            okBtn.style.cssText = `
                padding: 8px 22px; border-radius: 8px; border: none;
                background: #ff9900; color: #111; font-weight: bold;
                cursor: pointer; font-size: 13px;
            `;

            const hint = document.createElement('div');
            hint.textContent = '回车查询 · Esc 取消';
            hint.style.cssText = 'font-size: 11px; color:#aaa; margin-top: 10px; text-align:center;';

            function cleanup() {
                document.removeEventListener('keydown', onKey, true);
                overlay.remove();
            }
            function onKey(e) {
                if (e.key === 'Escape') { e.stopPropagation(); doClose(); }
                if (e.key === 'Enter') { e.stopPropagation(); submit(); }
            }

            function submit() {
                if (submitted || closed) return;
                const rawVal = input.value.trim();
                if (!rawVal) { input.focus(); return; }
                const asin = normalizeAsinInput(rawVal);
                if (!/^[A-Z0-9]{10}$/.test(asin)) {
                    showToast('⚠️ 请输入有效的 ASIN（10 位字母数字）或粘贴商品链接。');
                    input.focus();
                    input.select();
                    return;
                }

                let maxPages = parseInt(pageInput.value, 10);
                if (!Number.isFinite(maxPages) || maxPages < 1) {
                    maxPages = DEFAULT_MAX_PAGES;
                }
                if (knownMaxPages > 0 && maxPages > knownMaxPages) {
                    maxPages = knownMaxPages;
                }
                pageInput.value = String(maxPages);
                saveMaxPages(maxPages);
                saveQueryMode(currentMode);

                const existing = loadAsinHistory().find(x => x.asin === asin);
                let name = '';
                if (!existing) {
                    const inputName = prompt(
                        `新 ASIN：${asin}\n\n给它起个名字（可留空，方便日后识别）：`,
                        ''
                    );
                    if (inputName === null) {
                        input.focus();
                        input.select();
                        return;
                    }
                    name = inputName.trim();
                }

                submitted = true;
                okBtn.disabled = true;
                pushAsinHistory(asin);
                if (!existing && name) renameAsinHistory(asin, name);
                cleanup();
                resolve({ asin, maxPages, mode: currentMode });
            }

            okBtn.addEventListener('click', submit);
            document.addEventListener('keydown', onKey, true);

            panel.appendChild(titleRow);
            panel.appendChild(modeRow);
            panel.appendChild(input);
            panel.appendChild(pageRow);
            panel.appendChild(histHeader);
            panel.appendChild(histBox);
            btnRow.appendChild(okBtn);
            panel.appendChild(btnRow);
            panel.appendChild(hint);
            overlay.appendChild(panel);
            document.body.appendChild(overlay);
            setTimeout(() => { input.focus(); input.select(); }, 30);

            if (knownMaxPages === 0) {
                ensureMaxPages().then(n => {
                    if (closed || submitted) return;
                    knownMaxPages = n;
                    refreshPageHint();
                }).catch(() => {
                    if (closed || submitted) return;
                    refreshPageHint();
                });
            }
        });
    }

    // ---------- Listing 关键词搜索面板 ----------
    function openKeywordPanel() {
        return new Promise(resolve => {
            let closed = false;

            const overlay = document.createElement('div');
            overlay.style.cssText = `
                position: fixed; inset: 0; z-index: 999999;
                background: rgba(0,0,0,0.45);
                display: flex; align-items: center; justify-content: center;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                will-change: opacity;
                contain: layout paint;
            `;

            const panel = document.createElement('div');
            panel.style.cssText = `
                position: relative;
                background: #fff; border-radius: 12px; padding: 20px;
                width: 480px; max-width: 92vw; box-shadow: 0 10px 40px rgba(0,0,0,0.3);
                max-height: 90vh; display: flex; flex-direction: column;
            `;

            const titleRow = document.createElement('div');
            titleRow.style.cssText =
                'display:flex; justify-content:space-between; align-items:center; margin-bottom: 14px;';

            const title = document.createElement('div');
            title.textContent = '🔍 搜索 Listing 关键词';
            title.style.cssText = 'font-size: 16px; font-weight: bold; color:#111;';

            const closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.textContent = '×';
            closeBtn.title = '关闭（Esc）';
            closeBtn.setAttribute('aria-label', '关闭');
            closeBtn.style.cssText = `
                display: inline-flex; align-items: center; justify-content: center;
                width: 30px; height: 30px; border-radius: 50%;
                font-size: 18px; line-height: 1; color: #999;
                background: transparent; border: none; padding: 0; margin: 0;
                cursor: pointer; user-select: none;
                touch-action: manipulation;
                -webkit-tap-highlight-color: transparent;
                outline: none;
            `;
            closeBtn.addEventListener('mouseenter', () => {
                closeBtn.style.background = '#f2f2f2';
                closeBtn.style.color = '#333';
            });
            closeBtn.addEventListener('mouseleave', () => {
                closeBtn.style.background = 'transparent';
                closeBtn.style.color = '#999';
            });

            const doClose = () => {
                if (closed) return;
                closed = true;
                cleanup();
                resolve(null);
            };

            closeBtn.addEventListener('pointerdown', e => {
                if (e.pointerType === 'mouse' && e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                doClose();
            });
            if (!window.PointerEvent) {
                closeBtn.addEventListener('mousedown', e => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    doClose();
                });
            }
            closeBtn.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    doClose();
                }
            });

            titleRow.appendChild(title);
            titleRow.appendChild(closeBtn);

            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = '关键词（多个用逗号分隔，如：蓝牙耳机,降噪,续航）';
            input.style.cssText = `
                width: 100%; box-sizing: border-box; padding: 10px 12px;
                border: 2px solid #ddd; border-radius: 8px; font-size: 14px;
                outline: none; transition: border-color .15s; letter-spacing: .3px;
            `;
            input.addEventListener('focus', () => {
                input.style.borderColor = '#ff9900';
                if (!/[,，]\s*$/.test(input.value)) input.value = '';
            });
            input.addEventListener('blur', () => input.style.borderColor = '#ddd');

            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex; justify-content:flex-end; gap:10px; margin-top:14px;';

            const searchBtn = document.createElement('button');
            searchBtn.textContent = '搜索';
            searchBtn.style.cssText = `
                padding: 8px 22px; border-radius: 8px; border: none;
                background: #ff9900; color: #111; font-weight: bold;
                cursor: pointer; font-size: 13px;
            `;

            btnRow.appendChild(searchBtn);

            const resultBox = document.createElement('div');
            resultBox.style.cssText = `
                display: none; flex-direction: column; gap: 6px;
                margin-top: 14px; padding-top: 12px;
                border-top: 1px solid #eee;
                max-height: 320px; overflow-y: auto;
            `;

            const resultTitle = document.createElement('div');
            resultTitle.textContent = '搜索结果';
            resultTitle.style.cssText =
                'font-size: 12px; color: #888; margin-bottom: 2px;';
            resultBox.appendChild(resultTitle);

            const hint = document.createElement('div');
            hint.textContent = '回车搜索 · Esc 关闭';
            hint.style.cssText = 'font-size: 11px; color:#aaa; margin-top: 10px; text-align:center;';

            function cleanup() {
                document.removeEventListener('keydown', onKey, true);
                overlay.remove();
            }
            function onKey(e) {
                if (e.key === 'Escape') { e.stopPropagation(); doClose(); }
                if (e.key === 'Enter') { e.stopPropagation(); doSearch(); }
            }

            function parseKeywords(raw) {
                return raw.split(/[,，;；]+/).map(s => s.trim()).filter(Boolean);
            }

            function renderResults(results, keywords) {
                while (resultBox.childNodes.length > 1) {
                    resultBox.removeChild(resultBox.lastChild);
                }

                resultTitle.textContent = `${keywords.join('、')} 的搜索结果：`;

                const hitResults = results.filter(r => r.found);

                if (!hitResults.length) {
                    const empty = document.createElement('div');
                    empty.style.cssText = `
                        padding: 14px 12px; border-radius: 6px;
                        background: #fdecec; color: #a03030;
                        font-size: 13px; text-align: center;
                        line-height: 1.6;
                    `;
                    empty.textContent = `❌ 所有区域均未命中「${keywords.join('、')}」`;
                    resultBox.appendChild(empty);
                    resultBox.style.display = 'flex';
                    return;
                }

                hitResults.forEach(r => {
                    const row = document.createElement('div');
                    row.style.cssText = `
                        display: flex; align-items: center; gap: 8px;
                        padding: 7px 10px; border-radius: 6px;
                        font-size: 13px; line-height: 1.4;
                        white-space: normal; word-break: break-word;
                        background: #eaf7ea; color: #1a5c1a;
                        cursor: pointer;
                    `;
                    row.title = '点击滚动到该区域';
                    row.addEventListener('mouseenter', () => row.style.background = '#d5eed5');
                    row.addEventListener('mouseleave', () => row.style.background = '#eaf7ea');
                    row.addEventListener('click', () => {
                        if (r.el) {
                            doClose();
                            setTimeout(() => scrollAndHighlight(r.el), 100);
                        }
                    });

                    const status = document.createElement('span');
                    status.textContent = '✅';
                    status.style.flexShrink = '0';
                    row.appendChild(status);

                    const name = document.createElement('span');
                    name.textContent = r.name + '：';
                    name.style.fontWeight = 'bold';
                    name.style.flexShrink = '0';
                    row.appendChild(name);

                    const hits = document.createElement('span');
                    hits.textContent = '命中 ' + r.hits.join('、');
                    row.appendChild(hits);

                    resultBox.appendChild(row);
                });

                const summary = document.createElement('div');
                summary.style.cssText =
                    'font-size: 11px; color: #888; margin-top: 6px; text-align: right;';
                summary.textContent = `命中 ${hitResults.length}/${results.length} 个区域`;
                resultBox.appendChild(summary);

                resultBox.style.display = 'flex';
            }

            function doSearch() {
                const raw = input.value.trim();
                if (!raw) { input.focus(); return; }
                const keywords = parseKeywords(raw);
                if (!keywords.length) { input.focus(); return; }

                let results;
                try {
                    results = searchListing(keywords);
                } catch (e) {
                    showToast('❌ 搜索出错：' + e.message);
                    return;
                }
                renderResults(results, keywords);
            }

            searchBtn.addEventListener('click', doSearch);
            document.addEventListener('keydown', onKey, true);

            panel.appendChild(titleRow);
            panel.appendChild(input);
            panel.appendChild(btnRow);
            panel.appendChild(resultBox);
            panel.appendChild(hint);
            overlay.appendChild(panel);
            document.body.appendChild(overlay);
            setTimeout(() => input.focus(), 30);
        });
    }

    // ---------- 查询主流程 ----------
    async function doQuery(targetAsin, maxPages, mode) {
        const label = mode === 'ad' ? '广告位' : '自然位';
        const result = await findRank(targetAsin, maxPages, mode);
        if (!result) {
            showToast(`⚠️ 前 ${maxPages} 页中未找到该 ASIN 的${label}。`);
            return;
        }
        const { page, position, card } = result;
        const curPage = getCurrentPage();

        if (curPage !== page) {
            sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
                asin: targetAsin,
                page,
                position,
                mode
            }));
            const url = new URL(location.href);
            if (page === 1) {
                url.searchParams.delete('page');
            } else {
                url.searchParams.set('page', page);
            }
            console.log(`✅ 找到${label} ${page}-${position}，正在跳转...`);
            location.href = url.toString();
        } else {
            highlightCard(card, page, position, mode);
            const info = card ? extractCardInfo(card) : { title: '', price: '' };
            showToast(buildResultToast(page, position, targetAsin, info, mode));
        }
    }

    // ---------- 悬浮按钮（可拖动，带位置边界检查） ----------
    function setupFloatingButton(label, onClick) {
        const old = document.getElementById(FLOAT_BTN_ID);
        if (old) old.remove();

        const btn = document.createElement('button');
        btn.id = FLOAT_BTN_ID;
        btn.textContent = label;
        btn.title = '点击查询 · 可拖动';
        btn.style.cssText = `
            position: fixed; bottom: 90px; right: 20px; z-index: 2147483646;
            padding: 8px 14px; background: rgba(255,153,0,0.95); color: #111;
            border: none; border-radius: 18px; font-weight: bold;
            cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.25);
            font-family: -apple-system, sans-serif; font-size: 13px;
            user-select: none; touch-action: none;
            display: block !important;
            visibility: visible !important;
            opacity: 1 !important;
            pointer-events: auto !important;
        `;

        try {
            const pos = JSON.parse(GM_getValue(BTN_POS_KEY, 'null'));
            if (pos && pos.left && pos.top) {
                const leftPx = parseFloat(pos.left);
                const topPx = parseFloat(pos.top);
                const vw = window.innerWidth;
                const vh = window.innerHeight;
                const valid = Number.isFinite(leftPx) && Number.isFinite(topPx) &&
                    leftPx > -40 && leftPx < vw - 40 &&
                    topPx > -40 && topPx < vh - 40;
                if (valid) {
                    btn.style.left = leftPx + 'px';
                    btn.style.top = topPx + 'px';
                    btn.style.right = 'auto';
                    btn.style.bottom = 'auto';
                } else {
                    console.warn('[Amazon查自然位] 记忆位置越界，已重置为默认位置:', pos);
                    GM_setValue(BTN_POS_KEY, 'null');
                }
            }
        } catch (e) {
            console.warn('[Amazon查自然位] 解析位置记忆失败:', e);
        }

        let dragging = false, moved = false, startX = 0, startY = 0;
        let rafId = null, lastEvent = null;

        const onDown = (cx, cy) => { dragging = true; moved = false; startX = cx; startY = cy; };
        const onMove = (cx, cy) => {
            if (!dragging) return;
            const dx = cx - startX, dy = cy - startY;
            if (!moved && Math.abs(dx) + Math.abs(dy) < 6) return;
            moved = true;
            lastEvent = { cx, cy };
            if (rafId) return;
            rafId = requestAnimationFrame(() => {
                rafId = null;
                if (!lastEvent) return;
                const { cx, cy } = lastEvent;
                const w = btn.offsetWidth, h = btn.offsetHeight;
                const left = Math.max(0, Math.min(window.innerWidth - w, cx - w / 2));
                const top = Math.max(0, Math.min(window.innerHeight - h, cy - h / 2));
                btn.style.right = 'auto'; btn.style.bottom = 'auto';
                btn.style.left = left + 'px'; btn.style.top = top + 'px';
            });
        };
        const onUp = () => {
            if (!dragging) return;
            dragging = false;
            if (moved) GM_setValue(BTN_POS_KEY, JSON.stringify({ left: btn.style.left, top: btn.style.top }));
        };

        btn.addEventListener('mousedown', e => { if (e.button === 0) { onDown(e.clientX, e.clientY); e.preventDefault(); } });
        btn.addEventListener('touchstart', e => { onDown(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
        document.addEventListener('mousemove', e => onMove(e.clientX, e.clientY), { passive: true });
        document.addEventListener('touchmove', e => onMove(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
        document.addEventListener('mouseup', onUp);
        document.addEventListener('touchend', onUp);

        let busy = false;
        btn.addEventListener('click', e => {
            if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; return; }
            if (busy) return;
            onClick(() => busy, v => busy = v, btn);
        });

        document.body.appendChild(btn);
        console.log('[Amazon查自然位] 悬浮按钮已创建:', {
            left: btn.style.left || 'auto',
            top: btn.style.top || 'auto',
            right: btn.style.right || 'auto',
            bottom: btn.style.bottom || 'auto',
        });
        return btn;
    }

    // ---------- 按当前页面类型挂载按钮 ----------
    function mountForPage() {
        const pageType = detectPageType();
        console.log('[Amazon查自然位] 页面检测结果:', pageType, '| 站点:', getSiteKey(), '| URL:', location.href);

        if (pageType === 'search') {
            ensureMaxPages().catch(() => {});
            checkPendingJump();

            setupFloatingButton('🔍 查自然位/广告位', async (setBusy, setBusyVal, btn) => {
                setBusyVal(true);
                btn.disabled = true;
                const originalText = btn.textContent;
                btn.textContent = '查询中…';
                try {
                    const loaded = await waitForCards(8000);
                    if (!loaded) { showToast('⚠️ 搜索结果尚未加载，请稍候再试。'); return; }
                    const res = await askAsin();
                    if (!res) return;
                    await doQuery(res.asin, res.maxPages, res.mode);
                } catch (e) {
                    console.error(e);
                    showToast('❌ 查询出错：' + e.message);
                } finally {
                    setBusyVal(false);
                    btn.disabled = false;
                    btn.textContent = originalText;
                }
            });
        } else if (pageType === 'listing') {
            setupFloatingButton('🔍 查关键词', async (setBusy, setBusyVal, btn) => {
                setBusyVal(true);
                btn.disabled = true;
                try {
                    await openKeywordPanel();
                } catch (e) {
                    console.error(e);
                    showToast('❌ 搜索出错：' + e.message);
                } finally {
                    setBusyVal(false);
                    btn.disabled = false;
                }
            });
        } else {
            const old = document.getElementById(FLOAT_BTN_ID);
            if (old) old.remove();
        }
    }

    // ---------- SPA 导航监听 ----------
    let lastUrl = location.href;
    function onUrlMaybeChanged() {
        if (location.href === lastUrl) return;
        lastUrl = location.href;
        console.log('[Amazon查自然位] URL 变化:', lastUrl);
        cachedMaxPages = 0;
        setTimeout(mountForPage, 300);
    }

    try {
        const _pushState = history.pushState;
        history.pushState = function () {
            const ret = _pushState.apply(this, arguments);
            onUrlMaybeChanged();
            return ret;
        };
        const _replaceState = history.replaceState;
        history.replaceState = function () {
            const ret = _replaceState.apply(this, arguments);
            onUrlMaybeChanged();
            return ret;
        };
    } catch (e) {
        console.warn('[Amazon查自然位] 无法拦截 history:', e);
    }
    window.addEventListener('popstate', onUrlMaybeChanged);
    window.addEventListener('hashchange', onUrlMaybeChanged);

    // ---------- 入口 ----------
    function main() {
        if (!document.body) {
            setTimeout(main, 100);
            return;
        }
        migrateLegacyHistory();
        mountForPage();
    }

    main();
})();
