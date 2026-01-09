// ==UserScript==
// @name         Twitch Affiliate Status Checker
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Shows affiliate/partner status on Twitch directory and browse pages
// @author       You
// @match        https://www.twitch.tv/directory/*
// @match        https://www.twitch.tv/search*
// @match        https://www.twitch.tv/*
// @grant        GM_xmlhttpRequest
// @connect      api.twitch.tv
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // You need to set your Twitch Client ID. Do NOT embed client_secret here.
    // Recommended: run the token server (see README) and let the userscript fetch a short-lived App Access Token from http://localhost:3000/twitch-token
    const CLIENT_ID = 'cmu3g5ukloxsupzgts9kj4sv98a8m8';
    let OAUTH_TOKEN = ''; // will be fetched from local token server or set manually
    const LOCAL_TOKEN_URL = 'http://localhost:4000/twitch-token';

    const checkedChannels = new Set();
    const channelCache = new Map();
    const pageObservers = new Map();
    let invalidToken = false; // set to true when API returns 401 to prevent repeated requests
    const DEBUG = false; // set false for release; true enables debug logs
    
    let lastTokenAttempt = 0;
    const TOKEN_RETRY_MS = 10000;
    let rateLimitUntil = 0;
    const RATE_LIMIT_BACKOFF_MS = 60 * 1000; // 1 minute backoff on 429

    // Track last location to detect SPA navigation changes
    let lastHref = location.href;

    // Display a small banner in-page for token/server status
    function showBanner(msg, persistent = false) {
        try {
            let el = document.getElementById('tac-token-banner');
            if (!el) {
                el = document.createElement('div');
                el.id = 'tac-token-banner';
                el.style.cssText = 'position:fixed;top:10px;left:10px;padding:8px 12px;background:rgba(0,0,0,0.8);color:#fff;border-radius:6px;z-index:2147483647;font-size:12px;font-weight:600;pointer-events:none';
                document.body.appendChild(el);
            }
            el.textContent = msg;
            if (!persistent) {
                setTimeout(() => {
                    if (el && el.parentNode) el.parentNode.removeChild(el);
                }, 6000);
            }
        } catch (e) {
            /* ignore DOM errors */
        }
    }

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
                                checkedChannels.clear();
                                // remove any old badges that were created before we had a token
                                removeAllBadges();
                                // re-run processing (cards + channel page)
                                setTimeout(() => { processAllCards(); processChannelPage(); }, 200);
                            showBanner('Twitch Affiliate: token obtained from local server', false);
                            resolve(OAUTH_TOKEN);
                        } else {
                            console.warn('Twitch Affiliate: local token endpoint returned no access_token');
                            showBanner('Twitch Affiliate: local token endpoint returned no access_token', false);
                            resolve(null);
                        }
                    } catch (e) {
                        console.error('Twitch Affiliate: failed to parse local token response', e);
                        showBanner('Twitch Affiliate: failed to parse local token response', false);
                        resolve(null);
                    }
                },
                onerror: function(err) {
                    // likely server not running
                    showBanner('Twitch Affiliate: local token server not reachable', false);
                    resolve(null);
                }
            });
        });
    }

    // Get broadcaster info from Twitch API (returns { broadcasterType, error })
    async function getBroadcasterInfo(username) {
        // normalize cached values: if cache stored a raw string, convert to object
        if (channelCache.has(username)) {
            const cached = channelCache.get(username);
            if (cached && typeof cached === 'string') {
                return { broadcasterType: cached, error: null };
            }
            return cached;
        }

        return new Promise(async (resolve) => {
            // try to ensure we have a token (try local server, but retry periodically)
            const now = Date.now();
            if (!OAUTH_TOKEN && (now - lastTokenAttempt > TOKEN_RETRY_MS)) {
                lastTokenAttempt = now;
                await ensureAccessToken();
            }

            // internal request function with single-retry-on-401
            const sendRequest = (retry) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: `https://api.twitch.tv/helix/users?login=${encodeURIComponent(username)}`,
                    headers: {
                        'Client-ID': CLIENT_ID,
                        'Authorization': `Bearer ${OAUTH_TOKEN}`
                    },
                    onload: async function(response) {
                        const status = response.status;
                        if (status === 200) {
                            try {
                                const data = JSON.parse(response.responseText);
                                if (data.data && data.data.length > 0) {
                                    const broadcasterType = data.data[0].broadcaster_type || '';
                                    const result = { broadcasterType, error: null };
                                    channelCache.set(username, result);
                                    return resolve(result);
                                }
                                const result = { broadcasterType: '', error: null };
                                channelCache.set(username, result);
                                return resolve(result);
                            } catch (e) {
                                console.error('Error parsing Twitch API response for', username, e);
                                const result = { broadcasterType: '', error: 'parse_error' };
                                channelCache.set(username, result);
                                return resolve(result);
                            }
                        }

                        // Handle 401 by attempting to refresh token once
                        if (status === 401 && !retry) {
                            console.warn('Twitch API 401 for', username, '- attempting token refresh');
                            await ensureAccessToken();
                            if (OAUTH_TOKEN) {
                                // retry once with new token
                                return sendRequest(true);
                            }
                        }

                                    // Handle 429 rate limiting by backing off
                                    if (status === 429) {
                                        console.warn('Twitch API 429 (rate limited). Backing off for', RATE_LIMIT_BACKOFF_MS, 'ms');
                                        rateLimitUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
                                    }

                        const err = `HTTP ${status}`;
                        console.error('Twitch API error for', username, err, response.responseText);
                        if (status === 401) {
                            invalidToken = true;
                            showBanner('Twitch Affiliate: invalid or missing OAuth token', true);
                        }
                        const result = { broadcasterType: '', error: err };
                        channelCache.set(username, result);
                        return resolve(result);
                    },
                    onerror: function(error) {
                        console.error('API request failed for', username, error);
                        const result = { broadcasterType: '', error: 'network_error' };
                        channelCache.set(username, result);
                        return resolve(result);
                    }
                });
            };

            // If rate-limited, avoid making requests
            if (Date.now() < rateLimitUntil) {
                const result = { broadcasterType: '', error: 'rate_limited' };
                channelCache.set(username, result);
                return resolve(result);
            }

            // If we still don't have a token, show banner but attempt request anyway (Twitch will respond accordingly)
            if (!OAUTH_TOKEN) {
                showBanner('Twitch Affiliate: no access token — run token server or set OAUTH_TOKEN', true);
            }

            sendRequest(false);
        });
    }

    // Extract username from channel card by scanning anchors for a simple /username href
    function extractUsername(element) {
        const anchors = element.querySelectorAll('a[href^="/"]');
        for (const a of anchors) {
            const href = a.getAttribute('href');
            if (!href) continue;
            // Match /username optionally followed by ? or # or end
            const match = href.match(/^\/([a-zA-Z0-9_]+)(?:$|[?#\/])/);
            if (match && match[1]) {
                const name = match[1];
                const skip = ['directory', 'search', 'videos', 'collections', 'subscriptions', 'settings'];
                if (!skip.includes(name.toLowerCase())) {
                    return name;
                }
            }
        }
        return null;
    }

    // Create status badge (smaller, non-intrusive)
    function createBadge(broadcasterType, error) {
        const badge = document.createElement('div');
        badge.className = 'tac-affiliate-badge';
        badge.style.cssText = [
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
        ].join(';');

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
            const existing = document.querySelectorAll('.tac-affiliate-badge');
            existing.forEach(el => {
                if (el && el.parentNode) el.parentNode.removeChild(el);
            });
        } catch (e) {
            /* ignore DOM errors */
        }
    }

    // Create a small inline label to append to overlay text (uses less space)
    function createInlineLabel(broadcasterType, error) {
        const span = document.createElement('span');
        span.className = 'tac-inline-label';
        span.style.cssText = [
            'margin-left:6px',
            'padding:2px 6px',
            'border-radius:999px',
            'font-size:12px',
            'font-weight:700',
            'vertical-align:middle',
            'color:#fff',
            'pointer-events:none',
            'box-shadow:0 1px 3px rgba(0,0,0,0.35)'
        ].join(';');

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

    // Process channel card
    async function processChannelCard(card) {
        try {
            if (!card) return;
            const username = extractUsername(card);
            if (!username || checkedChannels.has(username)) {
                return;
            }

            checkedChannels.add(username);

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

    // Find and process all channel cards
    function processAllCards() {
        // Twitch uses various selectors for channel cards
        const selectors = [
            'article[data-target]',
            'div[data-target*="directory-card"]',
            'a[data-a-target="preview-card-image-link"]',
            'div[class*="StreamPreview"]'
        ];

        selectors.forEach(selector => {
            const cards = document.querySelectorAll(selector);
            cards.forEach(card => {
                const parent = card.closest('article') || card.closest('div[class*="card"]') || card;
                processChannelCard(parent);
            });
        });
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
            // avoid repeating for same username
            if (checkedChannels.has('__page__' + username)) return;

            const titleSelector = 'h1.CoreText-sc-1txzju1-0';
            let titleEl = document.querySelector(titleSelector);

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
                            // auto-disconnect observer after 30s to avoid indefinite watching
                            setTimeout(() => {
                                try {
                                    const ob = pageObservers.get(username);
                                    if (ob) ob.disconnect();
                                } catch (e) {}
                                pageObservers.delete(username);
                                checkedChannels.add('__page__' + username);
                            }, 30000);
                        } catch (e) {
                            // if observer fails, mark as done so we don't loop forever
                            checkedChannels.add('__page__' + username);
                        }
                    }
                } catch (e) {
                    console.error('processChannelPage append error', e);
                    // mark as done even on error to avoid spamming
                    checkedChannels.add('__page__' + username);
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
                                // mark as done to avoid repeated waiting
                                checkedChannels.add('__page__' + username);
                            }
                        } catch (e) { /* ignore */ }
                    }, 5000);
                } catch (e) {
                    // fallback: mark as done so we don't loop
                    checkedChannels.add('__page__' + username);
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
            // Clear per-page processed set so new cards get processed
            checkedChannels.clear();
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
        processChannelPage();
    });

    // Start observing
    async function init() {
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

        // Also check periodically in case observer misses something
        setInterval(processAllCards, 5000);
    }

    // Wait for page to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    console.log('Twitch Affiliate Status Checker loaded');
})();
