const fs = require('fs');
const path = require('path');
const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const edge = require('selenium-webdriver/edge');

class ErrorMessageValidator {
    constructor(options = {}) {
        this.reportsDirPath = options.reportsDirPath || path.join(__dirname, 'Reports');
        this.screenshotDir = options.screenshotDir || path.join(this.reportsDirPath, 'screenshots');
        this.errorMessages = [
            // ── Application-specific error messages ──────────────────────────────────
            "We can't find that page",
            "We apologize, fund performance is temporarily unavailable.",
            "A problem occurred while rendering this section.",
            "This site can't be reached",
            "Details for this policy are no longer available. Please return to the",
            "We Are Having Technical Difficulties",
            "Please first review the guidelines below and register to participate in using Generative AI websites",
            "No webpage was found for the web address",
            "Application Unavailable",

            // ── 404 – Not Found ──────────────────────────────────────────────────────
            "404 Not Found",
            "404 – Not Found",
            "404 — Not Found",
            "Error 404",

            // ── 403 – Forbidden ──────────────────────────────────────────────────────
            "403 Forbidden",
            "403 – Forbidden",
            "403 — Forbidden",
            "Error 403",
            "Access Denied",
            "Access denied",

            // ── 401 – Unauthorized ──────────────────────────────────────────────────
            "401 Unauthorized",
            "401 – Unauthorized",
            "401 — Unauthorized",
            "Error 401",
            "Authentication required",

            // ── 429 – Too Many Requests ─────────────────────────────────────────────
            "429 Too Many Requests",
            "429 – Too Many Requests",
            "429 — Too Many Requests",
            "Error 429",
            "Rate limit exceeded",
            "Too Many Requests",

            // ── 500 – Internal Server Error ─────────────────────────────────────────
            "500 Internal Server Error",
            "500 – Internal Server Error",
            "500 — Internal Server Error",
            "Error 500",
            "Internal Server Error",

            // ── 502 – Bad Gateway ───────────────────────────────────────────────────
            "502 Bad Gateway",
            "502 – Bad Gateway",
            "502 — Bad Gateway",
            "Error 502",

            // ── 503 – Service Unavailable ──────────────────────────────────────────
            "503 Service Unavailable",
            "503 – Service Unavailable",
            "503 — Service Unavailable",
            "Error 503",
            "Service Unavailable",
            "Service temporarily unavailable",

            // ── 504 – Gateway Timeout ──────────────────────────────────────────────
            "504 Gateway Timeout",
            "504 – Gateway Timeout",
            "504 — Gateway Timeout",
            "Error 504",
            "Gateway Timeout"
        ];
        this.reportPath = options.reportPath || "test_report.html";
        this.testStartTime = null;
        this.testResults = [];
        this.browser = (options.browser || 'chrome').toLowerCase();
        this.headless = options.headless !== false;
        this.driver = null;
        this.environment = options.environment || '';
        this.polledErrors = [];
        this.urlsTestedWithCurrentDriver = 0;
        this.maxUrlsPerSession = options.maxUrlsPerSession || 30; // increased to reduce restarts
        this.skippedRows = [];
        this.sessionLostCount = 0;
        this.ambiguousErrorMessages = new Set([
            'Access Denied', 'Access denied', 'Authentication required',
            'Rate limit exceeded', 'Too Many Requests',
            'Internal Server Error',
            'Service Unavailable', 'Service temporarily unavailable',
            'Gateway Timeout'
        ]);

        // Create directories
        if (!fs.existsSync(this.screenshotDir)) {
            fs.mkdirSync(this.screenshotDir, { recursive: true });
        }
        if (!fs.existsSync(this.reportsDirPath)) {
            fs.mkdirSync(this.reportsDirPath, { recursive: true });
        }
    }

    async setupDriver() {
        if (this.browser === 'edge') {
            await this.setupEdgeDriver();
        } else {
            await this.setupChromeDriver();
        }
    }

    async setupChromeDriver() {
        const options = new chrome.Options();

        if (this.headless) {
            options.addArguments('--headless');
        }

        options.addArguments('--no-sandbox');
        options.addArguments('--disable-dev-shm-usage');
        options.addArguments('--disable-gpu');
        options.addArguments('--window-size=1920,1080');
        options.addArguments('--ignore-certificate-errors');
        options.addArguments('--ignore-ssl-errors');
        options.addArguments('--disable-extensions');
        options.addArguments('--disable-plugins');
        options.addArguments('--disable-default-apps');
        options.addArguments('--disable-sync');
        options.addArguments('--disable-notifications');

        options.setUserPreferences({
            'profile.managed_default_content_settings.images': 2
        });

        try {
            this.driver = await new Builder()
                .forBrowser('chrome')
                .setChromeOptions(options)
                .build();

            await this.driver.manage().setTimeouts({
                implicit: 5000,
                pageLoad: 30000
            });
            console.log('Chrome WebDriver initialized successfully');
        } catch (error) {
            console.error('Error initializing Chrome WebDriver:', error.message);
            process.exit(1);
        }
    }

    async setupEdgeDriver() {
        const options = new edge.Options();

        if (this.headless) {
            options.addArguments('--headless');
        }

        options.addArguments('--no-sandbox');
        options.addArguments('--disable-dev-shm-usage');
        options.addArguments('--disable-gpu');
        options.addArguments('--window-size=1920,1080');
        options.addArguments('--ignore-certificate-errors');
        options.addArguments('--ignore-ssl-errors');
        options.addArguments('--disable-extensions');
        options.addArguments('--disable-plugins');
        options.addArguments('--disable-default-apps');
        options.addArguments('--disable-sync');
        options.addArguments('--disable-notifications');
        // Suppress Edge LLM errors
        options.addArguments('--disable-features=EdgeLLM,OnDeviceModel');
        options.addArguments('--log-level=3');

        options.setUserPreferences({
            'profile.managed_default_content_settings.images': 2
        });

        try {
            this.driver = await new Builder()
                .forBrowser('MicrosoftEdge')
                .setEdgeOptions(options)
                .build();

            await this.driver.manage().setTimeouts({
                implicit: 5000,
                pageLoad: 30000
            });
            console.log('Edge WebDriver initialized successfully');
        } catch (error) {
            console.error('Error initializing Edge WebDriver:', error.message);
            process.exit(1);
        }
    }

    async validateSession() {
        try {
            await this.driver.getCurrentUrl();
            return true;
        } catch (error) {
            return false;
        }
    }

    async reinitializeDriver() {
        console.log('   ⚠️ Session lost, reinitializing browser...');
        try {
            await this.driver.quit();
        } catch (e) { /* ignore */ }

        if (this.browser === 'edge') {
            await this.setupEdgeDriver();
        } else {
            await this.setupChromeDriver();
        }
    }

    // Faster cookie consent – timeout reduced to 1 second
    async handleCookieConsent() {
        console.log('   - Checking for cookie consent banners...');
        let consentHandled = false;
        let consentWarning = false;
        const CONSENT_TIMEOUT_MS = 1000; // reduced from 2000
        const consentStart = Date.now();
        const isTimedOut = () => (Date.now() - consentStart) >= CONSENT_TIMEOUT_MS;

        const combinedSelector = [
            'div[id="truste-consent-track"]',
            'button[class*="accept"]',
            'button[id*="accept"]',
            'button[class*="consent"]',
            'button[id*="consent"]',
            'button[class*="agree"]',
            'button[id*="agree"]'
        ].join(',');

        try {
            const elements = await this.driver.findElements(By.css(combinedSelector));
            for (const element of elements) {
                if (isTimedOut()) { consentWarning = true; break; }
                try {
                    if (await element.isDisplayed() && await element.isEnabled()) {
                        const text = await element.getText();
                        if (text.toLowerCase().includes('accept') ||
                            text.toLowerCase().includes('agree') ||
                            text.toLowerCase().includes('ok')) {
                            console.log(`     Clicking consent button: '${text}'`);
                            await element.click();
                            consentHandled = true;
                            try {
                                await this.driver.wait(until.stalenessOf(element), 1500);
                            } catch (_) { /* ignore */ }
                            break;
                        }
                    }
                } catch (e) {
                    continue;
                }
            }

            if (consentWarning && !consentHandled) {
                console.log('     ⚠️ COOKIE_BANNER_NOT_DISMISSED — consent check timed out after 1s');
            } else if (consentHandled) {
                console.log('     ✓ Cookie consent handled successfully');
            } else {
                console.log('     ✓ No cookie consent banner found or already handled');
            }
        } catch (error) {
            consentWarning = true;
            console.log(`     ⚠️ Error handling cookie consent: ${error.message}`);
        }

        return { handled: consentHandled, warning: consentWarning };
    }

    // Streamlined page load with tighter timeouts
    async waitForPageLoad(timeout = 10000) { // reduced default from 15000 to 10000
        try {
            console.log('   Waiting for page to be fully ready...');
            const pageLoadStartTime = Date.now();

            // 1. Document ready state (max 3s)
            try {
                await this.driver.wait(async () => {
                    const readyState = await this.driver.executeScript('return document.readyState');
                    return readyState === 'complete';
                }, 3000);
                console.log('   ✓ Document ready state is complete');
            } catch (e) {
                console.log('   ⚠ Document ready timeout (continuing anyway)');
            }

            // 2. Quick main content check
            console.log('   → Detecting main content element...');
            try {
                const mainContentFound = await this.driver.executeScript(`
                    const selectors = ['main', '[role="main"]', 'article', '.container', '[class*="content"]', '.main-content', '#main', '[id*="main"]'];
                    for (const selector of selectors) {
                        const element = document.querySelector(selector);
                        if (element && element.offsetHeight > 0) return true;
                    }
                    const bodyText = document.body.innerText || '';
                    return bodyText.trim().length > 100;
                `);
                if (mainContentFound) {
                    console.log('   ✓ Main content element detected');
                } else {
                    console.log('   ⚠ Main content not explicitly detected (continuing anyway)');
                }
            } catch (e) {
                console.log('   ⚠ Main content detection failed (continuing anyway)');
            }

            // 3. Loading indicators (max 5s)
            console.log('   → Checking for loading indicators...');
            try {
                await this.driver.wait(async () => {
                    return await this.driver.executeScript(`
                        const loadingSelectors = [
                            '[class*="loading"]', '[class*="spinner"]', '[id*="loading"]', '[id*="spinner"]',
                            '.loader', '.preloader', '.progress', '[class*="skeleton"]',
                            '[data-testid*="loading"]', '.lds-ring', '.sk-spinner'
                        ];
                        for (const selector of loadingSelectors) {
                            try {
                                const elements = document.querySelectorAll(selector);
                                for (const el of elements) {
                                    if (el.offsetHeight > 0 && el.offsetWidth > 0) {
                                        const style = window.getComputedStyle(el);
                                        if (style.display !== 'none' && style.visibility !== 'hidden') {
                                            return false;
                                        }
                                    }
                                }
                            } catch (e) { continue; }
                        }
                        return true;
                    `);
                }, 5000);
                console.log('   ✓ Loading indicators removed');
            } catch (e) {
                console.log('   ⚠ Loading indicators still present (timeout)');
            }

            // 4. Content stability (shorter)
            console.log('   → Stabilizing dynamic content...');
            try {
                const stabilityResult = await this.driver.executeScript(`
                    return new Promise((resolve) => {
                        let snapshot = {
                            text: document.body.innerText.length,
                            elementCount: document.querySelectorAll('*').length
                        };
                        let previousSnapshot = snapshot;
                        let stableCount = 0;
                        const maxAttempts = 6;   // reduced from 10
                        const requiredStable = 2;
                        let attemptCount = 0;

                        const check = () => {
                            snapshot = {
                                text: document.body.innerText.length,
                                elementCount: document.querySelectorAll('*').length
                            };
                            if (snapshot.text === previousSnapshot.text && 
                                snapshot.elementCount === previousSnapshot.elementCount) {
                                stableCount++;
                            } else {
                                stableCount = 0;
                            }
                            if (stableCount >= requiredStable) {
                                resolve({ stable: true, reason: 'Content stabilized' });
                                return;
                            }
                            previousSnapshot = snapshot;
                            attemptCount++;
                            if (attemptCount >= maxAttempts) {
                                if (snapshot.text > 500) {
                                    resolve({ stable: true, reason: 'Substantial content detected' });
                                } else {
                                    resolve({ stable: false, reason: 'Content stability timeout' });
                                }
                                return;
                            }
                            setTimeout(check, 150); // reduced from 200
                        };
                        check();
                    });
                `);
                if (stabilityResult.stable) {
                    console.log('   ✓ Content stability check passed');
                } else {
                    console.log('   ⚠ Content stability check failed');
                }
            } catch (e) {
                console.log('   ⚠ Content stability check failed');
            }

            // 5. Error polling (1.5s)
            console.log('   → Final error monitoring (1500ms)...');
            const pollStartTime = Date.now();
            let pollResults = [];

            while (Date.now() - pollStartTime < 1500) {
                try {
                    const foundErrors = await this.driver.executeScript(`
                        const errors = [];
                        const targetMsg = 'We apologize, fund performance is temporarily unavailable.';
                        const candidates = document.querySelectorAll(
                            'bolt-notification, nw-notification, [class*="notification"], ' +
                            '[role="alert"], [class*="alert"], [class*="error"], [class*="warning"]'
                        );
                        for (const el of candidates) {
                            const text = el.textContent || el.innerText || '';
                            const style = window.getComputedStyle(el);
                            if (text.includes(targetMsg) && style.display !== 'none' && style.visibility !== 'hidden') {
                                if (!errors.includes(targetMsg)) errors.push(targetMsg);
                            }
                        }
                        const bodyText = document.body.innerText || '';
                        const otherErrors = [
                            "We can't find that page",
                            "A problem occurred while rendering this section.",
                            "This site can't be reached"
                        ];
                        for (const msg of otherErrors) {
                            if (bodyText.includes(msg)) errors.push(msg);
                        }
                        return errors;
                    `);
                    if (foundErrors && foundErrors.length > 0) {
                        pollResults = foundErrors;
                        console.log(`   ⚠ Error(s) detected during polling: ${foundErrors.join(', ')}`);
                        break;
                    }
                } catch (e) { /* continue polling */ }
                await this.sleep(150); // reduced from 200
            }

            console.log('   ✓ Ongoing monitoring completed');
            this.polledErrors = pollResults;
            return true;
        } catch (error) {
            console.log(`⚠️ Warning: Page load timeout after ${timeout / 1000} seconds`);
            console.log(`   Continuing with validation despite timeout...`);
            return false;
        }
    }

    // Combined error check – one script instead of three
    async checkAllErrors() {
        try {
            const result = await this.driver.executeScript(`
                function getVisibleText(element) {
                    if (!element || element.nodeType !== 1) return '';
                    const tag = element.tagName.toLowerCase();
                    if (tag === 'script' || tag === 'style' || tag === 'noscript') return '';
                    const style = window.getComputedStyle(element);
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return '';
                    let text = '';
                    for (let child of element.childNodes) {
                        if (child.nodeType === 3) text += child.textContent;
                        else if (child.nodeType === 1) text += getVisibleText(child);
                    }
                    return text;
                }

                const visibleText = getVisibleText(document.body);
                const bodyText = document.body.innerText || '';

                const clone = document.body.cloneNode(true);
                const scriptsAndStyles = clone.querySelectorAll('script, style, noscript');
                scriptsAndStyles.forEach(el => el.remove());
                const cleanHTML = clone.innerHTML;

                // Rendering errors
                const renderingErrors = [];
                const renderingMsg = "A problem occurred while rendering this section";
                const alertDivs = document.querySelectorAll('div.alert.alert-danger, [class*="error"][class*="alert"]');
                for (const div of alertDivs) {
                    const txt = div.textContent || div.innerText || '';
                    if (txt.includes(renderingMsg)) {
                        renderingErrors.push({
                            tag: div.tagName,
                            class: div.className || '',
                            id: div.id || '',
                            text: txt.trim().substring(0, 200),
                            visible: true,
                            type: 'alert_div'
                        });
                    }
                }
                const allElements = document.querySelectorAll('body *:not(script):not(style):not(noscript)');
                for (const el of allElements) {
                    const style = window.getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
                    const txt = el.textContent || el.innerText || '';
                    if (txt.includes(renderingMsg)) {
                        renderingErrors.push({
                            tag: el.tagName,
                            class: el.className || '',
                            id: el.id || '',
                            text: txt.trim().substring(0, 200),
                            visible: true,
                            parent: el.parentElement ? {
                                tag: el.parentElement.tagName,
                                class: el.parentElement.className || '',
                                id: el.parentElement.id || ''
                            } : null
                        });
                    }
                }

                // Main error detection
                const found = [];
                const errorMessages = arguments[0] || [];
                const ambiguousSet = new Set(arguments[1] || []);

                for (const msg of errorMessages) {
                    if (msg === 'A problem occurred while rendering this section.' || 
                        msg === 'A problem occurred while rendering this section') continue;

                    if (msg === 'We apologize, fund performance is temporarily unavailable.') {
                        const target = msg;
                        const allEls = document.querySelectorAll(
                            'bolt-notification, nw-notification, [class*="notification"], ' +
                            '[role="alert"], [class*="alert"], [class*="error"], [class*="warning"], ' +
                            '.message.error, .alert-danger, .alert-warning, .error-message, ' +
                            '.fund-error, [data-test*="error"]'
                        );
                        let foundFund = false;
                        for (const el of allEls) {
                            const txt = el.textContent || el.innerText || '';
                            if (txt.includes(target)) {
                                const style = window.getComputedStyle(el);
                                if (style.display !== 'none' && style.visibility !== 'hidden') {
                                    foundFund = true;
                                    break;
                                }
                            }
                        }
                        if (!foundFund) {
                            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null);
                            let node;
                            while ((node = walker.nextNode())) {
                                const directText = Array.from(node.childNodes)
                                    .filter(n => n.nodeType === 3).map(n => n.textContent).join('');
                                if (directText.includes(target)) {
                                    const style = window.getComputedStyle(node);
                                    if (style.display !== 'none' && style.visibility !== 'hidden') {
                                        foundFund = true;
                                        break;
                                    }
                                }
                            }
                        }
                        if (foundFund) {
                            found.push({ message: msg, location: 'fund_performance', details: 'Found in notification' });
                        }
                        continue;
                    }

                    let inSource = cleanHTML.includes(msg);
                    let inVisible = visibleText.includes(msg);

                    if (ambiguousSet.has(msg)) {
                        if (inSource || inVisible) {
                            const containers = document.querySelectorAll(
                                '[role="alert"], [role="status"], .alert, .alert-danger, .alert-warning, ' +
                                '.alert-error, [class*="error"], [class*="banner"], h1, h2'
                            );
                            let contextFound = false;
                            for (const el of containers) {
                                const txt = el.textContent || el.innerText || '';
                                const style = window.getComputedStyle(el);
                                if (txt.includes(msg) && style.display !== 'none' && style.visibility !== 'hidden') {
                                    contextFound = true;
                                    break;
                                }
                            }
                            if (contextFound) {
                                found.push({ message: msg, location: 'contextual', details: 'Found in error container' });
                            }
                        }
                    } else {
                        if (inSource) {
                            found.push({ message: msg, location: 'page_source', details: 'Found in HTML source' });
                        } else if (inVisible) {
                            found.push({ message: msg, location: 'visible_text', details: 'Found in visible text' });
                        }
                    }
                }

                return {
                    foundMessages: found,
                    renderingErrors: renderingErrors,
                    pageTitle: document.title
                };
            `, this.errorMessages, Array.from(this.ambiguousErrorMessages));

            const foundMessages = result.foundMessages || [];
            const renderingErrors = result.renderingErrors || [];
            const pageTitle = result.pageTitle || '';

            let inTitle = false;
            for (const msg of this.errorMessages) {
                if (pageTitle.includes(msg)) { inTitle = true; break; }
            }

            const renderingErrorObjects = renderingErrors.map(e => ({
                message: 'A problem occurred while rendering this section.',
                location: 'DOM',
                details: 'Found in page DOM',
                element_details: e
            }));

            return { foundMessages, renderingErrorObjects, inTitle, pageTitle };
        } catch (e) {
            console.log(`     ⚠️ Error in combined error check: ${e.message}`);
            return { foundMessages: [], renderingErrorObjects: [], inTitle: false, pageTitle: '' };
        }
    }

    // Deprecated stubs (kept for compatibility)
    async checkPageSource() { return []; }
    async checkVisibleText() { return []; }
    async scanDomForRenderingError() { return []; }

    async highlightAndScrollToError(errorMessages) {
        try {
            const jsScript = `
            var errorTexts = ${JSON.stringify(errorMessages)};
            var bestElement = null;
            var bestLength = Infinity;

            var allElements = document.querySelectorAll('*');
            for (var i = 0; i < allElements.length; i++) {
                var el = allElements[i];
                var tag = el.tagName.toLowerCase();
                if (tag === 'html' || tag === 'body' || tag === 'head' ||
                    tag === 'script' || tag === 'style' || tag === 'noscript') continue;
                var style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
                var text = (el.textContent || el.innerText || '').trim();
                if (text.length === 0 || text.length > bestLength) continue;
                for (var j = 0; j < errorTexts.length; j++) {
                    if (text.includes(errorTexts[j])) {
                        bestElement = el;
                        bestLength = text.length;
                        break;
                    }
                }
            }

            if (bestElement) {
                bestElement.style.outline = '4px solid red';
                bestElement.style.outlineOffset = '4px';
                bestElement.style.backgroundColor = 'rgba(255, 0, 0, 0.15)';
                bestElement.style.boxShadow = '0 0 0 6px rgba(255,0,0,0.4)';
                bestElement.scrollIntoView({behavior: 'instant', block: 'center', inline: 'center'});
                var badge = document.createElement('div');
                badge.id = '__ev_error_badge__';
                badge.textContent = '⛔ ERROR DETECTED';
                badge.style.cssText = [
                    'position:fixed', 'top:0', 'left:0', 'width:100%',
                    'background:#b91c1c', 'color:#fff', 'font:bold 18px/40px sans-serif',
                    'text-align:center', 'z-index:2147483647', 'letter-spacing:2px',
                    'box-shadow:0 4px 12px rgba(0,0,0,0.5)', 'pointer-events:none'
                ].join(';');
                document.body.appendChild(badge);
                return true;
            }
            return false;
            `;
            const result = await this.driver.executeScript(jsScript);
            if (result) {
                await this.sleep(300); // reduced from 400
            }
            return result;
        } catch (error) {
            console.log(`     ⚠️ Could not highlight error: ${error.message}`);
            return false;
        }
    }

    async removeErrorBadge() {
        try {
            await this.driver.executeScript(`
                var badge = document.getElementById('__ev_error_badge__');
                if (badge) badge.remove();
            `);
        } catch (_) { /* non-critical */ }
    }

    async validatePage(url, retryCount = 0) {
        const testStart = new Date();
        this.polledErrors = [];
        console.log('\n' + '='.repeat(60));
        console.log(`Testing URL: ${url}`);
        if (retryCount > 0) console.log(`[RETRY ${retryCount}]`);
        console.log('='.repeat(60));

        if (this.urlsTestedWithCurrentDriver >= this.maxUrlsPerSession) {
            console.log('⚠️ Browser resource limit reached, recycling...');
            try {
                await this.close();
                await this.setupDriver();
            } catch (e) {
                console.log(`⚠️ Error recycling browser: ${e.message}`);
            }
            this.urlsTestedWithCurrentDriver = 0;
        }
        this.urlsTestedWithCurrentDriver++;

        try {
            console.log('1. Opening URL...');
            await this.driver.get(url);

            console.log('2. Checking for cookie consent...');
            const consentResult = await this.handleCookieConsent();
            const consentHandled = consentResult.handled;
            const cookieWarning = consentResult.warning;

            console.log('3. Waiting for page to load...');
            const pageLoaded = await this.waitForPageLoad(10000);
            if (!pageLoaded) {
                console.log('Warning: Page may not have fully loaded');
            }

            console.log('4. Searching for error messages (combined check)...');
            const { foundMessages, renderingErrorObjects, inTitle, pageTitle } = await this.checkAllErrors();

            const allFoundErrors = [];
            const seenErrors = new Set();

            const addUniqueError = (errorMsg, location, details, elementDetails = null) => {
                const uniqueKey = errorMsg.trim().toLowerCase();
                if (!seenErrors.has(uniqueKey)) {
                    seenErrors.add(uniqueKey);
                    allFoundErrors.push({
                        message: errorMsg,
                        location: location,
                        details: details,
                        element_details: elementDetails
                    });
                    console.log(`     [Consolidation] Adding unique error: "${errorMsg}"`);
                }
            };

            for (const err of foundMessages) {
                addUniqueError(err.message, err.location, err.details);
            }

            for (const errObj of renderingErrorObjects) {
                addUniqueError(
                    errObj.message,
                    errObj.location || 'DOM',
                    errObj.details || 'Found in page DOM',
                    errObj.element_details
                );
            }

            if (inTitle) {
                addUniqueError(
                    'Error found in page title',
                    'title',
                    `Page title: ${pageTitle}`
                );
            }

            if (this.polledErrors && this.polledErrors.length > 0) {
                for (const errorMsg of this.polledErrors) {
                    addUniqueError(errorMsg, 'polling_monitor', 'Detected during page load monitoring');
                }
            }

            const errorFound = allFoundErrors.length > 0;
            console.log(`\n   [CRITICAL] Total consolidated errors: ${allFoundErrors.length}`);
            console.log(`   [CRITICAL] Error found flag: ${errorFound}`);

            // Screenshots are only taken if errorFound is true – this is already the case.
            let screenshotPath = null;
            let screenshotFailed = false;
            if (errorFound) {
                try {
                    if (!await this.validateSession()) {
                        console.log('   ⚠️ Session lost before screenshot – attempting recovery...');
                        await this.reinitializeDriver();
                        await this.driver.get(url);
                        await this.sleep(2000);
                    }

                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').substr(0, 19);
                    const urlPart = url.replace(/[^a-zA-Z0-9]/g, '_').substr(0, 50);
                    const screenshotFilename = `error_${urlPart}_${timestamp}.png`;
                    screenshotPath = path.join(this.screenshotDir, screenshotFilename);

                    console.log('   📍 Locating error on page...');
                    const errorHighlighted = await this.highlightAndScrollToError(this.errorMessages);
                    if (errorHighlighted) {
                        console.log('   ✓ Error element highlighted and centered');
                    }

                    const screenshotBase64 = await this.driver.takeScreenshot();
                    fs.writeFileSync(screenshotPath, Buffer.from(screenshotBase64, 'base64'));
                    console.log(`   📸 Screenshot saved: ${path.basename(screenshotPath)}`);

                    await this.removeErrorBadge();
                } catch (screenshotError) {
                    console.log(`   🔴 Screenshot capture FAILED: ${screenshotError.message}`);
                    screenshotPath = null;
                    screenshotFailed = true;
                }
            }

            const testEnd = new Date();
            const testDuration = (testEnd - testStart) / 1000;

            console.log('\n5. Validation Results:');
            console.log(`   - Cookie consent handled: ${consentHandled ? 'YES' : 'NO'}`);
            console.log(`   - Total errors found: ${allFoundErrors.length}`);
            allFoundErrors.forEach((error, index) => {
                console.log(`   - Error ${index + 1}: ${error.message}`);
                if (error.element_details) {
                    const elem = error.element_details;
                    console.log(`     Location: ${elem.tag || 'unknown'}`);
                    if (elem.class) console.log(`     Class: ${elem.class}`);
                    if (elem.id) console.log(`     ID: ${elem.id}`);
                }
            });

            const result = {
                url: url,
                status: errorFound ? 'FAIL' : 'PASS',
                error_found: errorFound,
                errors: allFoundErrors,
                consent_handled: consentHandled,
                cookie_warning: cookieWarning,
                in_page_source: foundMessages.some(e => e.location === 'page_source'),
                in_visible_text: foundMessages.some(e => e.location === 'visible_text'),
                in_overlays: false,
                rendering_errors: renderingErrorObjects.length > 0,
                in_title: inTitle,
                page_loaded: pageLoaded,
                duration: testDuration,
                timestamp: testStart.toISOString().replace('T', ' ').substr(0, 19),
                error_count: allFoundErrors.length,
                screenshot: screenshotPath ? path.basename(screenshotPath) : null,
                screenshot_failed: screenshotFailed
            };

            if (errorFound) {
                console.log(`\n❌ RESULT: FAIL - ${allFoundErrors.length} error(s) found on page`);
                allFoundErrors.forEach(error => console.log(`   • ${error.message}`));
                result.details = `${allFoundErrors.length} error(s) found`;
                this.testResults.push(result);
                return { success: false, result };
            } else {
                console.log('\n✅ RESULT: PASS - No error messages found on page');
                result.details = "No error messages found";
                this.testResults.push(result);
                return { success: true, result };
            }

        } catch (error) {
            const testDuration = (new Date() - testStart) / 1000;
            const msg = error.message || '';
            const isTimeout = msg.includes('timeout') || msg.includes('Timed out');
            const isNetworkError = isTimeout ||
                msg.includes('net::') || msg.includes('ERR_') ||
                msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') ||
                msg.includes('ECONNRESET');
            const isSessionDead = msg.includes('no such session') ||
                msg.includes('invalid session id') ||
                msg.includes('session deleted') ||
                msg.includes('Unable to find a matching set of capabilities') ||
                msg.includes('WebDriverError');
            const shouldRetry = (isNetworkError || isSessionDead) && retryCount < 1;

            if (shouldRetry) {
                const reason = isSessionDead ? 'Browser session died'
                    : isTimeout ? 'Page load timeout'
                    : 'Network error';
                console.log(`⚠️ ${reason} detected, retrying with fresh browser...`);
                try {
                    await this.close();
                    await this.setupDriver();
                    this.urlsTestedWithCurrentDriver = 0;
                } catch (e) {
                    console.log(`⚠️ Error during retry setup: ${e.message}`);
                }
                return await this.validatePage(url, retryCount + 1);
            }

            if (isSessionDead) {
                console.log(`\n🔴 RESULT: SESSION_LOST — Browser session unrecoverable for: ${url}`);
                this.sessionLostCount++;
                const sessionLostResult = {
                    url: url,
                    status: 'SESSION_LOST',
                    error_found: false,
                    error_message: error.message,
                    duration: testDuration,
                    timestamp: testStart.toISOString().replace('T', ' ').substr(0, 19),
                    details: `Session lost after retry: ${error.message}`
                };
                this.testResults.push(sessionLostResult);
                return { success: false, result: sessionLostResult };
            }

            console.log(`\n⚠️ RESULT: ERROR - ${error.message}`);
            const errorResult = {
                url: url,
                status: 'ERROR',
                error_found: false,
                error_message: error.message,
                duration: testDuration,
                timestamp: testStart.toISOString().replace('T', ' ').substr(0, 19),
                details: `Error: ${error.message} (Duration: ${testDuration.toFixed(2)}s)`
            };
            this.testResults.push(errorResult);
            return { success: false, result: errorResult };
        }
    }

    async runFromCsv(csvFilePath, urlColumn = 0, parallel = false, maxConcurrent = 5) {
        this.testStartTime = new Date();

        const csvContent = fs.readFileSync(csvFilePath, 'utf-8');
        const lines = csvContent.split('\n').filter(line => line.trim());

        let startIndex = 0;
        if (lines.length > 0) {
            const firstLine = lines[0].toLowerCase();
            if (!firstLine.startsWith('http')) {
                startIndex = 1;
            }
        }

        const urls = lines.slice(startIndex).map(line => {
            const columns = line.split(',');
            return columns[urlColumn] ? columns[urlColumn].trim() : null;
        }).filter(url => url && url.startsWith('http'));

        this.skippedRows = [];
        lines.slice(startIndex).forEach((line, idx) => {
            const rawRowNum = startIndex + idx + 1;
            const columns = line.split(',');
            if (urlColumn >= columns.length) {
                this.skippedRows.push({ row: rawRowNum, raw: line.trim(), reason: `Column ${urlColumn} out of bounds (${columns.length} column(s))` });
                return;
            }
            const candidate = columns[urlColumn] ? columns[urlColumn].trim() : '';
            if (!candidate) {
                this.skippedRows.push({ row: rawRowNum, raw: line.trim(), reason: 'Empty cell in URL column' });
            } else if (!candidate.startsWith('http')) {
                this.skippedRows.push({ row: rawRowNum, raw: line.trim(), reason: `Value does not start with http: "${candidate.substring(0, 80)}"` });
            }
        });

        if (this.skippedRows.length > 0) {
            console.log(`⚠️  CSV skipped rows: ${this.skippedRows.length} row(s) could not be loaded`);
            this.skippedRows.forEach(s => console.log(`   Row ${s.row}: ${s.reason}`));
        }
        console.log(`\nProcessing ${urls.length} URLs from CSV file...`);

        if (parallel) {
            console.log(`Running in parallel mode with ${maxConcurrent} concurrent workers...\n`);
            let completed = 0;
            const processUrl = async (url) => {
                try {
                    await this.validatePage(url);
                } catch (error) {
                    console.error(`Error processing ${url}: ${error.message}`);
                }
                completed++;
                console.log(`[Progress] Completed ${completed}/${urls.length} URLs`);
            };
            for (let i = 0; i < urls.length; i += maxConcurrent) {
                const batch = urls.slice(i, i + maxConcurrent);
                console.log(`\nProcessing batch ${Math.floor(i / maxConcurrent) + 1} (URLs ${i + 1} - ${Math.min(i + maxConcurrent, urls.length)})...`);
                await Promise.all(batch.map(processUrl));
            }
        } else {
            for (let i = 0; i < urls.length; i++) {
                console.log(`\n\nProcessing URL ${i + 1} of ${urls.length}\n`);
                await this.validatePage(urls[i]);
            }
        }

        const results = {
            total: this.testResults.length,
            passed: this.testResults.filter(r => r.status === 'PASS').length,
            failed: this.testResults.filter(r => r.status === 'FAIL').length,
            errors: this.testResults.filter(r => r.status === 'ERROR').length,
            session_lost: this.testResults.filter(r => r.status === 'SESSION_LOST').length,
            skipped: (this.skippedRows || []).length,
            details: this.testResults
        };
        return results;
    }

    generateHtmlReport(environment = '') {
        const env = environment || this.environment || '';
        const totalTests = this.testResults.length;
        const passed = this.testResults.filter(r => r.status === 'PASS').length;
        const failed = this.testResults.filter(r => r.status === 'FAIL').length;
        const errors = this.testResults.filter(r => r.status === 'ERROR').length;

        const passPercentage = totalTests > 0 ? (passed / totalTests * 100).toFixed(1) : 0;
        const failedPercentage = totalTests > 0 ? (failed / totalTests * 100).toFixed(1) : 0;
        const errorsPercentage = totalTests > 0 ? (errors / totalTests * 100).toFixed(1) : 0;

        const totalDuration = this.testResults.reduce((sum, r) => sum + (r.duration || 0), 0);
        const avgDuration = totalTests > 0 ? (totalDuration / totalTests).toFixed(2) : 0;
        const totalExecutionTime = this.testStartTime ? ((new Date() - this.testStartTime) / 1000).toFixed(2) : 0;
        const consentHandledCount = this.testResults.filter(r => r.consent_handled).length;
        const cookieWarningCount = this.testResults.filter(r => r.cookie_warning).length;
        const sessionLostCount = this.testResults.filter(r => r.status === 'SESSION_LOST').length;
        const screenshotFailedCount = this.testResults.filter(r => r.screenshot_failed).length;
        const totalErrorsFound = this.testResults.reduce((sum, r) => sum + (r.error_count || 0), 0);
        const skippedRows = this.skippedRows || [];

        // Escape HTML to prevent XSS
        const escapeHtml = (str) => {
            if (!str) return '';
            return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
        };

        const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Error Message Validation Test Report</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            margin: 20px;
            background-color: #f5f5f5;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            border-radius: 10px;
            margin-bottom: 20px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        }
        .header h1 {
            margin: 0 0 10px 0;
            font-size: 28px;
        }
        .header p {
            margin: 5px 0;
            opacity: 0.9;
        }
        .summary {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
        }
        .summary-card {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            text-align: center;
        }
        .summary-card h3 {
            margin: 0 0 10px 0;
            font-size: 14px;
            color: #666;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        .summary-card .value {
            font-size: 32px;
            font-weight: bold;
            margin-bottom: 5px;
        }
        .summary-card .percentage {
            font-size: 14px;
            color: #888;
        }
        .passed { color: #10b981; }
        .failed { color: #ef4444; }
        .error { color: #f59e0b; }
        .info { color: #3b82f6; }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
        }
        .stat-item {
            background: white;
            padding: 15px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .stat-item .label {
            color: #666;
            font-size: 14px;
        }
        .stat-item .value {
            font-weight: bold;
            font-size: 18px;
            color: #333;
        }

        .results-table {
            background: white;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            margin-bottom: 20px;
        }
        .results-table h2 {
            padding: 20px;
            margin: 0;
            background: #f8f9fa;
            border-bottom: 2px solid #e9ecef;
        }
        table {
            width: 100%;
            border-collapse: collapse;
        }
        th, td {
            padding: 12px 15px;
            text-align: left;
            border-bottom: 1px solid #e9ecef;
        }
        th {
            background-color: #f8f9fa;
            font-weight: 600;
            color: #495057;
            position: sticky;
            top: 0;
        }
        tr:hover {
            background-color: #f8f9fa;
        }
        .status-badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
        }
        .status-pass {
            background-color: #d1fae5;
            color: #065f46;
        }
        .status-fail {
            background-color: #fee2e2;
            color: #991b1b;
        }
        .status-error {
            background-color: #fef3c7;
            color: #92400e;
        }
        .status-session_lost {
            background-color: #ede9fe;
            color: #5b21b6;
        }
        .status-warning-badge {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 8px;
            font-size: 11px;
            font-weight: 600;
            background-color: #fef9c3;
            color: #92400e;
            border: 1px solid #fde68a;
            margin-left: 4px;
        }
        .url-cell {
            max-width: 400px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .error-details {
            background-color: #fff3cd;
            padding: 10px;
            margin-top: 5px;
            border-left: 3px solid #ffc107;
            font-size: 12px;
            border-radius: 4px;
        }
        .error-found-section {
            text-align: left;
            font-size: 13px;
        }
        .error-found-section strong {
            display: block;
            margin-bottom: 8px;
        }
        .error-found-section a {
            display: inline-block;
            padding: 6px 12px;
            background-color: #3b82f6;
            color: white !important;
            text-decoration: none;
            border-radius: 4px;
            font-size: 12px;
            transition: background-color 0.2s;
        }
        .error-found-section a:hover {
            background-color: #2563eb;
        }
        .error-messages-section {
            margin-top: 20px;
            padding: 20px;
            background-color: white;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .error-messages-section h3 {
            margin: 0 0 15px 0;
            color: #333;
            font-size: 18px;
        }
        .error-category {
            margin-bottom: 20px;
        }
        .error-category-title {
            font-size: 13px;
            font-weight: 600;
            color: #666;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 8px;
            padding-bottom: 8px;
            border-bottom: 1px solid #e9ecef;
        }
        .error-badge {
            display: inline-block;
            padding: 6px 12px;
            margin: 4px 6px 4px 0;
            background-color: #e8f0ff;
            color: #0052cc;
            border-radius: 16px;
            font-size: 12px;
            border: 1px solid #d0e0ff;
            font-weight: 500;
        }
        .badge-grid {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
        }
        .footer {
            text-align: center;
            padding: 20px;
            color: #666;
            font-size: 14px;
        }
        @media print {
            .header {
                background: #667eea;
                -webkit-print-color-adjust: exact;
                print-color-adjust: exact;
            }
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🔍 Error Message Validation Test Report</h1>
        <p>Generated on: ${new Date().toISOString().replace('T', ' ').substr(0, 19)}</p>
        <p>Browser: ${this.browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome'}</p>
    </div>

    <div class="summary">
        <div class="summary-card">
            <h3>Total Tests</h3>
            <div class="value info">${totalTests}</div>
        </div>
        <div class="summary-card">
            <h3>Passed</h3>
            <div class="value passed">${passed}</div>
            <div class="percentage">${passPercentage}%</div>
        </div>
        <div class="summary-card">
            <h3>Failed</h3>
            <div class="value failed">${failed}</div>
            <div class="percentage">${failedPercentage}%</div>
        </div>
        <div class="summary-card">
            <h3>Errors</h3>
            <div class="value error">${errors}</div>
            <div class="percentage">${errorsPercentage}%</div>
        </div>
    </div>

    <div class="stats-grid">
        <div class="stat-item">
            <span class="label">Total Duration</span>
            <span class="value">${totalExecutionTime}s</span>
        </div>
        <div class="stat-item">
            <span class="label">Average Duration</span>
            <span class="value">${avgDuration}s</span>
        </div>
        <div class="stat-item">
            <span class="label">Cookie Consents Handled</span>
            <span class="value">${consentHandledCount}</span>
        </div>
        <div class="stat-item">
            <span class="label">Total Errors Found</span>
            <span class="value">${totalErrorsFound}</span>
        </div>
        ${cookieWarningCount > 0 ? `<div class="stat-item"><span class="label">⚠️ Cookie Banner Warnings</span><span class="value" style="color:#92400e">${cookieWarningCount}</span></div>` : ''}
        ${sessionLostCount > 0 ? `<div class="stat-item"><span class="label">🔴 Session Lost</span><span class="value" style="color:#5b21b6">${sessionLostCount}</span></div>` : ''}
        ${screenshotFailedCount > 0 ? `<div class="stat-item"><span class="label">📸 Screenshot Failures</span><span class="value" style="color:#ef4444">${screenshotFailedCount}</span></div>` : ''}
        ${skippedRows.length > 0 ? `<div class="stat-item"><span class="label">⏭️ CSV Rows Skipped</span><span class="value" style="color:#6b7280">${skippedRows.length}</span></div>` : ''}
    </div>

    <div class="error-messages-section">
        <h3>✓ Error Messages Being Checked (${this.errorMessages.length} total)</h3>
        <div class="error-category">
            <div class="error-category-title">Application Specific Errors</div>
            <div class="badge-grid">
                <span class="error-badge">We can't find that page</span>
                <span class="error-badge">Fund performance unavailable</span>
                <span class="error-badge">Rendering error</span>
                <span class="error-badge">Site can't be reached</span>
                <span class="error-badge">Policy details unavailable</span>
                <span class="error-badge">Technical difficulties</span>
                <span class="error-badge">AI guidelines registration</span>
                <span class="error-badge">Webpage not found</span>
                <span class="error-badge">Application unavailable</span>
            </div>
        </div>
        <div class="error-category">
            <div class="error-category-title">4xx Client Errors</div>
            <div class="badge-grid">
                <span class="error-badge">404 Not Found</span>
                <span class="error-badge">403 Forbidden</span>
                <span class="error-badge">Access Denied</span>
                <span class="error-badge">401 Unauthorized</span>
                <span class="error-badge">Authentication Required</span>
                <span class="error-badge">429 Too Many Requests</span>
                <span class="error-badge">Rate Limit Exceeded</span>
            </div>
        </div>
        <div class="error-category">
            <div class="error-category-title">5xx Server Errors</div>
            <div class="badge-grid">
                <span class="error-badge">500 Internal Server Error</span>
                <span class="error-badge">502 Bad Gateway</span>
                <span class="error-badge">503 Service Unavailable</span>
                <span class="error-badge">Service Temporarily Unavailable</span>
                <span class="error-badge">504 Gateway Timeout</span>
            </div>
        </div>
    </div>

    <div class="results-table">
        <h2>📋 Detailed Test Results</h2>
        <table>
            <thead>
                <tr>
                    <th>#</th>
                    <th>URL</th>
                    <th>Status</th>
                    <th>Timestamp</th>
                    <th>Duration</th>
                    <th>Errors Found</th>
                    <th>Details</th>
                </tr>
            </thead>
            <tbody>
                ${this.testResults.map((result, index) => `
                <tr>
                    <td>${index + 1}</td>
                    <td class="url-cell" title="${escapeHtml(result.url)}">${escapeHtml(result.url)}</td>
                    <td>
                        <span class="status-badge status-${result.status.toLowerCase()}">
                            ${result.status === 'PASS' ? '✓ ' : result.status === 'FAIL' ? '✗ ' : result.status === 'SESSION_LOST' ? '🔴 ' : '⚠ '}${result.status}
                        </span>
                        ${result.cookie_warning ? '<span class="status-warning-badge">🍪 banner?</span>' : ''}
                        ${result.screenshot_failed ? '<span class="status-warning-badge">📸 no screenshot</span>' : ''}
                    </td>
                    <td style="font-size: 12px; white-space: nowrap;">${result.timestamp || 'N/A'}</td>
                    <td>${(result.duration || 0).toFixed(2)}s</td>
                    <td><span class="${result.error_count > 0 ? 'failed' : ''}" style="font-weight: bold;">${result.error_count || 0}</span></td>
                    <td>
                        ${result.status === 'FAIL' && result.errors && result.errors.length > 0 ? `
                        <div class="error-found-section">
                            <strong style="color: #ef4444;">⚠️ Errors Found:</strong>
                            <div class="error-details" style="margin-top: 8px; padding-left: 15px;">
                                ${result.errors.map((err, idx) => `
                                <div style="margin-bottom: 8px; padding: 8px; background-color: #fee; border-left: 3px solid #ef4444; border-radius: 3px;">
                                    <strong>Error ${idx + 1}:</strong> ${escapeHtml(err.message)}
                                    ${err.location ? `<br><small style="color: #666;">Location: ${escapeHtml(err.location)}</small>` : ''}
                                    ${err.element_details ? `<br><small style="color: #666;">Element: ${escapeHtml(err.element_details.tag || 'N/A')}</small>` : ''}
                                </div>
                                `).join('')}
                            </div>
                            ${result.screenshot ? `
                            <div style="margin-top: 10px;">
                                <a href="screenshots/${encodeURIComponent(result.screenshot)}" target="_blank" style="color: #3b82f6; text-decoration: none; font-weight: bold;">
                                    📸 View Screenshot
                                </a>
                            </div>
                            ` : ''}
                        </div>
                        ` : result.status === 'PASS' ? `
                        <span style="color: #10b981;">✓ No errors detected</span>
                        ` : result.status === 'SESSION_LOST' ? `
                        <span style="color: #5b21b6;">🔴 Browser session lost — URL was not tested. Will be retried on next run.</span>
                        ` : `
                        <span style="color: #f59e0b;">${escapeHtml(result.details || 'Test error occurred')}</span>
                        `}
                    </td>
                </tr>
                `).join('')}
            </tbody>
        </table>
    </div>

    ${skippedRows.length > 0 ? `
    <div style="background:white;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1);margin-bottom:20px;overflow:hidden">
        <details>
            <summary style="padding:16px 20px;font-weight:600;cursor:pointer;background:#f8f9fa;border-bottom:1px solid #e9ecef">
                ⏭️ CSV Rows Skipped (${skippedRows.length}) — these URLs were NOT tested
            </summary>
            <table style="width:100%;border-collapse:collapse">
                <thead><tr>
                    <th style="padding:10px 15px;text-align:left;background:#f8f9fa;border-bottom:1px solid #e9ecef">Row #</th>
                    <th style="padding:10px 15px;text-align:left;background:#f8f9fa;border-bottom:1px solid #e9ecef">Reason</th>
                    <th style="padding:10px 15px;text-align:left;background:#f8f9fa;border-bottom:1px solid #e9ecef">Raw Value</th>
                </tr></thead>
                <tbody>
                    ${skippedRows.map(s => `<tr>
                        <td style="padding:8px 15px;border-bottom:1px solid #e9ecef">${s.row}</td>
                        <td style="padding:8px 15px;border-bottom:1px solid #e9ecef;color:#92400e">${escapeHtml(s.reason)}</td>
                        <td style="padding:8px 15px;border-bottom:1px solid #e9ecef;font-family:monospace;font-size:12px;max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml((s.raw || '').substring(0, 120))}</td>
                    </tr>`).join('')}
                </tbody>
            </table>
        </details>
    </div>` : ''}
    <div class="footer">
        <p>Report generated by Error Message Validator (Node.js/Selenium)</p>
    </div>
</body>
</html>`;

        try {
            fs.writeFileSync(this.reportPath, htmlContent);
            console.log(`\n📄 HTML report generated: ${this.reportPath}`);
            return this.reportPath;
        } catch (error) {
            console.error(`Error generating HTML report: ${error.message}`);
            return null;
        }
    }

    generateCsvReport(environment = '') {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').substr(0, 19);
        const envPrefix = environment ? `${environment}_` : '';
        const csvFilename = `${envPrefix}validation_results_${timestamp}.csv`;
        const csvPath = path.join(this.reportsDirPath, csvFilename);

        const headers = ['URL', 'Status', 'Error Found', 'Error Count', 'Errors Detected', 'Duration (sec)', 'Timestamp', 'Consent Handled', 'In Page Source', 'Page Loaded'];
        const csvRows = [headers.map(h => `"${h}"`).join(',')];

        this.testResults.forEach(result => {
            const errorDetails = result.errors && result.errors.length > 0
                ? result.errors.map(e => e.message).join(' | ')
                : result.error_message || 'N/A';

            const row = [
                `"${(result.url || 'N/A').replace(/"/g, '""')}"`,
                `"${result.status}"`,
                `"${result.error_found ? 'YES' : 'NO'}"`,
                `"${result.error_count || 0}"`,
                `"${errorDetails.replace(/"/g, '""')}"`,
                `"${(result.duration || 0).toFixed(2)}"`,
                `"${result.timestamp || 'N/A'}"`,
                `"${result.consent_handled ? 'YES' : 'NO'}"`,
                `"${result.in_page_source ? 'YES' : 'NO'}"`,
                `"${result.page_loaded ? 'YES' : 'NO'}"`
            ];
            csvRows.push(row.join(','));
        });

        csvRows.push('');
        csvRows.push('SUMMARY');
        csvRows.push(`Total Tests,${this.testResults.length}`);
        csvRows.push(`Passed,${this.testResults.filter(r => r.status === 'PASS').length}`);
        csvRows.push(`Failed,${this.testResults.filter(r => r.status === 'FAIL').length}`);
        csvRows.push(`Errors,${this.testResults.filter(r => r.status === 'ERROR').length}`);
        csvRows.push(`Total Errors Found,${this.testResults.reduce((sum, r) => sum + (r.error_count || 0), 0)}`);
        const totalDuration = this.testResults.reduce((sum, r) => sum + (r.duration || 0), 0);
        csvRows.push(`Total Duration (sec),${totalDuration.toFixed(2)}`);
        csvRows.push(`Generated,${new Date().toISOString()}`);

        const csvContent = csvRows.join('\n');
        try {
            fs.writeFileSync(csvPath, csvContent, 'utf-8');
            console.log(`\n📊 CSV report generated: ${csvPath}`);
            return csvPath;
        } catch (error) {
            console.error(`Error generating CSV report: ${error.message}`);
            return null;
        }
    }

    printSummary(results) {
        console.log('\n' + '='.repeat(80));
        console.log('TEST EXECUTION SUMMARY');
        console.log('='.repeat(80));
        console.log(`Total URLs Tested: ${results.total}`);
        console.log(`✅ Passed: ${results.passed}`);
        console.log(`❌ Failed: ${results.failed}`);
        console.log(`⚠️  Errors: ${results.errors}`);
        if ((results.session_lost || 0) > 0) console.log(`🔴 Session Lost: ${results.session_lost} (URL was not tested — browser died)`);
        if ((results.skipped || 0) > 0) console.log(`⏭️  CSV Rows Skipped: ${results.skipped} (see HTML report for details)`);
        console.log('='.repeat(80));

        if (results.failed > 0) {
            console.log('\nURLs with errors found:');
            results.details
                .filter(d => d.status === 'FAIL')
                .forEach(d => console.log(`  - ${d.url}`));
        }
        if (results.errors > 0) {
            console.log('\nURLs with errors:');
            results.details
                .filter(d => d.status === 'ERROR')
                .forEach(d => console.log(`  - ${d.url}: ${d.error_message || 'Unknown error'}`));
        }
    }

    async close() {
        if (this.driver) {
            try {
                await this.driver.quit();
            } catch (error) {
                // ignore
            }
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Helper: extract environment from CSV (unchanged)
function getEnvironmentFromCsv(csvFilePath) {
    try {
        const csvContent = fs.readFileSync(csvFilePath, 'utf-8');
        const lines = csvContent.split('\n').filter(line => line.trim());
        if (lines.length < 2) return '';
        const firstLine = lines[0].toLowerCase();
        if (!firstLine.startsWith('http')) {
            const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
            const envIndex = headers.indexOf('environment');
            if (envIndex !== -1 && lines.length > 1) {
                const secondLine = lines[1].split(',');
                return secondLine[envIndex] ? secondLine[envIndex].trim() : '';
            }
        }
        return '';
    } catch (error) {
        console.warn(`Warning: Could not read environment from CSV: ${error.message}`);
        return '';
    }
}

// Main execution with command-line arguments
async function main() {
    const args = process.argv.slice(2);
    let CSV_FILE_PATH = "url.csv";
    let COLUMN_INDEX = 0;
    let BROWSER = "edge";
    let HEADLESS = true;

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--file':
                if (i + 1 < args.length) CSV_FILE_PATH = args[++i];
                break;
            case '--column':
                if (i + 1 < args.length) COLUMN_INDEX = parseInt(args[++i], 10);
                break;
            case '--browser':
                if (i + 1 < args.length) BROWSER = args[++i].toLowerCase();
                break;
            case '--headed':
                HEADLESS = false;
                break;
            case '--headless':
                HEADLESS = true;
                break;
            case '--help':
                console.log(`
Usage: node error_validator.js [options]

Options:
  --file <path>      Path to CSV file (default: url.csv)
  --column <number>  Column index (0-based) containing URLs (default: 0)
  --browser <name>   Browser: "chrome" or "edge" (default: edge)
  --headed           Run with visible browser window (default: headless)
  --headless         Run in headless mode (default)
  --help             Show this help
                `);
                process.exit(0);
        }
    }

    if (!path.isAbsolute(CSV_FILE_PATH)) {
        CSV_FILE_PATH = path.join(__dirname, CSV_FILE_PATH);
    }

    if (!fs.existsSync(CSV_FILE_PATH)) {
        console.error(`Error: CSV file not found: ${CSV_FILE_PATH}`);
        process.exit(1);
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').substr(0, 19);
    const REPORTS_DIR = path.join(__dirname, 'Reports');
    const ENVIRONMENT = getEnvironmentFromCsv(CSV_FILE_PATH);
    const REPORT_FILE_PATH = path.join(REPORTS_DIR, `${ENVIRONMENT}_ErrorMessageValidation_${timestamp}.html`);

    if (!fs.existsSync(REPORTS_DIR)) {
        fs.mkdirSync(REPORTS_DIR, { recursive: true });
    }

    const validator = new ErrorMessageValidator({
        headless: HEADLESS,
        reportPath: REPORT_FILE_PATH,
        browser: BROWSER,
        environment: ENVIRONMENT
    });

    let isShuttingDown = false;
    const gracefulShutdown = async (signal) => {
        if (isShuttingDown) return;
        isShuttingDown = true;
        console.log(`\n${signal} received, shutting down gracefully...`);
        try {
            await validator.close();
            console.log('Browser closed.');
        } catch (e) {
            console.error('Error during shutdown:', e.message);
        }
        process.exit(0);
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    try {
        await validator.setupDriver();
        console.log('Starting error message validation...');
        if (ENVIRONMENT) console.log(`Environment: ${ENVIRONMENT}`);
        console.log(`Browser: ${BROWSER}, Headless: ${HEADLESS}`);
        console.log(`CSV file: ${CSV_FILE_PATH}, URL column: ${COLUMN_INDEX}`);

        const results = await validator.runFromCsv(CSV_FILE_PATH, COLUMN_INDEX, false);

        const htmlReportFile = validator.generateHtmlReport();
        const csvReportFile = validator.generateCsvReport(ENVIRONMENT);

        validator.printSummary(results);

        if (htmlReportFile) {
            console.log(`\n📄 HTML Report: ${htmlReportFile}`);
        } else {
            console.log('\n⚠️ HTML report generation failed');
        }
        if (csvReportFile) {
            console.log(`\n📊 CSV Report: ${csvReportFile}`);
        } else {
            console.log('\n⚠️ CSV report generation failed');
        }

        const exitCode = (results.failed > 0 || results.errors > 0) ? 1 : 0;
        await validator.close();
        process.exit(exitCode);

    } catch (error) {
        console.error(`\nCritical error: ${error.message}`);
        await validator.close();
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = ErrorMessageValidator;