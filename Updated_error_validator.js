const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Builder, By, until } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');
const edge = require('selenium-webdriver/edge');

class ErrorMessageValidator {
    constructor(options = {}) {
        this.reportsDirPath = options.reportsDirPath || path.join(__dirname, 'Reports');
        this.screenshotDir = options.screenshotDir || path.join(this.reportsDirPath, 'screenshots');
        this.errorMessages = [
            // ── Application-specific errors ──────────────────────────────────────────
            "We can't find that page",
            "We apologize, fund performance is temporarily unavailable.",
            "A problem occurred while rendering this section.",
            "This site can't be reached",
            "Details for this policy are no longer available. Please return to the",
            "We Are Having Technical Difficulties",
            "Please first review the guidelines below and register to participate in using Generative AI websites",
            "No webpage was found for the web address",
            "Application Unavailable",
            // ── 4xx ─────────────────────────────────────────────────────────────────
            "404 Not Found", "404 – Not Found", "404 — Not Found", "Error 404",
            "403 Forbidden", "403 – Forbidden", "403 — Forbidden", "Error 403",
            "Access Denied", "Access denied",
            "401 Unauthorized", "401 – Unauthorized", "401 — Unauthorized", "Error 401",
            "Authentication required",
            "429 Too Many Requests", "429 – Too Many Requests", "429 — Too Many Requests",
            "Error 429", "Rate limit exceeded", "Too Many Requests",
            // ── 5xx ─────────────────────────────────────────────────────────────────
            "500 Internal Server Error", "500 – Internal Server Error",
            "500 — Internal Server Error", "Error 500", "Internal Server Error",
            "502 Bad Gateway", "502 – Bad Gateway", "502 — Bad Gateway", "Error 502",
            "503 Service Unavailable", "503 – Service Unavailable",
            "503 — Service Unavailable", "Error 503", "Service Unavailable",
            "Service temporarily unavailable",
            "504 Gateway Timeout", "504 – Gateway Timeout", "504 — Gateway Timeout",
            "Error 504", "Gateway Timeout"
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
        this.maxUrlsPerSession = options.maxUrlsPerSession || 30;
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

    // ─── Driver setup ─────────────────────────────────────────────────────────────
    async setupDriver() {
        if (this.browser === 'edge') {
            await this.setupEdgeDriver();
        } else {
            await this.setupChromeDriver();
        }
    }

    async setupChromeDriver() {
        const options = new chrome.Options();
        if (this.headless) options.addArguments('--headless');
        options.addArguments('--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
            '--window-size=1920,1080', '--ignore-certificate-errors', '--ignore-ssl-errors',
            '--disable-extensions', '--disable-plugins', '--disable-default-apps',
            '--disable-sync', '--disable-notifications');
        options.setUserPreferences({ 'profile.managed_default_content_settings.images': 2 });
        try {
            this.driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
            await this.driver.manage().setTimeouts({ implicit: 5000, pageLoad: 30000 });
            console.log('Chrome WebDriver initialized successfully');
        } catch (error) {
            console.error('Error initializing Chrome WebDriver:', error.message);
            process.exit(1);
        }
    }

    async setupEdgeDriver() {
        const options = new edge.Options();
        if (this.headless) options.addArguments('--headless');
        options.addArguments('--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
            '--window-size=1920,1080', '--ignore-certificate-errors', '--ignore-ssl-errors',
            '--disable-extensions', '--disable-plugins', '--disable-default-apps',
            '--disable-sync', '--disable-notifications',
            '--disable-features=EdgeLLM,OnDeviceModel', '--log-level=3');
        options.setUserPreferences({ 'profile.managed_default_content_settings.images': 2 });
        try {
            this.driver = await new Builder().forBrowser('MicrosoftEdge').setEdgeOptions(options).build();
            await this.driver.manage().setTimeouts({ implicit: 5000, pageLoad: 30000 });
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
        } catch (_) { return false; }
    }

    async reinitializeDriver() {
        console.log('   ⚠️ Session lost, reinitializing browser...');
        try { await this.driver.quit(); } catch (_) { /* ignore */ }
        if (this.browser === 'edge') await this.setupEdgeDriver();
        else await this.setupChromeDriver();
    }

    // ─── Cookie consent (1s timeout) ────────────────────────────────────────────
    async handleCookieConsent() {
        console.log('   - Checking for cookie consent banners...');
        let consentHandled = false;
        let consentWarning = false;
        const CONSENT_TIMEOUT_MS = 1000;
        const consentStart = Date.now();
        const isTimedOut = () => (Date.now() - consentStart) >= CONSENT_TIMEOUT_MS;

        const combinedSelector = [
            'div[id="truste-consent-track"]',
            'button[class*="accept"]', 'button[id*="accept"]',
            'button[class*="consent"]', 'button[id*="consent"]',
            'button[class*="agree"]', 'button[id*="agree"]'
        ].join(',');

        try {
            const elements = await this.driver.findElements(By.css(combinedSelector));
            for (const element of elements) {
                if (isTimedOut()) { consentWarning = true; break; }
                try {
                    if (await element.isDisplayed() && await element.isEnabled()) {
                        const text = await element.getText();
                        if (/accept|agree|ok/i.test(text)) {
                            console.log(`     Clicking consent button: '${text}'`);
                            await element.click();
                            consentHandled = true;
                            try {
                                await this.driver.wait(until.stalenessOf(element), 1500);
                            } catch (_) { /* ignore */ }
                            break;
                        }
                    }
                } catch (_) { continue; }
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

    // ─── Page load (tight timeouts) ─────────────────────────────────────────────
    async waitForPageLoad(timeout = 10000) {
        try {
            console.log('   Waiting for page to be fully ready...');
            // 1. Document ready (3s)
            try {
                await this.driver.wait(async () => {
                    return await this.driver.executeScript('return document.readyState') === 'complete';
                }, 3000);
                console.log('   ✓ Document ready state is complete');
            } catch (_) { console.log('   ⚠ Document ready timeout (continuing anyway)'); }

            // 2. Main content check
            console.log('   → Detecting main content element...');
            try {
                const mainContentFound = await this.driver.executeScript(`
                    const selectors = ['main','[role="main"]','article','.container','[class*="content"]','.main-content','#main','[id*="main"]'];
                    for (const s of selectors) {
                        const el = document.querySelector(s);
                        if (el && el.offsetHeight > 0) return true;
                    }
                    return (document.body.innerText || '').trim().length > 100;
                `);
                console.log(mainContentFound ? '   ✓ Main content element detected' : '   ⚠ Main content not explicitly detected (continuing anyway)');
            } catch (_) { console.log('   ⚠ Main content detection failed (continuing anyway)'); }

            // 3. Loading indicators (5s)
            console.log('   → Checking for loading indicators...');
            try {
                await this.driver.wait(async () => {
                    return await this.driver.executeScript(`
                        const selectors = ['[class*="loading"]','[class*="spinner"]','[id*="loading"]','[id*="spinner"]',
                            '.loader','.preloader','.progress','[class*="skeleton"]','[data-testid*="loading"]','.lds-ring','.sk-spinner'];
                        for (const s of selectors) {
                            const els = document.querySelectorAll(s);
                            for (const el of els) {
                                if (el.offsetHeight > 0 && el.offsetWidth > 0) {
                                    const style = window.getComputedStyle(el);
                                    if (style.display !== 'none' && style.visibility !== 'hidden') return false;
                                }
                            }
                        }
                        return true;
                    `);
                }, 5000);
                console.log('   ✓ Loading indicators removed');
            } catch (_) { console.log('   ⚠ Loading indicators still present (timeout)'); }

            // 4. Content stability (shorter)
            console.log('   → Stabilizing dynamic content...');
            try {
                const stabilityResult = await this.driver.executeScript(`
                    return new Promise((resolve) => {
                        let prev = { text: document.body.innerText.length, count: document.querySelectorAll('*').length };
                        let stable = 0, attempts = 0;
                        const check = () => {
                            const curr = { text: document.body.innerText.length, count: document.querySelectorAll('*').length };
                            if (curr.text === prev.text && curr.count === prev.count) stable++;
                            else stable = 0;
                            if (stable >= 2) { resolve({ stable: true }); return; }
                            prev = curr;
                            attempts++;
                            if (attempts >= 6) {
                                resolve({ stable: curr.text > 500 });
                                return;
                            }
                            setTimeout(check, 150);
                        };
                        check();
                    });
                `);
                console.log(stabilityResult.stable ? '   ✓ Content stability check passed' : '   ⚠ Content stability check failed');
            } catch (_) { console.log('   ⚠ Content stability check failed'); }

            // 5. Error polling (1.5s)
            console.log('   → Final error monitoring (1500ms)...');
            const pollStart = Date.now();
            let pollResults = [];
            while (Date.now() - pollStart < 1500) {
                try {
                    const found = await this.driver.executeScript(`
                        const errors = [];
                        const target = 'We apologize, fund performance is temporarily unavailable.';
                        const candidates = document.querySelectorAll(
                            'bolt-notification, nw-notification, [class*="notification"], [role="alert"], [class*="alert"], [class*="error"], [class*="warning"]'
                        );
                        for (const el of candidates) {
                            const text = el.textContent || el.innerText || '';
                            const style = window.getComputedStyle(el);
                            if (text.includes(target) && style.display !== 'none' && style.visibility !== 'hidden') {
                                if (!errors.includes(target)) errors.push(target);
                            }
                        }
                        const body = document.body.innerText || '';
                        ['We can\'t find that page','A problem occurred while rendering this section.','This site can\'t be reached']
                            .forEach(m => { if (body.includes(m)) errors.push(m); });
                        return errors;
                    `);
                    if (found && found.length > 0) {
                        pollResults = found;
                        console.log(`   ⚠ Error(s) detected during polling: ${found.join(', ')}`);
                        break;
                    }
                } catch (_) { /* continue */ }
                await this.sleep(150);
            }
            console.log('   ✓ Ongoing monitoring completed');
            this.polledErrors = pollResults;
            return true;
        } catch (error) {
            console.log(`⚠️ Warning: Page load timeout after ${timeout / 1000} seconds`);
            console.log('   Continuing with validation despite timeout...');
            return false;
        }
    }

    // ─── Combined error check ──────────────────────────────────────────────────
    async checkAllErrors() {
        try {
            const result = await this.driver.executeScript(`
                function getVisibleText(el) {
                    if (!el || el.nodeType !== 1) return '';
                    const tag = el.tagName.toLowerCase();
                    if (['script','style','noscript'].includes(tag)) return '';
                    const style = window.getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return '';
                    let text = '';
                    for (let child of el.childNodes) {
                        if (child.nodeType === 3) text += child.textContent;
                        else if (child.nodeType === 1) text += getVisibleText(child);
                    }
                    return text;
                }
                const visibleText = getVisibleText(document.body);
                const cleanHTML = (() => {
                    const clone = document.body.cloneNode(true);
                    clone.querySelectorAll('script, style, noscript').forEach(el => el.remove());
                    return clone.innerHTML;
                })();

                // Rendering errors
                const renderingErrors = [];
                const renderMsg = "A problem occurred while rendering this section";
                document.querySelectorAll('div.alert.alert-danger, [class*="error"][class*="alert"]').forEach(div => {
                    const txt = div.textContent || div.innerText || '';
                    if (txt.includes(renderMsg)) {
                        renderingErrors.push({ tag: div.tagName, class: div.className || '', id: div.id || '', text: txt.trim().substring(0,200), visible: true, type: 'alert_div' });
                    }
                });
                document.querySelectorAll('body *:not(script):not(style):not(noscript)').forEach(el => {
                    const style = window.getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;
                    const txt = el.textContent || el.innerText || '';
                    if (txt.includes(renderMsg)) {
                        renderingErrors.push({
                            tag: el.tagName, class: el.className || '', id: el.id || '',
                            text: txt.trim().substring(0,200), visible: true,
                            parent: el.parentElement ? { tag: el.parentElement.tagName, class: el.parentElement.className || '', id: el.parentElement.id || '' } : null
                        });
                    }
                });

                // Main error detection
                const found = [];
                const errorMessages = arguments[0] || [];
                const ambiguousSet = new Set(arguments[1] || []);

                for (const msg of errorMessages) {
                    if (msg === 'A problem occurred while rendering this section.' || msg === 'A problem occurred while rendering this section') continue;

                    if (msg === 'We apologize, fund performance is temporarily unavailable.') {
                        const target = msg;
                        let foundFund = false;
                        document.querySelectorAll(
                            'bolt-notification, nw-notification, [class*="notification"], [role="alert"], [class*="alert"], [class*="error"], [class*="warning"], .message.error, .alert-danger, .alert-warning, .error-message, .fund-error, [data-test*="error"]'
                        ).forEach(el => {
                            const txt = el.textContent || el.innerText || '';
                            if (txt.includes(target)) {
                                const style = window.getComputedStyle(el);
                                if (style.display !== 'none' && style.visibility !== 'hidden') foundFund = true;
                            }
                        });
                        if (!foundFund) {
                            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null);
                            let node;
                            while ((node = walker.nextNode())) {
                                const direct = Array.from(node.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('');
                                if (direct.includes(target)) {
                                    const style = window.getComputedStyle(node);
                                    if (style.display !== 'none' && style.visibility !== 'hidden') { foundFund = true; break; }
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
                            let contextFound = false;
                            document.querySelectorAll(
                                '[role="alert"], [role="status"], .alert, .alert-danger, .alert-warning, .alert-error, [class*="error"], [class*="banner"], h1, h2'
                            ).forEach(el => {
                                const txt = el.textContent || el.innerText || '';
                                const style = window.getComputedStyle(el);
                                if (txt.includes(msg) && style.display !== 'none' && style.visibility !== 'hidden') contextFound = true;
                            });
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
                return { foundMessages: found, renderingErrors, pageTitle: document.title };
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

    // ─── Highlight & screenshot ──────────────────────────────────────────────
    async highlightAndScrollToError(errorMessages) {
        try {
            const jsScript = `
            var errorTexts = ${JSON.stringify(errorMessages)};
            var bestElement = null, bestLength = Infinity;
            document.querySelectorAll('*').forEach(el => {
                var tag = el.tagName.toLowerCase();
                if (['html','body','head','script','style','noscript'].includes(tag)) return;
                var style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;
                var text = (el.textContent || el.innerText || '').trim();
                if (text.length === 0 || text.length > bestLength) return;
                for (var j = 0; j < errorTexts.length; j++) {
                    if (text.includes(errorTexts[j])) {
                        bestElement = el;
                        bestLength = text.length;
                        break;
                    }
                }
            });
            if (bestElement) {
                bestElement.style.outline = '4px solid red';
                bestElement.style.outlineOffset = '4px';
                bestElement.style.backgroundColor = 'rgba(255, 0, 0, 0.15)';
                bestElement.style.boxShadow = '0 0 0 6px rgba(255,0,0,0.4)';
                bestElement.scrollIntoView({behavior: 'instant', block: 'center', inline: 'center'});
                var badge = document.createElement('div');
                badge.id = '__ev_error_badge__';
                badge.textContent = '⛔ ERROR DETECTED';
                badge.style.cssText = 'position:fixed;top:0;left:0;width:100%;background:#b91c1c;color:#fff;font:bold 18px/40px sans-serif;text-align:center;z-index:2147483647;letter-spacing:2px;box-shadow:0 4px 12px rgba(0,0,0,0.5);pointer-events:none';
                document.body.appendChild(badge);
                return true;
            }
            return false;
            `;
            const result = await this.driver.executeScript(jsScript);
            if (result) await this.sleep(300);
            return result;
        } catch (error) {
            console.log(`     ⚠️ Could not highlight error: ${error.message}`);
            return false;
        }
    }

    async removeErrorBadge() {
        try {
            await this.driver.executeScript(`document.getElementById('__ev_error_badge__')?.remove();`);
        } catch (_) { /* non-critical */ }
    }

    // ─── Validate a single URL ────────────────────────────────────────────────
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
            if (!pageLoaded) console.log('Warning: Page may not have fully loaded');

            console.log('4. Searching for error messages (combined check)...');
            const { foundMessages, renderingErrorObjects, inTitle, pageTitle } = await this.checkAllErrors();

            const allFoundErrors = [];
            const seenErrors = new Set();
            const addUnique = (msg, loc, det, elem = null) => {
                const key = msg.trim().toLowerCase();
                if (!seenErrors.has(key)) {
                    seenErrors.add(key);
                    allFoundErrors.push({ message: msg, location: loc, details: det, element_details: elem });
                    console.log(`     [Consolidation] Adding unique error: "${msg}"`);
                }
            };
            foundMessages.forEach(e => addUnique(e.message, e.location, e.details));
            renderingErrorObjects.forEach(e => addUnique(e.message, e.location || 'DOM', e.details || 'Found in page DOM', e.element_details));
            if (inTitle) addUnique('Error found in page title', 'title', `Page title: ${pageTitle}`);
            if (this.polledErrors.length > 0) {
                this.polledErrors.forEach(msg => addUnique(msg, 'polling_monitor', 'Detected during page load monitoring'));
            }

            const errorFound = allFoundErrors.length > 0;
            console.log(`\n   [CRITICAL] Total consolidated errors: ${allFoundErrors.length}`);
            console.log(`   [CRITICAL] Error found flag: ${errorFound}`);

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
                    const filename = `error_${urlPart}_${timestamp}.png`;
                    screenshotPath = path.join(this.screenshotDir, filename);

                    console.log('   📍 Locating error on page...');
                    const highlighted = await this.highlightAndScrollToError(this.errorMessages);
                    if (highlighted) console.log('   ✓ Error element highlighted and centered');

                    const base64 = await this.driver.takeScreenshot();
                    fs.writeFileSync(screenshotPath, Buffer.from(base64, 'base64'));
                    console.log(`   📸 Screenshot saved: ${path.basename(screenshotPath)}`);
                    await this.removeErrorBadge();
                } catch (screenshotError) {
                    console.log(`   🔴 Screenshot capture FAILED: ${screenshotError.message}`);
                    screenshotPath = null;
                    screenshotFailed = true;
                }
            }

            const testEnd = new Date();
            const duration = (testEnd - testStart) / 1000;

            console.log('\n5. Validation Results:');
            console.log(`   - Cookie consent handled: ${consentHandled ? 'YES' : 'NO'}`);
            console.log(`   - Total errors found: ${allFoundErrors.length}`);
            allFoundErrors.forEach((error, i) => {
                console.log(`   - Error ${i+1}: ${error.message}`);
                if (error.element_details) {
                    const elem = error.element_details;
                    console.log(`     Location: ${elem.tag || 'unknown'}`);
                    if (elem.class) console.log(`     Class: ${elem.class}`);
                    if (elem.id) console.log(`     ID: ${elem.id}`);
                }
            });

            const result = {
                url, status: errorFound ? 'FAIL' : 'PASS', error_found: errorFound,
                errors: allFoundErrors, consent_handled: consentHandled, cookie_warning: cookieWarning,
                in_page_source: foundMessages.some(e => e.location === 'page_source'),
                in_visible_text: foundMessages.some(e => e.location === 'visible_text'),
                in_overlays: false, rendering_errors: renderingErrorObjects.length > 0,
                in_title: inTitle, page_loaded: pageLoaded, duration, error_count: allFoundErrors.length,
                timestamp: testStart.toISOString().replace('T', ' ').substr(0, 19),
                screenshot: screenshotPath ? path.basename(screenshotPath) : null,
                screenshot_failed: screenshotFailed,
                details: errorFound ? `${allFoundErrors.length} error(s) found` : "No error messages found"
            };
            this.testResults.push(result);
            if (errorFound) {
                console.log(`\n❌ RESULT: FAIL - ${allFoundErrors.length} error(s) found`);
                allFoundErrors.forEach(e => console.log(`   • ${e.message}`));
            } else {
                console.log('\n✅ RESULT: PASS - No error messages found');
            }
            return { success: !errorFound, result };

        } catch (error) {
            const duration = (new Date() - testStart) / 1000;
            const msg = error.message || '';
            const isTimeout = msg.includes('timeout') || msg.includes('Timed out');
            const isNetwork = isTimeout || /net::|ERR_|ECONNREFUSED|ENOTFOUND|ECONNRESET/.test(msg);
            const isSession = /no such session|invalid session id|session deleted|Unable to find a matching set of capabilities|WebDriverError/.test(msg);
            const shouldRetry = (isNetwork || isSession) && retryCount < 1;

            if (shouldRetry) {
                const reason = isSession ? 'Browser session died' : isTimeout ? 'Page load timeout' : 'Network error';
                console.log(`⚠️ ${reason} detected, retrying with fresh browser...`);
                try {
                    await this.close();
                    await this.setupDriver();
                    this.urlsTestedWithCurrentDriver = 0;
                } catch (e) { console.log(`⚠️ Error during retry setup: ${e.message}`); }
                return await this.validatePage(url, retryCount + 1);
            }

            if (isSession) {
                console.log(`\n🔴 RESULT: SESSION_LOST — Browser session unrecoverable for: ${url}`);
                this.sessionLostCount++;
                const result = {
                    url, status: 'SESSION_LOST', error_found: false,
                    error_message: error.message, duration,
                    timestamp: testStart.toISOString().replace('T', ' ').substr(0, 19),
                    details: `Session lost after retry: ${error.message}`
                };
                this.testResults.push(result);
                return { success: false, result };
            }

            console.log(`\n⚠️ RESULT: ERROR - ${error.message}`);
            const result = {
                url, status: 'ERROR', error_found: false,
                error_message: error.message, duration,
                timestamp: testStart.toISOString().replace('T', ' ').substr(0, 19),
                details: `Error: ${error.message} (Duration: ${duration.toFixed(2)}s)`
            };
            this.testResults.push(result);
            return { success: false, result };
        }
    }

    // ─── Run from CSV (sequential) ────────────────────────────────────────────
    async runFromCsv(csvFilePath, urlColumn = 0) {
        this.testStartTime = new Date();
        const csvContent = fs.readFileSync(csvFilePath, 'utf-8');
        const lines = csvContent.split('\n').filter(line => line.trim());
        let startIndex = 0;
        if (lines.length > 0 && !lines[0].toLowerCase().startsWith('http')) startIndex = 1;

        const urls = lines.slice(startIndex).map(line => {
            const cols = line.split(',');
            return cols[urlColumn] ? cols[urlColumn].trim() : null;
        }).filter(url => url && url.startsWith('http'));

        this.skippedRows = [];
        lines.slice(startIndex).forEach((line, idx) => {
            const row = startIndex + idx + 1;
            const cols = line.split(',');
            if (urlColumn >= cols.length) {
                this.skippedRows.push({ row, raw: line.trim(), reason: `Column ${urlColumn} out of bounds (${cols.length} column(s))` });
            } else {
                const candidate = cols[urlColumn] ? cols[urlColumn].trim() : '';
                if (!candidate) this.skippedRows.push({ row, raw: line.trim(), reason: 'Empty cell in URL column' });
                else if (!candidate.startsWith('http')) {
                    this.skippedRows.push({ row, raw: line.trim(), reason: `Value does not start with http: "${candidate.substring(0,80)}"` });
                }
            }
        });

        if (this.skippedRows.length > 0) {
            console.log(`⚠️  CSV skipped rows: ${this.skippedRows.length} row(s) could not be loaded`);
            this.skippedRows.forEach(s => console.log(`   Row ${s.row}: ${s.reason}`));
        }
        console.log(`\nProcessing ${urls.length} URLs from CSV file...`);

        for (let i = 0; i < urls.length; i++) {
            console.log(`\n\nProcessing URL ${i + 1} of ${urls.length}\n`);
            await this.validatePage(urls[i]);
        }

        return {
            total: this.testResults.length,
            passed: this.testResults.filter(r => r.status === 'PASS').length,
            failed: this.testResults.filter(r => r.status === 'FAIL').length,
            errors: this.testResults.filter(r => r.status === 'ERROR').length,
            session_lost: this.testResults.filter(r => r.status === 'SESSION_LOST').length,
            skipped: this.skippedRows.length,
            details: this.testResults
        };
    }

    // ─── Reports ──────────────────────────────────────────────────────────────
    generateHtmlReport(environment = '') {
        const env = environment || this.environment || '';
        const total = this.testResults.length;
        const passed = this.testResults.filter(r => r.status === 'PASS').length;
        const failed = this.testResults.filter(r => r.status === 'FAIL').length;
        const errors = this.testResults.filter(r => r.status === 'ERROR').length;
        const passPct = total ? (passed / total * 100).toFixed(1) : 0;
        const failPct = total ? (failed / total * 100).toFixed(1) : 0;
        const errPct = total ? (errors / total * 100).toFixed(1) : 0;
        const totalDur = this.testResults.reduce((s, r) => s + (r.duration || 0), 0);
        const avgDur = total ? (totalDur / total).toFixed(2) : 0;
        const execTime = this.testStartTime ? ((new Date() - this.testStartTime) / 1000).toFixed(2) : 0;
        const consentCount = this.testResults.filter(r => r.consent_handled).length;
        const cookieWarn = this.testResults.filter(r => r.cookie_warning).length;
        const sessionLost = this.testResults.filter(r => r.status === 'SESSION_LOST').length;
        const screenshotFail = this.testResults.filter(r => r.screenshot_failed).length;
        const totalErrors = this.testResults.reduce((s, r) => s + (r.error_count || 0), 0);
        const skippedRows = this.skippedRows || [];

        const escape = str => String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');

        const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Error Message Validation Test Report</title>
<style>body{font-family:Arial,sans-serif;margin:20px;background:#f5f5f5}.header{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;padding:30px;border-radius:10px;margin-bottom:20px;box-shadow:0 4px 6px rgba(0,0,0,0.1)}.header h1{margin:0 0 10px;font-size:28px}.header p{margin:5px 0;opacity:.9}.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:15px;margin-bottom:20px}.summary-card{background:#fff;padding:20px;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1);text-align:center}.summary-card h3{margin:0 0 10px;font-size:14px;color:#666;text-transform:uppercase;letter-spacing:1px}.summary-card .value{font-size:32px;font-weight:700;margin-bottom:5px}.summary-card .percentage{font-size:14px;color:#888}.passed{color:#10b981}.failed{color:#ef4444}.error{color:#f59e0b}.info{color:#3b82f6}.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:15px;margin-bottom:20px}.stat-item{background:#fff;padding:15px;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1);display:flex;justify-content:space-between;align-items:center}.stat-item .label{color:#666;font-size:14px}.stat-item .value{font-weight:700;font-size:18px;color:#333}.results-table{background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 4px rgba(0,0,0,0.1);margin-bottom:20px}.results-table h2{padding:20px;margin:0;background:#f8f9fa;border-bottom:2px solid #e9ecef}table{width:100%;border-collapse:collapse}th,td{padding:12px 15px;text-align:left;border-bottom:1px solid #e9ecef}th{background:#f8f9fa;font-weight:600;color:#495057;position:sticky;top:0}tr:hover{background:#f8f9fa}.status-badge{display:inline-block;padding:4px 12px;border-radius:12px;font-size:12px;font-weight:600;text-transform:uppercase}.status-pass{background:#d1fae5;color:#065f46}.status-fail{background:#fee2e2;color:#991b1b}.status-error{background:#fef3c7;color:#92400e}.status-session_lost{background:#ede9fe;color:#5b21b6}.status-warning-badge{display:inline-block;padding:2px 8px;border-radius:8px;font-size:11px;font-weight:600;background:#fef9c3;color:#92400e;border:1px solid #fde68a;margin-left:4px}.url-cell{max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.error-details{background:#fff3cd;padding:10px;margin-top:5px;border-left:3px solid #ffc107;font-size:12px;border-radius:4px}.error-found-section{text-align:left;font-size:13px}.error-found-section strong{display:block;margin-bottom:8px}.error-found-section a{display:inline-block;padding:6px 12px;background:#3b82f6;color:#fff!important;text-decoration:none;border-radius:4px;font-size:12px;transition:background .2s}.error-found-section a:hover{background:#2563eb}.error-messages-section{margin-top:20px;padding:20px;background:#fff;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1)}.error-messages-section h3{margin:0 0 15px;color:#333;font-size:18px}.error-category{margin-bottom:20px}.error-category-title{font-size:13px;font-weight:600;color:#666;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #e9ecef}.error-badge{display:inline-block;padding:6px 12px;margin:4px 6px 4px 0;background:#e8f0ff;color:#0052cc;border-radius:16px;font-size:12px;border:1px solid #d0e0ff;font-weight:500}.badge-grid{display:flex;flex-wrap:wrap;gap:6px}.footer{text-align:center;padding:20px;color:#666;font-size:14px}@media print{.header{background:#667eea;-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head>
<body>
<div class="header"><h1>🔍 Error Message Validation Test Report</h1><p>Generated on: ${new Date().toISOString().replace('T',' ').substr(0,19)}</p><p>Browser: ${this.browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome'}</p></div>
<div class="summary">
<div class="summary-card"><h3>Total Tests</h3><div class="value info">${total}</div></div>
<div class="summary-card"><h3>Passed</h3><div class="value passed">${passed}</div><div class="percentage">${passPct}%</div></div>
<div class="summary-card"><h3>Failed</h3><div class="value failed">${failed}</div><div class="percentage">${failPct}%</div></div>
<div class="summary-card"><h3>Errors</h3><div class="value error">${errors}</div><div class="percentage">${errPct}%</div></div>
</div>
<div class="stats-grid">
<div class="stat-item"><span class="label">Total Duration</span><span class="value">${execTime}s</span></div>
<div class="stat-item"><span class="label">Average Duration</span><span class="value">${avgDur}s</span></div>
<div class="stat-item"><span class="label">Cookie Consents Handled</span><span class="value">${consentCount}</span></div>
<div class="stat-item"><span class="label">Total Errors Found</span><span class="value">${totalErrors}</span></div>
${cookieWarn > 0 ? `<div class="stat-item"><span class="label">⚠️ Cookie Banner Warnings</span><span class="value" style="color:#92400e">${cookieWarn}</span></div>` : ''}
${sessionLost > 0 ? `<div class="stat-item"><span class="label">🔴 Session Lost</span><span class="value" style="color:#5b21b6">${sessionLost}</span></div>` : ''}
${screenshotFail > 0 ? `<div class="stat-item"><span class="label">📸 Screenshot Failures</span><span class="value" style="color:#ef4444">${screenshotFail}</span></div>` : ''}
${skippedRows.length > 0 ? `<div class="stat-item"><span class="label">⏭️ CSV Rows Skipped</span><span class="value" style="color:#6b7280">${skippedRows.length}</span></div>` : ''}
</div>
<div class="error-messages-section">
<h3>✓ Error Messages Being Checked (${this.errorMessages.length} total)</h3>
<div class="error-category"><div class="error-category-title">Application Specific Errors</div><div class="badge-grid"><span class="error-badge">We can't find that page</span><span class="error-badge">Fund performance unavailable</span><span class="error-badge">Rendering error</span><span class="error-badge">Site can't be reached</span><span class="error-badge">Policy details unavailable</span><span class="error-badge">Technical difficulties</span><span class="error-badge">AI guidelines registration</span><span class="error-badge">Webpage not found</span><span class="error-badge">Application unavailable</span></div></div>
<div class="error-category"><div class="error-category-title">4xx Client Errors</div><div class="badge-grid"><span class="error-badge">404 Not Found</span><span class="error-badge">403 Forbidden</span><span class="error-badge">Access Denied</span><span class="error-badge">401 Unauthorized</span><span class="error-badge">Authentication Required</span><span class="error-badge">429 Too Many Requests</span><span class="error-badge">Rate Limit Exceeded</span></div></div>
<div class="error-category"><div class="error-category-title">5xx Server Errors</div><div class="badge-grid"><span class="error-badge">500 Internal Server Error</span><span class="error-badge">502 Bad Gateway</span><span class="error-badge">503 Service Unavailable</span><span class="error-badge">Service Temporarily Unavailable</span><span class="error-badge">504 Gateway Timeout</span></div></div>
</div>
<div class="results-table"><h2>📋 Detailed Test Results</h2><table><thead><tr><th>#</th><th>URL</th><th>Status</th><th>Timestamp</th><th>Duration</th><th>Errors Found</th><th>Details</th></tr></thead><tbody>
${this.testResults.map((r,i) => `<tr><td>${i+1}</td><td class="url-cell" title="${escape(r.url)}">${escape(r.url)}</td><td><span class="status-badge status-${r.status.toLowerCase()}">${r.status==='PASS'?'✓ ':r.status==='FAIL'?'✗ ':r.status==='SESSION_LOST'?'🔴 ':'⚠ '}${r.status}</span>${r.cookie_warning?'<span class="status-warning-badge">🍪 banner?</span>':''}${r.screenshot_failed?'<span class="status-warning-badge">📸 no screenshot</span>':''}</td><td style="font-size:12px;white-space:nowrap">${r.timestamp||'N/A'}</td><td>${(r.duration||0).toFixed(2)}s</td><td><span class="${r.error_count>0?'failed':''}" style="font-weight:700">${r.error_count||0}</span></td><td>${r.status==='FAIL' && r.errors && r.errors.length ? `<div class="error-found-section"><strong style="color:#ef4444">⚠️ Errors Found:</strong><div class="error-details" style="margin-top:8px;padding-left:15px">${r.errors.map((e,idx)=>`<div style="margin-bottom:8px;padding:8px;background:#fee;border-left:3px solid #ef4444;border-radius:3px"><strong>Error ${idx+1}:</strong> ${escape(e.message)}${e.location?`<br><small style="color:#666">Location: ${escape(e.location)}</small>`:''}${e.element_details?`<br><small style="color:#666">Element: ${escape(e.element_details.tag||'N/A')}</small>`:''}</div>`).join('')}</div>${r.screenshot?`<div style="margin-top:10px"><a href="screenshots/${encodeURIComponent(r.screenshot)}" target="_blank" style="color:#3b82f6;text-decoration:none;font-weight:700">📸 View Screenshot</a></div>`:''}</div>`:r.status==='PASS'?'<span style="color:#10b981">✓ No errors detected</span>':r.status==='SESSION_LOST'?'<span style="color:#5b21b6">🔴 Browser session lost — URL was not tested. Will be retried on next run.</span>':`<span style="color:#f59e0b">${escape(r.details||'Test error occurred')}</span>`}</td></tr>`).join('')}
</tbody></table></div>
${skippedRows.length ? `<div style="background:#fff;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1);margin-bottom:20px;overflow:hidden"><details><summary style="padding:16px 20px;font-weight:600;cursor:pointer;background:#f8f9fa;border-bottom:1px solid #e9ecef">⏭️ CSV Rows Skipped (${skippedRows.length}) — these URLs were NOT tested</summary><table style="width:100%;border-collapse:collapse"><thead><tr><th style="padding:10px 15px;text-align:left;background:#f8f9fa;border-bottom:1px solid #e9ecef">Row #</th><th style="padding:10px 15px;text-align:left;background:#f8f9fa;border-bottom:1px solid #e9ecef">Reason</th><th style="padding:10px 15px;text-align:left;background:#f8f9fa;border-bottom:1px solid #e9ecef">Raw Value</th></tr></thead><tbody>${skippedRows.map(s=>`<tr><td style="padding:8px 15px;border-bottom:1px solid #e9ecef">${s.row}</td><td style="padding:8px 15px;border-bottom:1px solid #e9ecef;color:#92400e">${escape(s.reason)}</td><td style="padding:8px 15px;border-bottom:1px solid #e9ecef;font-family:monospace;font-size:12px;max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escape((s.raw||'').substring(0,120))}</td></tr>`).join('')}</tbody></table></details></div>` : ''}
<div class="footer"><p>Report generated by Error Message Validator (Node.js/Selenium)</p></div>
</body></html>`;

        try {
            fs.writeFileSync(this.reportPath, html);
            console.log(`\n📄 HTML report generated: ${this.reportPath}`);
            return this.reportPath;
        } catch (e) {
            console.error(`Error generating HTML report: ${e.message}`);
            return null;
        }
    }

    generateCsvReport(environment = '') {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').substr(0, 19);
        const prefix = environment ? `${environment}_` : '';
        const file = `${prefix}validation_results_${ts}.csv`;
        const outPath = path.join(this.reportsDirPath, file);
        const headers = ['URL','Status','Error Found','Error Count','Errors Detected','Duration (sec)','Timestamp','Consent Handled','In Page Source','Page Loaded'];
        const rows = [headers.map(h => `"${h}"`).join(',')];
        this.testResults.forEach(r => {
            const details = r.errors && r.errors.length ? r.errors.map(e => e.message).join(' | ') : (r.error_message || 'N/A');
            rows.push([
                `"${(r.url||'N/A').replace(/"/g,'""')}"`,
                `"${r.status}"`,
                `"${r.error_found?'YES':'NO'}"`,
                `"${r.error_count||0}"`,
                `"${details.replace(/"/g,'""')}"`,
                `"${(r.duration||0).toFixed(2)}"`,
                `"${r.timestamp||'N/A'}"`,
                `"${r.consent_handled?'YES':'NO'}"`,
                `"${r.in_page_source?'YES':'NO'}"`,
                `"${r.page_loaded?'YES':'NO'}"`
            ].join(','));
        });
        rows.push('','SUMMARY');
        rows.push(`Total Tests,${this.testResults.length}`);
        rows.push(`Passed,${this.testResults.filter(r=>r.status==='PASS').length}`);
        rows.push(`Failed,${this.testResults.filter(r=>r.status==='FAIL').length}`);
        rows.push(`Errors,${this.testResults.filter(r=>r.status==='ERROR').length}`);
        rows.push(`Total Errors Found,${this.testResults.reduce((s,r)=>s+(r.error_count||0),0)}`);
        rows.push(`Total Duration (sec),${this.testResults.reduce((s,r)=>s+(r.duration||0),0).toFixed(2)}`);
        rows.push(`Generated,${new Date().toISOString()}`);
        fs.writeFileSync(outPath, rows.join('\n'), 'utf-8');
        console.log(`\n📊 CSV report generated: ${outPath}`);
        return outPath;
    }

    printSummary(results) {
        console.log('\n' + '='.repeat(80));
        console.log('TEST EXECUTION SUMMARY');
        console.log('='.repeat(80));
        console.log(`Total URLs Tested: ${results.total}`);
        console.log(`✅ Passed: ${results.passed}`);
        console.log(`❌ Failed: ${results.failed}`);
        console.log(`⚠️  Errors: ${results.errors}`);
        if (results.session_lost) console.log(`🔴 Session Lost: ${results.session_lost} (URL was not tested — browser died)`);
        if (results.skipped) console.log(`⏭️  CSV Rows Skipped: ${results.skipped} (see HTML report for details)`);
        console.log('='.repeat(80));
        if (results.failed > 0) {
            console.log('\nURLs with errors found:');
            results.details.filter(d => d.status === 'FAIL').forEach(d => console.log(`  - ${d.url}`));
        }
        if (results.errors > 0) {
            console.log('\nURLs with errors:');
            results.details.filter(d => d.status === 'ERROR').forEach(d => console.log(`  - ${d.url}: ${d.error_message || 'Unknown error'}`));
        }
    }

    async close() {
        if (this.driver) {
            try { await this.driver.quit(); } catch (_) { /* ignore */ }
        }
    }

    sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getEnvironmentFromCsv(csvFilePath) {
    try {
        const content = fs.readFileSync(csvFilePath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        if (lines.length < 2) return '';
        if (!lines[0].toLowerCase().startsWith('http')) {
            const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
            const idx = headers.indexOf('environment');
            if (idx !== -1 && lines.length > 1) {
                const cols = lines[1].split(',');
                return cols[idx] ? cols[idx].trim() : '';
            }
        }
        return '';
    } catch (_) { return ''; }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    const args = process.argv.slice(2);
    let csvFile = 'url.csv';
    let col = 0;
    let browser = 'edge';
    let headless = true;
    let parallel = 0; // 0 = sequential, >0 = number of workers

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--file': if (i+1 < args.length) csvFile = args[++i]; break;
            case '--column': if (i+1 < args.length) col = parseInt(args[++i], 10); break;
            case '--browser': if (i+1 < args.length) browser = args[++i].toLowerCase(); break;
            case '--headed': headless = false; break;
            case '--headless': headless = true; break;
            case '--parallel': if (i+1 < args.length) parallel = parseInt(args[++i], 10); break;
            case '--help':
                console.log(`
Usage: node error_validator.js [options]

Options:
  --file <path>      CSV file with URLs (default: url.csv)
  --column <number>  Column index (0-based) containing URLs (default: 0)
  --browser <name>   "chrome" or "edge" (default: edge)
  --headed           Show browser window (default: headless)
  --headless         Run headless (default)
  --parallel <N>     Split CSV into N chunks and run N processes in parallel (default: 0 = sequential)
  --help             Show this help
                `);
                process.exit(0);
        }
    }

    // If parallel mode, spawn child processes
    if (parallel > 0) {
        // Resolve full path
        if (!path.isAbsolute(csvFile)) csvFile = path.join(__dirname, csvFile);
        if (!fs.existsSync(csvFile)) {
            console.error(`Error: CSV file not found: ${csvFile}`);
            process.exit(1);
        }

        // Read URLs
        const content = fs.readFileSync(csvFile, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());
        let start = 0;
        if (lines.length > 0 && !lines[0].toLowerCase().startsWith('http')) start = 1;
        const urls = lines.slice(start)
            .map(line => { const parts = line.split(','); return parts[col] ? parts[col].trim() : null; })
            .filter(u => u && u.startsWith('http'));

        if (urls.length === 0) {
            console.error('No valid URLs found in CSV.');
            process.exit(1);
        }

        console.log(`Total URLs: ${urls.length}. Splitting into ${parallel} chunks...`);
        const chunkSize = Math.ceil(urls.length / parallel);
        const chunks = [];
        for (let i = 0; i < urls.length; i += chunkSize) {
            chunks.push(urls.slice(i, i + chunkSize));
        }

        // Create temporary chunk files
        const chunkFiles = [];
        chunks.forEach((chunk, idx) => {
            const fname = `chunk_${idx+1}_${Date.now()}.csv`;
            fs.writeFileSync(fname, chunk.join('\n'), 'utf-8');
            chunkFiles.push(fname);
            console.log(`Created ${fname} with ${chunk.length} URLs`);
        });

        // Spawn child processes
        const children = [];
        chunkFiles.forEach((file) => {
            const childArgs = ['error_validator.js', '--file', file, '--column', '0', '--browser', browser];
            if (headless) childArgs.push('--headless');
            else childArgs.push('--headed');
            // Do NOT pass --parallel to children
            console.log(`Launching process for ${file}`);
            const child = spawn('node', childArgs, { stdio: 'inherit' });
            children.push(child);
        });

        // Wait for all children to finish
        let finished = 0;
        await new Promise((resolve) => {
            children.forEach((child, idx) => {
                child.on('exit', (code) => {
                    finished++;
                    console.log(`Process ${idx+1} (${chunkFiles[idx]}) exited with code ${code}`);
                    if (finished === children.length) {
                        // Clean up chunk files
                        chunkFiles.forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });
                        resolve();
                    }
                });
            });
        });

        console.log('\n✅ All parallel runs completed.');
        console.log('📁 Check the Reports/ folder for individual HTML/CSV reports from each chunk.');
        process.exit(0);
    }

    // ─── Sequential mode (original) ──────────────────────────────────────────
    if (!path.isAbsolute(csvFile)) csvFile = path.join(__dirname, csvFile);
    if (!fs.existsSync(csvFile)) {
        console.error(`Error: CSV file not found: ${csvFile}`);
        process.exit(1);
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').substr(0, 19);
    const reportsDir = path.join(__dirname, 'Reports');
    const env = getEnvironmentFromCsv(csvFile);
    const reportPath = path.join(reportsDir, `${env}_ErrorMessageValidation_${ts}.html`);
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

    const validator = new ErrorMessageValidator({
        headless,
        reportPath,
        browser,
        environment: env
    });

    let shuttingDown = false;
    const graceful = async (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`\n${signal} received, shutting down gracefully...`);
        try { await validator.close(); console.log('Browser closed.'); } catch (e) { console.error('Shutdown error:', e.message); }
        process.exit(0);
    };
    process.on('SIGINT', () => graceful('SIGINT'));
    process.on('SIGTERM', () => graceful('SIGTERM'));

    try {
        await validator.setupDriver();
        console.log('Starting error message validation...');
        if (env) console.log(`Environment: ${env}`);
        console.log(`Browser: ${browser}, Headless: ${headless}`);
        console.log(`CSV file: ${csvFile}, URL column: ${col}`);

        const results = await validator.runFromCsv(csvFile, col);

        validator.generateHtmlReport();
        validator.generateCsvReport(env);
        validator.printSummary(results);

        await validator.close();
        process.exit((results.failed > 0 || results.errors > 0) ? 1 : 0);
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