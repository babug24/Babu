const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { chromium, devices } = require('playwright');
const XLSX = require('xlsx');

// ---------- Parse arguments ----------
let INPUT_CSV = 'urls.csv';
let MOBILE_MODE = false;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file' || args[i] === '--csv') {
    if (i + 1 < args.length) {
      INPUT_CSV = args[i + 1];
      i++;
    } else {
      console.error('❌ --file requires a filename');
      process.exit(1);
    }
  } else if (args[i] === '--mobile' || args[i] === '-m') {
    MOBILE_MODE = true;
  } else {
    INPUT_CSV = args[i];
  }
}
console.log(`📂 Using CSV: ${INPUT_CSV}`);
if (MOBILE_MODE) console.log('📱 Mobile mode ON');

// ---------- Configuration ----------
const REPORTS_DIR = 'reports';
const SCREENSHOT_DIR = 'screenshots';
const OUTPUT_CSV = path.join(REPORTS_DIR, 'results.csv');
const NAV_TIMEOUT = 60000;
const BUTTON_TIMEOUT = 15000;
const PRESENCE_TIMEOUT = 5000;
const MAX_RETRIES = 2;

// ---------- Overlay handler ----------
async function handleOverlays(page, url) {
  console.log(`  🔍 Checking for overlays on ${url}`);
  try {
    const acceptButton = page.locator('#truste-consent-button');
    if (await acceptButton.isVisible({ timeout: 3000 })) {
      console.log('  🍪 TrustArc cookie banner found – clicking Accept');
      await acceptButton.click();
      await page.waitForSelector('#truste-consent-content', { state: 'hidden', timeout: 5000 }).catch(() => {});
      console.log('  ✅ Cookie banner accepted');
    } else {
      console.log('  ℹ️ No TrustArc cookie banner detected');
    }
  } catch (e) {
    console.log(`  ℹ️ TrustArc check: ${e.message}`);
  }

  const overlaySelectors = [
    'button[aria-label*="cookie" i]',
    'button[aria-label*="consent" i]',
    'button:has-text("Accept")',
    'button:has-text("Agree")',
    'button:has-text("Allow")',
    'button:has-text("Got it")',
    'button:has-text("OK")',
    'button[aria-label*="close" i]',
    'button:has-text("×")',
    'button:has-text("Close")',
    'button:has-text("Dismiss")',
    'button:has-text("No thanks")',
    '.cookie-accept',
    '.cookie-consent button',
    '#cookie-banner button',
    '#privacy-banner button',
    '.modal-close',
    '.close-button',
  ];

  let overlayCount = 0;
  for (const sel of overlaySelectors) {
    try {
      const els = await page.$$(sel);
      for (const el of els) {
        if (await el.isVisible()) {
          await el.click();
          overlayCount++;
          console.log(`  🧹 Closed overlay: ${sel}`);
          await page.waitForTimeout(300);
        }
      }
    } catch (_) {}
  }
  if (overlayCount === 0) console.log('  ℹ️ No additional overlays found');
  else console.log(`  ✅ Closed ${overlayCount} overlay(s)`);
}

// ---------- Navigate with retry ----------
async function navigateWithRetry(page, url, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`  🌐 Navigating to ${url} (attempt ${attempt}/${retries})`);
      await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT });
      console.log(`  ✅ Page loaded: ${await page.title()}`);
      return;
    } catch (e) {
      console.log(`  ❌ Navigation attempt ${attempt} failed: ${e.message}`);
      if (attempt === retries) throw e;
      console.log(`  ⏳ Waiting 2s before retry...`);
      await page.waitForTimeout(2000);
    }
  }
}

// ---------- Validate a single click (handles new tabs, skips tel/mailto) ----------
// Added returnToUrl parameter to navigate back after click
async function validateButtonClick(page, locator, description, requireQuote = true, returnToUrl = null) {
  console.log(`  🔘 Testing: "${description}"`);
  try {
    const handle = await locator.elementHandle();
    const href = await handle.getAttribute('href');
    const target = await handle.getAttribute('target');
    console.log(`  🔗 href: ${href || 'none'}, target: ${target || 'none'}`);

    if (href && (href.startsWith('tel:') || href.startsWith('mailto:'))) {
      console.log(`  📞 Skipping tel/mailto link: ${href}`);
      return { success: true, skipped: true, note: 'Phone/mail skipped' };
    }

    console.log(`  📍 Clicking: ${href || 'button'}`);

    const newPagePromise = page.context().waitForEvent('page');
    let finalUrl = page.url();

    // Click with retry strategies
    let clickSuccess = false;
    const clickStrategies = [
      async () => await locator.click({ timeout: 5000 }),
      async () => await locator.click({ force: true, timeout: 5000 }),
      async () => await page.evaluate(el => el.click(), await locator.elementHandle()),
    ];

    for (const strategy of clickStrategies) {
      try {
        await strategy();
        clickSuccess = true;
        break;
      } catch (e) {
        console.log(`  ⚠️ Click strategy failed: ${e.message}`);
      }
    }

    if (!clickSuccess) {
      throw new Error('All click strategies failed');
    }

    const result = await Promise.race([
      page.waitForNavigation({ waitUntil: 'load', timeout: 10000 }).then(() => 'navigation'),
      newPagePromise.then(() => 'newpage'),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 10000))
    ]);

    let finalPage = page;
    let title = await page.title();

    if (result === 'newpage') {
      console.log('  📑 New tab opened');
      const newPage = await newPagePromise;
      await newPage.waitForLoadState('load');
      finalPage = newPage;
      finalUrl = newPage.url();
      title = await newPage.title();
    } else if (result === 'navigation') {
      console.log('  📄 Navigation in same tab');
      finalUrl = page.url();
      title = await page.title();
    } else {
      console.log('  ⏱️ No immediate navigation; waiting for URL change...');
      const startUrl = page.url();
      let attempts = 0;
      let urlChanged = false;
      while (attempts < 20) {
        await page.waitForTimeout(500);
        const currentUrl = page.url();
        if (currentUrl !== startUrl) {
          console.log(`  🔗 URL changed to: ${currentUrl}`);
          finalUrl = currentUrl;
          title = await page.title();
          urlChanged = true;
          break;
        }
        attempts++;
      }
      if (!urlChanged) {
        if (!requireQuote) {
          console.log('  ✅ Click succeeded (no navigation required)');
          // Even if no navigation, we may still want to return to the original URL if given
          if (returnToUrl && page.url() !== returnToUrl) {
            console.log(`  ⬅️ Returning to original URL: ${returnToUrl}`);
            await page.goto(returnToUrl, { waitUntil: 'load', timeout: NAV_TIMEOUT });
            await handleOverlays(page, returnToUrl);
          }
          return { success: true, finalUrl: startUrl, title };
        } else {
          throw new Error('No navigation occurred and quote page not reached');
        }
      }
    }

    console.log(`  🔗 Final URL: ${finalUrl}`);
    console.log(`  📄 Page title: ${title}`);

    if (requireQuote) {
      const isQuote = finalUrl.toLowerCase().includes('quote') ||
                      title.toLowerCase().includes('quote') ||
                      (await finalPage.$('form[data-testid="quote-form"]')) !== null;
      if (!isQuote) {
        throw new Error(`Not a quote page. URL: ${finalUrl}, Title: ${title}`);
      }
      console.log(`  ✅ Quote page confirmed`);
    } else {
      console.log(`  ✅ Navigation successful (quote check skipped)`);
    }

    // If new tab was opened, close it
    if (result === 'newpage') {
      await finalPage.close();
      console.log('  🔒 New tab closed');
    }

    // If returnToUrl is provided, navigate back to it
    if (returnToUrl && page.url() !== returnToUrl) {
      console.log(`  ⬅️ Returning to original URL: ${returnToUrl}`);
      await page.goto(returnToUrl, { waitUntil: 'load', timeout: NAV_TIMEOUT });
      await handleOverlays(page, returnToUrl);
    } else {
      console.log(`  📍 Staying on final URL: ${finalUrl}`);
    }

    return { success: true, finalUrl, title };
  } catch (error) {
    console.log(`  ❌ Click validation failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// ---------- Validate main button ----------
async function validateMainButton(page, url) {
  console.log(`\n  🔵 Testing Main Button...`);
  const result = {
    status: 'N/A',
    error: '',
    finalUrl: '',
    title: '',
    backNavigation: 'N/A',
    backError: '',
    backUrl: '',
  };

  try {
    const selector = 'a.button.nw-button--mint-dark.bold-penguin-quote';
    let present = false;
    try {
      await page.waitForSelector(selector, { state: 'attached', timeout: PRESENCE_TIMEOUT });
      present = true;
      console.log(`  ✅ Main button found in DOM`);
    } catch (_) {
      result.status = 'N/A';
      result.error = 'Button not present';
      console.log(`  ℹ️ Main button not present`);
      return result;
    }

    await page.waitForSelector(selector, { state: 'visible', timeout: BUTTON_TIMEOUT });
    console.log(`  ✅ Main button is visible`);
    const disabled = await page.$eval(selector, el => el.hasAttribute('disabled'));
    if (disabled) {
      throw new Error('Button is disabled');
    }
    console.log(`  ✅ Main button is enabled`);

    // Main button will navigate to quote and we want to return to original URL after test
    const clickResult = await validateButtonClick(page, page.locator(selector), 'Main button', true, url);
    if (!clickResult.success) throw new Error(clickResult.error);
    if (clickResult.skipped) {
      result.status = 'N/A';
      result.error = 'Skipped (tel/mailto)';
      return result;
    }

    result.status = 'PASS';
    result.finalUrl = clickResult.finalUrl;
    result.title = clickResult.title;
    result.backNavigation = 'SUCCESS';
    result.backUrl = page.url(); // should be back to original
    console.log(`  ✅ Main button test PASSED`);
  } catch (error) {
    result.status = 'FAIL';
    result.error = error.message || 'Unknown error';
    console.log(`  ❌ Main button test FAILED: ${result.error}`);
  }
  return result;
}

// ---------- Validate small CTA (simple locator-based, no evaluate) ----------
// Accepts originalUrl so we can return after each CTA test
async function validateSmallCta(page, originalUrl) {
  console.log(`\n  🟢 Testing Small CTA...`);
  const result = {
    status: 'N/A',
    error: '',
    buttonsFound: 0,
    buttonsTested: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    details: [],
  };

  try {
    // Try to find the component wrapper
    const componentSelector = 'ngx-web-small-cta, ngx-nationwide-small-cta, .small-cta-wrapper';
    let container = null;
    let componentFound = false;

    try {
      console.log(`  🔍 Waiting for component: ${componentSelector}`);
      await page.waitForSelector(componentSelector, { timeout: 5000 });
      container = page.locator(componentSelector).first();
      componentFound = true;
      console.log(`  ✅ Component found`);
    } catch (_) {
      console.log(`  ℹ️ Component not found, falling back to page-wide search`);
    }

    // Function to collect CTAs from a root locator (page or container)
    const collectCtas = async (root) => {
      const ctaLocators = [];
      // 1. Specific href selectors
      const hrefSelectors = [
        'a[href="/business/insurance/"]',
        'a[href*="agency.nationwide.com"]',
        'a[href^="tel:"]',
      ];
      for (const sel of hrefSelectors) {
        const items = await root.locator(sel).all();
        for (const item of items) {
          ctaLocators.push(item);
        }
      }

      // 2. Button with class bold-penguin-quote
      const quoteButtons = await root.locator('button.bold-penguin-quote').all();
      for (const btn of quoteButtons) {
        ctaLocators.push(btn);
      }

      // 3. Text-based selectors (common CTAs)
      const textSelectors = [
        'a:has-text("Nationwide business insurance")',
        'a:has-text("Talk to a specialist")',
        'button:has-text("Get a quote")',
        'a:has-text("Get a quote")',
        'button:has-text("Start your quote")',
        'a:has-text("Start your quote")',
      ];
      for (const sel of textSelectors) {
        const items = await root.locator(sel).all();
        for (const item of items) {
          // Avoid duplicates by href (if available)
          let duplicate = false;
          const itemHref = await item.getAttribute('href');
          for (const existing of ctaLocators) {
            const existingHref = await existing.getAttribute('href');
            if (itemHref && existingHref && itemHref === existingHref) {
              duplicate = true;
              break;
            }
          }
          if (!duplicate) {
            ctaLocators.push(item);
          }
        }
      }

      // 4. Fallback: any interactive element with CTA-like class or text
      const fallbackSelector = 'button, a[role="button"], .button, .btn, [type="button"], a[href]';
      const allInteractive = await root.locator(fallbackSelector).all();
      for (const el of allInteractive) {
        const className = await el.getAttribute('class') || '';
        const text = await el.textContent() || '';
        const trimmed = text.trim().toLowerCase();
        if (className.includes('bold-penguin-quote') ||
            className.includes('nw-button--hollow-blue-light') ||
            className.includes('bolt-button-wc--outline') ||
            trimmed.includes('get a quote') ||
            trimmed.includes('talk to a specialist') ||
            trimmed.includes('start your quote') ||
            trimmed.includes('business insurance')) {
          // Check duplicate
          let duplicate = false;
          const elHref = await el.getAttribute('href');
          for (const existing of ctaLocators) {
            const existingHref = await existing.getAttribute('href');
            if (elHref && existingHref && elHref === existingHref) {
              duplicate = true;
              break;
            }
          }
          if (!duplicate) {
            ctaLocators.push(el);
          }
        }
      }

      return ctaLocators;
    };

    let ctaLocators = [];
    if (componentFound) {
      ctaLocators = await collectCtas(container);
      console.log(`  📋 Found ${ctaLocators.length} CTA elements inside component`);
    } else {
      // Page-wide search, but exclude the main button
      const allCandidates = await collectCtas(page);

      // Identify the main button by selector and href
      const mainButtonSelector = 'a.button.nw-button--mint-dark.bold-penguin-quote';
      const mainButton = await page.$(mainButtonSelector);
      let mainHref = null;
      if (mainButton) {
        mainHref = await mainButton.getAttribute('href');
      }

      ctaLocators = [];
      for (const loc of allCandidates) {
        const href = await loc.getAttribute('href');
        if (mainHref && href === mainHref) continue;
        const isMain = await loc.evaluate((node, sel) => node.matches && node.matches(sel), mainButtonSelector);
        if (isMain) continue;
        const text = await loc.textContent();
        if (text && text.trim().toLowerCase() === 'start your quote') continue;
        ctaLocators.push(loc);
      }
      console.log(`  📋 Found ${ctaLocators.length} CTA elements page-wide (excluding main button)`);
    }

    result.buttonsFound = ctaLocators.length;
    console.log(`  📋 Relevant CTA elements found: ${ctaLocators.length}`);

    if (ctaLocators.length === 0) {
      result.status = 'N/A';
      result.error = 'No relevant CTA buttons found';
      return result;
    }

    // Test each CTA (requireQuote = false, and always return to originalUrl)
    let allPassed = true;
    let index = 0;
    for (const loc of ctaLocators) {
      index++;
      const text = await loc.textContent();
      const displayText = (text ? text.trim() : `CTA Button ${index}`);
      // Pass originalUrl as returnToUrl
      const clickResult = await validateButtonClick(page, loc, `CTA: "${displayText}"`, false, originalUrl);
      result.buttonsTested++;
      if (clickResult.skipped) {
        result.skipped++;
        result.details.push({ text: displayText, success: true, skipped: true, note: clickResult.note });
        continue;
      }
      if (clickResult.success) {
        result.passed++;
        result.details.push({ text: displayText, success: true, finalUrl: clickResult.finalUrl, title: clickResult.title });
      } else {
        result.failed++;
        allPassed = false;
        result.details.push({ text: displayText, success: false, error: clickResult.error });
      }
    }

    const tested = result.passed + result.failed;
    if (tested === 0) {
      result.status = 'N/A';
      result.error = 'All CTA buttons skipped (tel/mailto)';
    } else {
      result.status = allPassed ? 'PASS' : 'FAIL';
      if (!allPassed) {
        const failedItems = result.details.filter(d => !d.success && !d.skipped).map(d => d.text).join(', ');
        result.error = `Failed buttons: ${failedItems}`;
      }
    }
    console.log(`  ✅ CTA test ${result.status}: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped`);
  } catch (error) {
    result.status = 'FAIL';
    result.error = error.message || 'Unknown error';
    console.log(`  ❌ CTA test FAILED: ${result.error}`);
  }
  return result;
}

// ---------- Main URL validation ----------
async function validateUrl(page, url, index) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📍 [${index}] Testing: ${url}`);
  console.log(`${'='.repeat(60)}`);

  let result = {
    url,
    status: 'FAIL',
    error: '',
    screenshot: '',
    mainStatus: '',
    mainError: '',
    mainFinalUrl: '',
    mainTitle: '',
    mainBackNav: '',
    mainBackError: '',
    mainBackUrl: '',
    ctaStatus: '',
    ctaError: '',
    ctaButtonsFound: '',
    ctaButtonsTested: '',
    ctaPassed: '',
    ctaFailed: '',
    ctaSkipped: '',
    ctaDetails: '',
  };

  try {
    // Navigate to the original URL
    await navigateWithRetry(page, url);
    await page.waitForLoadState('domcontentloaded');
    await handleOverlays(page, url);

    // --- Test Main Button ---
    const mainRes = await validateMainButton(page, url);
    Object.assign(result, {
      mainStatus: mainRes.status,
      mainError: mainRes.error,
      mainFinalUrl: mainRes.finalUrl,
      mainTitle: mainRes.title,
      mainBackNav: mainRes.backNavigation,
      mainBackError: mainRes.backError,
      mainBackUrl: mainRes.backUrl,
    });

    // The main button test already returned to the original URL, but just in case:
    if (page.url() !== url) {
      console.log(`  ⬅️ Ensuring we are back on original URL for CTA test: ${url}`);
      await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT });
      await page.waitForLoadState('domcontentloaded');
      await handleOverlays(page, url);
    }

    // --- Test Small CTA ---
    const ctaRes = await validateSmallCta(page, url);
    Object.assign(result, {
      ctaStatus: ctaRes.status,
      ctaError: ctaRes.error,
      ctaButtonsFound: ctaRes.buttonsFound,
      ctaButtonsTested: ctaRes.buttonsTested,
      ctaPassed: ctaRes.passed,
      ctaFailed: ctaRes.failed,
      ctaSkipped: ctaRes.skipped,
      ctaDetails: JSON.stringify(ctaRes.details),
    });

    // Determine overall status
    if (mainRes.status === 'N/A' && ctaRes.status === 'N/A') {
      result.status = 'N/A';
      result.error = 'No applicable tests';
    } else if (mainRes.status === 'FAIL' || ctaRes.status === 'FAIL') {
      result.status = 'FAIL';
      result.error = `Main: ${mainRes.error || 'OK'}, CTA: ${ctaRes.error || 'OK'}`;
    } else {
      result.status = 'PASS';
    }

    console.log(`\n📊 Overall Status: ${result.status}`);
    try {
      const screenshotFile = path.join(SCREENSHOT_DIR, `screenshot_${index}_${Date.now()}.png`);
      await page.screenshot({ path: screenshotFile, fullPage: true });
      result.screenshot = screenshotFile;
      console.log(`📸 Screenshot saved: ${screenshotFile}`);
    } catch (ssError) {
      console.log(`⚠️ Screenshot failed: ${ssError.message}`);
      result.error += ` (Screenshot failed: ${ssError.message})`;
    }
  } catch (error) {
    result.status = 'FAIL';
    result.error = error.message || 'Unknown error';
    console.log(`❌ Validation failed: ${result.error}`);
    try {
      const screenshotFile = path.join(SCREENSHOT_DIR, `screenshot_${index}_${Date.now()}_FAIL.png`);
      await page.screenshot({ path: screenshotFile, fullPage: true });
      result.screenshot = screenshotFile;
      console.log(`📸 Failure screenshot saved: ${screenshotFile}`);
    } catch (_) {}
  }
  return result;
}

// ---------- Report generation ----------
function generateHtmlReport(results, startTime, mobileMode) {
  const total = results.length;
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const na = results.filter(r => r.status === 'N/A').length;
  const mainPass = results.filter(r => r.mainStatus === 'PASS').length;
  const mainFail = results.filter(r => r.mainStatus === 'FAIL').length;
  const mainNA = results.filter(r => r.mainStatus === 'N/A').length;
  const ctaPass = results.filter(r => r.ctaStatus === 'PASS').length;
  const ctaFail = results.filter(r => r.ctaStatus === 'FAIL').length;
  const ctaNA = results.filter(r => r.ctaStatus === 'N/A').length;
  const timestamp = new Date(startTime).toLocaleString();
  const modeLabel = mobileMode ? '📱 Mobile' : '🖥️ Desktop';

  let rows = results.map((r, i) => {
    const overallClass = r.status === 'PASS' ? 'badge-pass' : (r.status === 'N/A' ? 'badge-na' : 'badge-fail');
    const mainClass = r.mainStatus === 'PASS' ? 'badge-pass' : (r.mainStatus === 'N/A' ? 'badge-na' : 'badge-fail');
    const ctaClass = r.ctaStatus === 'PASS' ? 'badge-pass' : (r.ctaStatus === 'N/A' ? 'badge-na' : 'badge-fail');
    const screenshotLink = r.screenshot ? `<a href="../${r.screenshot}" target="_blank">View</a>` : '—';
    return `
      <tr>
        <td>${i + 1}</td>
        <td><a href="${r.url}" target="_blank">${r.url}</a></td>
        <td><span class="badge ${overallClass}">${r.status}</span></td>
        <td>${r.error || '—'}</td>
        <td>${screenshotLink}</td>
        <td><span class="badge ${mainClass}">${r.mainStatus || 'N/A'}</span></td>
        <td>${r.mainError || '—'}</td>
        <td><a href="${r.mainFinalUrl || '#'}" target="_blank">${r.mainFinalUrl || '—'}</a></td>
        <td>${r.mainTitle || '—'}</td>
        <td>${r.mainBackNav || 'N/A'}</td>
        <td>${r.mainBackError || '—'}</td>
        <td><span class="badge ${ctaClass}">${r.ctaStatus || 'N/A'}</span></td>
        <td>${r.ctaError || '—'}</td>
        <td>${r.ctaButtonsFound || '0'}</td>
        <td>${r.ctaPassed || '0'} / ${r.ctaFailed || '0'} (skipped: ${r.ctaSkipped || '0'})</td>
      </tr>
    `;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Quote Button Test Report</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', Roboto, system-ui, sans-serif; margin: 0; padding: 20px; background: #f0f2f5; }
    .container { max-width: 1400px; margin: 0 auto; background: #ffffff; border-radius: 16px; box-shadow: 0 8px 30px rgba(0,0,0,0.12); padding: 24px 30px 30px 30px; overflow-x: auto; }
    h1 { background: linear-gradient(135deg, #1e3c72, #2a5298); color: #fff; padding: 18px 24px; border-radius: 12px; margin: -24px -30px 20px -30px; font-weight: 600; font-size: 28px; display: flex; align-items: center; gap: 12px; }
    .summary { display: flex; flex-wrap: wrap; gap: 16px; margin: 24px 0 20px 0; padding: 16px 20px; background: #f8f9fc; border-radius: 12px; border: 1px solid #e9ecf0; }
    .summary-item { background: white; padding: 8px 18px; border-radius: 30px; box-shadow: 0 1px 4px rgba(0,0,0,0.05); font-size: 15px; font-weight: 500; color: #2c3e50; }
    .summary-item span { font-weight: 700; }
    .pass { color: #28a745; }
    .fail { color: #dc3545; }
    .na { color: #6c757d; }
    .badge { display: inline-block; padding: 4px 14px; border-radius: 30px; font-size: 13px; font-weight: 600; letter-spacing: 0.3px; text-transform: uppercase; }
    .badge-pass { background: #d4edda; color: #155724; }
    .badge-fail { background: #f8d7da; color: #721c24; }
    .badge-na { background: #e9ecef; color: #495057; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 10px; }
    th { background: #2a5298; color: white; padding: 10px 8px; text-align: left; white-space: nowrap; font-weight: 600; }
    td { padding: 8px 8px; border-bottom: 1px solid #e9ecf0; vertical-align: middle; }
    tr:hover td { background-color: #f8f9fc; }
    a { color: #0066cc; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .timestamp { color: #6c757d; font-size: 0.9em; margin-top: 10px; text-align: right; }
    .mode-badge { display: inline-block; background: #2a5298; color: white; padding: 4px 16px; border-radius: 30px; font-weight: 600; font-size: 14px; margin-left: 10px; }
    @media (max-width: 768px) { .container { padding: 15px; } h1 { font-size: 22px; padding: 14px 18px; margin: -15px -15px 15px -15px; } .summary { flex-direction: column; gap: 8px; } }
  </style>
</head>
<body>
<div class="container">
  <h1>🔍 NW-Interstellar- Bold-penguin-quote Validation Report
    <span class="mode-badge">${modeLabel}</span>
  </h1>
  <div class="summary">
    <div class="summary-item">📋 Total URLs: <span>${total}</span></div>
    <div class="summary-item">✅ Overall Pass: <span class="pass">${passed}</span></div>
    <div class="summary-item">❌ Overall Fail: <span class="fail">${failed}</span></div>
    <div class="summary-item">⏸️ Overall N/A: <span class="na">${na}</span></div>
    <div class="summary-item">🔵 Main Button Pass: <span class="pass">${mainPass}</span> | Fail: <span class="fail">${mainFail}</span> | N/A: <span class="na">${mainNA}</span></div>
    <div class="summary-item">🟢 Small CTA Pass: <span class="pass">${ctaPass}</span> | Fail: <span class="fail">${ctaFail}</span> | N/A: <span class="na">${ctaNA}</span></div>
  </div>
  <p class="timestamp">Generated: ${timestamp}</p>
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>URL</th>
        <th>Overall</th>
        <th>Overall Error</th>
        <th>Screenshot</th>
        <th>Main Status</th>
        <th>Main Error</th>
        <th>Main Final URL</th>
        <th>Main Title</th>
        <th>Main Back</th>
        <th>Main Back Error</th>
        <th>CTA Status</th>
        <th>CTA Error</th>
        <th>CTA Buttons</th>
        <th>CTA Pass/Fail</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</div>
</body>
</html>`;
}

// ---------- Generate Excel report ----------
function generateExcelReport(results, outputPath) {
  try {
    const data = results.map(r => ({
      'URL': r.url,
      'Overall Status': r.status,
      'Overall Error': r.error,
      'Screenshot': r.screenshot,
      'Main Status': r.mainStatus || 'N/A',
      'Main Error': r.mainError || '',
      'Main Final URL': r.mainFinalUrl || '',
      'Main Title': r.mainTitle || '',
      'Main Back Nav': r.mainBackNav || 'N/A',
      'Main Back Error': r.mainBackError || '',
      'CTA Status': r.ctaStatus || 'N/A',
      'CTA Error': r.ctaError || '',
      'CTA Buttons Found': r.ctaButtonsFound || 0,
      'CTA Passed': r.ctaPassed || 0,
      'CTA Failed': r.ctaFailed || 0,
      'CTA Skipped': r.ctaSkipped || 0,
      'CTA Details': r.ctaDetails || '',
    }));
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, 'Results');

    const tempPath = outputPath + '.tmp.xlsx';
    XLSX.writeFile(wb, tempPath);
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
    fs.renameSync(tempPath, outputPath);
    console.log(`📊 Excel: ${outputPath}`);
  } catch (error) {
    console.error(`⚠️ Could not write Excel file: ${error.message}`);
    console.log(`ℹ️ Excel file may be open in another program. Skipping Excel export.`);
  }
}

// ---------- Main ----------
(async () => {
  const startTime = Date.now();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 Starting Bold Penguin Validator`);
  console.log(`${'='.repeat(60)}\n`);

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  if (!fs.existsSync(INPUT_CSV)) {
    console.error(`❌ CSV not found: ${INPUT_CSV}`);
    process.exit(1);
  }

  const csvContent = fs.readFileSync(INPUT_CSV, 'utf8');
  const records = parse(csvContent, { columns: true, skip_empty_lines: true });
  const urls = records.map(r => r.URL).filter(Boolean);
  if (urls.length === 0) {
    console.error('❌ No URLs in CSV. Header must be "URL".');
    process.exit(1);
  }

  console.log(`📋 Processing ${urls.length} URLs from ${INPUT_CSV}\n`);

  const browser = await chromium.launch({ headless: false });
  const contextOptions = {};
  if (MOBILE_MODE) Object.assign(contextOptions, devices['iPhone 12']);
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  const results = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const result = await validateUrl(page, url, i+1);
    results.push(result);
    console.log(`\n📊 Summary for ${url}:`);
    console.log(`  Overall: ${result.status}`);
    console.log(`  Main: ${result.mainStatus || 'N/A'}`);
    console.log(`  CTA: ${result.ctaStatus || 'N/A'}`);
    if (result.error) console.log(`  Error: ${result.error}`);
    await context.clearCookies();
    console.log(`  🍪 Cookies cleared`);
  }

  await browser.close();

  // Write CSV (fixed name)
  const headers = ['url','status','error','screenshot','mainStatus','mainError','mainFinalUrl','mainTitle','mainBackNav','mainBackError','mainBackUrl','ctaStatus','ctaError','ctaButtonsFound','ctaButtonsTested','ctaPassed','ctaFailed','ctaSkipped','ctaDetails'];
  const rows = results.map(r => headers.map(h => r[h] || '').join(','));
  fs.writeFileSync(OUTPUT_CSV, headers.join(',') + '\n' + rows.join('\n'), 'utf8');
  console.log(`\n✅ CSV: ${OUTPUT_CSV}`);

  // Timestamped HTML and Excel reports
  const reportTimestamp = new Date(startTime).toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '_');
  const baseReportName = `bold-penguin-button-validator_report_${reportTimestamp}`;
  const htmlReportFile = path.join(REPORTS_DIR, `${baseReportName}.html`);
  const excelReportFile = path.join(REPORTS_DIR, `${baseReportName}.xlsx`);

  fs.writeFileSync(htmlReportFile, generateHtmlReport(results, startTime, MOBILE_MODE), 'utf8');
  console.log(`📊 HTML: ${htmlReportFile}`);

  generateExcelReport(results, excelReportFile);

  console.log(`📸 Screenshots: ${SCREENSHOT_DIR}/`);
  console.log(`✅ All reports in "${REPORTS_DIR}"`);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🏁 Done!`);
  console.log(`${'='.repeat(60)}`);
})();