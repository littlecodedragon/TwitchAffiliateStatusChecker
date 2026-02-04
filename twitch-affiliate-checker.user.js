// ==UserScript==
// @name         Twitch Affiliate Status Checker
// @namespace    https://github.com/littlecodedragon//TwitchAffiliateStatusChecker
// @version      1.2
// @description  Shows affiliate/partner status on Twitch directory and browse pages
// @author       You
// @match        https://www.twitch.tv/directory/*
// @match        https://www.twitch.tv/search*
// @match        https://www.twitch.tv/*
// @grant        GM_xmlhttpRequest
// @connect      api.twitch.tv
// @connect      localhost
// @run-at       document-idle
// @homepageURL  https://github.com/littlecodedragon//TwitchAffiliateStatusChecker
// @supportURL   https://github.com/littlecodedragon//TwitchAffiliateStatusChecker/issues
// @updateURL    https://raw.githubusercontent.com/littlecodedragon//TwitchAffiliateStatusChecker/main/twitch-affiliate-checker.user.js
// @downloadURL  https://raw.githubusercontent.com/littlecodedragon//TwitchAffiliateStatusChecker/main/twitch-affiliate-checker.user.js
//
// Replace <your-username> and the branch/path above with the correct GitHub user and branch.
// Example raw URL: https://raw.githubusercontent.com/beat/affiliate/main/twitch-affiliate-checker.user.js
// ==/UserScript==

// Early bootstrap log to verify the script actually runs (visible even before DOM ready)
console.warn('TAC: bootstrap loaded', new Date().toISOString());

(function() {
    'use strict';

    // You need to set your Twitch Client ID. Do NOT embed client_secret here.
    // Recommended: run the token server (see README) and let the userscript fetch a short-lived App Access Token from http://localhost:3000/twitch-token
    const CLIENT_ID = 'cmu3g5ukloxsupzgts9kj4sv98a8m8';
    let OAUTH_TOKEN = ''; // will be fetched from local token server or set manually
    const LOCAL_TOKEN_URL = 'http://localhost:4000/twitch-token';

    // Track which channel pages already have inline labels
    const processedPages = new Set();
    const channelCache = new Map();
    const errorCache = new Map(); // short-lived cache for failures to avoid request thrash
    const pendingLookups = new Map(); // username -> [resolvers]
    const pendingQueue = [];
    let batchTimer = null;
    let batchInFlight = false;
    const pageObservers = new Map();
    let invalidToken = false; // set to true when API returns 401 to prevent repeated requests
    const DEBUG = false; // set false for release; true enables debug logs
    // If you want extra selector-specific debugging output set this to true
    const SELECTOR_DEBUG = false;

    // Lightweight debug helper (warn so it stays visible even with default filters)
    function dbg(...args) {
        if (SELECTOR_DEBUG) {
            try { console.warn('TAC:', ...args); } catch (e) {}
        }
    }
    
    let lastTokenAttempt = 0;
    const TOKEN_RETRY_MS = 10000;
    let rateLimitUntil = 0;
    const RATE_LIMIT_BACKOFF_MS = 60 * 1000; // 1 minute backoff on 429
    const BATCH_MAX = 50; // Twitch Helix /users supports up to 100 logins; keep below to avoid long URLs
    const BATCH_DELAY_MS = 500; // debounce to batch multiple usernames
    const ERROR_TTL_MS = 20000; // cache errors briefly to prevent repeated retries

    // Track last location to detect SPA navigation changes
    let lastHref = location.href;

    // Banner UI removed: users prefer inline per-stream indicators only

    // Try to obtain an access token from a local server endpoint if available
    function ensureAccessToken() {
        return new Promise((resolve) => {
            if (OAUTH_TOKEN) return resolve(OAUTH_TOKEN);
            // Use GM_xmlhttpRequest to call localhost (allowed via @connect)
            GM_xmlhttpRequest({
                method: 'GET',
                url: LOCAL_TOKEN_URL,
                onload: function(resp) {
                    try {
                        const body = JSON.parse(resp.responseText);
                            if (body && body.access_token) {
                            OAUTH_TOKEN = body.access_token;
                            console.log('Twitch Affiliate: obtained access token from local server');
                            invalidToken = false;
                            // reset caches so we re-query with the new token
                                channelCache.clear();
                                errorCache.clear();
                                processedPages.clear();
                                // remove any old badges that were created before we had a token
                                removeAllBadges();
                                // re-run processing (cards + channel page)
                                setTimeout(() => { processAllCards(); processChannelPage(); }, 200);
                                resolve(OAUTH_TOKEN);
                        } else {
                                console.warn('Twitch Affiliate: local token endpoint returned no access_token');
                                resolve(null);
                        }
                    } catch (e) {
                            console.error('Twitch Affiliate: failed to parse local token response', e);
                            resolve(null);
                    }
                },
                onerror: function(err) {
                        // likely server not running
                        resolve(null);
                }
            });
        });
    }

    function normalizeUsername(name) {
        if (!name) return '';
        return String(name).trim().replace(/^@/, '').toLowerCase();
    }

    function getCachedError(login) {
        const cached = errorCache.get(login);
        if (!cached) return null;
        if (cached.expiresAt && cached.expiresAt < Date.now()) {
            errorCache.delete(login);
            return null;
        }
        return cached.result || null;
    }

    function setCachedError(login, result, ttlMs) {
        errorCache.set(login, { result, expiresAt: Date.now() + ttlMs });
    }

    function resolvePending(login, result, cacheSuccess, errorTtlMs) {
        const resolvers = pendingLookups.get(login) || [];
        pendingLookups.delete(login);
        if (cacheSuccess) {
            channelCache.set(login, result);
            errorCache.delete(login);
        } else if (errorTtlMs) {
            setCachedError(login, result, errorTtlMs);
        }
        for (const r of resolvers) {
            try { r(result); } catch (e) {}
        }
    }

    function scheduleBatch(delayMs = BATCH_DELAY_MS) {
        if (batchTimer || batchInFlight) return;
        batchTimer = setTimeout(() => {
            batchTimer = null;
            runBatch();
        }, delayMs);
    }

    async function runBatch() {
        if (batchInFlight) return;
        if (pendingQueue.length === 0) return;

        const now = Date.now();
        if (now < rateLimitUntil) {
            scheduleBatch(Math.max(200, rateLimitUntil - now));
            return;
        }

        batchInFlight = true;
        const batch = pendingQueue.splice(0, BATCH_MAX);

        const finish = () => {
            batchInFlight = false;
            if (pendingQueue.length > 0) {
                scheduleBatch(BATCH_DELAY_MS);
            }
        };

        // try to ensure we have a token (try local server, but retry periodically)
        if (!OAUTH_TOKEN && (now - lastTokenAttempt > TOKEN_RETRY_MS)) {
            lastTokenAttempt = now;
            await ensureAccessToken();
        }

        const resolveBatchError = (result, ttlMs) => {
            for (const login of batch) {
                resolvePending(login, result, false, ttlMs || ERROR_TTL_MS);
            }
            finish();
        };

        const sendRequest = (retry) => {
            const qs = batch.map((login) => `login=${encodeURIComponent(login)}`).join('&');
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://api.twitch.tv/helix/users?${qs}`,
                headers: {
                    'Client-ID': CLIENT_ID,
                    'Authorization': `Bearer ${OAUTH_TOKEN}`
                },
                onload: async function(response) {
                    const status = response.status;
                    if (status === 200) {
                        try {
                            const data = JSON.parse(response.responseText);
                            const byLogin = new Map();
                            if (data && data.data && Array.isArray(data.data)) {
                                for (const u of data.data) {
                                    const login = normalizeUsername(u.login || u.display_name || '');
                                    if (login) {
                                        byLogin.set(login, u.broadcaster_type || '');
                                    }
                                }
                            }
                            for (const login of batch) {
                                const broadcasterType = byLogin.has(login) ? byLogin.get(login) : '';
                                const result = { broadcasterType, error: null };
                                resolvePending(login, result, true);
                            }
                            return finish();
                        } catch (e) {
                            console.error('Error parsing Twitch API response for batch', e);
                            return resolveBatchError({ broadcasterType: '', error: 'parse_error' }, ERROR_TTL_MS);
                        }
                    }

                    // Handle 401 by attempting to refresh token once
                    if (status === 401 && !retry) {
                        console.warn('Twitch API 401 for batch - attempting token refresh');
                        await ensureAccessToken();
                        if (OAUTH_TOKEN) {
                            return sendRequest(true);
                        }
                    }

                    // Handle 429 rate limiting by backing off
                    if (status === 429) {
                        console.warn('Twitch API 429 (rate limited). Backing off for', RATE_LIMIT_BACKOFF_MS, 'ms');
                        rateLimitUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
                        return resolveBatchError({ broadcasterType: '', error: 'rate_limited' }, RATE_LIMIT_BACKOFF_MS);
                    }

                    const err = `HTTP ${status}`;
                    console.error('Twitch API error for batch', err, response.responseText);
                    if (status === 401) {
                        invalidToken = true;
                        console.warn('Twitch Affiliate: invalid or missing OAuth token');
                    }
                    return resolveBatchError({ broadcasterType: '', error: err }, ERROR_TTL_MS);
                },
                onerror: function(error) {
                    console.error('API request failed for batch', error);
                    return resolveBatchError({ broadcasterType: '', error: 'network_error' }, ERROR_TTL_MS);
                }
            });
        };

        // If we still don't have a token, attempt the request (Twitch will respond accordingly)
        sendRequest(false);
    }

    // Get broadcaster info from Twitch API (returns { broadcasterType, error })
    async function getBroadcasterInfo(username) {
        const login = normalizeUsername(username);
        if (!login) return { broadcasterType: '', error: 'invalid_username' };

        const cachedErr = getCachedError(login);
        if (cachedErr) return cachedErr;

        // normalize cached values: if cache stored a raw string, convert to object
        if (channelCache.has(login)) {
            const cached = channelCache.get(login);
            if (cached && typeof cached === 'string') {
                return { broadcasterType: cached, error: null };
            }
            return cached;
        }

        return new Promise((resolve) => {
            if (pendingLookups.has(login)) {
                pendingLookups.get(login).push(resolve);
                return;
            }
            pendingLookups.set(login, [resolve]);
            pendingQueue.push(login);
            scheduleBatch();
        });
    }

    // Extract username from channel card by scanning anchors for a simple /username href
    function extractUsername(element) {
        // try a variety of anchor patterns: absolute, site-root, and embedded links
        const anchors = element.querySelectorAll('a[href^="/"], a[href*="twitch.tv/"]');
        for (const a of anchors) {
            let href = a.getAttribute('href');
            if (!href) continue;
            // Normalize full URLs to path part
            let match = href.match(/^https?:\/\/(?:www\.)?twitch\.tv\/([^\/?#]+)/i);
            if (!match) {
                // Match /username optionally followed by ? or # or end
                match = href.match(/^\/([a-zA-Z0-9_]+)(?:$|[?#\/])/);
            }
            if (match && match[1]) {
                const name = match[1];
                const skip = ['directory', 'search', 'videos', 'collections', 'subscriptions', 'settings'];
                if (!skip.includes(name.toLowerCase())) {
                    return name;
                }
            }
        }

        // Some Twitch markup puts identifying info in aria-labels or image alts — try those as a fallback.
        try {
            // aria-labels sometimes contain the channel display name; pick a trailing username-like token
            const ariaEls = element.querySelectorAll('[aria-label]');
            for (const el of ariaEls) {
                const al = (el.getAttribute('aria-label') || '').trim();
                const m = al.match(/([a-zA-Z0-9_]{3,})$/);
                if (m && m[1]) return m[1];
            }

            // image alt attributes sometimes have the username/display name
            const imgs = element.querySelectorAll('img[alt]');
            for (const img of imgs) {
                const alt = (img.getAttribute('alt') || '').trim();
                const m = alt.match(/^([a-zA-Z0-9_]{3,})/);
                if (m && m[1]) return m[1];
            }
        } catch (e) {
            /* ignore DOM inspection errors */
        }
        if (SELECTOR_DEBUG) {
            try {
                const hrefs = Array.from(anchors).slice(0,8).map(a => a.getAttribute('href')).join(', ');
                console.warn('TAC: extractUsername could not find username for element ->', elementSummary(element), 'anchors:', hrefs);
            } catch (e) { /* ignore */ }
        }
        return null;
    }

    // Create status badge (smaller, non-intrusive)
    function createBadge(broadcasterType, error, variant = 'card') {
        const badge = document.createElement('div');
        badge.className = 'tac-affiliate-badge';
        const base = [
            'position: absolute',
            'bottom: 6px',
            'left: 6px',
            'padding: 3px 8px',
            'border-radius: 999px',
            'font-size: 12px',
            'font-weight: 700',
            'z-index: 99999',
            'white-space: nowrap',
            'text-shadow: 0 1px 1px rgba(0,0,0,0.6)',
            'pointer-events: none',
            'box-shadow: 0 2px 6px rgba(0,0,0,0.35)'
        ];
        if (variant === 'side') {
            base[1] = 'bottom: 2px';
            base[2] = 'left: 2px';
            base[3] = 'padding: 2px 6px';
            base[4] = 'border-radius: 10px';
            base[5] = 'font-size: 11px';
        }
        badge.style.cssText = base.join(';');

        if (error) {
            badge.textContent = 'API ERR';
            badge.style.backgroundColor = 'rgba(200,60,60,0.95)';
            badge.style.color = 'white';
        } else if (broadcasterType === 'partner') {
            badge.textContent = 'PARTNER';
            badge.style.backgroundColor = 'rgba(145, 70, 255, 0.95)';
            badge.style.color = 'white';
        } else if (broadcasterType === 'affiliate') {
            badge.textContent = 'AFFILIATE';
            badge.style.backgroundColor = 'rgba(0, 170, 160, 0.95)';
            badge.style.color = 'white';
        } else {
            badge.textContent = 'NOT AFFILIATE';
            badge.style.backgroundColor = 'rgba(80, 80, 80, 0.85)';
            badge.style.color = 'white';
        }

        return badge;
    }

    // Adjust badge placement if the preview container has an avatar or other bottom-left element
    function adjustBadgePlacement(previewContainer, badge) {
        try {
            if (!previewContainer || !badge) return;
            // common avatar/icon selectors used in Twitch markup
            const avatarSelectors = [
                'img[class*="avatar"]',
                'img[class*="profile"]',
                '[data-a-target*="preview-card-avatar"]',
                '[data-a-target*="channel-preview-profile-image"]',
                'img[src*="avatar"]',
                'svg[class*="avatar"]'
            ];
            let found = null;
            for (const s of avatarSelectors) {
                const el = previewContainer.querySelector(s);
                if (el) { found = el; break; }
            }
            if (found) {
                // move badge to bottom-right to avoid avatar overlap
                badge.style.left = 'auto';
                badge.style.right = '6px';
            } else {
                // ensure default
                badge.style.left = badge.style.left || '6px';
                badge.style.right = badge.style.right || 'auto';
            }
            // constrain size so it doesn't overflow or cover large areas
            badge.style.maxWidth = '90%';
            badge.style.overflow = 'hidden';
            badge.style.textOverflow = 'ellipsis';
            badge.style.display = 'inline-block';
        } catch (e) {
            /* ignore */
        }
    }

    // Choose the best parent element to attach a fallback badge to (prefer the preview link or image wrapper)
    function findBestBadgeParent(previewContainer) {
        if (!previewContainer) return null;
        try {
            // Prefer the preview link if present
            const link = previewContainer.querySelector('a[data-a-target="preview-card-image-link"]') || previewContainer.closest('a[data-a-target="preview-card-image-link"]');
            if (link) return link;

            // Prefer an image's closest clickable ancestor
            const img = previewContainer.querySelector('img');
            if (img) {
                const imgParentLink = img.closest('a');
                if (imgParentLink) return imgParentLink;
                return img.parentElement || previewContainer;
            }

            // Fallback to figure/picture wrappers
            const fig = previewContainer.querySelector('figure, picture');
            if (fig) return fig;

            // Fallback to the preview container itself
            return previewContainer;
        } catch (e) {
            return previewContainer;
        }
    }

    // Remove all existing badges so they can be refreshed (used after obtaining new token)
    function removeAllBadges() {
        try {
            const existingBadges = document.querySelectorAll('.tac-affiliate-badge');
            existingBadges.forEach(el => {
                if (el && el.parentNode) el.parentNode.removeChild(el);
            });
            const inlineLabels = document.querySelectorAll('.tac-inline-label');
            inlineLabels.forEach(el => {
                if (el && el.parentNode) el.parentNode.removeChild(el);
            });
        } catch (e) {
            /* ignore DOM errors */
        }
    }

    // Create a small inline label to append to overlay text (uses less space)
    function createInlineLabel(broadcasterType, error, variant = 'normal') {
        const span = document.createElement('span');
        span.className = 'tac-inline-label';
        const base = [
            'margin-left:6px',
            'padding:2px 6px',
            'border-radius:999px',
            'font-size:12px',
            'font-weight:700',
            'vertical-align:middle',
            'color:#fff',
            'pointer-events:none',
            'box-shadow:0 1px 3px rgba(0,0,0,0.35)'
        ];
        if (variant === 'compact') {
            base[1] = 'padding:1px 5px';
            base[3] = 'font-size:11px';
            base.push('line-height:1.2');
        }
        span.style.cssText = base.join(';');

        if (error) {
            span.textContent = '(API ERR)';
            span.style.backgroundColor = 'rgba(200,60,60,0.95)';
        } else if (broadcasterType === 'partner') {
            span.textContent = '(PARTNER)';
            span.style.backgroundColor = 'rgba(145,70,255,0.95)';
        } else if (broadcasterType === 'affiliate') {
            span.textContent = '(AFFILIATE)';
            span.style.backgroundColor = 'rgba(0,170,160,0.95)';
        } else {
            span.textContent = '(NOT AFFILIATE)';
            span.style.backgroundColor = 'rgba(80,80,80,0.85)';
        }

        return span;
    }

    // Find a suitable text overlay element inside the preview to append inline labels
    function findInlineTextElement(container) {
        if (!container) return null;
        // prefer paragraph overlays often used for viewer counts / titles; also consider divs
        const candidates = container.querySelectorAll('p, h3, span, div');
        const keywords = ['live', 'viewer', 'viewers', 'may contain', 'stream uptime', 'uptime'];
        for (const el of candidates) {
            if (!el) continue;
            const txt = (el.textContent || '').trim();
            if (!txt) continue;
            // Skip elements that are likely live/mature badges or contain icons
            try {
                // skip if ancestor has live/mature data-a-target markers
                const badAncestor = el.closest('[data-a-target*="live"], [data-a-target*="mature"], [data-a-target*="preview-card-live-label"]');
                if (badAncestor) continue;
                // skip if contains svg or img (icon badges)
                if (el.querySelector('svg, img')) continue;
                // skip content advisories like "may contain"
                const low = txt.toLowerCase();
                if (low.includes('may contain') || low.includes('mature')) continue;
                // skip single-word uppercase labels like "LIVE"
                if (txt.length <= 6 && txt === txt.toUpperCase()) continue;
            } catch (e) {
                // ignore DOM inspection errors
            }
            // prefer candidates that include common overlay keywords
            const ltxt = txt.toLowerCase();
            for (const k of keywords) {
                if (ltxt.includes(k)) return el;
            }
            // otherwise return first reasonable candidate
            return el;
        }
        return null;
    }

    // Find the best text element inside a sidebar/list row to attach a compact label
    function findSideNavTextElement(container) {
        if (!container) return null;
        const selectors = [
            '[data-a-target="side-nav-card-title"]',
            '[data-a-target*="side-nav-title"]',
            '.side-nav-card__title',
            '.side-nav-card__title p',
            '.Layout-sc-1xcs6mc-0 span',
            'p, span'
        ];
        for (const sel of selectors) {
            const el = container.querySelector(sel);
            if (el && (el.textContent || '').trim().length > 0) return el;
        }
        return null;
    }

    // Helper to produce a short diagnostic summary for an element
    function elementSummary(el) {
        if (!el) return 'null';
        try {
            const tag = el.tagName;
            const id = el.id ? `#${el.id}` : '';
            const cls = el.className ? `.${String(el.className).split(' ').slice(0,3).join('.')}` : '';
            const dataTarget = el.getAttribute && el.getAttribute('data-a-target') ? `[data-a-target="${el.getAttribute('data-a-target')}"]` : '';
            const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0,80);
            return `${tag}${id}${cls}${dataTarget} text="${txt}"`;
        } catch (e) {
            return String(el);
        }
    }

    // Simple logger for sidebar diagnostics
    function logSideNav(reason, row, extra = '') {
        if (!SELECTOR_DEBUG) return;
        try {
            console.warn('TAC side-nav:', reason, '-', elementSummary(row), extra);
        } catch (e) { /* ignore */ }
    }

    // Process channel card
    async function processChannelCard(card) {
        try {
            if (!card) return;
            const username = extractUsername(card);
            if (!username) {
                if (SELECTOR_DEBUG) console.log('TAC: no username extracted for card ->', elementSummary(card));
                return;
            }

            // Prefer the preview image/link container so badges don't overlap title/game overlays
            let previewContainer = card.querySelector('a[data-a-target="preview-card-image-link"]') ||
                                   card.querySelector('[class*="preview"]') || 
                                   card.querySelector('article') ||
                                   card.querySelector('div[class*="card"]') ||
                                   card;

            if (DEBUG) console.log('TAC: processing', username, 'previewContainer ->', elementSummary(previewContainer));

            if (!previewContainer) return;

            // Avoid duplicate badges
            if (previewContainer.querySelector('.tac-affiliate-badge')) {
                return;
            }

            // Make sure container has position relative
            const style = window.getComputedStyle(previewContainer);
            if (style.position === 'static') {
                previewContainer.style.position = 'relative';
            }

            const result = await getBroadcasterInfo(username);
            const broadcasterType = result && result.broadcasterType;
            const error = result && result.error;
            const badge = createBadge(broadcasterType, error);

            // Try to append an inline label to any overlay text first (less intrusive)
            const inlineTarget = findInlineTextElement(previewContainer);
            if (DEBUG) console.log('TAC: inlineTarget ->', elementSummary(inlineTarget));
            if (inlineTarget) {
                if (!inlineTarget.querySelector('.tac-inline-label')) {
                    const label = createInlineLabel(broadcasterType, error);
                    if (DEBUG) console.log('TAC: appending inline label to', elementSummary(inlineTarget));
                    inlineTarget.appendChild(label);
                }
            } else {
                // If overlay text isn't present yet (dynamic), set a one-time observer on the previewContainer
                const OBS_ATTR = 'data-tac-wait-inline';
                if (!previewContainer.getAttribute(OBS_ATTR)) {
                    previewContainer.setAttribute(OBS_ATTR, '1');
                    try {
                        const mo = new MutationObserver((mutations, obs) => {
                            const t = findInlineTextElement(previewContainer);
                            if (t) {
                                if (!t.querySelector('.tac-inline-label')) {
                                    const label = createInlineLabel(broadcasterType, error);
                                    if (DEBUG) console.log('TAC: dynamic overlay appeared, appending inline label to', elementSummary(t));
                                    t.appendChild(label);
                                }
                                obs.disconnect();
                                previewContainer.removeAttribute(OBS_ATTR);
                            }
                        });
                        mo.observe(previewContainer, { childList: true, subtree: true, characterData: true });
                        // fallback: if nothing appears after 3s, stop waiting (no badge fallback)
                        setTimeout(() => {
                            try {
                                if (previewContainer.getAttribute(OBS_ATTR)) {
                                    previewContainer.removeAttribute(OBS_ATTR);
                                    mo.disconnect();
                                    if (DEBUG) console.log('TAC: overlay not found in time; skipping fallback badge for', elementSummary(previewContainer));
                                }
                            } catch (e) { /* ignore */ }
                        }, 3000);
                    } catch (e) {
                        // if observer fails, just stop and rely on inline labels only
                        if (DEBUG) console.error('TAC: inline observer failed; skipping fallback badge', e);
                    }
                }
            }
        } catch (err) {
            console.error('processChannelCard error for', card, err);
        }
    }

    // Process side navigation or compact list rows
    async function processSideNavItem(row) {
        try {
            if (!row) return;
            const isSideNav = row.closest('nav#side-nav') || row.closest('[data-test-selector*="side-nav"]') || String(row.className || '').includes('side-nav');
            if (!isSideNav) return;
            logSideNav('start', row);

            const username = extractUsername(row);
            if (!username) {
                logSideNav('no-username', row);
                return;
            }

            const result = await getBroadcasterInfo(username);
            const broadcasterType = result && result.broadcasterType;
            const error = result && result.error;

            // Only badge on avatar (sidebar thumbnail); no inline labels
            const avatar = row.querySelector('.side-nav-card__avatar, .tw-avatar, img.tw-image-avatar, figure img, img');
            const badgeParent = avatar ? (avatar.closest('.side-nav-card__avatar') || avatar.parentElement) : null;
            if (badgeParent) {
                const badgeHost = badgeParent;
                const computed = window.getComputedStyle(badgeHost);
                if (computed.position === 'static') {
                    badgeHost.style.position = 'relative';
                }
                badgeHost.style.overflow = 'visible';
                if (!badgeHost.querySelector('.tac-affiliate-badge')) {
                    const badge = createBadge(broadcasterType, error, 'side');
                    adjustBadgePlacement(badgeHost, badge);
                    badgeHost.appendChild(badge);
                }
            }
        } catch (e) {
            console.error('processSideNavItem error', e);
        }
    }

    // Dedicated scan for sidebar cards (FFZ/7TV sometimes rerender them outside main selectors)
    function processSideNav() {
        try {
            const nav = document.querySelector('nav#side-nav');
            if (!nav) return;
            const rows = nav.querySelectorAll('.side-nav-card, a.side-nav-card__link');
            dbg('side-nav scan rows', rows.length);
            rows.forEach(r => processSideNavItem(r));
        } catch (e) {
            console.error('processSideNav scan error', e);
        }
    }

    // Process directory/browse cards by badging the avatar only
    function processDirectoryCards() {
        try {
            // Target avatar links/images on directory cards
            const avatarLinks = document.querySelectorAll(
                'a.preview-card-avatar, [data-test-selector=\"preview-card-avatar\"], .preview-card-avatar'
            );
            avatarLinks.forEach(link => {
                const card = link.closest('article') || link;
                processChannelCard(card);
            });
        } catch (e) {
            console.error('processDirectoryCards error', e);
        }
    }

    // Badge the main channel header avatar (for channel pages)
    async function processChannelHeaderAvatar() {
        try {
            const username = getPageUsername();
            if (!username) return;

            // Locate the channel header avatar image/container - try multiple selectors
            const avatarImg = document.querySelector(
                '.channel-root__player-container img.tw-image-avatar,\
                 header img.tw-image-avatar,\
                 [data-a-target="home-channel-header"] img.tw-image-avatar,\
                 .ScAvatar-sc-144b42z-0 img.tw-image-avatar,\
                 .tw-avatar img.tw-image-avatar,\
                 img.tw-image-avatar[alt="' + username + '"]'
            ) || document.querySelector('img.tw-image-avatar');

            if (!avatarImg) {
                if (DEBUG) console.log('TAC: no avatar image found for channel header');
                return;
            }

            const badgeHost = avatarImg.closest('.tw-avatar, .ScAvatar-sc-144b42z-0') || avatarImg.parentElement;
            if (!badgeHost) {
                if (DEBUG) console.log('TAC: no badge host found for avatar');
                return;
            }

            const result = await getBroadcasterInfo(username);
            const broadcasterType = result && result.broadcasterType;
            const error = result && result.error;

            const computed = window.getComputedStyle(badgeHost);
            if (computed.position === 'static') {
                badgeHost.style.position = 'relative';
            }
            badgeHost.style.overflow = 'visible';

            if (!badgeHost.querySelector('.tac-affiliate-badge')) {
                const badge = createBadge(broadcasterType, error, 'side');
                adjustBadgePlacement(badgeHost, badge);
                badgeHost.appendChild(badge);
            }
        } catch (e) {
            console.error('processChannelHeaderAvatar error', e);
        }
    }

    // Find and process all channel cards
    function processAllCards() {
        // Keep processing focused on sidebar avatars (always visible, even when collapsed)
        processSideNav();
        // Also badge the main channel header avatar when on a channel page
        processChannelHeaderAvatar();
        // Badge avatars on directory/browse cards
        processDirectoryCards();
    }

    // Get username from page path (first segment)
    function getPageUsername() {
        const parts = window.location.pathname.split('/').filter(Boolean);
        if (parts.length === 0) return null;
        // ignore known special paths
        const skip = ['directory', 'search', 'videos', 'collections', 'subscriptions', 'settings'];
        if (skip.includes(parts[0].toLowerCase())) return null;
        return parts[0];
    }

    // If on a channel page, append inline label to the channel title H1
    async function processChannelPage() {
        try {
            const username = getPageUsername();
            if (!username) return;
            // Check if already processing to avoid duplicates, but allow re-processing after content loads
            // Don't return early - check if label already exists instead

            // Try multiple selectors for the title element
            const titleSelector = 'h1.CoreText-sc-1txzju1-0, h1.tw-title, h1.ScTitleText-sc-d9mj2s-0';
            let titleEl = document.querySelector(titleSelector);
            
            // If title already has label, skip unless it was removed
            if (titleEl && titleEl.querySelector('.tac-inline-label')) {
                if (DEBUG) console.log('TAC: title already has label');
                return;
            }

            const doAppend = async (el) => {
                try {
                    const result = await getBroadcasterInfo(username);
                    const broadcasterType = result && result.broadcasterType;
                    const error = result && result.error;
                    if (!el.querySelector('.tac-inline-label')) {
                        const label = createInlineLabel(broadcasterType, error);
                        if (DEBUG) console.log('TAC: appending page label to', elementSummary(el));
                        el.appendChild(label);
                        // mark the title element so we know we've decorated it
                        try { el.setAttribute('data-tac-has-label', '1'); } catch (e) {}
                    }

                    // Ensure the label survives Twitch re-renders: watch the title's parent and re-append if replaced
                    if (!pageObservers.has(username)) {
                        const parent = el.parentElement || document.body;
                        try {
                            const mo = new MutationObserver((mutations) => {
                                const t = document.querySelector(titleSelector);
                                if (t && !t.querySelector('.tac-inline-label')) {
                                    // re-append label if missing
                                    if (DEBUG) console.log('TAC: re-appending page label after title re-render', elementSummary(t));
                                    doAppend(t);
                                }
                            });
                            mo.observe(parent, { childList: true, subtree: true });
                            pageObservers.set(username, mo);
                            // Keep observer active longer to handle late-loading content like tags
                            setTimeout(() => {
                                try {
                                    const ob = pageObservers.get(username);
                                    if (ob) ob.disconnect();
                                } catch (e) {}
                                pageObservers.delete(username);
                            }, 60000); // extended to 60s
                        } catch (e) {
                            // if observer fails, log but allow retry
                            if (DEBUG) console.error('TAC: page observer setup failed', e);
                        }
                    }
                } catch (e) {
                    console.error('processChannelPage append error', e);
                }
            };

            if (titleEl) {
                if (DEBUG) console.log('TAC: channel page title element ->', elementSummary(titleEl));
                await doAppend(titleEl);
                return;
            }

            // Title not present yet (dynamic). Watch for it once, then append. Timeout after 5s.
            const OBS_ATTR_PAGE = 'data-tac-wait-page';
            if (!document.documentElement.getAttribute(OBS_ATTR_PAGE)) {
                document.documentElement.setAttribute(OBS_ATTR_PAGE, '1');
                try {
                    const mo = new MutationObserver((mutations, obs) => {
                        const t = document.querySelector(titleSelector);
                        if (t) {
                            if (DEBUG) console.log('TAC: dynamic channel title found ->', elementSummary(t));
                            doAppend(t);
                            obs.disconnect();
                            document.documentElement.removeAttribute(OBS_ATTR_PAGE);
                        }
                    });
                    mo.observe(document.body, { childList: true, subtree: true });
                    setTimeout(() => {
                        try {
                            if (document.documentElement.getAttribute(OBS_ATTR_PAGE)) {
                                document.documentElement.removeAttribute(OBS_ATTR_PAGE);
                                mo.disconnect();
                            }
                        } catch (e) { /* ignore */ }
                    }, 5000);
                } catch (e) {
                    // fallback: log error
                    if (DEBUG) console.error('TAC: observer setup error', e);
                }
            }
        } catch (e) {
            console.error('processChannelPage error', e);
        }
    }

    // Set up mutation observer to watch for dynamically loaded content
    // Handle SPA navigation: clear per-page state and re-run processing
    async function onUrlChange() {
        try {
            // Clear per-page processed set so new pages get processed
            processedPages.clear();
            // try to refresh token if available locally
            await ensureAccessToken();
            // small delay to let Twitch render new content
            setTimeout(() => {
                processAllCards();
                processChannelPage();
            }, 350);
        } catch (e) {
            console.error('onUrlChange error', e);
        }
    }

    // Wrap history methods to detect pushState/replaceState SPA navigation
    (function() {
        const _wr = function(type) {
            const orig = history[type];
            return function() {
                const rv = orig.apply(this, arguments);
                window.dispatchEvent(new Event('locationchange'));
                return rv;
            };
        };
        history.pushState = _wr('pushState');
        history.replaceState = _wr('replaceState');
        window.addEventListener('popstate', () => window.dispatchEvent(new Event('locationchange')));
        window.addEventListener('locationchange', () => {
            if (location.href !== lastHref) {
                lastHref = location.href;
                onUrlChange();
            }
        });
        // Poll fallback in case a navigation method isn't captured
        setInterval(() => {
            if (location.href !== lastHref) {
                lastHref = location.href;
                onUrlChange();
            }
        }, 1000);
    })();

    const observer = new MutationObserver((mutations) => {
        processAllCards();
        processChannelPage(); // also reprocess channel page title when content changes
    });

    // Start observing
    async function init() {
        console.warn('TAC: userscript init (should appear once per load)');
        // Try to obtain token (if local server available) before first scan
        try {
            await ensureAccessToken();
        } catch (e) {
            /* ignore */
        }

        // small initial delay to allow Twitch to render dynamic cards
        setTimeout(() => {
            processAllCards();
            processChannelPage();
        }, 350);

        // Watch for new content
        const targetNode = document.body;
        observer.observe(targetNode, {
            childList: true,
            subtree: true
        });

        // Kick extra processing when user hovers sidebar rows (helps popouts/tooltips)
        let hoverTimer = null;
        document.addEventListener('mouseover', (e) => {
            const row = e.target && e.target.closest && e.target.closest('a.side-nav-card__link, .side-nav-card');
            if (!row) return;
            if (hoverTimer) clearTimeout(hoverTimer);
            hoverTimer = setTimeout(() => {
                processSideNavItem(row);
                processAllCards(); // catch hover popouts rendered in portals
            }, 40);
        }, true);

        // Also check periodically in case observer misses something
        setInterval(() => { dbg('interval sidenav'); processSideNav(); }, 2000);
    }

    // Wait for page to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    console.log('Twitch Affiliate Status Checker loaded');
})();
