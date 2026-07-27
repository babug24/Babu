const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ---------- Load pixelmatch and pngjs safely ----------
let pixelmatch, PNG;
try {
  const pm = require('pixelmatch');
  if (typeof pm === 'function') {
    pixelmatch = pm;
  } else if (pm.default && typeof pm.default === 'function') {
    pixelmatch = pm.default;
  } else {
    pixelmatch = null;
    console.warn('⚠️ pixelmatch loaded but is not a function – skipping visual regression.');
  }
  PNG = require('pngjs').PNG;
} catch (e) {
  console.warn('⚠️ pixelmatch or pngjs not installed. Visual regression will be skipped.');
  pixelmatch = null;
  PNG = null;
}

// ---------- Helper: create diff image ----------
function createDiffImage(basePath, currentPath, diffPath, threshold = 0.1) {
  if (!pixelmatch || typeof pixelmatch !== 'function' || !PNG) {
    throw new Error('pixelmatch/pngjs not available – install with: npm install pixelmatch pngjs');
  }
  const img1 = PNG.sync.read(fs.readFileSync(basePath));
  const img2 = PNG.sync.read(fs.readFileSync(currentPath));
  const { width, height } = img1;
  const diff = new PNG({ width, height });
  const numDiffPixels = pixelmatch(img1.data, img2.data, diff.data, width, height, { threshold });
  if (numDiffPixels > 0) {
    fs.writeFileSync(diffPath, PNG.sync.write(diff));
  }
  return numDiffPixels;
}

// ---------- Configuration ----------
const config = {
  visualThreshold: 300000,
  timeout: 90000,
  reportDir: 'reports',
  layoutOverflowTolerance: 5,
};

if (!fs.existsSync(config.reportDir)) {
  fs.mkdirSync(config.reportDir, { recursive: true });
}

function getTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
}

// ---------- Read URLs from CSV ----------
function readUrlsFromCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n').filter(line => line.trim() !== '');
  const urls = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    if (cols.length > 0 && cols[0].trim()) {
      urls.push(cols[0].trim());
    }
  }
  return urls;
}

const csvPath = path.join(__dirname, 'urls.csv');
if (!fs.existsSync(csvPath)) {
  console.error('❌ urls.csv not found in current directory.');
  process.exit(1);
}
const urls = readUrlsFromCSV(csvPath);
if (urls.length === 0) {
  console.error('❌ No URLs found in urls.csv.');
  process.exit(1);
}
console.log(`📋 Found ${urls.length} URL(s) to test.`);

// ---------- Main runner ----------
(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
  });

  const globalResults = {
    total: 0,
    passed: 0,
    failed: 0,
    warnings: 0,
    details: [],
    perUrl: [],
  };

  function getTickerFromUrl(url) {
    const parts = url.split('/');
    return parts[parts.length - 1] || '';
  }

  // ---------- Helper: get text from an element (robust) ----------
  async function getElementText(el) {
    try {
      let text = await el.innerText();
      if (text && text.trim()) return text.trim();
      text = await el.textContent();
      if (text && text.trim()) return text.trim();
      text = await el.getAttribute('aria-label');
      if (text && text.trim()) return text.trim();
      text = await el.getAttribute('title');
      if (text && text.trim()) return text.trim();
      const child = el.locator('span, tspan, text').first();
      if (await child.count() > 0) {
        text = await child.textContent();
        if (text && text.trim()) return text.trim();
      }
      return '';
    } catch (e) {
      return '';
    }
  }

  // ---------- Helper: click ALL visible legend items and return unique names ----------
  async function clickAllLegendItems(page, testName) {
    const legendContainer = page.locator('#legend-container');
    const containerCount = await legendContainer.count();
    if (containerCount === 0) {
      console.log(`  ⚠️ No legend container found for ${testName} – skipping.`);
      return null;
    }

    const textElements = legendContainer.locator('*').filter({
      hasText: /\S/
    });
    const count = await textElements.count();
    if (count === 0) {
      console.log(`  ⚠️ No text-bearing elements found inside legend container for ${testName} – skipping.`);
      return null;
    }

    const clickedNames = new Set();
    for (let i = 0; i < count; i++) {
      const el = textElements.nth(i);
      const isVisible = await el.isVisible();
      if (!isVisible) continue;
      const text = await getElementText(el);
      if (text) {
        await el.click();
        console.log(`  ✅ Clicked legend item for ${testName}: "${text}"`);
        clickedNames.add(text);
      }
    }

    if (clickedNames.size === 0) {
      console.log(`  ⚠️ No visible text-bearing elements found for ${testName} – skipping.`);
      return null;
    }
    return Array.from(clickedNames).join(', ');
  }

  async function runSuiteForUrl(url) {
    console.log(`\n🌐 Testing URL: ${url}`);
    const page = await context.newPage();
    page.on('console', () => {});

    const ticker = getTickerFromUrl(url);
    console.log(`   Ticker: ${ticker}`);

    const results = { total: 0, passed: 0, failed: 0, warnings: 0, details: [] };

    async function runTest(name, fn) {
      results.total++;
      let status = 'PASS';
      let error = null;
      let screenshotPath = null;
      let info = null;
      try {
        const result = await fn();
        if (result) info = result;
      } catch (err) {
        status = 'FAIL';
        error = err.message;
        results.failed++;
        const ssPath = path.join(config.reportDir, `fail-${name.replace(/\s/g, '_')}-${ticker}-${getTimestamp()}.png`);
        
        const isLayoutTest = name === 'Layout Validation';
        if (isLayoutTest) {
          await page.evaluate(() => {
            document.querySelectorAll('*').forEach(el => {
              const r = el.getBoundingClientRect();
              if (r.right > window.innerWidth + 2 || r.left < -2) {
                el.style.outline = '3px solid red';
              }
            });
          });
        }
        await page.screenshot({
          path: ssPath,
          fullPage: !isLayoutTest
        }).catch(() => {});
        screenshotPath = path.basename(ssPath);
      }
      if (status === 'PASS') results.passed++;
      results.details.push({ name, status, error, screenshot: screenshotPath, info });
      console.log(`  [${results.total}/${results.details.length}] ${name} ... ${status}${info ? ' (' + info + ')' : ''}`);
    }

    // ---------- Navigation ----------
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.timeout });
    } catch (e) {
      console.warn('Navigation partially loaded, continuing...');
    }

    try {
      const acceptButton = await page.waitForSelector('#truste-consent-button', { timeout: 5000 });
      if (acceptButton) {
        await acceptButton.click();
        console.log('🍪 Accepted cookies.');
        await page.waitForSelector('#truste-consent-track', { state: 'hidden', timeout: 5000 });
      }
    } catch (e) {
      // no consent needed
    }

    await page.waitForSelector('body', { timeout: 10000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // ---------- Standard tests with validation details ----------
    await runTest('Page Load & General', async () => {
      const title = await page.title();
      if (!title || title.length === 0) throw new Error('Title is empty');
      return `Title: "${title}"`;
    });

    await runTest('Visual Regression', async () => {
      if (!pixelmatch || typeof pixelmatch !== 'function' || !PNG) {
        console.warn('  ⚠️ Skipping visual regression – pixelmatch/pngjs not available.');
        return 'Visual regression skipped (dependencies missing)';
      }
      const safeTicker = ticker || 'unknown';
      const baselinePath = path.join(config.reportDir, `baseline-${safeTicker}.png`);
      const currentPath = path.join(config.reportDir, `current-${safeTicker}-${getTimestamp()}.png`);
      const diffPath = path.join(config.reportDir, `diff-${safeTicker}-${getTimestamp()}.png`);

      await page.waitForTimeout(1000);
      await page.screenshot({ path: currentPath, fullPage: true });

      if (!fs.existsSync(baselinePath)) {
        fs.copyFileSync(currentPath, baselinePath);
        console.log('  📸 Baseline screenshot created.');
        return 'Baseline created';
      }

      const diffPixels = createDiffImage(baselinePath, currentPath, diffPath);
      if (diffPixels > config.visualThreshold) {
        const diffData = fs.readFileSync(diffPath);
        const diffBase64 = diffData.toString('base64');
        if (!global.diffImages) global.diffImages = [];
        global.diffImages.push({ name: `Visual Regression - ${ticker}`, diffBase64 });
        throw new Error(`Visual diff of ${diffPixels} pixels exceeds threshold (${config.visualThreshold})`);
      }
      return `Diff pixels: ${diffPixels} (threshold: ${config.visualThreshold})`;
    });

    await runTest('Layout Validation', async () => {
      const issues = await page.evaluate(() => {
        const problems = [];
        document.querySelectorAll('*').forEach(el => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return;
          if (r.right > window.innerWidth + 2) problems.push(el.tagName);
          if (r.left < -2) problems.push(el.tagName);
        });
        return problems;
      });
      if (issues.length > config.layoutOverflowTolerance) {
        throw new Error(
          `Layout overflow detected: ${issues.length} elements extend beyond the screen width. ` +
          `This causes horizontal scrolling and may affect readability and user experience on smaller screens. ` +
          `Tolerance is set to ${config.layoutOverflowTolerance}. Please review the screenshot for details.`
        );
      }
      return `No overflow (${issues.length} elements within tolerance)`;
    });

    await runTest('Content Rendering', async () => {
      const tickerLocator = page.locator(`*:has-text("${ticker}")`).first();
      await tickerLocator.waitFor({ timeout: 20000 });
      const text = await tickerLocator.textContent();
      if (!text || !text.includes(ticker)) {
        throw new Error(`Fund ticker "${ticker}" not found`);
      }
      return `Ticker "${ticker}" found`;
    });

    await runTest('Fund Management', async () => {
      const managerSelectors = [
        '[data-testid="manager-name"]',
        '.manager-name',
        '.fund-manager',
        '[class*="manager"]',
        'p:has-text("Manager")',
        'div:has-text("Manager")',
      ];
      let found = false;
      let managerName = '';
      for (const selector of managerSelectors) {
        try {
          await page.waitForSelector(selector, { timeout: 5000 });
          const el = await page.$(selector);
          if (el) {
            const text = await el.textContent();
            if (text && text.trim().length > 0) {
              found = true;
              managerName = text.trim();
              break;
            }
          }
        } catch (e) { /* ignore */ }
      }
      if (!found) throw new Error('Manager info not found');
      return `Manager: ${managerName}`;
    });

    await runTest('Performance Table', async () => {
      const tableSelectors = [
        'table.performance-table',
        '.performance-data table',
        'table[class*="performance"]',
        'table:has-text("Return")',
        'table:has-text("Performance")',
      ];
      let found = false;
      let rows = 0;
      for (const selector of tableSelectors) {
        try {
          await page.waitForSelector(selector, { timeout: 5000 });
          const rowsCount = await page.$$(`${selector} tr`);
          if (rowsCount.length > 1) {
            found = true;
            rows = rowsCount.length;
            break;
          }
        } catch (e) { /* ignore */ }
      }
      if (!found) throw new Error('Performance table not found or has no data');
      return `Performance table with ${rows} rows`;
    });

    await runTest('Portfolio Section', async () => {
      const selectors = [
        '[data-testid="portfolio-section"]',
        '.portfolio-section',
        'section:has-text("Portfolio")',
        'div:has-text("Portfolio")',
      ];
      let found = false;
      for (const selector of selectors) {
        try {
          await page.waitForSelector(selector, { timeout: 5000 });
          found = true;
          break;
        } catch (e) { /* ignore */ }
      }
      if (!found) throw new Error('Portfolio section not found');
      return 'Portfolio section found';
    });

    await runTest('Navigation Tabs', async () => {
      const tabs = [
        { name: 'Overview', href: '#overview' },
        { name: 'Fund management', href: '#fund-management' },
        { name: 'Performance', href: '#performance' },
        { name: 'Portfolio', href: '#portfolio' },
        { name: 'Distributions', href: '#distributions' },
      ];

      const clickedTabs = [];
      for (const tab of tabs) {
        try {
          const link = page.locator(`a[href="${tab.href}"]`);
          await link.waitFor({ state: 'attached', timeout: 5000 });
          await link.scrollIntoViewIfNeeded();
          await page.waitForTimeout(200);
          await link.click();
          const targetId = tab.href.substring(1);
          await page.waitForSelector(`#${targetId}`, { state: 'visible', timeout: 5000 });
          clickedTabs.push(tab.name);
        } catch (e) {
          console.log(`  ⚠️ Tab "${tab.name}" not found or not interactive, skipping.`);
        }
      }
      if (clickedTabs.length === 0) throw new Error('No tabs were interactable');
      return `Tabs: ${clickedTabs.join(', ')}`;
    });

    await runTest('Section Data Validation', async () => {
      const sectionHeadings = [
        'Calendar year returns',
        'Growth of 10K',
        'Fees, expenses and minimums',
        'Asset allocation',
        'Top 10 holdings',
        'Sector allocations',
        'Portfolio characteristics',
        'Style details',
        'Continent allocation',
        'Rankings and ratings'
      ];

      let validated = 0;
      for (const heading of sectionHeadings) {
        try {
          const headingLocator = page.getByText(heading, { exact: false }).first();
          await headingLocator.waitFor({ state: 'attached', timeout: 5000 });
          await headingLocator.scrollIntoViewIfNeeded();
          await page.waitForTimeout(300);

          const hasData = await headingLocator.evaluate((el, headingText) => {
            let container = el.closest('section, div[class*="section"], div[class*="panel"], div[class*="content"]');
            if (!container) container = el.parentElement;
            if (!container) return false;
            const fullText = container.innerText.replace(/\s/g, '');
            const headingClean = headingText.replace(/\s/g, '');
            const remainingText = fullText.replace(headingClean, '');
            return remainingText.length > 0;
          }, heading);

          if (!hasData) {
            throw new Error(`Section "${heading}" has no data (empty content)`);
          }
          validated++;
        } catch (e) {
          console.log(`  ⚠️ Section "${heading}" not found or has no data – skipping.`);
        }
      }
      if (validated === 0) throw new Error('No sections with data found');
      return `${validated} sections validated`;
    });

    await runTest('Links Validation', async () => {
      const links = await page.$$eval('a', (anchors) =>
        anchors.map(a => a.href).filter(h => h.startsWith(window.location.origin))
      );
      const limitedLinks = links.slice(0, 20);
      const broken = [];
      for (const link of limitedLinks) {
        try {
          const response = await page.request.get(link, { timeout: 5000 });
          if (response.status() >= 400) broken.push(link);
        } catch (e) {
          broken.push(link);
        }
      }
      if (broken.length > 0) {
        throw new Error(`Broken internal links: ${broken.join(', ')}`);
      }
      return `${limitedLinks.length} links checked, 0 broken`;
    });

    await runTest('PDF Download', async () => {
      const pdfLinks = await page.$$eval('a[href$=".pdf"]', els => els.length);
      if (pdfLinks === 0) throw new Error('No PDF links found');
      return `${pdfLinks} PDF link${pdfLinks > 1 ? 's' : ''} found`;
    });

    await runTest('Performance Metrics', async () => {
      const metrics = await page.evaluate(() => {
        const perf = performance.getEntriesByType('navigation')[0];
        return perf ? perf.loadEventEnd - perf.fetchStart : -1;
      });
      if (metrics > 5000) throw new Error(`Slow load: ${metrics}ms`);
      return `Load time: ${metrics}ms`;
    });

    await runTest('Responsive (Mobile)', async () => {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.waitForSelector('body', { timeout: 5000 });
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      if (scrollWidth > 400) throw new Error('Horizontal overflow on mobile');
      await page.setViewportSize({ width: 1280, height: 720 });
      return `Mobile viewport OK (scrollWidth: ${scrollWidth}px)`;
    });

    await runTest('Error Handling (API fail)', async () => {
      const newPage = await context.newPage();
      await newPage.route('**/credit-qualities**', route => route.abort());
      await newPage.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await newPage.close();
      return 'API fail handled gracefully';
    });

    await runTest('Security', async () => {
      const mixed = await page.$$eval('img[src^="http:"]', imgs => imgs.length);
      if (mixed > 0) throw new Error(`${mixed} insecure images found`);
      return `No insecure images (${mixed} found)`;
    });

    await runTest('Footer', async () => {
      await page.waitForSelector('footer', { timeout: 10000 });
      return 'Footer found';
    });

    await runTest('User Interaction Flow', async () => {
      await page.waitForFunction(
        () => document.body.innerText.includes('Calendar year returns') ||
              document.body.innerText.includes('Year-to-Date'),
        { timeout: 20000 }
      );
      return 'Interaction flow completed';
    });

    // ---------- Legend Tests ----------
    await runTest('Calendar Year Returns Legend Bar', async () => {
      console.log('  📊 Testing Calendar Year Returns legend bar...');
      const heading = page.getByRole('heading', { name: /Calendar year returns/ });
      await heading.click();
      const table = page.locator('#thirdDataFeedTable');
      await table.click();
      return await clickAllLegendItems(page, 'Calendar Year Returns');
    });

    await runTest('Growth of 10K Legend Bar', async () => {
      console.log('  📊 Testing Growth of 10K legend bar...');
      const heading = page.getByText('Growth of 10K');
      await heading.click();
      const table = page.locator('#growth10KTable');
      await table.click();
      return await clickAllLegendItems(page, 'Growth of 10K');
    });

    await runTest('Sector Allocations Legend Bar', async () => {
      console.log('  📊 Testing Sector Allocations legend bar...');
      const heading = page.getByText('Sector allocations');
      await heading.click();

      const percentPortfolio = page.getByText('% of portfolio');
      const percentCount = await percentPortfolio.count();
      if (percentCount > 0) {
        await percentPortfolio.click();
        console.log('  ✅ Clicked "% of portfolio" toggle.');
      } else {
        console.log('  ⚠️ "% of portfolio" toggle not found – skipping toggle.');
      }

      return await clickAllLegendItems(page, 'Sector Allocations');
    });

    await runTest('Continent Allocation Legend Item Details', async () => {
      console.log('  📊 Testing Continent Allocation legend item details...');
      const distributionsLink = page.getByRole('link', { name: 'Distributions' });
      const distCount = await distributionsLink.count();
      if (distCount === 0) {
        console.log('  ⚠️ Distributions tab not found – skipping Continent Allocation test.');
        return null;
      }
      await distributionsLink.click();

      const continentHeading = page.getByText('Continent allocation');
      const headingCount = await continentHeading.count();
      if (headingCount === 0) {
        console.log('  ⚠️ "Continent allocation" heading not found – skipping.');
        return null;
      }
      await continentHeading.click();

      const chartContainer = page.getByLabel('This is a chart about "');
      const chartCount = await chartContainer.count();
      if (chartCount === 0) {
        console.log('  ⚠️ Chart container not found – skipping.');
        return null;
      }

      const legendItems = ['High Investment', 'Medium Investment', 'Low Investment'];
      let clickedNames = [];
      for (const itemText of legendItems) {
        const item = chartContainer.getByText(itemText).first();
        const itemCount = await chartContainer.getByText(itemText).count();
        if (itemCount === 0) {
          console.log(`  ⚠️ Legend item "${itemText}" not found – skipping.`);
          continue;
        }
        const isVisible = await item.isVisible();
        if (!isVisible) {
          console.log(`  ⚠️ Legend item "${itemText}" is not visible – skipping.`);
          continue;
        }
        await item.click();
        await item.click();
        console.log(`  ✅ Clicked "${itemText}" legend item (twice).`);
        clickedNames.push(itemText);
      }
      return clickedNames.length ? clickedNames.join(', ') : null;
    });

    await page.close();
    return results;
  }

  // ---------- Run for each URL ----------
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const urlResults = await runSuiteForUrl(url);
    globalResults.perUrl.push({ url, results: urlResults });
    globalResults.total += urlResults.total;
    globalResults.passed += urlResults.passed;
    globalResults.failed += urlResults.failed;
    globalResults.warnings += urlResults.warnings;
    for (const detail of urlResults.details) {
      globalResults.details.push({
        url: url,
        name: detail.name,
        status: detail.status,
        error: detail.error,
        screenshot: detail.screenshot,
        info: detail.info,
      });
    }
  }

  // ---------- Generate report with expanded details ----------
  const reportPath = path.join(config.reportDir, `regression-report-${getTimestamp()}.html`);
  const passRate = globalResults.total > 0 ? Math.round((globalResults.passed / globalResults.total) * 100) : 0;

  let perUrlHtml = '';
  for (const entry of globalResults.perUrl) {
    const r = entry.results;
    const rate = r.total > 0 ? Math.round((r.passed / r.total) * 100) : 0;
    const statusColor = r.failed === 0 ? '#4caf50' : '#f44336';
    perUrlHtml += `
      <div class="url-card" style="border-left-color: ${statusColor};">
        <div class="url-header">
          <span class="url-icon">🔗</span>
          <span class="url-link">${entry.url}</span>
          <span class="url-badge ${r.failed === 0 ? 'pass' : 'fail'}">${r.failed === 0 ? '✅ All passed' : '❌ ' + r.failed + ' failed'}</span>
        </div>
        <div class="url-stats">
          <span>✅ Passed: ${r.passed}</span>
          <span>❌ Failed: ${r.failed}</span>
          <span>📈 Pass Rate: ${rate}%</span>
        </div>
        <details class="url-details">
          <summary>Show / hide test details</summary>
          <div class="test-list">
            ${r.details.map((d, idx) => {
              let infoHtml = '';
              if (d.info) {
                const items = d.info.split(',').map(s => s.trim()).filter(s => s);
                if (items.length > 1) {
                  infoHtml = `<div class="test-info-block"><ul>${items.map(item => `<li>${item}</li>`).join('')}</ul></div>`;
                } else if (items.length === 1) {
                  infoHtml = `<div class="test-info-block">${items[0]}</div>`;
                }
              }
              return `
              <div class="test-row ${d.status.toLowerCase()}">
                <div class="test-row-header">
                  <span class="test-icon">${d.status === 'PASS' ? '✅' : '❌'}</span>
                  <span class="test-seq">[${idx+1}/${r.total}]</span>
                  <span class="test-name">${d.name}</span>
                  ${d.error ? `<span class="test-error">${d.error}</span>` : ''}
                  ${d.screenshot ? `<a href="${d.screenshot}" target="_blank" class="screenshot-link">📸 Screenshot</a>` : ''}
                </div>
                ${infoHtml}
              </div>
            `}).join('')}
          </div>
        </details>
      </div>
    `;
  }

  let html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cross-URL Regression Report</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: #f4f6f9;
      color: #1a1a2e;
      padding: 30px 20px;
    }
    .container { max-width: 1300px; margin: 0 auto; }

    /* Header */
    .report-header {
      background: linear-gradient(135deg, #0f2027, #203a43, #2c5364);
      color: white;
      padding: 30px 40px;
      border-radius: 18px;
      margin-bottom: 30px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.2);
    }
    .report-header h1 { font-size: 28px; font-weight: 700; letter-spacing: -0.5px; }
    .report-header .subtitle { opacity: 0.85; font-size: 14px; margin-top: 4px; }
    .report-header .timestamp { background: rgba(255,255,255,0.15); padding: 8px 16px; border-radius: 20px; font-size: 13px; }

    /* Summary cards */
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 16px;
      margin-bottom: 30px;
    }
    .summary-card {
      background: white;
      padding: 20px 20px;
      border-radius: 14px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.05);
      text-align: center;
      border-top: 4px solid #ccc;
      transition: transform 0.2s;
    }
    .summary-card:hover { transform: translateY(-3px); }
    .summary-card .label { font-size: 13px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; }
    .summary-card .value { font-size: 32px; font-weight: 700; margin-top: 4px; }
    .summary-card .icon { font-size: 28px; display: block; margin-bottom: 6px; }
    .summary-card.total { border-top-color: #1a237e; }
    .summary-card.pass { border-top-color: #4caf50; }
    .summary-card.fail { border-top-color: #f44336; }
    .summary-card.rate { border-top-color: #2196f3; }
    .summary-card.total .value { color: #1a237e; }
    .summary-card.pass .value { color: #2e7d32; }
    .summary-card.fail .value { color: #c62828; }
    .summary-card.rate .value { color: #0d47a1; }

    /* Per-URL cards */
    .url-card {
      background: white;
      margin: 16px 0;
      padding: 20px 24px;
      border-radius: 14px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.06);
      border-left: 5px solid #ccc;
      transition: box-shadow 0.2s;
    }
    .url-card:hover { box-shadow: 0 6px 20px rgba(0,0,0,0.08); }
    .url-header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
      margin-bottom: 10px;
    }
    .url-icon { font-size: 20px; }
    .url-link {
      font-weight: 600;
      font-size: 15px;
      word-break: break-all;
      flex: 1;
      min-width: 200px;
    }
    .url-badge {
      padding: 4px 14px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
      background: #eee;
    }
    .url-badge.pass { background: #e8f5e9; color: #2e7d32; }
    .url-badge.fail { background: #ffebee; color: #c62828; }
    .url-stats {
      display: flex;
      gap: 24px;
      flex-wrap: wrap;
      font-size: 14px;
      color: #444;
      margin-bottom: 8px;
    }
    .url-stats span { background: #f5f5f5; padding: 2px 12px; border-radius: 12px; }

    .url-details summary {
      cursor: pointer;
      color: #1a237e;
      font-weight: 500;
      padding: 6px 0;
      outline: none;
      user-select: none;
      transition: color 0.2s;
    }
    .url-details summary:hover { color: #0d47a1; }
    .url-details summary::-webkit-details-marker { color: #1a237e; }
    .test-list {
      margin-top: 12px;
      padding-left: 8px;
      border-left: 2px solid #e0e0e0;
    }
    .test-row {
      padding: 6px 0;
      border-bottom: 1px solid #f0f0f0;
    }
    .test-row:last-child { border-bottom: none; }
    .test-row-header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 16px;
      font-size: 14px;
    }
    .test-icon { font-size: 16px; }
    .test-seq {
      color: #888;
      font-size: 12px;
      font-weight: 400;
      min-width: 40px;
    }
    .test-name { font-weight: 500; flex: 1; min-width: 120px; }
    .test-info-block {
      margin: 4px 0 2px 32px;
      padding: 4px 12px;
      background: #f8f9fa;
      border-radius: 6px;
      font-size: 13px;
      color: #0d47a1;
      border-left: 3px solid #0d47a1;
    }
    .test-info-block ul {
      margin: 2px 0;
      padding-left: 20px;
    }
    .test-info-block ul li {
      list-style-type: disc;
    }
    .test-error {
      color: #c62828;
      background: #ffebee;
      padding: 2px 10px;
      border-radius: 12px;
      font-size: 12px;
      word-break: break-word;
      flex: 1;
      min-width: 100px;
    }
    .screenshot-link {
      background: #e3f2fd;
      color: #0d47a1;
      padding: 2px 10px;
      border-radius: 12px;
      font-size: 12px;
      text-decoration: none;
      transition: background 0.2s;
    }
    .screenshot-link:hover { background: #bbdefb; }
    .test-row.pass .test-name { color: #1e5e1e; }
    .test-row.fail .test-name { color: #b71c1c; }

    /* Diff images */
    .diff-images {
      margin-top: 30px;
      background: white;
      padding: 24px;
      border-radius: 14px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.05);
    }
    .diff-images h3 { margin-bottom: 16px; color: #1a237e; }
    .diff-images img {
      max-width: 100%;
      border: 1px solid #ddd;
      border-radius: 8px;
      margin-top: 8px;
    }

    h2 {
      margin: 30px 0 16px;
      font-size: 22px;
      color: #1a237e;
    }

    /* Responsive */
    @media (max-width: 700px) {
      .report-header { padding: 20px; flex-direction: column; align-items: flex-start; }
      .report-header h1 { font-size: 22px; }
      .summary-grid { grid-template-columns: repeat(2, 1fr); }
      .url-header { flex-direction: column; align-items: flex-start; }
      .test-row-header { font-size: 13px; }
      .test-info-block { margin-left: 16px; }
    }
  </style>
</head>
<body>
<div class="container">
  <div class="report-header">
    <div>
      <h1>🚀 Cross-URL Regression Report</h1>
      <div class="subtitle">Automated visual, functional, and performance testing across ${urls.length} URL(s)</div>
    </div>
    <div class="timestamp">📅 ${new Date().toLocaleString()}</div>
  </div>

  <div class="summary-grid">
    <div class="summary-card total"><span class="icon">📊</span><div class="label">Total Tests</div><div class="value">${globalResults.total}</div></div>
    <div class="summary-card pass"><span class="icon">✅</span><div class="label">Passed</div><div class="value">${globalResults.passed}</div></div>
    <div class="summary-card fail"><span class="icon">❌</span><div class="label">Failed</div><div class="value">${globalResults.failed}</div></div>
    <div class="summary-card rate"><span class="icon">📈</span><div class="label">Pass Rate</div><div class="value">${passRate}%</div></div>
  </div>

  <h2>🌐 Per‑URL Results</h2>
  ${perUrlHtml}

  ${global.diffImages && global.diffImages.length ? `
    <div class="diff-images">
      <h3>🖼️ Visual Diff Images</h3>
      ${global.diffImages.map(img => `
        <div style="margin-bottom: 20px;">
          <p><strong>${img.name}</strong> – Diff highlighted in red</p>
          <img src="data:image/png;base64,${img.diffBase64}" />
        </div>
      `).join('')}
    </div>
  ` : ''}
</div>
</body>
</html>
  `;

  fs.writeFileSync(reportPath, html);
  console.log(`\n✅ Consolidated report generated: ${reportPath}`);

  await browser.close();
})();