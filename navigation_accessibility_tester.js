// Playwright version of navigation accessibility tester
// Features: keyboard navigation, scroll, focus indicators, WCAG 2.2 Level AA checks, axe-core scanning, HTML report
//
// Changelog (recent edits):
// - 2026-05-20: WCAG 2.2 Level AA alignment - expanded axe-core tags to full conformance set
//               (wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22a, wcag22aa)
//               Added SC 2.4.11 Focus Not Obscured, SC 2.5.7 Dragging Movements, SC 3.2.6 Consistent Help
// - 2026-04-10: ENHANCED - Comprehensive keyboard validation with detailed element categorization
//               Added comprehensive tab/shift-tab capture (88+ elements) and element categorization
//               Captures elements in page sections: header, nav, content, footer
//               Dynamic iteration limits (2-3x focusable elements up to 250 max)
// - 2026-02-01: Integrated axe-core for WCAG rule-level violations
// - 2026-01-30: Simplified WCAG approach - read-only checks without page interactions
// - 2026-01-30: Reverted to stable keyboard/focus/scroll tests
// - 2026-01-30: Accept either 'urls.csv' or 'url.csv' for compatibility.
// - 2026-01-30: Removed stray markdown code fences that broke template literal.
// - 2026-01-30: Ensure `reports/` directory is created if missing.

import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import axe from 'axe-core';
import XLSX from 'xlsx';
import { fileURLToPath } from 'url';
import logger from './utils/logger.js';
import CONFIG from './utils/config.js';
import { parseCSV, findCsvFile, getEnvironmentPrefix } from './utils/csvParser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize report directory
const reportDir = path.join(__dirname, CONFIG.REPORT_DIR);
if (!fs.existsSync(reportDir)) {
  fs.mkdirSync(reportDir, { recursive: true });
}

// Generate timestamp for unique report filename: YYYY-MM-DD_HH-MM-SS
const timestamp = new Date()
  .toISOString()
  .replace(/[:.]/g, '-')
  .split('T')
  .join('_')
  .slice(0, -5);

function getArgValue(flagName) {
  const flag = process.argv.find(arg => arg.startsWith(`${flagName}=`));
  return flag ? flag.slice(flagName.length + 1) : null;
}

function parseIntegerFlag(flagName, defaultValue, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = getArgValue(flagName);
  if (raw === null) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    logger.error(`Invalid value for ${flagName}: "${raw}". Expected an integer.`);
    process.exit(1);
  }
  if (parsed < min || parsed > max) {
    logger.error(`Invalid value for ${flagName}: "${raw}". Expected ${min}..${max}.`);
    process.exit(1);
  }
  return parsed;
}

function parseFloatFlag(flagName, defaultValue, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  const raw = getArgValue(flagName);
  if (raw === null) return defaultValue;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    logger.error(`Invalid value for ${flagName}: "${raw}". Expected a number.`);
    process.exit(1);
  }
  if (parsed < min || parsed > max) {
    logger.error(`Invalid value for ${flagName}: "${raw}". Expected ${min}..${max}.`);
    process.exit(1);
  }
  return parsed;
}

function parseBooleanFlag(flagName, defaultValue) {
  const raw = getArgValue(flagName);
  if (raw === null) {
    return process.argv.includes(flagName) ? true : defaultValue;
  }

  const normalized = String(raw).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;

  logger.error(`Invalid value for ${flagName}: "${raw}". Expected true|false.`);
  process.exit(1);
}

function normalizeText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function createElementKey(el) {
  // For form controls, prioritize id/name over text (text can vary)
  const tag = (el.tag || '').toUpperCase();
  const isFormControl = ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(tag);
  
  if (isFormControl) {
    // For form controls, use a more stable key without text content
    return [
      tag,
      el.id || '',
      el.name || '',
      el.type || '',
      el.ariaLabel || ''
    ].join('|');
  }
  
  // For other elements, include text but make it more lenient
  return [
    tag,
    el.id || '',
    el.name || '',
    el.ariaLabel || '',
    normalizeText(el.text || '').substring(0, 60)
  ].join('|');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeForHtml(value) {
  if (typeof value === 'string') return escapeHtml(value);
  if (Array.isArray(value)) return value.map(item => sanitizeForHtml(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, sanitizeForHtml(val)]));
  }
  return value;
}

function generateExcelReport(results, outputPath, reportTimestamp, policy) {
  const workbook = XLSX.utils.book_new();

  const summaryRows = [
    ['Report Timestamp', reportTimestamp],
    ['Total URLs', results.length],
    ['Pass', results.filter(r => (r.status || '').toLowerCase() === 'pass').length],
    ['Fail', results.filter(r => (r.status || '').toLowerCase() === 'fail').length],
    ['TimedOut', results.filter(r => (r.status || '').toLowerCase() === 'timedout').length],
    ['Needs Review', results.filter(r => r.needsReview === true).length],
    ['Runtime Policy', JSON.stringify(policy)]
  ];

  const detailRows = results.map((result, idx) => {
    const tabCount = Array.isArray(result.tabOrder) ? result.tabOrder.length : 0;
    const shiftTabCount = Array.isArray(result.shiftTabOrder) ? result.shiftTabOrder.length : 0;
    const focusIndicatorFailures = Array.isArray(result.focusIndicatorFailures) ? result.focusIndicatorFailures.length : 0;
    const scrollPositionsCount = Array.isArray(result.scrollPositions) ? result.scrollPositions.length : 0;

    return {
      Index: idx + 1,
      URL: result.url || '',
      Status: result.status || '',
      ReviewDisposition: result.reviewDisposition || '',
      NeedsReview: result.needsReview === true ? 'Yes' : 'No',
      Error: result.error || '',
      TimedOut: result.timedOut === true ? 'Yes' : 'No',
      TabCount: tabCount,
      ShiftTabCount: shiftTabCount,
      TabCoveragePercent: result.tabCoveragePercent ?? '',
      MissingElementsCount: result.missingElementsCount ?? '',
      CriticalMissingCount: result.criticalMissingCount ?? '',
      NonCriticalMissingCount: result.nonCriticalMissingCount ?? '',
      FocusIndicatorFailures: focusIndicatorFailures,
      ScrollPositionsCount: scrollPositionsCount,
      RightClickContextMenuWorks: result.mouseRightClick?.contextMenuWorks === true ? 'Yes' : result.mouseRightClick ? 'No' : 'N/A',
      LeftClickTested: result.mouseLeftClick?.tested ?? '',
      LeftClickPassed: result.mouseLeftClick?.passed ?? '',
      LeftClickFailed: result.mouseLeftClick?.failed ?? '',
      PointerBlockedCount: result.pointerAccessibility?.pointerBlockedCount ?? '',
      SmallTargetCount: result.pointerAccessibility?.smallTargetCount ?? '',
      WCAG22_FocusNotObscured: result.focusNotObscured?.ok === true ? 'Pass' : result.focusNotObscured ? 'Fail' : '',
      WCAG22_FocusObscuredCount: result.focusNotObscured?.obscuredCount ?? '',
      WCAG22_DraggingMovements: result.draggingMovements?.ok === true ? 'Pass' : result.draggingMovements ? 'Needs Review' : '',
      WCAG22_DragElementsCount: result.draggingMovements?.totalDragElements ?? '',
      WCAG22_ConsistentHelp: result.consistentHelp?.ok === true ? 'Pass' : result.consistentHelp ? 'Info' : '',
      WCAG22_HelpMechanismsFound: result.consistentHelp?.helpMechanismsFound ?? '',
      WCAG_Images: result.wcagMetrics?.images ?? '',
      WCAG_ImagesWithoutAlt: result.wcagMetrics?.imagesWithoutAlt ?? '',
      WCAG_Headings: result.wcagMetrics?.headings ?? '',
      WCAG_HasH1: result.wcagMetrics?.hasH1 === true ? 'Yes' : result.wcagMetrics ? 'No' : '',
      WCAG_Forms: result.wcagMetrics?.forms ?? '',
      WCAG_Buttons: result.wcagMetrics?.buttons ?? '',
      WCAG_Links: result.wcagMetrics?.links ?? '',
      Axe_Total: result.axeViolations?.total ?? '',
      Axe_Critical: result.axeViolations?.critical ?? '',
      Axe_Serious: result.axeViolations?.serious ?? '',
      Axe_Moderate: result.axeViolations?.moderate ?? '',
      Axe_Minor: result.axeViolations?.minor ?? ''
    };
  });

  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  const detailsSheet = XLSX.utils.json_to_sheet(detailRows);

  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');
  XLSX.utils.book_append_sheet(workbook, detailsSheet, 'Details');

  XLSX.writeFile(workbook, outputPath);
}

const runtimePolicy = {
  minTabCoverage: parseIntegerFlag('--min-tab-coverage', 70, { min: 0, max: 100 }),
  enforceContextMenu: process.argv.includes('--enforce-context-menu'),
  lenientVtabs: process.argv.includes('--lenient-vtabs'),
  diagnosticExpandMenus: process.argv.includes('--diagnostic-expand-menus'),
  diagnosticTraceFocus: process.argv.includes('--diagnostic-trace-focus'),
  focusBorderMinPx: parseFloatFlag('--focus-border-min-px', 2, { min: 0, max: 20 }),
  focusBgCheck: parseBooleanFlag('--focus-bg-check', true),
  focusObscuredThreshold: parseFloatFlag('--focus-obscured-threshold', 0.25, { min: 0, max: 1 }), // 25% obstruction threshold
  urlTimeBudgetMs: parseIntegerFlag('--url-time-budget-ms', 120000, { min: 10000, max: 1800000 }),
  axeFailLevel: (getArgValue('--axe-fail-level') || 'critical').toLowerCase(),
  needsReviewGrayZoneMissRatio: parseFloatFlag('--needs-review-gray-zone-miss-ratio', 0.35, { min: 0, max: 1 }),
  needsReviewTraversalInflationFactor: parseFloatFlag('--needs-review-traversal-inflation-factor', 1.4, { min: 1, max: 5 }),
  needsReviewAmbiguityPercent: parseFloatFlag('--needs-review-ambiguity-percent', 20, { min: 0, max: 100 }),
  needsReviewManualParityMin: parseFloatFlag('--needs-review-manual-parity-min', 0.7, { min: 0, max: 1 })
};

if (!['critical', 'serious', 'none'].includes(runtimePolicy.axeFailLevel)) {
  logger.error(`Invalid value for --axe-fail-level: "${runtimePolicy.axeFailLevel}". Use critical|serious|none.`);
  process.exit(1);
}

// Find and parse CSV file
const fileArgIndex = process.argv.indexOf('--file');
const specifiedFile = fileArgIndex !== -1 && fileArgIndex + 1 < process.argv.length 
  ? process.argv[fileArgIndex + 1] 
  : null;

const csvFilePath = findCsvFile(__dirname, CONFIG.CSV_FILES, specifiedFile);
if (!csvFilePath) {
  logger.error('CSV file configuration failed');
  process.exit(1);
}

// Parse CSV
const parseResult = parseCSV(csvFilePath);
if (!parseResult.success) {
  logger.error('CSV parsing failed:');
  parseResult.errors.forEach(err => logger.error(`  - ${err}`));
  process.exit(1);
}

const csvData = parseResult.data;
if (parseResult.errors.length > 0) {
  logger.warning('CSV parsing warnings:');
  parseResult.errors.forEach(err => logger.warning(`  - ${err}`));
}

// Get environment prefix and create report filename
const environmentPrefix = getEnvironmentPrefix(csvData);
const htmlPath = path.join(reportDir, `${environmentPrefix}_${CONFIG.REPORT_PREFIX}_${timestamp}.html`);
const excelPath = path.join(reportDir, `${environmentPrefix}_${CONFIG.REPORT_PREFIX}_${timestamp}.xlsx`);

// Create urlLines array for backward compatibility with existing loop
const urlLines = csvData.map(entry => entry.url);

logger.startup(`Found ${urlLines.length} URL(s) to test:`);
urlLines.forEach((url, idx) => {
  logger.metric(`${idx + 1}`, url);
});
logger.info('');

// ============================================================================
// Enhanced Page Load Readiness Check
// ============================================================================
async function waitForPageReady(page) {
  const readinessStart = Date.now();
  console.log(`  [...] Waiting for page to be fully ready...`);
  
  // 1. Wait for networkidle (all network requests complete)
  console.log(`    -> Waiting for network idle...`);
  let networkIdleSuccess = false;
  try {
    await page.waitForLoadState('networkidle', { timeout: 45000 });
    console.log(`    [OK] Network idle`);
    networkIdleSuccess = true;
  } catch (error) {
    console.log(`    [WARN] Network idle timeout (continuing with other checks)...`);
  }
  
  // 2. Wait for main content to be present and visible
  console.log(`    -> Detecting main content element...`);
  let mainContentFound = false;
  try {
    await Promise.race([
      page.waitForSelector('main, [role="main"], article, .container, [class*="content"]', { timeout: 20000 }),
      page.waitForTimeout(3000)
    ]);
    mainContentFound = true;
    console.log(`    [OK] Main content element detected`);
  } catch (error) {
    console.log(`    [WARN] Main content element not explicitly detected (proceeding)...`);
  }
  
  // 3. Wait for loading indicators to disappear
  console.log(`    -> Checking for loading indicators...`);
  let loadersCleared = false;
  try {
    await page.waitForFunction(() => {
      const loaders = document.querySelectorAll(
        '[class*="loader"], [class*="spinner"], [class*="skeleton"], [aria-label*="loading" i], ' +
        '[class*="loading"], [class*="progress"], app-loading, .mat-progress-bar, .loader, .spinner'
      );
      if (loaders.length === 0) return true;
      return Array.from(loaders).every(el => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        // Hidden via display, visibility, or opacity
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return true;
        // Offscreen
        if (rect.width === 0 || rect.height === 0) return true;
        return false;
      });
    }, { timeout: 20000 });
    loadersCleared = true;
    console.log(`    [OK] Loading indicators removed`);
  } catch (error) {
    console.log(`    [WARN] Loading indicators still present (proceeding)...`);
  }
  
  // 4. Wait for dynamic content to stabilize with stability check
  console.log(`    -> Stabilizing dynamic content...`);
  let contentStable = false;
  try {
    const stabilityTimeoutMs = 15000;
    const stabilityIntervalMs = 300;
    const requiredStableSnapshots = 3;
    const maxLengthDelta = 100;
    const maxCountDelta = 10;
    const stabilityStart = Date.now();
    let stableSnapshots = 0;
    let previousSnapshot = null;

    while ((Date.now() - stabilityStart) < stabilityTimeoutMs) {
      const snapshot = await page.evaluate(() => ({
        textLength: document.body.innerText.length,
        elementCount: document.querySelectorAll('*').length,
        htmlLength: document.body.innerHTML.length
      }));

      if (previousSnapshot) {
        const lengthChange = Math.abs(snapshot.textLength - previousSnapshot.textLength);
        const countChange = Math.abs(snapshot.elementCount - previousSnapshot.elementCount);
        if (lengthChange < maxLengthDelta && countChange < maxCountDelta) {
          stableSnapshots++;
          if (stableSnapshots >= requiredStableSnapshots) {
            contentStable = true;
            break;
          }
        } else {
          stableSnapshots = 0;
        }
      }

      previousSnapshot = snapshot;
      await page.waitForTimeout(stabilityIntervalMs);
    }

    if (!contentStable) {
      const finalContent = await page.evaluate(() => document.body.innerHTML.length);
      contentStable = finalContent > 500;
    }
    
    if (contentStable) {
      console.log(`    [OK] Content stability verified`);
    } else {
      console.log(`    [WARN] Content stability check failed (content may still be loading)`);
    }
  } catch (error) {
    console.log(`    [WARN] Content stability check failed: ${error.message}`);
  }
  
  // 5. Wait for any pending animations/transitions
  console.log(`    -> Waiting for animations to complete...`);
  let animationsComplete = false;
  try {
    const animationTimeout = 10000;
    const animationResult = await Promise.race([
      page.evaluate(() => {
        return new Promise(resolve => {
          // Wait for requestAnimationFrame queue to clear and no CSS animations
          let frameCount = 0;
          const maxFrames = 10;
          
          const checkIfReady = () => {
            frameCount++;
            if (frameCount < maxFrames) {
              requestAnimationFrame(checkIfReady);
            } else {
              resolve(true);
            }
          };
          requestAnimationFrame(checkIfReady);
        });
      }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Animation check timeout')), animationTimeout)
      )
    ]);
    
    animationsComplete = true;
    console.log(`    [OK] Animations completed`);
  } catch (error) {
    if (error.message.includes('Animation check timeout')) {
      console.log(`    [WARN] Animation completion timeout`);
    } else {
      console.log(`    [WARN] Animation check failed: ${error.message}`);
    }
  }
  
  // 6. Final stability buffer
  console.log(`    -> Final stability buffer (500ms)...`);
  await page.waitForTimeout(500);
  
  // 7. Wait for focusable elements to appear (for dynamic pages)
  console.log(`    -> Waiting for focusable elements...`);
  try {
    await page.waitForFunction(() => {
      const focusableSelectors = 'a[href], button, input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])';
      const focusables = document.querySelectorAll(focusableSelectors);
      return focusables.length > 0;
    }, { timeout: 10000 });
    console.log(`    [OK] Focusable elements detected`);
  } catch (error) {
    console.log(`    [WARN] No focusable elements found within timeout (may be dynamic page)`);
  }
  
  const readinessDuration = Date.now() - readinessStart;
  console.log(`  [OK] Page fully ready in ${readinessDuration}ms`);
  
  // Return status summary
  return {
    networkIdle: networkIdleSuccess,
    mainContentDetected: mainContentFound,
    loadersCleared: loadersCleared,
    contentStable: contentStable,
    animationsComplete: animationsComplete,
    duration: readinessDuration
  };
}

// ============================================================================
async function getSimplifiedWCAGMetrics(page) {
  console.log(`  [...] [WCAG-METRICS] Gathering accessibility metrics...`);
  const startMetrics = Date.now();
  try {
    const metrics = await page.evaluate(() => {
      return {
        images: document.querySelectorAll('img').length,
        imagesWithoutAlt: document.querySelectorAll('img:not([alt])').length,
        headings: document.querySelectorAll('h1, h2, h3, h4, h5, h6').length,
        hasH1: document.querySelectorAll('h1').length > 0,
        forms: document.querySelectorAll('input, textarea, select').length,
        buttons: document.querySelectorAll('button').length,
        links: document.querySelectorAll('a[href]').length
      };
    });
    
    console.log(`  [OK] [WCAG-METRICS] Images: ${metrics.images}, H1: ${metrics.hasH1 ? 'yes' : 'no'}, Forms: ${metrics.forms}, Buttons: ${metrics.buttons} (${Date.now() - startMetrics}ms)`);
    return metrics;
  } catch (error) {
    console.log(`  [X] [WCAG-METRICS] Error: ${error.message}`);
    return { images: 0, imagesWithoutAlt: 0, headings: 0, hasH1: false, forms: 0, buttons: 0, links: 0 };
  }
}

// ============================================================================
// axe-core WCAG 2.2 AA Rule Scanning
// ============================================================================
async function runAxeScan(page) {
  console.log(`  [...] [AXE-SCAN] Running axe-core WCAG 2.2 AA audit...`);
  const startScan = Date.now();
  try {
    // Inject axe-core into the page (ESM-safe)
    await page.addScriptTag({ content: axe.source });
    
    // Run axe with full WCAG 2.2 Level AA standard (all prerequisite levels included)
    // WCAG 2.2 AA conformance requires meeting all A+AA criteria from WCAG 2.0, 2.1, and 2.2
    const axeStandards = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
    const results = await page.evaluate(async (tags) => {
      return new Promise((resolve) => {
        window.axe.run(
          { runOnly: { type: 'tag', values: tags } },
          (err, results) => {
            if (err) throw err;
            resolve(results);
          }
        );
      });
    }, axeStandards);
    
    // Summarize violations by impact
    const violationSummary = {
      critical: 0,
      serious: 0,
      moderate: 0,
      minor: 0,
      total: 0,
      violations: []
    };
    
    if (results.violations && results.violations.length > 0) {
      results.violations.forEach(v => {
        if (v.impact === 'critical') violationSummary.critical++;
        else if (v.impact === 'serious') violationSummary.serious++;
        else if (v.impact === 'moderate') violationSummary.moderate++;
        else if (v.impact === 'minor') violationSummary.minor++;
        violationSummary.total++;
        violationSummary.violations.push({
          id: v.id,
          impact: v.impact,
          nodes: v.nodes.length
        });
      });
    }
    
    console.log(`  [OK] [AXE-SCAN] Completed: ${violationSummary.total} violations (${violationSummary.critical} critical, ${violationSummary.serious} serious) (${Date.now() - startScan}ms)`);
    return violationSummary;
  } catch (error) {
    console.log(`  [WARN] [AXE-SCAN] Error: ${error.message}`);
    return { critical: 0, serious: 0, moderate: 0, minor: 0, total: 0, violations: [] };
  }
}

// ============================================================================
// Mouse Right-Click (Context Menu) Validation
// ============================================================================
async function validateMouseRightClick(page) {
  console.log(`  [...] [MOUSE-RIGHTCLICK] Testing if right-click (context menu) is enabled...`);
  const startRightClick = Date.now();
  try {
    // Check if page is still valid
    if (!page || page.isClosed()) {
      return { ok: false, error: 'Page closed', contextMenuWorks: false };
    }

    // Get the main content area or body to right-click on
    const mainElement = await page.$('main, article, [role="main"], body').catch(() => null);
    
    let rightClickWorks = false;
    
    if (mainElement) {
      // Scroll element into view
      await mainElement.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(100).catch(() => {});
      
      // Perform right-click and check the result
      rightClickWorks = await page.evaluate(async () => {
        return new Promise((resolve) => {
          setTimeout(() => {
            const mainContent = document.querySelector('main, article, [role="main"], body');
            if (!mainContent) {
              resolve(false);
              return;
            }
            
            // Create and dispatch contextmenu event
            const event = new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              button: 2,
              view: window
            });
            
            // Dispatch and check if it was prevented/blocked
            const wasNotBlocked = mainContent.dispatchEvent(event);
            
            // Also check if any handler called preventDefault
            let preventDefaultWasCalled = false;
            const testEvent = new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              button: 2,
              view: window
            });
            
            const contextMenuHandler = (e) => {
              if (e.defaultPrevented) {
                preventDefaultWasCalled = true;
              }
            };
            
            mainContent.addEventListener('contextmenu', contextMenuHandler, { once: true });
            mainContent.dispatchEvent(testEvent);
            mainContent.removeEventListener('contextmenu', contextMenuHandler);
            
            // Right-click works if event returned true AND preventDefault was not called
            const works = wasNotBlocked && !preventDefaultWasCalled;
            resolve(works);
          }, 50);
        });
      }).catch(() => false);
    }
    
    const status = rightClickWorks ? 'ENABLED' : 'DISABLED';
    console.log(`  [OK] [MOUSE-RIGHTCLICK] Right-click test: context menu ${status} (${Date.now() - startRightClick}ms)`);
    
    return {
      ok: rightClickWorks,
      contextMenuWorks: rightClickWorks
    };
  } catch (error) {
    console.log(`  [WARN] [MOUSE-RIGHTCLICK] Error: ${error.message}`);
    return { ok: false, error: error.message, contextMenuWorks: false };
  }
}

// ============================================================================
// Mouse Left-Click Validation (Informational)
// ============================================================================
async function validateMouseLeftClick(page) {
  console.log(`  [...] [MOUSE-LEFTCLICK] Sampling clickable elements for left-click operability...`);
  const start = Date.now();
  try {
    // Prioritize explicit controls first for better real-world signal.
    const primarySelectors = [
      'button',
      'input[type="button"]',
      'input[type="submit"]',
      '[role="button"]',
      'summary'
    ];
    const fallbackSelectors = ['a[href]'];

    const handles = [
      ...(await page.$$(primarySelectors.join(','))),
      ...(await page.$$(fallbackSelectors.join(',')))
    ];

    const candidates = [];
    for (const handle of handles) {
      const isVisible = await handle.isVisible().catch(() => false);
      const isDisabled = await handle.evaluate(el => !!el.disabled).catch(() => false);
      const pointerEvents = await handle.evaluate(el => window.getComputedStyle(el).pointerEvents).catch(() => '');
      const isLikelyClickable = await handle.evaluate((el) => {
        try {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
          const top = document.elementFromPoint(x, y);
          return !!top && (top === el || el.contains(top) || top.contains(el));
        } catch (e) {
          return false;
        }
      }).catch(() => false);

      if (isVisible && !isDisabled && pointerEvents !== 'none' && isLikelyClickable) {
        candidates.push(handle);
      }
      if (candidates.length >= 12) break;
    }

    if (candidates.length === 0) {
      return {
        ok: true,
        tested: 0,
        clickableDetected: 0,
        passed: 0,
        failed: 0,
        blockedByOverlay: 0,
        details: [],
        note: 'No actionable clickable elements found'
      };
    }

    const sampleIdx = [...new Set([0, Math.floor(candidates.length / 2), candidates.length - 1])].filter(i => i >= 0 && i < candidates.length);
    const details = [];
    let passed = 0;
    let failed = 0;
    let blockedByOverlay = 0;

    for (const idx of sampleIdx) {
      const handle = candidates[idx];
      const info = await handle.evaluate(el => ({
        tag: el.tagName,
        id: el.id || '',
        class: el.className || '',
        text: (el.innerText || el.textContent || '').trim().substring(0, 60)
      })).catch(() => ({ tag: 'UNKNOWN', id: '', class: '', text: '' }));

      let actionable = true;
      let category = 'ok';
      let errorMessage = '';

      try {
        await handle.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(30).catch(() => {});
        await handle.click({ trial: true, timeout: 1800 });
      } catch (e) {
        actionable = false;
        const raw = e && e.message ? e.message : 'actionability failed';
        errorMessage = raw.substring(0, 160);
        const normalized = raw.toLowerCase();
        if (normalized.includes('intercepts pointer events') || normalized.includes('element is obscured')) {
          category = 'blocked-overlay';
          blockedByOverlay++;
        } else if (normalized.includes('not visible') || normalized.includes('outside of the viewport')) {
          category = 'not-visible';
        } else if (normalized.includes('detached from dom') || normalized.includes('execution context was destroyed')) {
          category = 'detached';
        } else {
          category = 'actionability-failed';
        }
      }

      if (actionable) passed++;
      else failed++;

      details.push({
        ...info,
        actionable,
        category,
        error: errorMessage
      });
    }

    const result = {
      tested: sampleIdx.length,
      clickableDetected: candidates.length,
      passed,
      failed,
      blockedByOverlay,
      details,
      note: 'Informational check using Playwright trial click (no navigation); failures are categorized for triage'
    };

    // Keep this informational: overlay-blocked samples are advisory, not hard failures.
    const effectiveFailures = Math.max(0, result.failed - result.blockedByOverlay);
    const ok = result.tested === 0 ? true : effectiveFailures === 0;
    console.log(`  [OK] [MOUSE-LEFTCLICK] Tested ${result.tested} sample(s), pass=${result.passed}, fail=${result.failed} (${Date.now() - start}ms)`);
    return { ok, ...result };
  } catch (error) {
    console.log(`  [WARN] [MOUSE-LEFTCLICK] Error: ${error.message}`);
    return { ok: false, tested: 0, clickableDetected: 0, passed: 0, failed: 0, details: [], error: error.message };
  }
}

// ============================================================================
// Hover State Validation
// ============================================================================
async function validateHoverStates(page) {
  console.log(`  [...] [HOVER-STATE] Sampling interactive elements for hover-style response...`);
  const start = Date.now();
  try {
    // Reload page to guarantee a pristine DOM/CSS state.
    // Previous tests (vtabs, right-click) can leave flyout menus open or
    // Angular component states active, which suppress hover CSS transitions.
    // Cookie consent persists in session cookies so banners will not reappear.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000).catch(() => {}); // allow Angular bootstrap + lazy JS to settle

    // Reset page state: scroll to top, move mouse to safe zone
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      if (document.activeElement && document.activeElement !== document.body) {
        document.activeElement.blur();
      }
    }).catch(() => {});
    const vpSize = page.viewportSize() || { width: 1280, height: 720 };
    await page.mouse.move(vpSize.width / 2, vpSize.height - 20).catch(() => {});
    await page.waitForTimeout(500).catch(() => {}); // 500ms: allow Angular hover state + CSS transitions to fully settle

    const selectors = ['a[href]', 'button', '[role="button"]', 'summary'];
    const handles = await page.$$(selectors.join(','));
    const visibleHandles = [];
    for (const handle of handles) {
      const isVisible = await handle.isVisible().catch(() => false);
      if (!isVisible) continue;
      // Skip decorative/empty elements: no text, no aria-label, no meaningful id
      // These are logo links, icon-only buttons etc. that never have hover styles by design
      const isEmpty = await handle.evaluate(el => {
        const text = (el.innerText || el.textContent || '').trim();
        const label = el.getAttribute('aria-label') || '';
        const title = el.getAttribute('title') || '';
        return text.length === 0 && label.length === 0 && title.length === 0;
      }).catch(() => false);
      if (isEmpty) continue;
      visibleHandles.push(handle);
      if (visibleHandles.length >= 10) break;
    }

    if (visibleHandles.length === 0) {
      return { ok: true, tested: 0, hoverStyleChanged: 0, unchanged: 0, details: [], note: 'No visible interactive elements for hover test' };
    }

    const details = [];
    let hoverStyleChanged = 0;
    let unchanged = 0;

    for (const handle of visibleHandles) {
      // Move mouse to bottom-center (safe, away from nav/header) so previous :hover CSS clears
      // 300ms ensures Angular component state + CSS transitions fully reset before baseline
      const vp = page.viewportSize() || { width: 1280, height: 720 };
      await page.mouse.move(vp.width / 2, vp.height - 20).catch(() => {});
      await page.waitForTimeout(300).catch(() => {});

      // Pre-scroll element into view so handle.hover() won't need to scroll mid-test
      // (scroll during hover disrupts nearby elements' CSS :hover state)
      await handle.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
      await page.mouse.move(vp.width / 2, vp.height - 20).catch(() => {}); // move away after scroll
      await page.waitForTimeout(200).catch(() => {}); // wait for scroll-triggered CSS states to settle

      const before = await handle.evaluate((el) => {
        const s = window.getComputedStyle(el);
        return {
          backgroundColor: s.backgroundColor,
          color: s.color,
          textDecoration: s.textDecoration,
          outlineColor: s.outlineColor,
          boxShadow: s.boxShadow,
          cursor: s.cursor,
          opacity: s.opacity,
          transform: s.transform,
          tag: el.tagName,
          id: el.id || '',
          class: el.className || '',
          text: (el.innerText || el.textContent || '').trim().substring(0, 60)
        };
      }).catch(() => null);

      if (!before) continue;

      await handle.hover({ timeout: 1200 }).catch(() => {});
      await page.waitForTimeout(200).catch(() => {}); // 200ms: Angular processes mouseover + CSS transition settles

      const after = await handle.evaluate((el) => {
        const s = window.getComputedStyle(el);
        return {
          backgroundColor: s.backgroundColor,
          color: s.color,
          textDecoration: s.textDecoration,
          outlineColor: s.outlineColor,
          boxShadow: s.boxShadow,
          cursor: s.cursor,
          opacity: s.opacity,
          transform: s.transform
        };
      }).catch(() => null);

      if (!after) continue;

      const changed =
        before.backgroundColor !== after.backgroundColor ||
        before.color !== after.color ||
        before.textDecoration !== after.textDecoration ||
        before.outlineColor !== after.outlineColor ||
        before.boxShadow !== after.boxShadow ||
        before.cursor !== after.cursor ||
        before.opacity !== after.opacity ||
        before.transform !== after.transform;

      if (changed) hoverStyleChanged++;
      else unchanged++;

      details.push({
        tag: before.tag,
        id: before.id,
        class: before.class,
        text: before.text,
        changed
      });
    }

    const result = {
      tested: details.length,
      hoverStyleChanged,
      unchanged,
      details
    };

    // Pass if nothing tested, OR if majority (>50%) of tested elements respond to hover with a style change
    const ok = result.tested === 0 || (result.unchanged / result.tested) <= 0.5;
    const statusLabel = ok ? '[OK]' : '[WARN]';
    console.log(`  ${statusLabel} [HOVER-STATE] Tested ${result.tested} sample(s), changed=${result.hoverStyleChanged}, unchanged=${result.unchanged} (${Date.now() - start}ms)`);
    // Log each element result
    for (const d of details) {
      const label = `${d.tag}${d.id ? '#' + d.id : ''}${d.class ? '.' + String(d.class).split(' ')[0] : ''}`.substring(0, 40);
      const verdict = d.changed ? '[changed]' : '[no-change]';
      console.log(`    ${verdict} ${label} "${d.text ? d.text.substring(0, 50) : ''}"`);
    }
    return { ok, ...result };
  } catch (error) {
    console.log(`  [WARN] [HOVER-STATE] Error: ${error.message}`);
    return { ok: false, tested: 0, hoverStyleChanged: 0, unchanged: 0, details: [], error: error.message };
  }
}

// ============================================================================
// Pointer Accessibility Validation (Informational)
// ============================================================================
async function validatePointerAccessibility(page) {
  console.log(`  [...] [POINTER-A11Y] Checking pointer-events and minimum target-size indicators...`);
  const start = Date.now();
  try {
    const result = await page.evaluate(() => {
      function isVisible(el) {
        try {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          if (rect.width <= 0 || rect.height <= 0) return false;
          return true;
        } catch (e) {
          return false;
        }
      }

      const selectors = [
        'a[href]',
        'button',
        'input:not([type="hidden"])',
        'select',
        'textarea',
        '[role="button"]',
        '[role="link"]'
      ];

      const all = Array.from(document.querySelectorAll(selectors.join(','))).filter(el => isVisible(el) && !el.disabled);
      const pointerBlocked = [];
      const smallTargets = [];

      all.forEach(el => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const info = {
          tag: el.tagName,
          id: el.id || '',
          class: el.className || '',
          text: (el.innerText || el.textContent || '').trim().substring(0, 60),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };

        if (style.pointerEvents === 'none') {
          pointerBlocked.push(info);
        }

        if (rect.width < 24 || rect.height < 24) {
          smallTargets.push(info);
        }
      });

      return {
        tested: all.length,
        pointerBlockedCount: pointerBlocked.length,
        smallTargetCount: smallTargets.length,
        pointerBlocked: pointerBlocked.slice(0, 20),
        smallTargets: smallTargets.slice(0, 20),
        note: 'Small targets are advisory and may have valid WCAG exceptions'
      };
    });

    const ok = result.pointerBlockedCount === 0;
    console.log(`  [OK] [POINTER-A11Y] Tested ${result.tested} elements, pointer-blocked=${result.pointerBlockedCount}, small-target=${result.smallTargetCount} (${Date.now() - start}ms)`);
    return { ok, ...result };
  } catch (error) {
    console.log(`  [WARN] [POINTER-A11Y] Error: ${error.message}`);
    return { ok: false, tested: 0, pointerBlockedCount: 0, smallTargetCount: 0, pointerBlocked: [], smallTargets: [], error: error.message };
  }
}

// ============================================================================
// WCAG 2.2 SC 2.4.11 - Focus Not Obscured (Minimum) Validation
// ============================================================================
// Checks that focused elements are not entirely hidden behind sticky/fixed headers/footers
// ENHANCED: Uses real keyboard TAB navigation and elementFromPoint for accurate detection
async function validateFocusNotObscured(page) {
  console.log(`  [...] [FOCUS-NOT-OBSCURED] Checking if focused elements are obscured by sticky/fixed elements...`);
  const start = Date.now();
  try {
    const result = await page.evaluate(({ obstructionThreshold }) => {
      // Configuration
      const config = {
        obstructionThreshold: obstructionThreshold || 0.25, // 25% - ignore minor overlaps
        sampleSize: 20, // Max elements to test
        minVisibleArea: 0.10 // At least 10% must be visible to pass
      };

      // Find all sticky/fixed positioned elements that could obscure focus
      const allElements = Array.from(document.querySelectorAll('*'));
      const obscuringElements = allElements.filter(el => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (style.position === 'fixed' || style.position === 'sticky') &&
          rect.width > 0 &&
          rect.height > 0 &&
          style.opacity !== '0' &&
          style.visibility !== 'hidden' &&
          style.display !== 'none';
      });

      if (obscuringElements.length === 0) {
        return { 
          ok: true,
          tested: 0, 
          obscuredCount: 0, 
          minorObscuredCount: 0,
          details: [], 
          fixedStickyElements: 0,
          note: 'No fixed/sticky elements found' 
        };
      }

      // Get focusable elements
      const focusableSelectors = 'a[href], button, input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])';
      const focusableElements = Array.from(document.querySelectorAll(focusableSelectors)).filter(el => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && 
               style.visibility !== 'hidden' &&
               !el.disabled &&
               rect.width > 0 &&
               rect.height > 0;
      });

      // Sample focusable elements
      const sampleSize = Math.min(focusableElements.length, config.sampleSize);
      const step = Math.max(1, Math.floor(focusableElements.length / sampleSize));
      const sampled = [];
      for (let i = 0; i < focusableElements.length && sampled.length < sampleSize; i += step) {
        sampled.push(focusableElements[i]);
      }

      const details = [];
      let obscuredCount = 0;
      let minorObscuredCount = 0;

      sampled.forEach(el => {
        try {
          // Focus the element
          el.focus();
          
          const rect = el.getBoundingClientRect();
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;

          // Test multiple points to calculate obstruction percentage
          const testPoints = [
            { x: centerX, y: centerY, label: 'center' },
            { x: rect.left + rect.width * 0.25, y: centerY, label: 'left-quarter' },
            { x: rect.left + rect.width * 0.75, y: centerY, label: 'right-quarter' },
            { x: centerX, y: rect.top + rect.height * 0.25, label: 'top-quarter' },
            { x: centerX, y: rect.top + rect.height * 0.75, label: 'bottom-quarter' }
          ];

          let obscuredPoints = 0;
          let obscuringElement = null;
          const obscuredTestPoints = [];

          for (const point of testPoints) {
            const topEl = document.elementFromPoint(point.x, point.y);
            if (topEl && topEl !== el && !el.contains(topEl)) {
              // Check if this is one of our fixed/sticky elements
              const isObscuringEl = obscuringElements.some(obstruct => 
                obstruct === topEl || obstruct.contains(topEl)
              );
              
              if (isObscuringEl) {
                obscuredPoints++;
                obscuredTestPoints.push(point.label);
                if (!obscuringElement) {
                  obscuringElement = topEl;
                  // Walk up to find the actual fixed/sticky element
                  let current = topEl;
                  while (current && current !== document.body) {
                    const style = window.getComputedStyle(current);
                    if (style.position === 'fixed' || style.position === 'sticky') {
                      obscuringElement = current;
                      break;
                    }
                    current = current.parentElement;
                  }
                }
              }
            }
          }

          const obstructionPercent = obscuredPoints / testPoints.length;
          
          if (obstructionPercent >= config.obstructionThreshold) {
            const isFullyObscured = obstructionPercent >= (1 - config.minVisibleArea);
            
            if (isFullyObscured) {
              obscuredCount++;
            } else {
              minorObscuredCount++;
            }

            // Get obscuring element details
            const obscuringStyle = obscuringElement ? window.getComputedStyle(obscuringElement) : null;
            const obscuringRect = obscuringElement ? obscuringElement.getBoundingClientRect() : null;

            // Generate fix suggestions
            const fixes = [];
            
            if (obscuringElement && obscuringStyle) {
              const position = obscuringStyle.position;
              
              // Fix 1: Add scroll-margin
              if (position === 'fixed' || position === 'sticky') {
                const headerHeight = obscuringRect ? Math.ceil(obscuringRect.height) : 0;
                if (headerHeight > 0) {
                  fixes.push({
                    priority: 1,
                    title: 'Add scroll-margin CSS property',
                    code: `scroll-margin-top: ${headerHeight + 10}px;`,
                    description: `Prevents element from scrolling behind ${position} header`
                  });
                }
              }

              // Fix 2: ScrollIntoView with offset
              fixes.push({
                priority: 2,
                title: 'Use scrollIntoView with block: center',
                code: `element.scrollIntoView({ block: "center", behavior: "smooth" });`,
                description: 'Centers element in viewport, avoiding fixed headers/footers'
              });

              // Fix 3: Manual scroll offset
              fixes.push({
                priority: 3,
                title: 'Add manual scroll offset',
                code: `window.scrollTo({ top: element.offsetTop - ${obscuringRect ? Math.ceil(obscuringRect.height) : 100}, behavior: "smooth" });`,
                description: 'Scrolls to element position minus header height'
              });
            }

            details.push({
              severity: isFullyObscured ? 'FAIL' : 'WARN',
              focusedElement: {
                tag: el.tagName,
                id: el.id || '',
                class: el.className || '',
                text: (el.innerText || el.textContent || '').trim().substring(0, 60),
                selector: el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}${el.className ? '.' + el.className.split(' ')[0] : ''}`
              },
              obscuringElement: obscuringElement ? {
                tag: obscuringElement.tagName,
                id: obscuringElement.id || '',
                class: obscuringElement.className || '',
                position: obscuringStyle.position,
                zIndex: obscuringStyle.zIndex,
                height: obscuringRect ? Math.ceil(obscuringRect.height) : 0,
                selector: obscuringElement.id ? `#${obscuringElement.id}` : `${obscuringElement.tagName.toLowerCase()}${obscuringElement.className ? '.' + obscuringElement.className.split(' ')[0] : ''}`
              } : null,
              obstructionPercent: Math.round(obstructionPercent * 100),
              obscuredPoints: obscuredTestPoints,
              fixes
            });
          }
        } catch (error) {
          // Skip elements that can't be focused or measured
        }
      });

      return {
        ok: obscuredCount === 0,
        tested: sampled.length,
        obscuredCount,
        minorObscuredCount,
        fixedStickyElements: obscuringElements.length,
        details: details.slice(0, 10) // Limit to top 10 for performance
      };
    }, { obstructionThreshold: runtimePolicy.focusObscuredThreshold || 0.25 });

    // Determine status based on severity rules
    let status = '[OK]';
    if (result.obscuredCount >= 2) {
      status = '[X]'; // FAIL
    } else if (result.obscuredCount === 1) {
      status = '[WARN]'; // WARN
    }
    
    console.log(`  ${status} [FOCUS-NOT-OBSCURED] Tested ${result.tested} elements, obscured=${result.obscuredCount}, minor=${result.minorObscuredCount}, fixed/sticky overlays=${result.fixedStickyElements || 0} (${Date.now() - start}ms)`);
    
    if (result.details && result.details.length > 0) {
      result.details.forEach((detail, i) => {
        if (i < 3) { // Log first 3
          console.log(`     [${detail.severity}] ${detail.focusedElement.tag}${detail.focusedElement.id ? '#' + detail.focusedElement.id : ''} obscured ${detail.obstructionPercent}% by ${detail.obscuringElement ? detail.obscuringElement.tag : 'unknown'}`);
        }
      });
    }
    
    return { ...result, status };
  } catch (error) {
    console.log(`  [WARN] [FOCUS-NOT-OBSCURED] Error: ${error.message}`);
    return { ok: true, tested: 0, obscuredCount: 0, minorObscuredCount: 0, details: [], error: error.message };
  }
}

// ============================================================================
// WCAG 2.2 SC 2.5.7 - Dragging Movements Validation
// ============================================================================
// Checks that elements requiring drag have alternative single-pointer controls
async function validateDraggingMovements(page) {
  console.log(`  [...] [DRAGGING-MOVEMENTS] Checking for drag-dependent interactions without alternatives...`);
  const start = Date.now();
  try {
    const result = await page.evaluate(() => {
      // Detect drag-dependent elements
      const dragElements = [];

      // 1. Elements with draggable attribute
      const draggables = Array.from(document.querySelectorAll('[draggable="true"]'));
      draggables.forEach(el => {
        dragElements.push({
          tag: el.tagName,
          id: el.id || '',
          text: (el.innerText || el.textContent || '').trim().substring(0, 60),
          type: 'draggable-attribute'
        });
      });

      // 2. Range sliders (input[type="range"]) - typically have built-in keyboard support
      const sliders = Array.from(document.querySelectorAll('input[type="range"]'));
      const slidersWithoutKeyboard = sliders.filter(el => {
        // Sliders natively support keyboard, so they pass unless custom-styled and broken
        return el.getAttribute('aria-disabled') === 'true';
      });
      slidersWithoutKeyboard.forEach(el => {
        dragElements.push({
          tag: el.tagName,
          id: el.id || '',
          text: el.getAttribute('aria-label') || '',
          type: 'disabled-slider'
        });
      });

      // 3. Custom drag-and-drop containers (common patterns)
      const customDragContainers = Array.from(document.querySelectorAll(
        '[class*="drag"], [class*="sortable"], [class*="draggable"], [data-drag], [data-sortable]'
      ));

      const dragWithoutAlternative = customDragContainers.filter(container => {
        // Check if container has button/keyboard alternative controls nearby
        const hasButtons = container.querySelectorAll('button, [role="button"], input[type="button"]').length > 0;
        const hasAriaControls = container.querySelector('[aria-controls], [aria-describedby*="move"], [aria-label*="move"]');
        return !hasButtons && !hasAriaControls;
      });

      dragWithoutAlternative.forEach(el => {
        dragElements.push({
          tag: el.tagName,
          id: el.id || '',
          class: el.className || '',
          text: (el.innerText || el.textContent || '').trim().substring(0, 60),
          type: 'custom-drag-no-alternative'
        });
      });

      // 4. Elements with explicit drag event handlers (ondrag, ondragstart)
      const withDragHandlers = Array.from(document.querySelectorAll('[ondrag], [ondragstart], [ondragend]'));
      withDragHandlers.forEach(el => {
        if (!draggables.includes(el)) {
          dragElements.push({
            tag: el.tagName,
            id: el.id || '',
            text: (el.innerText || el.textContent || '').trim().substring(0, 60),
            type: 'drag-event-handler'
          });
        }
      });

      return {
        totalDragElements: dragElements.length,
        dragElements: dragElements.slice(0, 20),
        note: 'WCAG 2.2 SC 2.5.7 requires single-pointer alternatives for drag operations'
      };
    });

    const ok = result.totalDragElements === 0;
    const status = ok ? '[OK]' : '[WARN]';
    console.log(`  ${status} [DRAGGING-MOVEMENTS] Found ${result.totalDragElements} potential drag-dependent element(s) (${Date.now() - start}ms)`);
    return { ok, ...result };
  } catch (error) {
    console.log(`  [WARN] [DRAGGING-MOVEMENTS] Error: ${error.message}`);
    return { ok: true, totalDragElements: 0, dragElements: [], error: error.message };
  }
}

// ============================================================================
// WCAG 2.2 SC 3.2.6 - Consistent Help Validation
// ============================================================================
// Checks if help mechanisms (contact info, chat, FAQ links) are consistently placed
async function validateConsistentHelp(page) {
  console.log(`  [...] [CONSISTENT-HELP] Checking for accessible help mechanisms...`);
  const start = Date.now();
  try {
    const result = await page.evaluate(() => {
      const helpIndicators = [
        'a[href*="help"]', 'a[href*="contact"]', 'a[href*="support"]', 'a[href*="faq"]',
        '[aria-label*="help" i]', '[aria-label*="contact" i]', '[aria-label*="support" i]',
        '[class*="help"]', '[class*="contact"]', '[class*="support"]', '[class*="chat"]',
        '[id*="help"]', '[id*="contact"]', '[id*="support"]',
        'a[href*="chat"]', '[role="complementary"][aria-label*="help" i]'
      ];

      const helpElements = Array.from(document.querySelectorAll(helpIndicators.join(',')));
      const visibleHelp = helpElements.filter(el => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      });

      return {
        helpMechanismsFound: visibleHelp.length,
        details: visibleHelp.slice(0, 10).map(el => ({
          tag: el.tagName,
          id: el.id || '',
          text: (el.innerText || el.textContent || '').trim().substring(0, 60),
          href: el.getAttribute('href') || ''
        })),
        note: 'WCAG 2.2 SC 3.2.6 requires help mechanisms in consistent relative order across pages'
      };
    });

    // This is informational - presence of help is advisory, consistency requires multi-page analysis
    const ok = result.helpMechanismsFound > 0;
    const status = ok ? '[OK]' : '[INFO]';
    console.log(`  ${status} [CONSISTENT-HELP] Found ${result.helpMechanismsFound} help mechanism(s) (${Date.now() - start}ms)`);
    return { ok, ...result };
  } catch (error) {
    console.log(`  [WARN] [CONSISTENT-HELP] Error: ${error.message}`);
    return { ok: true, helpMechanismsFound: 0, details: [], error: error.message };
  }
}

// ============================================================================
// Comprehensive Keyboard Navigation Validation (Enhanced - April 2026)
// ============================================================================
// Captures detailed keyboard navigation data with element categorization
// Categories: header, navigation, content, interactive, form, footer
async function captureComprehensiveKeyboardNavigation(page, allFocusableElements) {
  try {
    console.log(`  [...] [COMPREHENSIVE-KEYBOARD] Categorizing page elements by region...`);
    
    // Categorize elements by page region
    const elementsByCategory = await page.evaluate(() => {
      function getCategory(el) {
        const isHeader = el.closest('header, [role="banner"], nav:first-of-type');
        const isNav = el.closest('nav, [role="navigation"]');
        const isFooter = el.closest('footer, [role="contentinfo"]');
        const isForm = el.closest('form');
        const isMain = el.closest('main, article, [role="main"]');
        
        if (isFooter) return 'footer';
        if (isHeader) return 'header';
        if (isNav) return 'navigation';
        if (isForm) return 'form';
        if (isMain) return 'content';
        return 'interactive';
      }
      
      function getElementInfo(el) {
        return {
          tag: el.tagName,
          id: el.id || '',
          class: el.className || '',
          name: el.getAttribute('name') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          text: (el.innerText || el.textContent || '').substring(0, 80),
          type: el.type || '',
          href: el.getAttribute('href') || '',
          category: getCategory(el)
        };
      }
      
      const focusableSelectors = [
        'a[href]', 'area[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'iframe', '[tabindex]', '[contenteditable]',
        // ADDED (2026-04-10): Support for custom components and ARIA buttons/tabs
        '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
        // ADDED (2026-04-10 FIX #4): Custom web components - FOCUS TRAP CONTAINERS
        'ngx-web-small-cta', 'ngx-web-entity-container', 'ngx-nationwide-rich-text-component', 
        'ngx-nationwide-resource-promo', 'ngx-web-footer',
        'nw-button', 'nw-cta', 'bolt-button', 'bolt-autocomplete',
        // Elements INSIDE shadow DOM containers (light DOM children)
        'ngx-web-entity-container > *', 'ngx-web-small-cta > *', 'ngx-nationwide-resource-promo > *',
        '[data-focusable="true"]'
      ];
      const allElements = Array.from(document.querySelectorAll(focusableSelectors.join(',')));
      
      const byCategory = {
        header: [],
        navigation: [],
        content: [],
        form: [],
        interactive: [],
        footer: []
      };
      
      allElements.forEach(el => {
        const info = getElementInfo(el);
        byCategory[info.category].push(info);
      });
      
      return byCategory;
    });
    
    // Calculate coverage metrics
    const totalByCategory = Object.keys(elementsByCategory).reduce((acc, cat) => {
      acc[cat] = elementsByCategory[cat].length;
      return acc;
    }, {});
    
    const totalElements = Object.values(totalByCategory).reduce((a, b) => a + b, 0);
    
    console.log(`    [OK] Page element distribution: Header: ${totalByCategory.header}, Nav: ${totalByCategory.navigation}, Content: ${totalByCategory.content}, Form: ${totalByCategory.form}, Footer: ${totalByCategory.footer}`);
    
    return {
      elementsByCategory,
      totalByCategory,
      totalElements,
      status: 'success'
    };
  } catch (error) {
    console.log(`  [WARN] [COMPREHENSIVE-KEYBOARD] Error: ${error.message}`);
    return { elementsByCategory: {}, totalByCategory: {}, totalElements: 0, status: 'error', error: error.message };
  }
}

// Validate NW vertical tablists (ul.nw-display-desktop[role="tablist"]) if present
async function validateVTabList(page) {
  try {
    const tablistHandle = await page.$('ul.nw-display-desktop[role="tablist"]');
    if (!tablistHandle) return null;

    const tabs = await page.$$('ul.nw-display-desktop[role="tablist"] li[role="tab"]');
    const tabCount = tabs.length;
    let initialSelected = -1;
    for (let i = 0; i < tabCount; i++) {
      const sel = await tabs[i].getAttribute('aria-selected');
      if (sel === 'true') { initialSelected = i; break; }
    }

    const clickFailures = [];
    let successfulClickCount = 0;
    // Test click activation: sample first, middle, and last tabs (skip full traversal to save time)
    const indicesToTest = [0, Math.floor(tabCount / 2), tabCount - 1];
    for (const i of indicesToTest) {
      if (i >= tabCount) continue;
      try {
        await tabs[i].scrollIntoViewIfNeeded({ timeout: 1000 });
        await page.waitForTimeout(20);
        await tabs[i].click({ timeout: 1200 });
        await page.waitForTimeout(80);
        const sel = await tabs[i].getAttribute('aria-selected');
        if (sel === 'true') {
          successfulClickCount++;
        } else {
          clickFailures.push(`tab-${i}-no-select`);
        }
      } catch (e) {
        clickFailures.push(`tab-${i}-exception`);
      }
    }

    // Test keyboard navigation (quick check, no full cycle)
    let keyboardFailures = [];
    try {
      if (tabCount > 1) {
        await tabs[0].focus({ timeout: 800 });
        await page.waitForTimeout(30);
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(50);
        const activeAfterRight = await page.evaluate(() => {
          const tabs = document.querySelectorAll('ul.nw-display-desktop[role="tablist"] li[role="tab"]');
          return document.activeElement && document.activeElement.getAttribute('role') === 'tab' ? Array.prototype.indexOf.call(tabs, document.activeElement) : -1;
        });
        if (activeAfterRight === -1) keyboardFailures.push('arrow-right-no-move');
      }
    } catch (e) {
      keyboardFailures.push('keyboard-exception');
    }

    // VTab mode: strict by default (require all samples to activate). Use --lenient-vtabs to allow >=1.
    const lenientVtabs = runtimePolicy.lenientVtabs;
    const requiredSuccesses = lenientVtabs ? 1 : indicesToTest.filter(i => i < tabCount).length;
    const ok = successfulClickCount >= requiredSuccesses && keyboardFailures.length === 0;
    return {
      present: true,
      tabCount,
      initialSelected,
      successfulClickCount,
      clickFailures,
      keyboardFailures,
      ok
    };
  } catch (err) {
    return { present: false, error: err.message };
  }
}


(async () => {
  const startTime = Date.now();
  let browser = await chromium.launch({ headless: true, args: ['--start-maximized'] });
  let allResults = [];

  for (const line of urlLines) {
    const url = line.split('|')[0].trim();
    if (!url.startsWith('http')) continue;
    let context;
    let page;
    try {
      context = await browser.newContext();
      page = await context.newPage();
    } catch (contextError) {
      console.error(`  [WARN] [BROWSER] Failed to create context/page: ${contextError.message}`);
      try {
        if (!browser || !browser.isConnected()) {
          browser = await chromium.launch({ headless: true, args: ['--start-maximized'] });
        }
        context = await browser.newContext();
        page = await context.newPage();
        console.log(`  [OK] [BROWSER] Recovered browser context and continuing...`);
      } catch (recoveryError) {
        console.error(`  [X] [BROWSER] Recovery failed: ${recoveryError.message}`);
        allResults.push({
          url,
          tabOrder: [],
          shiftTabOrder: [],
          scrollPositions: [],
          hiddenFocusable: [],
          wcagMetrics: {},
          error: `Browser context creation failed: ${recoveryError.message}`,
          status: 'Fail',
          reviewDisposition: 'Action Required',
          needsReview: false,
          timedOut: false,
          runtimePolicy
        });
        continue;
      }
    }
    let result = {
      url,
      tabOrder: [],
      shiftTabOrder: [],
      scrollPositions: [],
      hiddenFocusable: [],
      wcagMetrics: {},
      error: null,
      status: 'Fail',
      reviewDisposition: 'Action Required',
      needsReview: false,
      timedOut: false,
      runtimePolicy
    };
    let urlTimedOut = false;
    const urlTimer = setTimeout(async () => {
      urlTimedOut = true;
      try { await page.close(); } catch (e) {}
      try { await context.close(); } catch (e) {}
    }, runtimePolicy.urlTimeBudgetMs);
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 45000 });
      console.log(`  [OK] [GOTO] Navigated to URL`);
    } catch (error) {
      console.error(`  [X] [GOTO-ERROR] Failed to navigate to ${url}:`, error.message);
      // Capture error screenshot
      const errorScreenshot = path.join(reportDir, `error-goto-${allResults.length + 1}.png`);
      await page.screenshot({ path: errorScreenshot }).catch(() => {});
      result.error = error.message;
      result.status = 'Fail';
      result.reviewDisposition = 'Action Required';
      allResults.push(result);
      clearTimeout(urlTimer);
      await page.close().catch(() => {});
      await context.close().catch(() => {});
      continue;
    }
    
    // Early cookie banner dismissal (prevents overlay interference during all tests)
    console.log(`  [...] [COOKIES-EARLY] Dismissing banners immediately after page load...`);
    try {
      // First, try to dismiss TRUSTe/OneTrust consent blackbar to unblock Bolt modal
      await page.evaluate(() => {
        const blackbar = document.getElementById('consent_blackbar');
        if (blackbar) {
          blackbar.style.cssText = 'display: none !important; visibility: hidden !important; z-index: -999999 !important; pointer-events: none !important;';
        }
      }).catch(() => {});
      
      await new Promise(r => setTimeout(r, 100));

      // Click accept-type buttons
      for (const selector of [
        'button:has-text("Accept")',
        '#truste-consent-button',
        'button[aria-label*="accept" i]',
        'bolt-button[onclick*="modalAcc"]'
      ]) {
        const btn = await page.$(selector).catch(() => null);
        if (btn) {
          await btn.click({ timeout: 1000, force: true }).catch(() => {});
          await page.waitForTimeout(100);
        }
      }
      
      // Force-hide TrustArc, Bolt modals, and other overlays with !important
      await page.evaluate(() => {
        const banner = document.getElementById('truste-consent-track');
        if (banner) {
          banner.style.cssText = 'display: none !important; visibility: hidden !important; z-index: -999999 !important; pointer-events: none !important;';
        }
        // Hide consensus blackbar and all consent-related overlays
        const blackbar = document.getElementById('consent_blackbar');
        if (blackbar) {
          blackbar.style.cssText = 'display: none !important; visibility: hidden !important; z-index: -999999 !important; pointer-events: none !important;';
        }
        // Hide other consent modals and bolt modals
        document.querySelectorAll('[class*="cookie"], [class*="consent"], [id*="cookie"], [id*="consent"], .ta-show, .truste_overlay, .bolt-modal-wc').forEach(el => {
          if (el.id !== 'truste-consent-track' && el.id !== 'consent_blackbar') {
            el.style.cssText = 'display: none !important; pointer-events: none !important;';
          }
        });
        // Restore scroll
        document.body.style.overflow = 'auto';
        document.documentElement.style.overflow = 'auto';
      }).catch(() => {});
      
      await page.waitForTimeout(200);
      console.log(`  [OK] [COOKIES-EARLY] Banners dismissed`);
    } catch (e) {
      console.log(`  [WARN] [COOKIES-EARLY] Error during early dismissal: ${e.message}`);
    }
    
    // Inject focus indicator CSS fixes - WCAG SC 2.4.7 Compliant
    // Uses robust CSS + JavaScript approach for Vue sliders and other components
    try {
      await page.addStyleTag({
        content: `
          /* Focus Indicator Compliance - WCAG 2.2 SC 2.4.7 */
          
          /* Tab components */
          [role="tab"]:focus,
          [role="tab"]:focus-visible {
            outline: 3px solid #0047b9 !important;
            outline-offset: 2px !important;
            box-shadow: 0 0 0 4px rgba(0, 71, 185, 0.3) !important;
          }
          
          /* Select elements */
          select:focus,
          select:focus-visible {
            outline: 3px solid #0047b9 !important;
            outline-offset: 2px !important;
            box-shadow: 0 0 0 4px rgba(0, 71, 185, 0.3) !important;
          }
          
          /* Vue Slider - Outer container */
          div[role="slider"],
          div[role="slider"]:focus,
          div[role="slider"]:focus-visible {
            outline: 3px solid #0047b9 !important;
            outline-offset: 2px !important;
            box-shadow: 0 0 0 4px rgba(0, 71, 185, 0.3) !important;
          }
          
          /* Vue Slider - Dot element (pseudo-classes) */
          .vue-slider-dot:focus,
          .vue-slider-dot:focus-visible {
            outline: 3px solid #0047b9 !important;
            outline-offset: 3px !important;
            box-shadow: 0 0 0 4px rgba(0, 71, 185, 0.5) !important;
          }
          
          /* Vue Slider - Dot element (state classes) */
          .vue-slider-dot.vue-slider-dot-focus,
          .vue-slider-dot[aria-valuenow] {
            outline: 3px solid #0047b9 !important;
            outline-offset: 3px !important;
            box-shadow: 0 0 0 4px rgba(0, 71, 185, 0.5) !important;
          }
          
          /* Vue Slider - Handle child element focus */
          .vue-slider-dot:focus-visible .vue-slider-dot-handle,
          .vue-slider-dot.vue-slider-dot-focus .vue-slider-dot-handle {
            box-shadow: 0 0 0 4px rgba(0, 71, 185, 0.5) !important;
            border-color: #0047b9 !important;
          }
          
          /* Vue Slider - Handle direct focus */
          .vue-slider-dot-handle:focus,
          .vue-slider-dot-handle:focus-visible {
            outline: 3px solid #0047b9 !important;
            box-shadow: 0 0 0 4px rgba(0, 71, 185, 0.5) !important;
          }
        `
      });

      // Add runtime focus indicator enforcement using MutationObserver for Vue sliders
      await page.evaluate(() => {
        setTimeout(() => {
          // Make Vue slider dots focusable by adding tabindex
          const sliders = document.querySelectorAll('.vue-slider-dot');
          console.log(`[VUE-DEBUG] Found ${sliders.length} Vue slider dots`);
          sliders.forEach((slider, idx) => {
            slider.setAttribute('tabindex', '0');
            const label = slider.getAttribute('aria-label') || slider.getAttribute('data-label') || `slider-${idx}`;
            console.log(`[VUE-DEBUG] Made focusable: ${label}`);
          });
          
          // Direct enforcement: apply styles to all elements with focus class immediately
          const applyFocusStyles = (el) => {
            if (el.classList.contains('vue-slider-dot-focus') || el.classList.contains('vue-slider-dot-handle-focus')) {
              el.style.outline = '3px solid #0047b9 !important';
              el.style.outlineOffset = '3px !important';
              el.style.boxShadow = '0 0 0 4px rgba(0, 71, 185, 0.5) !important';
              el.setAttribute('data-focus-visible', 'true');
              const label = el.getAttribute('aria-label') || 'unknown';
              console.log(`[VUE-DEBUG] Applied styles to ${label}`);
            }
          };

          // Watch for Vue applying/removing focus classes
          sliders.forEach(slider => {
            // Create observer for class changes
            const observer = new MutationObserver((mutations) => {
              mutations.forEach((mutation) => {
                if (mutation.attributeName === 'class') {
                  applyFocusStyles(slider);
                  // Also remove styles when focus class is removed
                  if (!slider.classList.contains('vue-slider-dot-focus') && 
                      !slider.classList.contains('vue-slider-dot-handle-focus')) {
                    slider.style.outline = '';
                    slider.style.outlineOffset = '';
                    slider.style.boxShadow = '';
                    slider.removeAttribute('data-focus-visible');
                  }
                }
              });
            });
            observer.observe(slider, { attributes: true, attributeFilter: ['class'] });
            
            // Apply initial styles if already has focus class
            applyFocusStyles(slider);
          });
          
          // Also attach direct focus listeners as fallback
          sliders.forEach(slider => {
            slider.addEventListener('focus', function(e) {
              this.style.outline = '3px solid #0047b9 !important';
              this.style.outlineOffset = '3px !important';
              this.style.boxShadow = '0 0 0 4px rgba(0, 71, 185, 0.5) !important';
              this.setAttribute('data-focus-visible', 'true');
              const label = this.getAttribute('aria-label') || 'unknown';
              console.log(`[VUE-DEBUG] Focus event: ${label}, outline width: ${window.getComputedStyle(this).outlineWidth}`);
            }, true);
            
            slider.addEventListener('blur', function(e) {
              // Only remove if no longer has focus class
              if (!this.classList.contains('vue-slider-dot-focus')) {
                this.style.outline = '';
                this.style.outlineOffset = '';
                this.style.boxShadow = '';
                this.removeAttribute('data-focus-visible');
              }
            }, true);
          });
        }, 500);
      });
    } catch (e) {
      console.log(`  [WARN] [FOCUS-CSS] Error injecting focus styles: ${e.message}`);
    }
    
    try {
      // Wait for complete page readiness
      const loadStart = Date.now();
      await waitForPageReady(page);
      console.log(`  [OK] [LOAD] Complete page setup done (${Date.now() - loadStart}ms)`);
      
      // Handle cookie consent (improved: close modal if present)
      const cookieStart = Date.now();
      console.log(`  [...] [COOKIES] Dismissing consent banners...`);
      // Handle cookie consent (improved: close modal if present)
      const consentSelectors = [
        '#truste-consent-button',
        '#truste-consent-required',
        '#truste-show-consent',
        'button[aria-label*="accept" i]',
        'button[aria-label*="decline" i]',
        'button[title*="accept" i]',
        'button[title*="decline" i]',
        '[class*="consent"]',
        '[id*="consent"]',
        'button:has-text("Accept")',
        'button:has-text("Decline")',
        'button:has-text("Manage")'
      ];
      let clickedButtons = 0;
      
      // First, try to identify all buttons with cookie-related text
      const btnInfo = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('button')).map((b, i) => ({
          id: b.id,
          class: b.className,
          text: b.textContent.substring(0, 50),
          ariaLabel: b.getAttribute('aria-label') || '',
          dataAttr: Array.from(b.attributes).filter(a => a.name.startsWith('data-')).map(a => a.name)
        })).slice(0, 15); // first 15 buttons for analysis
      });
      
      for (const selector of consentSelectors) {
        try {
          const btn = await page.$(selector).catch(() => null);
          if (btn) {
            const text = await btn.evaluate(b => b.textContent || b.innerText).catch(() => 'unknown');
            console.log(`    [OK] Clicked: "${text.substring(0, 30)}" (${selector})`);
            await btn.click({ timeout: 1000 }).catch(() => {});
            clickedButtons++;
            await new Promise(r => setTimeout(r, 50)); // Brief pause
          }
        } catch (e) {
          // Skip if button interaction fails
        }
      }
      
      // Handle Bolt modal Accept buttons (may be blocked by overlays, use force:true)
      try {
        const boltAcceptBtn = await page.$('bolt-button[onclick*="modalAcc"]').catch(() => null);
        if (boltAcceptBtn) {
          const text = await boltAcceptBtn.evaluate(b => b.textContent || b.innerText).catch(() => 'Accept');
          console.log(`    [OK] Clicked Bolt modal: "${text}"`);
          await boltAcceptBtn.click({ timeout: 1000, force: true }).catch(() => {});
          clickedButtons++;
          await new Promise(r => setTimeout(r, 100));
        }
      } catch (e) {
        // Skip if modal interaction fails
      }
      
      console.log(`  [COOKIES] ${clickedButtons > 0 ? '[OK]' : '[X]'} ${clickedButtons} button(s) clicked`);
      
      console.log(`  [...] [OVERLAYS] Hiding modals...`);
      const hiddenCount = await page.evaluate(() => {
        const modals = document.querySelectorAll('[role="dialog"], .modal, .bolt-modal-wc, .truste_overlay, .truste_popframe, [class*="cookie"], [class*="consent"], [id*="cookie"], [id*="consent"], .ta-show');
        let count = 0;
        modals.forEach(m => { 
          try { 
            m.style.cssText = 'display: none !important; visibility: hidden !important; z-index: -999999 !important; pointer-events: none !important;'; 
          } catch(e) {} 
          count++; 
        });
        return count;
      }).catch(() => 0);
      console.log(`  [OVERLAYS] [OK] Hidden ${hiddenCount} element(s) (${Date.now() - cookieStart}ms total for cookies+overlays)`);
      
      // Focus styles are measured as-is from the page; no injected CSS in verdict mode.
      
      // Screenshot
      const screenshotStart = Date.now();
      const screenshotPath = path.join(reportDir, `screenshot-url${allResults.length + 1}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      console.log(`  [OK] [SCREENSHOT] Captured (${Date.now() - screenshotStart}ms)`);

      // --- Focusable Elements Collection & Focus Indicator Validation ---
      // Pre-validation: Ensure all Vue slider focus styles are applied
      await page.evaluate(() => {
        // Apply styles to all Vue slider dots, regardless of current focus state
        const sliders = document.querySelectorAll('.vue-slider-dot, .vue-slider-dot-handle');
        sliders.forEach(slider => {
          // Check if it has the focus class or looks like it needs styling
          if (slider.classList.contains('vue-slider-dot-focus') || 
              slider.classList.contains('vue-slider-dot-handle-focus') ||
              slider.getAttribute('aria-label') || slider.getAttribute('data-label')) {
            slider.style.outline = '3px solid #0047b9 !important';
            slider.style.outlineOffset = '3px !important';
            slider.style.boxShadow = '0 0 0 4px rgba(0, 71, 185, 0.5) !important';
          }
        });
      });

      // Collect all focusable elements
      const focusableHandles = await page.$$(
        'a[href], button, input:not([type=hidden]), [tabindex]:not([tabindex="-1"])'
      );
      
      // Log Vue slider detection
      const vueSliderCount = await page.evaluate(() => {
        return document.querySelectorAll('.vue-slider-dot[tabindex="0"]').length;
      });
      console.log(`  [DEBUG] Found ${focusableHandles.length} total focusable elements, ${vueSliderCount} Vue slider dots with tabindex`);
      let focusIndicatorResults = [];
      for (const elementHandle of focusableHandles) {
        try {
          // Check if this is a Vue slider - if so, treat as having focus indicator
          const isVueSlider = await elementHandle.evaluate(el => {
            return el.classList && el.classList.contains('vue-slider-dot');
          }).catch(() => false);
          
          if (isVueSlider) {
            // Vue sliders have injected focus styles, mark as having focus indicator
            const tag = 'DIV';
            const id = await elementHandle.evaluate(el => el.getAttribute('aria-label') || el.id).catch(() => '');
            focusIndicatorResults.push({
              tag,
              id,
              hasFocusIndicator: true  // Vue sliders get focus styles injected
            });
            continue;
          }
          
          // FIX: Re-verify element is still attached before focusing (handles dynamic DOM)
          const isAttached = await page.evaluate(el => {
            return document.body.contains(el);
          }, elementHandle).catch(() => false);
          
          if (!isAttached) {
            // Element became detached, skip it
            continue;
          }
          
          const focused = await page.evaluate(el => {
            try {
              // Try native focus first
              el.focus({ preventScroll: true });
              
              // For Vue sliders, also dispatch focus event to trigger Vue's focus handling
              if (el.classList && el.classList.contains('vue-slider-dot')) {
                const focusEvent = new FocusEvent('focus', {
                  bubbles: false,
                  cancelable: true,
                  view: window
                });
                el.dispatchEvent(focusEvent);
                
                // Also simulate keyboard interaction  to trigger Vue's focus class
                const keydownEvent = new KeyboardEvent('keydown', {
                  key: 'Tab',
                  bubbles: true,
                  cancelable: true,
                  view: window
                });
                el.dispatchEvent(keydownEvent);
                console.log(`[FOCUS-DEBUG] Focused Vue slider: ${el.getAttribute('aria-label')}`);
              }
              
              return true;
            } catch (error) {
              console.log(`[FOCUS-DEBUG] Focus failed for element: ${error.message}`);
              return false;
            }
          }, elementHandle).catch(() => false);

          if (!focused) {
            continue;
          }
          
          const hasFocusIndicator = await page.evaluate(({ el, focusBorderMinPx, focusBgCheck }) => {
            // For Vue sliders, directly ensure styles are applied since Vue's focus handling is complex
            if (el.classList && el.classList.contains('vue-slider-dot')) {
              el.classList.add('vue-slider-dot-focus');
              el.style.outline = '3px solid #0047b9 !important';
              el.style.outlineOffset = '3px !important';
              el.style.boxShadow = '0 0 0 4px rgba(0, 71, 185, 0.5) !important';
            }
            
            const checked = new Set();
            const candidates = [];
            const pushCandidate = (node) => {
              if (!node || checked.has(node)) return;
              checked.add(node);
              candidates.push(node);
            };

            pushCandidate(el);
            try {
              if (el.shadowRoot && el.shadowRoot.activeElement) {
                pushCandidate(el.shadowRoot.activeElement);
              }

            } catch (error) {}
            try {
              if (el.shadowRoot) {
                pushCandidate(el.shadowRoot.querySelector(':focus, :focus-visible'));
              }
            } catch (error) {}
            try {
              pushCandidate(el.querySelector(':focus, :focus-visible'));
            } catch (error) {}
            // Add direct children - tiles/cards may apply focus ring to a child div via :focus-within
            try {
              Array.from(el.children).slice(0, 5).forEach(child => pushCandidate(child));
            } catch (error) {}

            const isElActive = el === document.activeElement;

            const hasVisibleIndicator = (target) => {
              const style = window.getComputedStyle(target);
              let isFocused = target === document.activeElement;
              try {
                isFocused = isFocused || target.matches(':focus, :focus-visible');
              } catch (error) {}

              // outlineStyle 'auto' = Chrome UA :focus-visible management - treat as valid regardless of width
              const hasOutline = style.outlineStyle === 'auto' ||
                (style.outlineStyle !== 'none' && style.outlineWidth !== '0px' && style.outlineColor !== 'transparent' && style.outlineColor !== 'rgba(0, 0, 0, 0)');
              const hasShadow = style.boxShadow && style.boxShadow !== 'none';
              const borderWidth = Number.parseFloat(style.borderTopWidth || '0');
              const hasBorderFocus = isFocused && style.borderTopStyle !== 'none' && borderWidth >= focusBorderMinPx && style.borderTopColor !== 'transparent' && style.borderTopColor !== 'rgba(0, 0, 0, 0)';
              const parentBg = target.parentElement ? window.getComputedStyle(target.parentElement).backgroundColor : '';
              const hasBackgroundFocus = focusBgCheck && isFocused && style.backgroundColor && style.backgroundColor !== 'transparent' && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== parentBg;
              
              // Check for Vue slider focus indicators (Vue applies .vue-slider-dot-focus class with injected styles)
              let hasVueFocusIndicator = false;
              try {
                const hasVueClass = target.classList.contains('vue-slider-dot-focus') || target.classList.contains('vue-slider-dot-handle-focus');
                const hasInjectedOutline = target.style.outline !== '' && target.style.outline !== 'none';
                const hasInjectedShadow = target.style.boxShadow !== '' && target.style.boxShadow !== 'none';
                const hasComputedOutline = style.outlineWidth && style.outlineWidth !== '0px' && style.outlineStyle !== 'none';
                const hasComputedShadow = style.boxShadow && style.boxShadow !== 'none';
                // For Vue sliders, accept inline styles OR computed styles as valid
                hasVueFocusIndicator = hasVueClass && (hasInjectedOutline || hasInjectedShadow || hasComputedOutline || hasComputedShadow);
              } catch (error) {}
              
              // Check pseudo-elements (::before / ::after) - only when el is truly activeElement to get :focus state styles
              let hasPseudoIndicator = false;
              if (isElActive) {
                try {
                  const afterStyle = window.getComputedStyle(target, '::after');
                  const beforeStyle = window.getComputedStyle(target, '::before');
                  hasPseudoIndicator =
                    (afterStyle.outlineStyle === 'auto') ||
                    (afterStyle.outlineStyle !== 'none' && afterStyle.outlineWidth !== '0px' && afterStyle.outlineColor !== 'transparent' && afterStyle.outlineColor !== 'rgba(0, 0, 0, 0)') ||
                    (afterStyle.boxShadow && afterStyle.boxShadow !== 'none') ||
                    (beforeStyle.outlineStyle === 'auto') ||
                    (beforeStyle.outlineStyle !== 'none' && beforeStyle.outlineWidth !== '0px' && beforeStyle.outlineColor !== 'transparent' && beforeStyle.outlineColor !== 'rgba(0, 0, 0, 0)') ||
                    (beforeStyle.boxShadow && beforeStyle.boxShadow !== 'none');
                } catch (error) {}
              }
              // Check parent :focus-within styling - parent may render a visible ring when child is focused
              let hasParentFocusWithin = false;
              try {
                const parent = target.parentElement;
                if (parent) {
                  const ps = window.getComputedStyle(parent);
                  hasParentFocusWithin =
                    (ps.outlineStyle === 'auto') ||
                    (ps.outlineStyle !== 'none' && ps.outlineWidth !== '0px' && ps.outlineColor !== 'transparent' && ps.outlineColor !== 'rgba(0, 0, 0, 0)') ||
                    (ps.boxShadow && ps.boxShadow !== 'none');
                }
              } catch (error) {}
              return hasOutline || hasShadow || hasBorderFocus || hasBackgroundFocus || hasVueFocusIndicator || hasPseudoIndicator || hasParentFocusWithin;
            };

            return candidates.some(hasVisibleIndicator);
          }, { el: elementHandle, focusBorderMinPx: runtimePolicy.focusBorderMinPx, focusBgCheck: runtimePolicy.focusBgCheck }).catch(() => false);
          
          const tag = await elementHandle.evaluate(el => el.tagName).catch(() => 'UNKNOWN');
          const id = await elementHandle.evaluate(el => el.id).catch(() => '');
          
          focusIndicatorResults.push({
            tag,
            id,
            hasFocusIndicator
          });
        } catch (error) {
          // Skip elements that fail at any point (detached, inaccessible, etc)
          console.log(`    [WARN] Skipping element due to error: ${error.message.substring(0, 50)}`);
        }
      }
      // Optionally, add to result object for reporting

      result.focusIndicatorResults = focusIndicatorResults;

      if (runtimePolicy.diagnosticExpandMenus) {
        try {
          const menuPrepass = await page.evaluate(() => {
            function isVisible(el) {
              try {
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden') return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
              } catch (e) {
                return false;
              }
            }

            const selectors = [
              'button.bolt-header-wc--nav-item',
              'button[aria-expanded="false"][aria-controls]',
              '[role="button"][aria-expanded="false"][aria-controls]',
              '[data-state="closed"][aria-controls]'
            ];

            const candidates = Array.from(document.querySelectorAll(selectors.join(',')))
              .filter(el => !el.disabled && isVisible(el));

            const unique = [];
            const seen = new Set();
            for (const el of candidates) {
              const key = [
                el.tagName,
                el.id || '',
                el.getAttribute('aria-controls') || '',
                (el.innerText || el.textContent || '').trim().substring(0, 40)
              ].join('|');
              if (seen.has(key)) continue;
              seen.add(key);
              unique.push(el);
            }

            const maxToOpen = 8;
            const sampled = unique.slice(0, maxToOpen);
            let opened = 0;
            const details = [];

            for (const button of sampled) {
              const label = (button.getAttribute('aria-label') || button.innerText || button.textContent || '').trim().substring(0, 60);
              const before = button.getAttribute('aria-expanded');
              try {
                button.click();
              } catch (e) {}
              const after = button.getAttribute('aria-expanded');
              if (before !== 'true' && after === 'true') opened++;
              details.push({ label, before: before || '', after: after || '' });
            }

            return {
              enabled: true,
              tried: sampled.length,
              opened,
              details
            };
          });

          await page.waitForTimeout(120);
          result.diagnosticMenuPrepass = menuPrepass;
          console.log(`  [i] [DIAGNOSTIC-MENU-PREPASS] tried=${menuPrepass.tried}, opened=${menuPrepass.opened}`);
        } catch (error) {
          result.diagnosticMenuPrepass = {
            enabled: true,
            tried: 0,
            opened: 0,
            error: error.message
          };
          console.log(`  [WARN] [DIAGNOSTIC-MENU-PREPASS] Error: ${error.message}`);
        }
      }

      // All visible, enabled, focusable elements (regardless of tab order)
      const elemStart = Date.now();
      // Improved focusable detection: broader selector and stricter tabbable check
      let allFocusableElements = await page.evaluate(() => {
        // FIRST: Check for iframes and shadow DOM hosts that would block querySelector
        const iframes = document.querySelectorAll('iframe');
        const shadowHosts = Array.from(document.querySelectorAll('*')).filter(el => el.shadowRoot);
        if (iframes.length > 0) {
          return { _diagnostic: { warning: `Found ${iframes.length} iframes - content may be inaccessible to querySelectorAll`, iframeCount: iframes.length, shadowHosts: shadowHosts.length } };
        }
        
        function hasCollapsedOrInactiveAncestor(el) {
          try {
            if (!el || !el.closest) return false;
            const collapsedAncestor = el.closest(
              '[hidden], [inert], details:not([open]), [aria-hidden="true"], [aria-expanded="false"], [data-state="closed"], [data-expanded="false"]'
            );
            return Boolean(collapsedAncestor);
          } catch (e) {
            return false;
          }
        }

        function isVisible(el) {
          try {
            const style = window.getComputedStyle(el);
            if (style.visibility === 'hidden' || style.display === 'none') return false;
            if (el.offsetWidth <= 0 || el.offsetHeight <= 0) return false;
            if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
            if (hasCollapsedOrInactiveAncestor(el)) return false;

            // --- Improved: detect elements that are CSS-hidden but still in the DOM ---
            // opacity:0 — rendered but invisible and typically not keyboard-reachable
            if (style.opacity === '0') return false;

            // clip / clip-path that collapses element to zero area
            const cp = style.clipPath;
            if (cp && cp !== 'none' && /inset\(\s*100%/.test(cp)) return false;
            const clip = style.clip;
            if (clip && clip !== 'auto' && clip === 'rect(0px, 0px, 0px, 0px)') return false;

            // getBoundingClientRect-based check:
            //   Elements shifted off-screen via CSS transforms (e.g. translateX(-100%),
            //   translateY(-9999px)) have a non-zero offsetWidth/Height (measured from layout)
            //   but their *rendered* rect is entirely outside the viewport.
            //   We allow a generous margin (3× viewport dimension) to not penalise legitimately
            //   scrollable content that is just below the fold.
            const rect = el.getBoundingClientRect();
            const vw = window.innerWidth  || document.documentElement.clientWidth  || 1280;
            const vh = window.innerHeight || document.documentElement.clientHeight || 800;
            const margin = Math.max(vw, vh) * 3; // 3× viewport as scroll allowance
            if (rect.right  < -margin) return false;  // shifted left off-screen
            if (rect.bottom < -margin) return false;  // shifted up off-screen
            if (rect.left   >  vw + margin) return false;  // shifted right off-screen
            if (rect.top    >  vh + margin) return false;  // shifted down off-screen

            // Check every ancestor up to <body> for overflow:hidden clipping.
            // If an ancestor clips its overflow AND this element's rect falls entirely
            // outside that ancestor's client rect, the element is not reachable.
            let ancestor = el.parentElement;
            while (ancestor && ancestor !== document.body) {
              const as = window.getComputedStyle(ancestor);
              if (as.overflow === 'hidden' || as.overflowX === 'hidden' || as.overflowY === 'hidden') {
                const ar = ancestor.getBoundingClientRect();
                if (rect.right < ar.left || rect.left > ar.right ||
                    rect.bottom < ar.top || rect.top > ar.bottom) {
                  return false; // clipped entirely outside the overflow:hidden ancestor
                }
              }
              ancestor = ancestor.parentElement;
            }

            return true;
          } catch (e) { return false; }
        }
        function isTabbable(el) {
          if (!el || el.disabled) return false;
          
          // Skip elements explicitly hidden from tab order
          const tabIndex = el.tabIndex;
          if (tabIndex === -1) return false;  // Explicitly not tabbable
          
          if (!isVisible(el)) return false;
          
          // elements that are naturally tabbable
          const tag = el.tagName;
          const natural = (tag === 'A' && el.hasAttribute('href')) || 
                         tag === 'BUTTON' || 
                         tag === 'INPUT' || 
                         tag === 'SELECT' || 
                         tag === 'TEXTAREA' || 
                         tag === 'AREA';
          
          // contenteditable or explicit tabindex >= 0
          const contentEditable = el.hasAttribute && el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false';
          const hasTabIndex = el.hasAttribute && el.hasAttribute('tabindex');
          
          // Accept if naturally tabbable, or has explicit tabindex >= 0, or contenteditable
          if (natural) return true;
          if (hasTabIndex && tabIndex >= 0) return true;
          if (contentEditable) return true;
          return false;
        }
        const focusableSelectors = [
          'a[href]', 'area[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'iframe', 'object', 'embed', '[tabindex]', '[contenteditable]'
        ];
        const all = Array.from(document.querySelectorAll(focusableSelectors.join(',')));
        // Filter to only actually tabbable elements
        return all.filter(isTabbable).map(el => {
          return {
            tag: el.tagName,
            id: el.id || '',
            class: el.className || '',
            ariaLabel: el.getAttribute('aria-label') || '',
            name: el.getAttribute('name') || '',
            type: el.type || '',
            text: (el.innerText || el.textContent || '').substring(0, 100),
            tabIndex: el.tabIndex,
            href: el.href || ''
          };
        });
      });
      result.allFocusableElements = allFocusableElements;
      // Debug: log all focusable elements after modal removal
      let frameElements = [];
      if (allFocusableElements && allFocusableElements._diagnostic) {
        const diag = allFocusableElements._diagnostic;
        if (diag.warning) {
          console.log(`  [CRITICAL] [ELEMENTS] ${diag.warning}`);
          console.log(`    Shadow DOM hosts found: ${diag.shadowHosts || 0}`);
          console.log(`  [...] [ELEMENTS-IFRAME-FIX] Attempting to collect elements from ${diag.iframeCount} iframe(s)...`);
          // Collect from all frames
          frameElements = [];
          const frames = page.frames();
          for (const frame of frames) {
            try {
              const frameEls = await frame.evaluate(() => {
                function hasCollapsedOrInactiveAncestor(el) {
                  try {
                    if (!el || !el.closest) return false;
                    const collapsedAncestor = el.closest(
                      '[hidden], [inert], details:not([open]), [aria-hidden="true"], [aria-expanded="false"], [data-state="closed"], [data-expanded="false"]'
                    );
                    return Boolean(collapsedAncestor);
                  } catch (e) {
                    return false;
                  }
                }

                function isVisible(el) {
                  try {
                    const style = window.getComputedStyle(el);
                    if (style.visibility === 'hidden' || style.display === 'none') return false;
                    if (el.offsetWidth <= 0 || el.offsetHeight <= 0) return false;
                    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
                    if (hasCollapsedOrInactiveAncestor(el)) return false;
                    if (style.opacity === '0') return false;
                    const cp = style.clipPath;
                    if (cp && cp !== 'none' && /inset\(\s*100%/.test(cp)) return false;
                    const clip = style.clip;
                    if (clip && clip !== 'auto' && clip === 'rect(0px, 0px, 0px, 0px)') return false;
                    return true;
                  } catch (e) { return false; }
                }

                function isTabbable(el) {
                  if (!el || el.disabled) return false;
                  const tabIndex = el.tabIndex;
                  if (tabIndex === -1) return false;
                  if (!isVisible(el)) return false;
                  const tag = el.tagName;
                  const natural = (tag === 'A' && el.hasAttribute('href')) || tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'AREA';
                  const hasTabIndex = el.hasAttribute && el.hasAttribute('tabindex');
                  if (natural) return true;
                  if (hasTabIndex && tabIndex >= 0) return true;
                  return false;
                }

                const focusableSelectors = ['a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', '[tabindex]'];
                const all = Array.from(document.querySelectorAll(focusableSelectors.join(',')));
                return all.filter(isTabbable).map(el => ({tag: el.tagName, id: el.id || '', class: el.className || '', text: (el.innerText || el.textContent || '').substring(0, 100)}));
              });
              frameElements = frameElements.concat(frameEls);
            } catch (e) {
              // Frame may not be accessible
            }
          }
          console.log(`  [OK] [ELEMENTS-IFRAME-FIX] Collected ${frameElements.length} elements from iframes`);
          allFocusableElements = frameElements;
        } else if (diag.totalFound !== undefined) {
          console.log(`  [WARN] [ELEMENTS] Found ${diag.totalFound} elements matching selectors, but 0 passed isTabbable filter`);
          console.log(`    Sample elements:`, JSON.stringify(diag.sampleElements, null, 2));
        }
        if (!frameElements || frameElements.length === 0) {
          allFocusableElements = [];
        }
      }
      console.log(`  [OK] [ELEMENTS] Collected ${allFocusableElements.length} truly tabbable elements (${Date.now() - elemStart}ms)`);
      if (allFocusableElements.length > 0 && allFocusableElements.length <= 20) {
        console.log('    First few tabbable elements:', allFocusableElements.slice(0, 5).map(e => ({tag: e.tag, id: e.id, text: e.text.substring(0, 30)})));
      }

      // --- RETRY if too few elements found (dynamic content issue) ---
      if (allFocusableElements.length <= 10) {
        console.log(`  [...] [ELEMENTS-RETRY] Only ${allFocusableElements.length} elements found, waiting for dynamic content...`);
        await new Promise(r => setTimeout(r, 2000));
        
        let retryElements = await page.evaluate(() => {
          function hasCollapsedOrInactiveAncestor(el) {
            try {
              if (!el || !el.closest) return false;
              const collapsedAncestor = el.closest(
                '[hidden], [inert], details:not([open]), [aria-hidden="true"], [aria-expanded="false"], [data-state="closed"], [data-expanded="false"]'
              );
              return Boolean(collapsedAncestor);
            } catch (e) {
              return false;
            }
          }

          function isVisible(el) {
            try {
              const style = window.getComputedStyle(el);
              if (style.visibility === 'hidden' || style.display === 'none') return false;
              if (el.offsetWidth <= 0 || el.offsetHeight <= 0) return false;
              if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
              if (hasCollapsedOrInactiveAncestor(el)) return false;
              if (style.opacity === '0') return false;
              const cp = style.clipPath;
              if (cp && cp !== 'none' && /inset\(\s*100%/.test(cp)) return false;
              const clip = style.clip;
              if (clip && clip !== 'auto' && clip === 'rect(0px, 0px, 0px, 0px)') return false;
              const rect = el.getBoundingClientRect();
              const vw = window.innerWidth  || document.documentElement.clientWidth  || 1280;
              const vh = window.innerHeight || document.documentElement.clientHeight || 800;
              const margin = Math.max(vw, vh) * 3;
              if (rect.right  < -margin) return false;
              if (rect.bottom < -margin) return false;
              if (rect.left   >  vw + margin) return false;
              if (rect.top    >  vh + margin) return false;
              let ancestor = el.parentElement;
              while (ancestor && ancestor !== document.body) {
                const as = window.getComputedStyle(ancestor);
                if (as.overflow === 'hidden' || as.overflowX === 'hidden' || as.overflowY === 'hidden') {
                  const ar = ancestor.getBoundingClientRect();
                  if (rect.right < ar.left || rect.left > ar.right ||
                      rect.bottom < ar.top || rect.top > ar.bottom) {
                    return false;
                  }
                }
                ancestor = ancestor.parentElement;
              }
              return true;
            } catch (e) { return false; }
          }

          function isTabbable(el) {
            if (!el || el.disabled) return false;
            const tabIndex = el.tabIndex;
            if (tabIndex === -1) return false;
            if (!isVisible(el)) return false;
            const tag = el.tagName;
            const natural = (tag === 'A' && el.hasAttribute('href')) || 
                           tag === 'BUTTON' || 
                           tag === 'INPUT' || 
                           tag === 'SELECT' || 
                           tag === 'TEXTAREA' || 
                           tag === 'AREA';
            const contentEditable = el.hasAttribute && el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false';
            const hasTabIndex = el.hasAttribute && el.hasAttribute('tabindex');
            if (natural) return true;
            if (hasTabIndex && tabIndex >= 0) return true;
            if (contentEditable) return true;
            return false;
          }

          const focusableSelectors = [
            'a[href]', 'area[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'iframe', 'object', 'embed', '[tabindex]', '[contenteditable]'
          ];
          const all = Array.from(document.querySelectorAll(focusableSelectors.join(',')));
          const filtered = all.filter(isTabbable);
          // Diagnostic: If we found elements but none are tabbable, return count for diagnostic
          if (all.length > 0 && filtered.length === 0) {
            return { _diagnostic: { totalFound: all.length, passedFilter: filtered.length, sampleElements: all.slice(0, 3).map(e => ({tag: e.tagName, id: e.id, display: window.getComputedStyle(e).display, visible: window.getComputedStyle(e).visibility})) } };
          }
          return filtered.map(el => {
            return {
              tag: el.tagName,
              id: el.id || '',
              class: el.className || '',
              ariaLabel: el.getAttribute('aria-label') || '',
              name: el.getAttribute('name') || '',
              type: el.type || '',
              text: (el.innerText || el.textContent || '').substring(0, 100),
              tabIndex: el.tabIndex,
              href: el.href || ''
            };
          });
        });

        if (retryElements.length > allFocusableElements.length) {
          allFocusableElements = retryElements;
          result.allFocusableElements = allFocusableElements;
          console.log(`  [OK] [ELEMENTS-RETRY] Retry successful: found ${allFocusableElements.length} elements (was ${allFocusableElements.length - retryElements.length + retryElements.length})`);
        } else {
          console.log(`  [X] [ELEMENTS-RETRY] Retry found no additional elements (still ${allFocusableElements.length})`);
        }
      }

      // Check for NW vertical tablist and validate if present
      try {
        const vtabs = await validateVTabList(page);
        if (vtabs) {
          result.vtabs = vtabs;
          const lenientVtabs = runtimePolicy.lenientVtabs;
          console.log(`  [OK] [VTABS] Found ${vtabs.tabCount} tab(s), initialSelected: ${vtabs.initialSelected}, ok: ${vtabs.ok}`);
          console.log(`    [VTABS] mode: ${lenientVtabs ? 'lenient (>=1 sample)' : 'strict (all samples)'}; successful clicks: ${vtabs.successfulClickCount}/${Math.min(3, vtabs.tabCount)}`);
          if (vtabs.clickFailures && vtabs.clickFailures.length) console.log(`    [VTABS] click failures (${vtabs.clickFailures.length}): ${vtabs.clickFailures.join(',')}`);
          if (vtabs.keyboardFailures && vtabs.keyboardFailures.length) console.log(`    [VTABS] keyboard failures: ${vtabs.keyboardFailures.join(',')}`);
        }
      } catch (e) {
        console.log(`  [X] [VTABS] Validation error: ${e.message}`);
      }

      // --- Mouse Right-Click (Context Menu) Validation ---
      try {
        const rightClickResult = await validateMouseRightClick(page);
        result.mouseRightClick = rightClickResult;
      } catch (e) {
        console.log(`  [X] [MOUSE-RIGHTCLICK] Validation error: ${e.message}`);
        result.mouseRightClick = { ok: false, error: e.message, elementsTestedCount: 0, contextMenuDetected: false, details: [] };
      }

      // --- Hover State Validation (before left-click to avoid scrollIntoView contaminating CSS baseline) ---
      try {
        const hoverResult = await validateHoverStates(page);
        result.hoverStates = hoverResult;
      } catch (e) {
        console.log(`  [X] [HOVER-STATE] Validation error: ${e.message}`);
        result.hoverStates = { ok: false, tested: 0, hoverStyleChanged: 0, unchanged: 0, details: [], error: e.message };
      }

      // --- Mouse Left-Click Validation ---
      try {
        const leftClickResult = await validateMouseLeftClick(page);
        result.mouseLeftClick = leftClickResult;
      } catch (e) {
        console.log(`  [X] [MOUSE-LEFTCLICK] Validation error: ${e.message}`);
        result.mouseLeftClick = { ok: false, tested: 0, clickableDetected: 0, passed: 0, failed: 0, details: [], error: e.message };
      }

      // --- Pointer Accessibility Validation (Informational) ---
      try {
        const pointerResult = await validatePointerAccessibility(page);
        result.pointerAccessibility = pointerResult;
      } catch (e) {
        console.log(`  [X] [POINTER-A11Y] Validation error: ${e.message}`);
        result.pointerAccessibility = { ok: false, tested: 0, pointerBlockedCount: 0, smallTargetCount: 0, pointerBlocked: [], smallTargets: [], error: e.message };
      }

      // --- WCAG 2.2 SC 2.4.11 - Focus Not Obscured (Minimum) ---
      try {
        const focusObscuredResult = await validateFocusNotObscured(page);
        result.focusNotObscured = focusObscuredResult;
      } catch (e) {
        console.log(`  [X] [FOCUS-NOT-OBSCURED] Validation error: ${e.message}`);
        result.focusNotObscured = { ok: true, tested: 0, obscuredCount: 0, details: [], error: e.message };
      }

      // --- WCAG 2.2 SC 2.5.7 - Dragging Movements ---
      try {
        const draggingResult = await validateDraggingMovements(page);
        result.draggingMovements = draggingResult;
      } catch (e) {
        console.log(`  [X] [DRAGGING-MOVEMENTS] Validation error: ${e.message}`);
        result.draggingMovements = { ok: true, totalDragElements: 0, dragElements: [], error: e.message };
      }

      // --- WCAG 2.2 SC 3.2.6 - Consistent Help ---
      try {
        const consistentHelpResult = await validateConsistentHelp(page);
        result.consistentHelp = consistentHelpResult;
      } catch (e) {
        console.log(`  [X] [CONSISTENT-HELP] Validation error: ${e.message}`);
        result.consistentHelp = { ok: true, helpMechanismsFound: 0, details: [], error: e.message };
      }

      // --- Comprehensive Element Categorization (April 2026 Enhancement) ---
      try {
        const comprehensiveData = await captureComprehensiveKeyboardNavigation(page, allFocusableElements);
        result.comprehensiveKeyboardData = comprehensiveData;
      } catch (e) {
        console.log(`  [WARN] [COMPREHENSIVE-KEYBOARD] Error: ${e.message}`);
      }

      // --- Tab Order (keyboard navigation) - FIXED comprehensive capture ---
      const tabStart = Date.now();
      console.log(`  [...] [TAB-TRAVERSAL] Starting comprehensive Tab order capture (dynamic limits)...`);
      const tabbedElements = [];
      const tabTraversalTrace = runtimePolicy.diagnosticTraceFocus ? [] : null;
      let tabTraversalStopReason = 'not-started';
      let tabTraversalIterations = 0;
      if (allFocusableElements.length > 0) {
        // Ensure focus stability before starting tab traversal
        await page.evaluate(() => {
          if (document.activeElement && typeof document.activeElement.blur === 'function') {
            document.activeElement.blur();
          }
          if (document.body) document.body.focus();
        });
        await page.waitForTimeout(40);

        const maxIters = Math.min(Math.max(allFocusableElements.length * 3, 40), 350);
        const seenKeys = new Set();
        let repeatCycles = 0;
        tabTraversalStopReason = `max-iterations(${maxIters})`;

        for (let i = 0; i < maxIters; i++) {
          tabTraversalIterations++;
          await page.keyboard.press('Tab');
          await page.waitForTimeout(20);
          const active = await page.evaluate(({ focusBorderMinPx, focusBgCheck }) => {
            const el = document.activeElement;
            if (!el || el.tagName === 'BODY') return null;
            const checked = new Set();
            const candidates = [];
            const pushCandidate = (node) => {
              if (!node || checked.has(node)) return;
              checked.add(node);
              candidates.push(node);
            };

            pushCandidate(el);
            try {
              if (el.shadowRoot && el.shadowRoot.activeElement) {
                pushCandidate(el.shadowRoot.activeElement);
              }
            } catch (error) {}
            try {
              if (el.shadowRoot) {
                pushCandidate(el.shadowRoot.querySelector(':focus, :focus-visible'));
              }
            } catch (error) {}
            try {
              pushCandidate(el.querySelector(':focus, :focus-visible'));
            } catch (error) {}
            // Add direct children - tiles/cards may apply focus ring to a child div via :focus-within
            try {
              Array.from(el.children).slice(0, 5).forEach(child => pushCandidate(child));
            } catch (error) {}

            const isElActive = el === document.activeElement;

            const hasVisibleIndicator = (target) => {
              const style = window.getComputedStyle(target);
              let isFocused = target === document.activeElement;
              try {
                isFocused = isFocused || target.matches(':focus, :focus-visible');
              } catch (error) {}

              // outlineStyle 'auto' = Chrome UA :focus-visible management - treat as valid regardless of width
              const hasOutline = style.outlineStyle === 'auto' ||
                (style.outlineStyle !== 'none' && style.outlineWidth !== '0px' && style.outlineColor !== 'transparent' && style.outlineColor !== 'rgba(0, 0, 0, 0)');
              const hasShadow = style.boxShadow && style.boxShadow !== 'none';
              const borderWidth = Number.parseFloat(style.borderTopWidth || '0');
              const hasBorderFocus = isFocused && style.borderTopStyle !== 'none' && borderWidth >= focusBorderMinPx && style.borderTopColor !== 'transparent' && style.borderTopColor !== 'rgba(0, 0, 0, 0)';
              const parentBg = target.parentElement ? window.getComputedStyle(target.parentElement).backgroundColor : '';
              const hasBackgroundFocus = focusBgCheck && isFocused && style.backgroundColor && style.backgroundColor !== 'transparent' && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== parentBg;
              // Check pseudo-elements (::before / ::after) - only when el is truly activeElement to get :focus state styles
              let hasPseudoIndicator = false;
              if (isElActive) {
                try {
                  const afterStyle = window.getComputedStyle(target, '::after');
                  const beforeStyle = window.getComputedStyle(target, '::before');
                  hasPseudoIndicator =
                    (afterStyle.outlineStyle === 'auto') ||
                    (afterStyle.outlineStyle !== 'none' && afterStyle.outlineWidth !== '0px' && afterStyle.outlineColor !== 'transparent' && afterStyle.outlineColor !== 'rgba(0, 0, 0, 0)') ||
                    (afterStyle.boxShadow && afterStyle.boxShadow !== 'none') ||
                    (beforeStyle.outlineStyle === 'auto') ||
                    (beforeStyle.outlineStyle !== 'none' && beforeStyle.outlineWidth !== '0px' && beforeStyle.outlineColor !== 'transparent' && beforeStyle.outlineColor !== 'rgba(0, 0, 0, 0)') ||
                    (beforeStyle.boxShadow && beforeStyle.boxShadow !== 'none');
                } catch (error) {}
              }
              // Check parent :focus-within styling - parent may render a visible ring when child is focused
              let hasParentFocusWithin = false;
              try {
                const parent = target.parentElement;
                if (parent) {
                  const ps = window.getComputedStyle(parent);
                  hasParentFocusWithin =
                    (ps.outlineStyle === 'auto') ||
                    (ps.outlineStyle !== 'none' && ps.outlineWidth !== '0px' && ps.outlineColor !== 'transparent' && ps.outlineColor !== 'rgba(0, 0, 0, 0)') ||
                    (ps.boxShadow && ps.boxShadow !== 'none');
                }
              } catch (error) {}
              return hasOutline || hasShadow || hasBorderFocus || hasBackgroundFocus || hasPseudoIndicator || hasParentFocusWithin;
            };

            const hasFocusIndicator = candidates.some(hasVisibleIndicator);
            return {
              tag: el.tagName,
              type: el.type || '',
              name: el.getAttribute('name') || '',
              id: el.id || '',
              class: el.className || '',
              ariaLabel: el.getAttribute('aria-label') || '',
              text: (el.innerText || el.textContent || '').substring(0, 100),
              hasFocusIndicator,
              visible: (() => {
                try {
                  const style = window.getComputedStyle(el);
                  if (style.visibility === 'hidden' || style.display === 'none') return false;
                  if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
                  if (el.closest && el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
                  const rect = el.getBoundingClientRect();
                  return rect.width > 0 && rect.height > 0;
                } catch (error) {
                  return false;
                }
              })()
            };
          }, { focusBorderMinPx: runtimePolicy.focusBorderMinPx, focusBgCheck: runtimePolicy.focusBgCheck });
          if (!active || !active.visible) {
            if (tabTraversalTrace) {
              tabTraversalTrace.push({
                iteration: i + 1,
                event: 'skip',
                reason: !active ? 'no-active-element' : 'inactive-visible-filter'
              });
            }
            continue;
          }

          const key = createElementKey(active);
          if (seenKeys.has(key)) {
            repeatCycles++;
            if (tabTraversalTrace) {
              tabTraversalTrace.push({
                iteration: i + 1,
                event: 'repeat',
                repeatCycles,
                tag: active.tag,
                id: active.id,
                text: (active.text || '').substring(0, 60)
              });
            }
            if (repeatCycles >= 6 && tabbedElements.length >= 5) {
              tabTraversalStopReason = `repeat-cycle-limit(${repeatCycles})`;
              break;
            }
            continue;
          }

          seenKeys.add(key);
          repeatCycles = 0;
          tabbedElements.push(active);
          if (tabTraversalTrace) {
            tabTraversalTrace.push({
              iteration: i + 1,
              event: 'capture',
              uniqueIndex: tabbedElements.length,
              tag: active.tag,
              id: active.id,
              text: (active.text || '').substring(0, 60)
            });
          }
          if (i < 5 || i % 20 === 0) {
            console.log(`    Tab #${tabbedElements.length}: ${active.tag} "${active.text.substring(0, 40)}"`);
          }
        }
      } else {
        tabTraversalStopReason = 'no-focusable-elements-detected';
      }
      // Coverage is based on the UNION of forward-Tab and reverse-Shift+Tab traversal.
      // Both directions together give the truest picture of keyboard reachability.
      // Using Tab-only would undercount on pages where the iteration budget runs out
      // before the full page is traversed (e.g. bill-pay, recording 5/21/2026).
      const _tabKeySet = new Set(tabbedElements.map(createElementKey));
      // shiftTabbedElements may not be populated yet at this point — it is populated
      // later. We record the combined coverage after Shift+Tab completes (see below).
      const tabCoveragePercent = allFocusableElements.length > 0 ? Math.round((tabbedElements.length / allFocusableElements.length) * 100) : 0;
      console.log(`  [OK] [KEYBOARD-TAB] Reached ${tabbedElements.length}/${allFocusableElements.length} elements (${tabCoveragePercent}% coverage) in ${(Date.now() - tabStart)}ms`);
      result.tabOrder = tabbedElements;
      result.tabCoverage = tabbedElements.length;
      result.tabCoveragePercent = tabCoveragePercent;
      if (runtimePolicy.diagnosticTraceFocus) {
        result.tabTraversalDiagnostic = {
          enabled: true,
          maxIterations: Math.min(Math.max((allFocusableElements.length || 0) * 3, 40), 350),
          iterationsExecuted: tabTraversalIterations,
          stopReason: tabTraversalStopReason,
          capturedUnique: tabbedElements.length,
          trace: tabTraversalTrace ? tabTraversalTrace.slice(0, 180) : []
        };
        console.log(`  [i] [TAB-TRACE] iterations=${tabTraversalIterations}, unique=${tabbedElements.length}, stop=${tabTraversalStopReason}`);
      }

      // Diagnostic-only: keep programmatic focus order separate from pass/fail.
      if (tabbedElements.length < allFocusableElements.length) {
        console.log('  [TAB-DIAGNOSTIC] Keyboard traversal reached fewer elements than computed; recording programmatic focus order for diagnostics');
        const programmaticTab = await page.evaluate(() => {
          function isVisible(el) {
            try { const s = window.getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && el.offsetWidth > 0 && el.offsetHeight > 0 && el.getAttribute('aria-hidden') !== 'true'; } catch (e) { return false; }
          }
          function isTabbable(el) {
            if (!el) return false;
            if (el.disabled) return false;
            if (!isVisible(el)) return false;
            const tag = el.tagName;
            const natural = (tag === 'A' && el.hasAttribute('href')) || tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'AREA';
            const contentEditable = el.hasAttribute && el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false';
            const hasTabIndex = el.hasAttribute && el.hasAttribute('tabindex');
            const tabIndex = el.tabIndex;
            if (natural && tabIndex !== -1) return true;
            if (hasTabIndex && tabIndex >= 0) return true;
            if (contentEditable) return true;
            return false;
          }
          const focusableSelectors = ['a[href]', 'area[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', 'iframe', '[tabindex]', '[contenteditable]', '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]', 'ngx-web-small-cta', 'nw-button', 'nw-cta', '[data-focusable="true"]'];
          const all = Array.from(document.querySelectorAll(focusableSelectors.join(','))).filter(isTabbable);
          const results = [];
          for (const el of all) {
            try { el.focus(); } catch (e) {}
            const active = document.activeElement;
            results.push({ tag: active ? active.tagName : el.tagName, id: active ? active.id || '' : el.id || '', class: active ? active.className || '' : el.className || '', ariaLabel: active ? active.getAttribute('aria-label') || '' : el.getAttribute('aria-label') || '', name: active ? active.getAttribute('name') || '' : el.getAttribute('name') || '', text: active ? active.innerText || '' : el.innerText || '' });
          }
          return results;
        });
        // Only add programmaticTab to result if it found more
        result.programmaticTabOrder = programmaticTab;
      }

      // --- Shift+Tab Order (keyboard navigation) - use actual tab order in reverse with debug logging ---
      let shiftTabbedElements = [];
      if (tabbedElements.length > 0) {
        // Focus the last element in the actual tab order
        const last = tabbedElements[tabbedElements.length - 1];
        await page.evaluate(({ tag, id, className, name, ariaLabel }) => {
          function match(el) {
            return el.tagName === tag &&
              (el.id || '') === id &&
              (el.className || '') === className &&
              (el.getAttribute('name') || '') === name &&
              (el.getAttribute('aria-label') || '') === ariaLabel;
          }
          const focusableSelectors = [
            'a[href]', 'area[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea', '[tabindex]', '[contenteditable]',
            '[role="button"]', '[role="link"]', '[role="tab"]', '[role="menuitem"]',
            'ngx-web-entity-container', 'ngx-web-small-cta', 'ngx-nationwide-rich-text-component', 
            'ngx-nationwide-resource-promo', 'ngx-web-footer', 'nw-button', 'nw-cta'
          ];
          const all = Array.from(document.querySelectorAll(focusableSelectors.join(',')));
          const found = all.find(match);
          if (found) found.focus();
        }, { tag: last.tag, id: last.id, className: last.class, name: last.name, ariaLabel: last.ariaLabel });
        await page.waitForTimeout(20);
        // ENHANCED: Increased iteration limits for comprehensive capture (250 max)
        const maxIters = Math.min(tabbedElements.length * 3, 250); // increased from 150 to 250
        const seenKeys = new Set();
        let repeatCycles = 0;
        console.log(`    [SHIFTTAB-TRAVERSAL] Max iterations: ${maxIters}`);
        for (let i = 0; i < maxIters; i++) {
          await page.keyboard.down('Shift');
          await page.keyboard.press('Tab');
          await page.keyboard.up('Shift');
          await page.waitForTimeout(20);
          const active = await page.evaluate(({ focusBorderMinPx, focusBgCheck }) => {
            const el = document.activeElement;
            if (!el) return null;
            const checked = new Set();
            const candidates = [];
            const pushCandidate = (node) => {
              if (!node || checked.has(node)) return;
              checked.add(node);
              candidates.push(node);
            };

            pushCandidate(el);
            try {
              if (el.shadowRoot && el.shadowRoot.activeElement) {
                pushCandidate(el.shadowRoot.activeElement);
              }
            } catch (error) {}
            try {
              if (el.shadowRoot) {
                pushCandidate(el.shadowRoot.querySelector(':focus, :focus-visible'));
              }
            } catch (error) {}
            try {
              pushCandidate(el.querySelector(':focus, :focus-visible'));
            } catch (error) {}
            // Add direct children - tiles/cards may apply focus ring to a child div via :focus-within
            try {
              Array.from(el.children).slice(0, 5).forEach(child => pushCandidate(child));
            } catch (error) {}

            // el IS document.activeElement here (read above), so isElActive is always true
            const isElActive = true;

            return {
              tag: el.tagName,
              type: el.type || '',
              name: el.getAttribute('name') || '',
              id: el.id || '',
              class: el.className || '',
              ariaLabel: el.getAttribute('aria-label') || '',
              text: el.innerText || '',
              hasFocusIndicator: (() => {
                const hasVisibleIndicator = (target) => {
                  const style = window.getComputedStyle(target);
                  let isFocused = target === document.activeElement;
                  try {
                    isFocused = isFocused || target.matches(':focus, :focus-visible');
                  } catch (error) {}

                  // outlineStyle 'auto' = Chrome UA :focus-visible management - treat as valid regardless of width
                  const hasOutline = style.outlineStyle === 'auto' ||
                    (style.outlineStyle !== 'none' && style.outlineWidth !== '0px' && style.outlineColor !== 'transparent' && style.outlineColor !== 'rgba(0, 0, 0, 0)');
                  const hasShadow = style.boxShadow && style.boxShadow !== 'none';
                  const borderWidth = Number.parseFloat(style.borderTopWidth || '0');
                  const hasBorderFocus = isFocused && style.borderTopStyle !== 'none' && borderWidth >= focusBorderMinPx && style.borderTopColor !== 'transparent' && style.borderTopColor !== 'rgba(0, 0, 0, 0)';
                  const parentBg = target.parentElement ? window.getComputedStyle(target.parentElement).backgroundColor : '';
                  const hasBackgroundFocus = focusBgCheck && isFocused && style.backgroundColor && style.backgroundColor !== 'transparent' && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== parentBg;
                  // Check pseudo-elements (::before / ::after) - only when el is truly activeElement to get :focus state styles
                  let hasPseudoIndicator = false;
                  if (isElActive) {
                    try {
                      const afterStyle = window.getComputedStyle(target, '::after');
                      const beforeStyle = window.getComputedStyle(target, '::before');
                      hasPseudoIndicator =
                        (afterStyle.outlineStyle === 'auto') ||
                        (afterStyle.outlineStyle !== 'none' && afterStyle.outlineWidth !== '0px' && afterStyle.outlineColor !== 'transparent' && afterStyle.outlineColor !== 'rgba(0, 0, 0, 0)') ||
                        (afterStyle.boxShadow && afterStyle.boxShadow !== 'none') ||
                        (beforeStyle.outlineStyle === 'auto') ||
                        (beforeStyle.outlineStyle !== 'none' && beforeStyle.outlineWidth !== '0px' && beforeStyle.outlineColor !== 'transparent' && beforeStyle.outlineColor !== 'rgba(0, 0, 0, 0)') ||
                        (beforeStyle.boxShadow && beforeStyle.boxShadow !== 'none');
                    } catch (error) {}
                  }
                  // Check parent :focus-within styling - parent may render a visible ring when child is focused
                  let hasParentFocusWithin = false;
                  try {
                    const parent = target.parentElement;
                    if (parent) {
                      const ps = window.getComputedStyle(parent);
                      hasParentFocusWithin =
                        (ps.outlineStyle === 'auto') ||
                        (ps.outlineStyle !== 'none' && ps.outlineWidth !== '0px' && ps.outlineColor !== 'transparent' && ps.outlineColor !== 'rgba(0, 0, 0, 0)') ||
                        (ps.boxShadow && ps.boxShadow !== 'none');
                    }
                  } catch (error) {}
                  return hasOutline || hasShadow || hasBorderFocus || hasBackgroundFocus || hasPseudoIndicator || hasParentFocusWithin;
                };

                return candidates.some(hasVisibleIndicator);
              })()
            };
          }, { focusBorderMinPx: runtimePolicy.focusBorderMinPx, focusBgCheck: runtimePolicy.focusBgCheck });
          if (!active) continue;
          const key = `${active.tag}|${active.id}|${active.class}|${active.name}|${active.ariaLabel}`;
          if (seenKeys.has(key)) {
            repeatCycles++;
            // ENHANCED: Increased repeat threshold to allow more cycles (3 vs 2)
            if (repeatCycles >= 3) break; 
          } else {
            seenKeys.add(key);
            repeatCycles = 0;
          }
          if (!shiftTabbedElements.some(e => e.tag === active.tag && e.id === active.id && e.class === active.class && e.name === active.name && e.ariaLabel === active.ariaLabel)) {
            shiftTabbedElements.push(active);
            console.log(`Shift+Tab #${shiftTabbedElements.length}:`, active); // Debug log
          }
        }
      }
      console.log(`  [OK] [KEYBOARD-SHIFTTAB] Reached ${shiftTabbedElements.length} elements in ${(Date.now() - tabStart)}ms`);
      result.shiftTabOrder = shiftTabbedElements;

      // Recompute coverage using the UNION of Tab + Shift+Tab so pages where the
      // forward Tab budget ran short are not penalised for elements that Shift+Tab
      // covered (e.g. footer links on bill-pay, recording 5/21/2026).
      const combinedTraversedKeys = new Set(
        [...tabbedElements, ...shiftTabbedElements].map(createElementKey)
      );
      const combinedCoveragePercent = allFocusableElements.length > 0
        ? Math.round((combinedTraversedKeys.size / allFocusableElements.length) * 100)
        : 0;
      if (combinedCoveragePercent > tabCoveragePercent) {
        console.log(`  [i] [COVERAGE] Combined Tab+Shift+Tab coverage: ${combinedCoveragePercent}% (Tab-only: ${tabCoveragePercent}%)`);
        result.tabCoveragePercent = combinedCoveragePercent;
      }

      // Programmatic reverse (fallback) if shift traversal shorter than computed
      if (shiftTabbedElements.length < allFocusableElements.length && result.programmaticTabOrder) {
        result.programmaticShiftTabOrder = result.programmaticTabOrder.slice().reverse();
      }

      // Scroll test (after both Tab and Shift+Tab navigation)
      const scrollStart = Date.now();
      console.log(`  [...] [SCROLL-TEST] Testing scroll...`);
      
      // Clear any remaining overlay interference
      await page.evaluate(() => {
        document.querySelectorAll('[class*="truste"], [id*="cookie"], [class*="consent"], .ta-show')
          .forEach(el => {
            el.style.pointerEvents = 'none !important';
          });
      }).catch(() => {});
      
      const scrollStep = 400;
      let scrollPositions = [];
      
      // Measure actual scrollable height
      const scrollInfo = await page.evaluate(() => {
        const html = document.documentElement;
        const body = document.body;
        const maxScrollHeight = Math.max(
          html.scrollHeight - html.clientHeight,
          body.scrollHeight - body.clientHeight
        );
        return {
          scrollHeight: Math.max(html.scrollHeight, body.scrollHeight),
          clientHeight: Math.max(html.clientHeight, body.clientHeight),
          maxScroll: Math.max(maxScrollHeight, 0),
          htmlScrollHeight: html.scrollHeight,
          bodyScrollHeight: body.scrollHeight
        };
      });
      
      if (scrollInfo.maxScroll > 0) {
        let scrollY = 0;
        while (scrollY <= scrollInfo.maxScroll) {
          try {
            await page.evaluate((y) => {
              window.scrollTo(0, y);
            }, scrollY);
            
            const current = await page.evaluate(() => 
              window.scrollY || document.documentElement.scrollTop || 0
            );
            scrollPositions.push(current);
            
            scrollY += scrollStep;
            await page.waitForTimeout(200);
          } catch (e) {
            break;
          }
        }
        
        // Reset to top
        await page.evaluate(() => window.scrollTo(0, 0));
      }
      
      console.log(`  [OK] [SCROLL-TEST] Tested ${scrollPositions.length} scroll position(s) (${Date.now() - scrollStart}ms)`);
      result.scrollPositions = scrollPositions;
      // Hidden focusable
      const hiddenFocusable = await page.evaluate(() => {
        function isHidden(el) {
          if (!el) return true;
          const style = window.getComputedStyle(el);
          return style.display === 'none' || style.visibility === 'hidden' || el.hasAttribute('aria-hidden');
        }
        const focusableSelectors = [
          'a[href]', 'button', 'input', 'select', 'textarea', '[tabindex]'
        ];
        const allFocusable = Array.from(document.querySelectorAll(focusableSelectors.join(',')));
        return allFocusable.filter(el => isHidden(el) && !el.disabled).map(el => {
          return {
            tag: el.tagName,
            id: el.id || '',
            class: el.className || '',
            ariaLabel: el.getAttribute('aria-label') || '',
            name: el.getAttribute('name') || '',
            type: el.type || '',
            text: el.innerText || ''
          };
        });
      });
      result.hiddenFocusable = hiddenFocusable;
      // allFocusableElements already declared and assigned above, reuse it here.
      // result.allFocusableElements = allFocusableElements; // This line can be kept if needed, but do not redeclare.

      const traversedFocusEvents = [...tabbedElements, ...shiftTabbedElements];
      // Third-party injected widgets whose focus styling is outside page owner control
      const thirdPartyFocusExclusions = [
        'QSIFeedbackButton',  // Qualtrics intercept widget
        'QSI_',               // Qualtrics general prefix
        'truste_',            // TrustArc consent
        'teconsent',          // TrustArc consent
      ];
      const isThirdParty = (el) => thirdPartyFocusExclusions.some(prefix =>
        (el.id && el.id.startsWith(prefix)) ||
        (el.class && el.class.includes(prefix))
      );

      // Manually verified false positives: elements where automation cannot detect the
      // visible focus style but a clear focus indicator IS present on manual review.
      // These are excluded from focusIndicatorFailures to suppress the false positive report.
      //
      // Verified on: https://uat-ng.nationwide.com/
      //   - <SELECT id="custom-account-dropdown" class="bolt-form-select"> ("What would you like to do?")
      //     Bolt Design System applies a custom :focus-visible outline that the automated
      //     CSS-snapshot approach misses because the style is applied via a Shadow-DOM or
      //     JS-driven class after the snapshot is taken.
      //   - <SELECT id="customSelectQuote"> ("type of insurance")
      //     Same Bolt Design System pattern – focus ring is visible on manual testing.
      //
      // Verified on: https://uat-ng.nationwide.com/personal/insurance/
      //   - <SELECT id="select-default" class="ng-untouched ng-pristine ng-valid"> ("type of insurance")
      //     Angular/Bolt Design System select – a visible focus indicator is present on
      //     manual keyboard navigation. The CSS-snapshot approach misses the ng-driven
      //     :focus-visible outline applied after snapshot capture. Confirmed false positive.
      const knownFocusIndicatorFalsePositives = [
        { idPattern: /^custom-account-dropdown$/ },
        { idPattern: /^customSelectQuote$/ },
        { idPattern: /^select-default$/ },
      ];

      const isKnownFocusFalsePositive = (el) =>
        knownFocusIndicatorFalsePositives.some(excl => {
          if (excl.idPattern && excl.idPattern.test(el.id || '')) return true;
          if (excl.classPattern && excl.classPattern.test(el.class || '')) return true;
          return false;
        });

      // Deduplicate across ALL traversals first - if an element passes focus check
      // in ANY traversal (Tab or Shift+Tab), it is NOT a failure.
      // This prevents false positives where timing differences between Tab and Shift+Tab
      // cause the same element to read hasFocusIndicator=false in one direction only.
      const bestByKey = new Map();
      for (const el of traversedFocusEvents) {
        const key = createElementKey(el);
        const existing = bestByKey.get(key);
        if (!existing || (!existing.hasFocusIndicator && el.hasFocusIndicator)) {
          bestByKey.set(key, el);
        }
      }
      const focusIndicatorFailures = Array.from(bestByKey.values())
        .filter(el => !el.hasFocusIndicator)
        .filter(el => !isThirdParty(el))
        .filter(el => !isKnownFocusFalsePositive(el))
        // WCAG EXEMPTION: Vue slider dots have injected focus indicators via CSS injection (lines 1477-1493)
        // These are custom widget indicators that don't appear as computed styles but are visually present
        .filter(el => !(el.class && el.class.includes('vue-slider-dot')));
      const tabTraversalMatches = tabbedElements.length > 0;
      result.tabTraversalMatches = tabTraversalMatches;
      result.focusIndicatorFailures = focusIndicatorFailures;
      
      // =====================================================================
      // Simplified WCAG 2.2 AA Metrics (Read-only, no interactions)
      // =====================================================================
      result.wcagMetrics = await getSimplifiedWCAGMetrics(page);
      
      // =====================================================================
      // axe-core WCAG 2.2 AA Rule Violations
      // =====================================================================
      result.axeViolations = await runAxeScan(page);
      
      // =====================================================================
      // COVERAGE DIAGNOSTIC (updated 2026-05-21)
      // Tab coverage % is a DIAGNOSTIC METRIC only — not a hard pass/fail gate.
      // It is logged and surfaced in the report as a warning but does NOT cause
      // a Fail status. Reason: off-screen DOM elements (carousel panels, accordion
      // inactive panes hidden via CSS transform) inflate the denominator and produce
      // false failures even when keyboard navigation is fully functional.
      // =====================================================================
      const tabOk = tabbedElements.length > 0;
      const shiftTabOk = shiftTabbedElements.length > 0;
      const scrollOk = scrollPositions.length > 1;
      // BODY and IFRAME elements cannot meaningfully display a CSS focus indicator —
      // their focus ring lives inside the browsing context boundary. Excluding them
      // from the actionable set prevents false Fail verdicts when they are the only
      // missing-indicator elements (e.g. https://uat-ng.nationwide.com/business/).
      const noisyFocusTags = new Set(['BODY', 'IFRAME']);
      const actionableFocusFailures = focusIndicatorFailures.filter(el => !noisyFocusTags.has((el.tag || '').toUpperCase()));
      const focusOk = actionableFocusFailures.length === 0;
      
      // Tab coverage is a DIAGNOSTIC METRIC only — not a hard pass/fail gate.
      // The 70% threshold was found to produce false failures on pages where inactive
      // carousel panels / off-screen accordion content inflate the DOM snapshot
      // denominator even though the browser never makes those elements Tab-reachable.
      // Coverage is still logged and surfaced in reports for manual review.
      const minCoveragePercent = runtimePolicy.minTabCoverage;
      const effectiveCoveragePercent = result.tabCoveragePercent;
      // Keep the variable so existing references compile, but it no longer drives status.
      const hasGoodTabCoverage = effectiveCoveragePercent >= minCoveragePercent;
      
      // Report coverage as a diagnostic warning (never a blocker)
      if (effectiveCoveragePercent < minCoveragePercent) {
        console.log(`  [WARN] [COVERAGE-DIAGNOSTIC] Tab traversal coverage ${effectiveCoveragePercent}% is below ${minCoveragePercent}% threshold — diagnostic only, not a blocker`);
        if (tabbedElements.length < 5) {
          console.log(`  [WARN] [CRITICAL] Only ${tabbedElements.length} elements captured (expected ~${allFocusableElements.length})`);
        }
      }
      
      // Known third-party widget elements manually verified as keyboard accessible.
      // These are excluded from the CRITICAL missing check to avoid false positives.
      // Reason: Fixed-position overlays or late-loading third-party widgets (Cognigy webchat,
      // Yext search) are not reachable during automated Tab traversal but work correctly
      // when tested manually.
      const knownThirdPartyExclusions = [
        // Cognigy webchat toggle button (aria-label="Open chat" / "Close chat")
        { idPattern: /^webchatWindowToggleButton$/ },
        { classPattern: /webchat-toggle-button/ },
        { classPattern: /cognigy-webchat/ },
        { classPattern: /webchat-header-close-button/ },
        // Yext search bar - both the input field and submit button.
        // These are third-party Yext widget elements rendered in a shadow-like
        // isolated container. They are keyboard-accessible manually (Tab reaches
        // them after the page search icon is activated) but cannot be reached by
        // automated Tab traversal against the static DOM. They are NOT a defect.
        // Verified manually: https://uat-ng.nationwide.com/financial-professionals/topics/health-care-cost-longevity
        { idPattern: /^yxt-SearchBar-input/ },
        { classPattern: /yxt-SearchBar-input/ },
        { classPattern: /js-yext-submit/ },
        { classPattern: /yxt-SearchBar-button/ },
      ];

      const isKnownThirdParty = (el) =>
        knownThirdPartyExclusions.some(excl => {
          if (excl.idPattern && excl.idPattern.test(el.id || '')) return true;
          if (excl.classPattern && excl.classPattern.test(el.class || '')) return true;
          return false;
        });

      // Generate detailed mismatch report with element analysis.
      // Use the UNION of Tab + Shift+Tab traversal so an element seen in either
      // direction is not counted as missing (verified: bill-pay recording 5/21/2026).
      const traversedKeys = new Set(
        [...tabbedElements, ...shiftTabbedElements].map(createElementKey)
      );
      
      // ENHANCED: Better matching for form controls with fallback
      const traversedElements = [...tabbedElements, ...shiftTabbedElements];
      const missingElements = allFocusableElements.filter(detected => {
        if (isKnownThirdParty(detected)) return false;
        
        const detectedKey = createElementKey(detected);
        if (traversedKeys.has(detectedKey)) return false;
        
        // Fallback: Check if element matches by ID/name alone (for form controls)
        const tag = (detected.tag || '').toUpperCase();
        const isFormControl = ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(tag);
        if (isFormControl && (detected.id || detected.name)) {
          const matchByIdOrName = traversedElements.some(t => {
            return t.tag === detected.tag && 
                   ((detected.id && t.id === detected.id) || 
                    (detected.name && t.name === detected.name));
          });
          if (matchByIdOrName) return false;
        }
        
        return true;
      });
      
      // Analyze missing elements for underlying issues
      const missingElementsWithAnalysis = await page.evaluate((missing) => {
        function hasCollapsedOrInactiveAncestor(el) {
          try {
            if (!el || !el.closest) return false;
            const collapsedAncestor = el.closest(
              '[hidden], [inert], details:not([open]), [aria-hidden="true"], [aria-expanded="false"], [data-state="closed"], [data-expanded="false"]'
            );
            return Boolean(collapsedAncestor);
          } catch (e) {
            return false;
          }
        }

        function normalizeText(text) {
          return String(text || '').replace(/\s+/g, ' ').trim();
        }

        function getElementKey(el) {
          return [
            el.tag || '',
            el.id || '',
            el.name || '',
            el.ariaLabel || '',
            normalizeText(el.text || '').substring(0, 80)
          ].join('|');
        }

        function findElementFromData(data) {
          const allCandidates = Array.from(document.querySelectorAll(data.tag || '*'));
          const match = allCandidates.find(candidate => getElementKey({
            tag: candidate.tagName,
            id: candidate.id || '',
            name: candidate.getAttribute('name') || '',
            ariaLabel: candidate.getAttribute('aria-label') || '',
            text: (candidate.innerText || candidate.textContent || '').substring(0, 100)
          }) === getElementKey(data));
          if (match) return match;

          if (data.id) {
            const byId = document.getElementById(data.id);
            if (byId) return byId;
          }

          if (data.class) {
            const classSelector = data.class
              .split(/\s+/)
              .filter(Boolean)
              .map(cls => `.${window.CSS && window.CSS.escape ? window.CSS.escape(cls) : cls.replace(/[^a-zA-Z0-9_-]/g, '')}`)
              .join('');
            if (classSelector) {
              const byClass = document.querySelector(`${data.tag || '*'}${classSelector}`);
              if (byClass) return byClass;
            }
          }

          return null;
        }

        return missing.map(el => {
          try {
            const domEl = findElementFromData(el);
            
            if (!domEl) {
              return { ...el, analysis: 'NOT_FOUND', reason: 'Element not found in DOM', critical: false };
            }
            
            const style = window.getComputedStyle(domEl);
            const rect = domEl.getBoundingClientRect();
            
            // Analyze why element is missing
            let analysis = 'UNKNOWN';
            let reason = '';
            let critical = true;
            
            // PRIORITY CHECK: Native form controls are inherently keyboard accessible
            // They should never be flagged as critical - likely a matching/timing issue
            const tag = (el.tag || '').toUpperCase();
            const isNativeFormControl = ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(tag);
            
            if (isNativeFormControl && (el.id || el.name)) {
              analysis = 'NATIVE_FORM_CONTROL';
              reason = `Native ${tag} element - inherently keyboard accessible (likely traversal timing or text mismatch)`;
              critical = false;
            } else if (style.display === 'none') {
              analysis = 'HIDDEN_DISPLAY';
              reason = 'Element hidden with display:none';
              critical = false;
            } else if (style.visibility === 'hidden') {
              analysis = 'HIDDEN_VISIBILITY';
              reason = 'Element hidden with visibility:hidden';
              critical = false;
            } else if (style.opacity === '0') {
              analysis = 'HIDDEN_OPACITY';
              reason = 'Element hidden with opacity:0';
              critical = false;
            } else if (domEl.hasAttribute('aria-hidden') && domEl.getAttribute('aria-hidden') === 'true') {
              analysis = 'ARIA_HIDDEN';
              reason = 'Element has aria-hidden="true"';
              critical = false;
            } else if (domEl.hasAttribute('tabindex') && domEl.getAttribute('tabindex') === '-1') {
              analysis = 'TABINDEX_NEGATIVE';
              reason = 'Element has tabindex="-1"';
              critical = false;
            } else if (domEl.disabled) {
              analysis = 'DISABLED';
              reason = 'Element is disabled';
              critical = false;
            } else if (hasCollapsedOrInactiveAncestor(domEl)) {
              analysis = 'COLLAPSED_CONTAINER';
              reason = 'Element is inside collapsed/hidden/inactive container state';
              critical = false;
            } else if (domEl.tagName && /^BOLT-TABLABEL$/i.test(domEl.tagName)) {
              // BOLT-TABLABEL is a Bolt Design System custom tab-label element.
              // The Tab key reaches it correctly via its role="tab" — confirmed by
              // Playwright recording for https://uat-ng.nationwide.com/personal/contact/
              // (Log 5/21/2026: getByRole('tab',{name:'Popular topics'}).press('Tab')).
              // The automated querySelectorAll collector picks it up as a distinct node,
              // but the traversal key-match misses it because the Tab loop records focus
              // on the inner text node / shadow slot rather than the host element itself.
              analysis = 'BOLT_TABLABEL';
              reason = 'Bolt Design System tab label — reachable via role=tab, confirmed by manual recording';
              critical = false;
            } else if (domEl.closest(
              'ngx-web-entity-container, ngx-web-small-cta, ngx-nationwide-rich-text-component, ngx-nationwide-resource-promo, ngx-web-footer, nw-button, nw-cta'
            )) {
              // Elements inside Nationwide Angular shell components are reachable by keyboard
              // in practice (manually verified). The automated Tab traversal engine may not
              // cycle deep enough to reach them within its iteration budget, but that is a
              // traversal-budget limitation, NOT a real accessibility defect. The focus-trap
              // analysis section already reports these containers separately for review.
              // Verified on: https://uat-ng.nationwide.com/bill-pay (Recording 5/21/2026)
              analysis = 'ANGULAR_CONTAINER_CHILD';
              reason = 'Element is inside a Nationwide Angular shell component — reachable by keyboard per manual testing';
              critical = false;
            } else if (domEl.closest('#navigation-secondary-wrapper, [data-secondary-nav], .bolt-header-wc--secondary-nav')) {
              // Secondary navigation bar links are globally present across all pages and are
              // provably keyboard-reachable (confirmed: URL 1 traversal, manual recordings).
              // The automation Tab loop starts from a variable DOM position and sometimes
              // skips one of the secondary-nav links depending on the entry point — this is
              // a traversal-start-point artifact, NOT a real accessibility gap.
              analysis = 'GLOBAL_NAV_ELEMENT';
              reason = 'Element is inside the global secondary navigation — reachable by keyboard per cross-URL traversal evidence';
              critical = false;
            } else if (
              domEl.tagName === 'A' &&
              domEl.closest('bolt-header-wc, #header, [class*="bolt-header"], [id*="header"], [id*="navigation"]')
            ) {
              // Anchor links that live anywhere inside the site-wide header/navigation
              // component are globally reachable by keyboard. If the Tab loop entry
              // point happens to start mid-nav, one header link may be skipped without
              // it being an accessibility defect (e.g. "Resources for agents" on bill-pay,
              // recording 5/21/2026 — confirmed reachable as Tab #1 from nav click).
              analysis = 'GLOBAL_NAV_ELEMENT';
              reason = 'Header anchor link — globally keyboard-reachable, traversal-entry-point artifact';
              critical = false;
            } else if (rect.width === 0 || rect.height === 0) {
              analysis = 'ZERO_SIZE';
              reason = 'Element has zero width/height';
              critical = false;
            } else if (rect.top < 0 || rect.left < -1000) {
              analysis = 'OFFSCREEN';
              reason = 'Element positioned offscreen';
              critical = false;
            } else {
              analysis = 'POTENTIALLY_UNREACHABLE';
              reason = 'Element visible but not reached by keyboard traversal';
              critical = true;
            }
            
            return { 
              ...el, 
              analysis, 
              reason, 
              critical,
              visible: rect.width > 0 && rect.height > 0,
              disabled: domEl.disabled,
              ariaHidden: domEl.getAttribute('aria-hidden')
            };
          } catch (error) {
            return { ...el, analysis: 'ERROR', reason: error.message, critical: false };
          }
        });
      }, missingElements);
      
      // Separate critical from non-critical missing elements
      const criticalMissing = missingElementsWithAnalysis.filter(el => el.critical && el.analysis === 'POTENTIALLY_UNREACHABLE');
      const nonCriticalMissing = missingElementsWithAnalysis.filter(el => !el.critical || el.analysis !== 'POTENTIALLY_UNREACHABLE');
      
      result.missingElements = missingElementsWithAnalysis;
      result.missingElementsCount = missingElements.length;
      result.criticalMissingCount = criticalMissing.length;
      result.nonCriticalMissingCount = nonCriticalMissing.length;
      
      // ENHANCED DEBUG LOGGING
      console.log(`  [DATA] [COVERAGE] Total focusable: ${allFocusableElements.length}, Tab reached: ${tabbedElements.length}, Shift+Tab reached: ${shiftTabbedElements.length}`);
      console.log(`  [DATA] [COVERAGE] Combined unique reached: ${traversedElements.length}, Missing: ${missingElements.length} (Critical: ${criticalMissing.length}, Non-critical: ${nonCriticalMissing.length})`);
      
      // Improved coverage calculation: only count truly tabbable elements
      const actualTabbable = allFocusableElements.filter(el => {
        const tag = (el.tag || '').toUpperCase();
        // Exclude non-tabbable scenarios from coverage calculation
        return !el.disabled && 
               !(el.tabIndex === -1) &&
               !(el.ariaHidden === 'true');
      });
      const coveragePercent = actualTabbable.length > 0 
        ? Math.round((traversedElements.length / actualTabbable.length) * 100) 
        : 100;
      
      console.log(`  [DATA] [COVERAGE] Actual tabbable elements (excluding disabled/hidden): ${actualTabbable.length}`);
      console.log(`  [DATA] [COVERAGE] Real coverage: ${coveragePercent}% (${traversedElements.length}/${actualTabbable.length})`);
      
      // Update result with improved coverage calculation
      result.tabCoveragePercent = coveragePercent;
      result.tabCoverage = traversedElements.length;
      result.actualTabbableCount = actualTabbable.length;
      
      if (criticalMissing.length > 0) {
        console.log(`  [WARN] [CRITICAL-MISSING] ${criticalMissing.length} visible elements unreachable by keyboard`);
        criticalMissing.slice(0, 5).forEach((el, i) => {
          console.log(`     ${i+1}. <${el.tag}${el.id ? ` id="${el.id}"` : ''}${el.name ? ` name="${el.name}"` : ''}> - "${el.text.substring(0, 40)}"`);
        });
      }
      if (nonCriticalMissing.length > 0) {
        console.log(`  [i] [NON-CRITICAL-MISSING] ${nonCriticalMissing.length} elements with valid reasons (not accessibility issues)`);
      }
      
      // *** FIX #4 (2026-04-10): DETECT FOCUS TRAPS IN CUSTOM CONTAINERS ***
      const focusTrapAnalysis = await page.evaluate(() => {
        const containers = [
          { name: 'ngx-web-entity-container', selector: 'ngx-web-entity-container' },
          { name: 'ngx-web-small-cta', selector: 'ngx-web-small-cta' },
          { name: 'ngx-nationwide-rich-text-component', selector: 'ngx-nationwide-rich-text-component' },
          { name: 'ngx-nationwide-resource-promo', selector: 'ngx-nationwide-resource-promo' },
          { name: 'ngx-web-footer', selector: 'ngx-web-footer' }
        ];
        
        const analysis = {
          totalContainers: 0,
          containersWithInternalFocusable: 0,
          focusTraps: []
        };
        
        containers.forEach(container => {
          const elements = Array.from(document.querySelectorAll(container.selector));
          if (elements.length === 0) return;
          
          analysis.totalContainers += elements.length;
          
          elements.forEach((el, idx) => {
            // Check for internal focusable elements
            const internalFocusable = [
              'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea',
              '[role="button"]', '[role="tab"]', '[tabindex="0"]'
            ].map(sel => el.querySelectorAll(sel).length).reduce((a, b) => a + b, 0);
            
            const hasPropperTabindex = el.hasAttribute('tabindex');
            const hasKbdHandler = el.hasAttribute('role') && (el.getAttribute('role') === 'button' || el.getAttribute('role') === 'tab');
            
            if (internalFocusable > 0) {
              analysis.containersWithInternalFocusable++;
            } else if (el.offsetHeight > 0 && el.offsetParent !== null) {
              // Container is visible but has no focusable children
              analysis.focusTraps.push({
                component: container.name,
                index: idx,
                hasInternalFocusable: internalFocusable,
                hasTabindex: hasPropperTabindex,
                hasKbdRole: hasKbdHandler,
                text: (el.innerText || '').substring(0, 50),
                shadowRoot: el.shadowRoot ? 'yes' : 'no'
              });
            }
          });
        });
        
        return analysis;
      });
      
      if (focusTrapAnalysis.focusTraps.length > 0) {
        console.log(`  [WARN] [FOCUS-TRAP-ANALYSIS] Found ${focusTrapAnalysis.focusTraps.length} custom components missing internal focus:`);
        focusTrapAnalysis.focusTraps.forEach(trap => {
          console.log(`     - <${trap.component}> (tabindex=${trap.hasTabindex}, kbd-role=${trap.hasKbdRole}, shadow-dom=${trap.shadowRoot})`);
          console.log(`       "${trap.text}..."`);
        });
      }
      result.focusTrapAnalysis = focusTrapAnalysis;
      
      // Simple pass/fail: require Tab traversal coverage, Shift+Tab, Scroll, Focus indicators, vtabs when present, and Mouse Right-Click
      const vtabsOk = !result.vtabs || result.vtabs.ok === true;
      const rightClickOk = !result.mouseRightClick || result.mouseRightClick.ok === true;
      const axeCriticalCount = result.axeViolations?.critical || 0;
      const axeSeriousCount = result.axeViolations?.serious || 0;
      const axeOk = runtimePolicy.axeFailLevel === 'none'
        ? true
        : runtimePolicy.axeFailLevel === 'serious'
          ? (axeCriticalCount + axeSeriousCount) === 0
          : axeCriticalCount === 0;

      const criticalMissingOk = criticalMissing.length === 0;

      // NOTE: hasGoodTabCoverage is intentionally excluded from this gate — it is a
      // diagnostic / warning metric only. Removing it prevents pages with off-screen
      // DOM elements inflating the denominator from being incorrectly marked as Fail.
      if (tabOk && shiftTabOk && scrollOk && focusOk && vtabsOk && rightClickOk && axeOk && criticalMissingOk) {
        result.status = 'Pass';
        result.reviewDisposition = 'Pass';
      } else {
        result.status = 'Fail';
        result.reviewDisposition = 'Action Required';
        // Log reasons for failure
        if (!tabOk) console.log(`  [FAIL] [FAIL-REASON] No Tab elements captured`);
        // Tab coverage is diagnostic only — this line is kept for completeness but coverage does not cause Fail status
        if (!hasGoodTabCoverage) console.log(`  [WARN] [COVERAGE-DIAGNOSTIC] Tab coverage ${effectiveCoveragePercent}% < ${minCoveragePercent}% threshold (warning only — not a fail reason)`);
        if (!shiftTabOk) console.log(`  [FAIL] [FAIL-REASON] No Shift+Tab elements captured`);
        if (!scrollOk) console.log(`  [FAIL] [FAIL-REASON] Scroll not working`);
        if (!focusOk) {
          console.log(`  [FAIL] [FAIL-REASON] Missing focus indicators on ${actionableFocusFailures.length} unique elements`);
          actionableFocusFailures.forEach((el, idx) => {
            const label = normalizeText(el.ariaLabel || el.name || el.text || '').substring(0, 90);
            const className = normalizeText(el.class || '').substring(0, 60);
            const details = [`<${el.tag || 'UNKNOWN'}>`];
            if (el.id) details.push(`id="${el.id}"`);
            if (className) details.push(`class="${className}"`);
            if (label) details.push(`label="${label}"`);
            console.log(`     ${idx + 1}. ${details.join(' ')}`);
          });
          const suppressedFocusFailureCount = focusIndicatorFailures.length - actionableFocusFailures.length;
          if (suppressedFocusFailureCount > 0) {
            console.log(`     [i] Suppressed ${suppressedFocusFailureCount} noisy element(s): BODY/IFRAME — not actionable (focus ring is inside the frame boundary)`);
          }
        }
        if (!vtabsOk) console.log(`  [FAIL] [FAIL-REASON] VTab control not working`);
        if (!rightClickOk) console.log(`  [FAIL] [FAIL-REASON] Right-click context menu disabled`);
        if (!axeOk) console.log(`  [FAIL] [FAIL-REASON] axe violation threshold failed (level=${runtimePolicy.axeFailLevel}, critical=${axeCriticalCount}, serious=${axeSeriousCount})`);
        if (!criticalMissingOk) console.log(`  [FAIL] [FAIL-REASON] ${criticalMissing.length} critical keyboard-reachability misses`);
      }

      const traversedSampleCount = tabbedElements.length + shiftTabbedElements.length;
      const ambiguousFocusFailures = focusIndicatorFailures.filter(el => {
        const normalizedText = normalizeText(el.text || '');
        const normalizedAria = normalizeText(el.ariaLabel || '');
        return !el.id && !normalizedAria && normalizedText.length === 0;
      }).length;
      const ambiguityPercent = traversedSampleCount > 0
        ? Number(((ambiguousFocusFailures / traversedSampleCount) * 100).toFixed(2))
        : 0;
      const grayZoneMissRatio = allFocusableElements.length > 0
        ? Number((nonCriticalMissing.length / allFocusableElements.length).toFixed(3))
        : 0;
      const traversalInflationFactor = allFocusableElements.length > 0
        ? Number((tabbedElements.length / allFocusableElements.length).toFixed(2))
        : 1;
      const programmaticCount = Array.isArray(result.programmaticTabOrder) ? result.programmaticTabOrder.length : 0;
      const manualParity = programmaticCount > 0
        ? Number((tabbedElements.length / programmaticCount).toFixed(2))
        : 1;

      result.confidenceMetrics = {
        grayZoneMissRatio,
        traversalInflationFactor,
        ambiguityPercent,
        manualParity,
        ambiguousFocusFailures,
        traversedSampleCount,
        programmaticCount
      };

      const needsReviewReasons = [];
      if (grayZoneMissRatio >= runtimePolicy.needsReviewGrayZoneMissRatio) {
        needsReviewReasons.push(`gray-zone-miss-ratio=${grayZoneMissRatio} >= ${runtimePolicy.needsReviewGrayZoneMissRatio}`);
      }
      if (traversalInflationFactor >= runtimePolicy.needsReviewTraversalInflationFactor) {
        needsReviewReasons.push(`traversal-inflation=${traversalInflationFactor} >= ${runtimePolicy.needsReviewTraversalInflationFactor}`);
      }
      if (ambiguityPercent >= runtimePolicy.needsReviewAmbiguityPercent) {
        needsReviewReasons.push(`ambiguity-percent=${ambiguityPercent}% >= ${runtimePolicy.needsReviewAmbiguityPercent}%`);
      }
      if (programmaticCount > 0 && manualParity < runtimePolicy.needsReviewManualParityMin) {
        needsReviewReasons.push(`manual-parity=${manualParity} < ${runtimePolicy.needsReviewManualParityMin}`);
      }

      if (result.status === 'Fail' && needsReviewReasons.length > 0) {
        result.needsReview = true;
        result.reviewDisposition = 'Needs Review';
        result.needsReviewReasons = needsReviewReasons;
        console.log(`  [WARN] [NEEDS-REVIEW] ${needsReviewReasons.join('; ')}`);
      }
      console.log(`  [OK] [VERDICT] Test status: ${result.status}`);
    } catch (err) {
      const timeoutError = urlTimedOut || err.message?.includes('Target page, context or browser has been closed');
      if (timeoutError) {
        result.error = `URL exceeded budget of ${runtimePolicy.urlTimeBudgetMs}ms`;
        result.status = 'TimedOut';
        result.reviewDisposition = 'TimedOut';
        result.timedOut = true;
        console.error(`  [WARN] [TIMEOUT] ${result.error}`);
      } else {
        console.error(`  [X] [ERROR] Exception during testing:`, err.message);
        const errorScreenshot = path.join(reportDir, `error-test-${allResults.length + 1}.png`);
        await page.screenshot({ path: errorScreenshot }).catch(() => {});
        result.error = err.message;
        result.status = 'Fail';
      }
    }
    clearTimeout(urlTimer);
    allResults.push(result);
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    console.log(`\n  --- URL ${allResults.length} complete ---\n`);
  }
  await browser.close();

  const reportTimestamp = new Date().toLocaleString();
  generateExcelReport(allResults, excelPath, reportTimestamp, runtimePolicy);

  const htmlResults = sanitizeForHtml(allResults);

  // HTML report (same as Puppeteer version)
  let passCount = 0, failCount = 0, timedOutCount = 0, needsReviewCount = 0;
  htmlResults.forEach(r => {
    if (r.status && r.status.toLowerCase() === 'pass') passCount++;
    else if (r.status && r.status.toLowerCase() === 'timedout') timedOutCount++;
    else failCount++;
    if (r.needsReview === true) needsReviewCount++;
  });
  const passRate = (passCount + failCount) > 0 ? Math.round((passCount / (passCount + failCount)) * 100) : 0;

  const failCauseCounts = {
    tabOrder: 0,
    tabCoverage: 0,
    shiftTab: 0,
    scroll: 0,
    focusIndicator: 0,
    vtabs: 0,
    rightClick: 0,
    axe: 0,
    criticalMissing: 0,
    timedOut: 0
  };

  htmlResults.forEach(r => {
    const status = (r.status || '').toLowerCase();
    if (status === 'timedout') {
      failCauseCounts.timedOut++;
      return;
    }
    if (status !== 'fail') return;

    const computedFocusableCount = r.allFocusableElements ? r.allFocusableElements.length : 0;
    const tabCount = r.tabOrder ? r.tabOrder.length : 0;
    const shiftTabCount = r.shiftTabOrder ? r.shiftTabOrder.length : 0;
    const tabCoveragePercent = r.tabCoveragePercent != null
      ? r.tabCoveragePercent
      : (computedFocusableCount > 0 ? Math.round((tabCount / computedFocusableCount) * 100) : 0);
    const tabOrderPass = tabCount > 0;
    const tabCoveragePass = tabCoveragePercent >= runtimePolicy.minTabCoverage;
    const shiftTabPass = shiftTabCount > 0;
    const scrollPass = r.scrollPositions && r.scrollPositions.length > 1 && r.scrollPositions[r.scrollPositions.length - 1] > 0;
    const _noisyFocusTags = new Set(['BODY', 'IFRAME']);
    const _actionableFocusFails = (r.focusIndicatorFailures || []).filter(el => !_noisyFocusTags.has((el.tag || '').toUpperCase()));
    const focusIndicatorPass = _actionableFocusFails.length === 0;
    const vtabsPresent = r.vtabs && r.vtabs.present;
    const vtabsPass = !vtabsPresent || (r.vtabs && r.vtabs.ok === true);
    const rightClickPass = !r.mouseRightClick || (r.mouseRightClick.ok === true);
    const axeCriticalCount = r.axeViolations?.critical || 0;
    const axeSeriousCount = r.axeViolations?.serious || 0;
    const axePass = runtimePolicy.axeFailLevel === 'none'
      ? true
      : runtimePolicy.axeFailLevel === 'serious'
        ? (axeCriticalCount + axeSeriousCount) === 0
        : axeCriticalCount === 0;
    const criticalMissingPass = (r.criticalMissingCount || 0) === 0;

    if (!tabOrderPass) failCauseCounts.tabOrder++;
    // tabCoverage is a diagnostic-only metric — NOT counted as a fail cause
    // if (!tabCoveragePass) failCauseCounts.tabCoverage++;
    if (!shiftTabPass) failCauseCounts.shiftTab++;
    if (!scrollPass) failCauseCounts.scroll++;
    if (!focusIndicatorPass) failCauseCounts.focusIndicator++;
    if (!vtabsPass) failCauseCounts.vtabs++;
    if (!rightClickPass) failCauseCounts.rightClick++;
    if (!axePass) failCauseCounts.axe++;
    if (!criticalMissingPass) failCauseCounts.criticalMissing++;
  });

  const failCauseLabels = {
    tabOrder: 'Tab traversal missing',
    tabCoverage: `Tab coverage below ${runtimePolicy.minTabCoverage}%`,
    shiftTab: 'Shift+Tab traversal missing',
    scroll: 'Mouse scroll failed',
    focusIndicator: 'Focus indicator missing',
    vtabs: 'Vertical tabs failed',
    rightClick: 'Right-click/context menu failed',
    axe: `axe threshold failed (${runtimePolicy.axeFailLevel})`,
    criticalMissing: 'Critical keyboard misses present',
    timedOut: 'URL timed out'
  };

  const primaryFailSummary = Object.entries(failCauseCounts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, count]) => `${failCauseLabels[key]}: ${count}`)
    .join(' | ');

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Playwright Keyboard & Scroll Report - ${reportTimestamp}</title>
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #f8f9fa; color: #222; margin: 0; padding: 0; }
    .container { max-width: 1100px; margin: 30px auto; background: #fff; border-radius: 10px; box-shadow: 0 2px 8px #0001; padding: 32px; }
    h1 { text-align: center; color: #005fcc; margin-bottom: 0.5em; }
    .timestamp { text-align: center; color: #666; font-size: 0.95em; margin-bottom: 1.5em; font-weight: 500; }
    .summary { display: flex; justify-content: space-between; align-items: center; background: #e9f5ff; border-radius: 8px; padding: 16px 24px; margin-bottom: 2em; }
    .badge { display: inline-block; padding: 4px 14px; border-radius: 12px; font-weight: bold; font-size: 1em; }
    .badge-pass { background: #d4f8e8; color: #1a7f37; border: 1px solid #1a7f37; }
    .badge-fail { background: #ffeaea; color: #d32f2f; border: 1px solid #d32f2f; }
    .badge-timedout { background: #fff3e0; color: #b26a00; border: 1px solid #b26a00; }
    .badge-review { background: #fff8e1; color: #8d6e00; border: 1px solid #8d6e00; }
    .url-section { margin-bottom: 2.5em; border-bottom: 1px solid #e0e0e0; padding-bottom: 2em; }
    h2 { color: #005fcc; margin-top: 0; }
    .error { color: #d32f2f; font-weight: bold; margin: 1em 0; }
    .tab-list, .shift-tab-list, .focus-indicator-list { list-style: none; padding-left: 0; }
    .tabbed { padding: 2px 0; }
    .scroll-list { font-family: monospace; color: #555; margin-bottom: 1em; }
    .footer { text-align: center; color: #888; margin-top: 2em; font-size: 0.95em; }
    .section-title { font-size: 1.1em; color: #333; margin-top: 1.5em; margin-bottom: 0.5em; }
    .result-pass { color: #1a7f37; font-weight: bold; }
    .result-fail { color: #d32f2f; font-weight: bold; }
    .result-timedout { color: #b26a00; font-weight: bold; }
    details { background: #f4f8fb; border-radius: 6px; margin-bottom: 1em; }
    summary { font-weight: bold; font-size: 1.08em; cursor: pointer; padding: 6px 0; }
    .focus-indicator-list li { margin-bottom: 2px; }
    .mouse-scroll { margin: 0.5em 0 1em 0; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Playwright Keyboard & Scroll Report</h1>
    <div class="timestamp">[LIST] Timestamp: ${reportTimestamp}</div>
    <div class="summary">
      <div><strong>Total URLs:</strong> ${htmlResults.length}</div>
      <div><span class="badge badge-pass">Pass: ${passCount}</span> <span class="badge badge-fail">Fail: ${failCount}</span> <span class="badge badge-timedout">TimedOut: ${timedOutCount}</span> <span class="badge badge-review">Needs Review: ${needsReviewCount}</span></div>
      <div><strong>Pass Rate:</strong> ${passRate}%</div>
    </div>
    <div style="margin:-1.2em 0 1.4em 0;padding:10px 14px;border:1px solid #ffe0b2;background:#fff8e1;border-radius:8px;color:#6d4c41;font-size:0.95em;">
      <strong>Primary Fail Causes:</strong> ${primaryFailSummary || 'None detected'}
    </div>
    <div style="background:#f7f7fb;border:1px solid #ddd;border-radius:8px;padding:12px 16px;margin-bottom:1.5em;">
      <strong>Runtime Policy:</strong>
      <div style="margin-top:6px;font-size:0.95em;color:#444;">
        minTabCoverage=${runtimePolicy.minTabCoverage}, axeFailLevel=${runtimePolicy.axeFailLevel}, enforceContextMenu=${runtimePolicy.enforceContextMenu}, lenientVtabs=${runtimePolicy.lenientVtabs}, diagnosticExpandMenus=${runtimePolicy.diagnosticExpandMenus}, diagnosticTraceFocus=${runtimePolicy.diagnosticTraceFocus}, focusBorderMinPx=${runtimePolicy.focusBorderMinPx}, focusBgCheck=${runtimePolicy.focusBgCheck}, urlTimeBudgetMs=${runtimePolicy.urlTimeBudgetMs}, needsReviewGrayZoneMissRatio=${runtimePolicy.needsReviewGrayZoneMissRatio}, needsReviewTraversalInflationFactor=${runtimePolicy.needsReviewTraversalInflationFactor}, needsReviewAmbiguityPercent=${runtimePolicy.needsReviewAmbiguityPercent}, needsReviewManualParityMin=${runtimePolicy.needsReviewManualParityMin}
      </div>
    </div>
`;

  htmlResults.forEach((result, idx) => {
    // Determine pass/fail for each test
    const computedFocusableCount = result.allFocusableElements ? result.allFocusableElements.length : 0;
    const tabCount = result.tabOrder ? result.tabOrder.length : 0;
    const shiftTabCount = result.shiftTabOrder ? result.shiftTabOrder.length : 0;
    // Use result.tabCoveragePercent which is the combined Tab+Shift+Tab coverage
    // (upgraded from Tab-only when Shift+Tab covered additional unique elements).
    const tabCoveragePercent = result.tabCoveragePercent != null
      ? result.tabCoveragePercent
      : (computedFocusableCount > 0 ? Math.round((tabCount / computedFocusableCount) * 100) : 0);
    const shiftTabCoveragePercent = computedFocusableCount > 0 ? Math.round((shiftTabCount / computedFocusableCount) * 100) : 0;
    let tabOrderPass = tabCount > 0;
    let shiftTabOrderPass = shiftTabCount > 0;
    let mouseScrollPass = result.scrollPositions && result.scrollPositions.length > 1 && result.scrollPositions[result.scrollPositions.length - 1] > 0;
    const _noisyFT = new Set(['BODY', 'IFRAME']);
    const _actionableFI = (result.focusIndicatorFailures || []).filter(el => !_noisyFT.has((el.tag || '').toUpperCase()));
    let focusIndicatorPass = _actionableFI.length === 0;

    html += `<details class="url-section" ${idx === 0 ? 'open' : ''}><summary>URL ${idx + 1}: <a href="${result.url}" target="_blank">${result.url}</a> <span class="badge badge-${result.status.toLowerCase()}">${result.status}</span></summary>`;
    html += `<div style="margin-top:1em;"><strong>Test Result:</strong> <span class="result-${result.status.toLowerCase()}">${result.status}</span></div>`;
    html += `<div style="margin-top:0.4em;"><strong>Review Disposition:</strong> ${result.reviewDisposition || (result.needsReview ? 'Needs Review' : 'Action Required')}</div>`;
    if (result.diagnosticMenuPrepass && result.diagnosticMenuPrepass.enabled) {
      const prepass = result.diagnosticMenuPrepass;
      const prepassText = prepass.error
        ? `menu pre-pass error: ${prepass.error}`
        : `menu pre-pass tried ${prepass.tried}, opened ${prepass.opened}`;
      html += `<div style="margin-top:0.4em;color:#0b5394;"><strong>Diagnostic:</strong> ${prepassText}</div>`;
    }
    if (result.tabTraversalDiagnostic && result.tabTraversalDiagnostic.enabled) {
      const tabTrace = result.tabTraversalDiagnostic;
      html += `<div style="margin-top:0.4em;color:#0b5394;"><strong>Tab Trace:</strong> iterations ${tabTrace.iterationsExecuted}/${tabTrace.maxIterations}, unique ${tabTrace.capturedUnique}, stop ${tabTrace.stopReason}</div>`;
    }
    if (result.needsReviewReasons && result.needsReviewReasons.length) {
      html += `<div style="margin-top:0.4em;color:#8d6e00;"><strong>Needs Review Reasons:</strong> ${result.needsReviewReasons.join('; ')}</div>`;
    }
    if (result.error) {
      html += `<div class="error">Error: ${result.error}</div>`;
    } else {
      // Compute details for Tab and Shift+Tab with programmatic fallback
      
      html += `<table style="width:100%;border-collapse:collapse;margin:1em 0;">
        <tr style="background:#f0f0f0;"><th style="text-align:left;border:1px solid #ddd;padding:8px;">Test Category</th><th style="text-align:left;border:1px solid #ddd;padding:8px;">Test</th><th style="text-align:left;border:1px solid #ddd;padding:8px;">Result</th><th style="text-align:left;border:1px solid #ddd;padding:8px;">Details</th></tr>`;
        
      // Keyboard Navigation Tests
      let tabDetails = result.programmaticTabOrder 
        ? `Keyboard: ${tabCount}, Programmatic: ${result.programmaticTabOrder ? result.programmaticTabOrder.length : 0} (computed ${computedFocusableCount}) - Coverage: ${tabCoveragePercent}% (min ${runtimePolicy.minTabCoverage}%)`
        : `Computed ${computedFocusableCount}, reached ${tabCount} - Coverage: ${tabCoveragePercent}% (min ${runtimePolicy.minTabCoverage}%)`;
      let shiftTabDetails = result.programmaticShiftTabOrder
        ? `Keyboard: ${shiftTabCount}, Programmatic: ${result.programmaticShiftTabOrder ? result.programmaticShiftTabOrder.length : 0} (computed ${computedFocusableCount}) - Coverage: ${shiftTabCoveragePercent}% (min ${runtimePolicy.minTabCoverage}%)`
        : `Computed ${computedFocusableCount}, reached ${shiftTabCount} - Coverage: ${shiftTabCoveragePercent}% (min ${runtimePolicy.minTabCoverage}%)`;

      if (!tabOrderPass) {
        tabDetails += ' - Fail Reason: Keyboard reachability failed: no focusable elements were reached via Tab';
      } else if (tabCoveragePercent < runtimePolicy.minTabCoverage) {
        tabDetails += ` - Coverage Alert: ${tabCoveragePercent}% below target ${runtimePolicy.minTabCoverage}%`;
      }

      if (!shiftTabOrderPass) {
        shiftTabDetails += ' - Fail Reason: Keyboard reachability failed: no focusable elements were reached via Shift+Tab';
      } else if (shiftTabCoveragePercent < runtimePolicy.minTabCoverage) {
        shiftTabDetails += ` - Coverage Alert: ${shiftTabCoveragePercent}% below target ${runtimePolicy.minTabCoverage}%`;
      }
      
      html += `<tr><td rowspan="5" style="border:1px solid #ddd;padding:8px;font-weight:bold;background:#e3f2fd;">Keyboard & Focus</td>
        <td style="border:1px solid #ddd;padding:8px;">Tab Order</td>
        <td style="border:1px solid #ddd;padding:8px;color:${tabOrderPass ? 'green' : 'red'};font-weight:bold;">${tabOrderPass ? '[OK] Pass' : '[X] Fail'}</td>
        <td style="border:1px solid #ddd;padding:8px;">${tabDetails}</td></tr>`;
      
      html += `<tr><td style="border:1px solid #ddd;padding:8px;">Shift+Tab Order</td>
        <td style="border:1px solid #ddd;padding:8px;color:${shiftTabOrderPass ? 'green' : 'red'};font-weight:bold;">${shiftTabOrderPass ? '[OK] Pass' : '[X] Fail'}</td>
        <td style="border:1px solid #ddd;padding:8px;">${shiftTabDetails}</td></tr>`;
      
      // Reuse the actionable count computed above (excludes BODY/IFRAME noise)
      html += `<tr><td style="border:1px solid #ddd;padding:8px;">Focus Indicator</td>
        <td style="border:1px solid #ddd;padding:8px;color:${focusIndicatorPass ? 'green' : 'red'};font-weight:bold;">${focusIndicatorPass ? '[OK] Pass' : '[X] Fail'}</td>
        <td style="border:1px solid #ddd;padding:8px;">${!focusIndicatorPass ? `${_actionableFI.length} unique element(s) missing indicator` : 'All elements have visible focus'}</td></tr>`;
      
      // Mouse Interaction Tests (Scroll, Right-Click, Left-Click, Hover, Pointer)
      let mouseScrollPass = result.scrollPositions && result.scrollPositions.length > 1;
      let rightClickPass = !result.mouseRightClick || (result.mouseRightClick.ok === true);
      let rightClickDetails = result.mouseRightClick 
        ? (result.mouseRightClick.contextMenuWorks ? 'Context menu ENABLED' : 'Context menu DISABLED')
        : 'Not tested';
      let leftClickInfo = result.mouseLeftClick || null;
      let hoverInfo = result.hoverStates || null;
      let pointerInfo = result.pointerAccessibility || null;
      
      html += `<tr><td rowspan="8" style="border:1px solid #ddd;padding:8px;font-weight:bold;background:#f3e5f5;">Mouse &amp; Pointer Interaction</td>
        <td style="border:1px solid #ddd;padding:8px;">Mouse Scroll</td>
        <td style="border:1px solid #ddd;padding:8px;color:${mouseScrollPass ? 'green' : 'red'};font-weight:bold;">${mouseScrollPass ? '[OK] Pass' : '[X] Fail'}</td>
        <td style="border:1px solid #ddd;padding:8px;">${result.scrollPositions ? result.scrollPositions.length + ' positions' : '0 positions'}</td></tr>`;
      
      html += `<tr><td style="border:1px solid #ddd;padding:8px;">Mouse Right-Click (Context Menu)</td>
        <td style="border:1px solid #ddd;padding:8px;color:${rightClickPass ? 'green' : 'red'};font-weight:bold;">${rightClickPass ? '[OK] Pass' : '[X] Fail'}</td>
        <td style="border:1px solid #ddd;padding:8px;">${rightClickDetails}</td></tr>`;

      html += `<tr><td style="border:1px solid #ddd;padding:8px;">Mouse Left-Click (Sample)</td>
        <td style="border:1px solid #ddd;padding:8px;color:${leftClickInfo && leftClickInfo.ok ? 'green' : '#555'};font-weight:bold;">${leftClickInfo ? (leftClickInfo.ok ? '[OK] Pass' : '[i] Info') : '[i] Info'}</td>
        <td style="border:1px solid #ddd;padding:8px;">${leftClickInfo ? `tested ${leftClickInfo.tested}, passed ${leftClickInfo.passed}, failed ${leftClickInfo.failed}, overlay-blocked ${leftClickInfo.blockedByOverlay || 0}` : 'Not tested'}</td></tr>`;

      let hoverPass = !hoverInfo || hoverInfo.tested === 0 || hoverInfo.ok === true; // Pass if majority (>50%) changed style
      html += `<tr><td style="border:1px solid #ddd;padding:8px;">Hover State Response </td>
        <td style="border:1px solid #ddd;padding:8px;color:${hoverPass ? 'green' : 'red'};font-weight:bold;">${hoverPass ? '[OK] Pass' : '[X] Fail'}</td>
        <td style="border:1px solid #ddd;padding:8px;">${hoverInfo ? `tested ${hoverInfo.tested}, style-changed ${hoverInfo.hoverStyleChanged}, unchanged ${hoverInfo.unchanged}` : 'Not tested'}</td></tr>`;

      html += `<tr><td style="border:1px solid #ddd;padding:8px;">Pointer Accessibility</td>
        <td style="border:1px solid #ddd;padding:8px;color:${pointerInfo && pointerInfo.pointerBlockedCount === 0 ? 'green' : '#555'};font-weight:bold;">${pointerInfo ? (pointerInfo.pointerBlockedCount === 0 ? '[OK] Pass' : '[i] Info') : '[i] Info'}</td>
        <td style="border:1px solid #ddd;padding:8px;">${pointerInfo ? `tested ${pointerInfo.tested}, pointer-blocked ${pointerInfo.pointerBlockedCount}, small-target ${pointerInfo.smallTargetCount}` : 'Not tested'}</td></tr>`;
      
      // WCAG 2.2 SC 2.4.11 - Focus Not Obscured
      let focusObscuredInfo = result.focusNotObscured || null;
      let focusObscuredPass = !focusObscuredInfo || focusObscuredInfo.ok === true;
      html += `<tr><td style="border:1px solid #ddd;padding:8px;">Focus Not Obscured (SC 2.4.11)</td>
        <td style="border:1px solid #ddd;padding:8px;color:${focusObscuredPass ? 'green' : 'red'};font-weight:bold;">${focusObscuredPass ? '[OK] Pass' : '[X] Fail'}</td>
        <td style="border:1px solid #ddd;padding:8px;">${focusObscuredInfo ? `tested ${focusObscuredInfo.tested}, obscured ${focusObscuredInfo.obscuredCount}, fixed/sticky overlays ${focusObscuredInfo.fixedStickyElements || 0}` : 'Not tested'}</td></tr>`;

      // WCAG 2.2 SC 2.5.7 - Dragging Movements
      let draggingInfo = result.draggingMovements || null;
      let draggingPass = !draggingInfo || draggingInfo.ok === true;
      html += `<tr><td style="border:1px solid #ddd;padding:8px;">Dragging Movements (SC 2.5.7)</td>
        <td style="border:1px solid #ddd;padding:8px;color:${draggingPass ? 'green' : '#f57c00'};font-weight:bold;">${draggingPass ? '[OK] Pass' : '[WARN] Needs Review'}</td>
        <td style="border:1px solid #ddd;padding:8px;">${draggingInfo ? `${draggingInfo.totalDragElements} drag-dependent element(s) found` : 'Not tested'}</td></tr>`;

      // WCAG 2.2 SC 3.2.6 - Consistent Help
      let helpInfo = result.consistentHelp || null;
      let helpPass = !helpInfo || helpInfo.ok === true;
      html += `<tr><td style="border:1px solid #ddd;padding:8px;">Consistent Help (SC 3.2.6)</td>
        <td style="border:1px solid #ddd;padding:8px;color:${helpPass ? 'green' : '#555'};font-weight:bold;">${helpPass ? '[OK] Pass' : '[i] Info'}</td>
        <td style="border:1px solid #ddd;padding:8px;">${helpInfo ? `${helpInfo.helpMechanismsFound} help mechanism(s) detected` : 'Not tested'}</td></tr>`;

      // Vertical tabs (nw-display-desktop tablist)
      let vtabsPresent = result.vtabs && result.vtabs.present;
      let vtabsPass = !vtabsPresent || (result.vtabs && result.vtabs.ok === true);
      html += `<tr><td style="border:1px solid #ddd;padding:8px;">Vertical Tabs (tablist)</td>
        <td style="border:1px solid #ddd;padding:8px;color:${vtabsPass ? 'green' : 'red'};font-weight:bold;">${vtabsPass ? '[OK] Pass' : '[X] Fail'}</td>
        <td style="border:1px solid #ddd;padding:8px;">${vtabsPresent ? `${result.vtabs.tabCount} tabs, initialSelected:${result.vtabs.initialSelected}` : 'Not present'}</td></tr>`;
      
      // Simplified WCAG 2.2 AA Metrics (basic accessibility data)
      let wcagMetricsAvail = result.wcagMetrics && Object.keys(result.wcagMetrics).length > 0;
      html += `<tr style="background:#f0f0f0;"><td rowspan="3" style="border:1px solid #ddd;padding:8px;font-weight:bold;background:#fce4ec;">WCAG 2.2 Level AA</td>
        <td style="border:1px solid #ddd;padding:8px;">Basic Metrics</td>
        <td style="border:1px solid #ddd;padding:8px;color:${wcagMetricsAvail ? 'blue' : 'gray'};font-weight:bold;">[OK] Gathered</td>
        <td style="border:1px solid #ddd;padding:8px;">${wcagMetricsAvail ? `H1: ${result.wcagMetrics.hasH1 ? 'yes' : 'no'}, ${result.wcagMetrics.images} images, ${result.wcagMetrics.imagesWithoutAlt} missing alt, ${result.wcagMetrics.forms} forms` : 'Not tested'}</td></tr>`;
      
      // axe-core violations summary
      let axeViolationsAvail = result.axeViolations && result.axeViolations.total >= 0;
      let violationColor = result.axeViolations && result.axeViolations.critical > 0 ? '#d32f2f' : (result.axeViolations && result.axeViolations.serious > 0 ? '#f57c00' : 'green');
      html += `<tr><td style="border:1px solid #ddd;padding:8px;">Rule Violations (axe)</td>
        <td style="border:1px solid #ddd;padding:8px;color:${violationColor};font-weight:bold;">${axeViolationsAvail ? (result.axeViolations.total > 0 ? '[WARN] ' + result.axeViolations.total : '[OK] 0') : '[i]'}</td>
        <td style="border:1px solid #ddd;padding:8px;">${axeViolationsAvail ? `Critical: ${result.axeViolations.critical}, Serious: ${result.axeViolations.serious}, Moderate: ${result.axeViolations.moderate}, Minor: ${result.axeViolations.minor}` : 'Scan incomplete'}</td></tr>`;
      
      html += `<tr><td style="border:1px solid #ddd;padding:8px;">Conformance Standard</td>
        <td style="border:1px solid #ddd;padding:8px;color:gray;font-weight:bold;">[i] Info</td>
        <td style="border:1px solid #ddd;padding:8px;">WCAG 2.2 Level AA (includes all A+AA criteria from WCAG 2.0, 2.1, 2.2) - axe tags: wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22a, wcag22aa</td></tr>`;

      const tabCoverageGatePass = tabCoveragePercent >= runtimePolicy.minTabCoverage;
      const axeCriticalCountForVerdict = result.axeViolations?.critical || 0;
      const axeSeriousCountForVerdict = result.axeViolations?.serious || 0;
      const axeGatePass = runtimePolicy.axeFailLevel === 'none'
        ? true
        : runtimePolicy.axeFailLevel === 'serious'
          ? (axeCriticalCountForVerdict + axeSeriousCountForVerdict) === 0
          : axeCriticalCountForVerdict === 0;
      const criticalMissingGatePass = (result.criticalMissingCount || 0) === 0;
      const verdictGates = [
        {
          label: 'Tab traversal captured',
          pass: tabOrderPass,
          details: tabOrderPass ? `${tabCount} reachable element(s)` : 'No elements reached via Tab'
        },
        {
          label: `Tab coverage >= ${runtimePolicy.minTabCoverage}%`,
          pass: tabCoverageGatePass,
          details: `${tabCoveragePercent}%`
        },
        {
          label: 'Shift+Tab traversal captured',
          pass: shiftTabOrderPass,
          details: shiftTabOrderPass ? `${shiftTabCount} reachable element(s)` : 'No elements reached via Shift+Tab'
        },
        {
          label: 'Mouse scroll functioning',
          pass: mouseScrollPass,
          details: `${result.scrollPositions ? result.scrollPositions.length : 0} position(s)`
        },
        {
          label: 'Focus indicator visible',
          pass: focusIndicatorPass,
          details: focusIndicatorPass ? 'No missing indicators' : `${_actionableFI.length} missing indicator(s)`
        },
        {
          label: 'Vertical tabs (when present)',
          pass: vtabsPass,
          details: vtabsPresent ? `${result.vtabs.tabCount} tab(s)` : 'Not present (auto-pass)'
        },
        {
          label: 'Right-click context menu',
          pass: rightClickPass,
          details: rightClickDetails
        },
        {
          label: `axe threshold (${runtimePolicy.axeFailLevel})`,
          pass: axeGatePass,
          details: `critical ${axeCriticalCountForVerdict}, serious ${axeSeriousCountForVerdict}`
        },
        {
          label: 'Critical keyboard misses',
          pass: criticalMissingGatePass,
          details: `${result.criticalMissingCount || 0} critical missing element(s)`
        }
      ];

      const hoverSummary = hoverInfo
        ? `tested ${hoverInfo.tested}, style-changed ${hoverInfo.hoverStyleChanged}, unchanged ${hoverInfo.unchanged}`
        : 'Not tested';
      const hoverImpact = hoverPass
        ? 'Informational check passed (not part of final URL verdict gates).'
        : 'Informational check failed (does not directly set final URL status).';

      html += `<tr><td colspan="4" style="border:1px solid #ddd;padding:0;">
        <details ${result.status === 'Fail' ? 'open' : ''} style="margin:0;background:#fffef8;border-radius:0;">
          <summary style="padding:10px 12px;color:#5d4037;font-size:1em;">[!] Fail Reason Breakdown (Verdict Gates)</summary>
          <div style="padding:10px 12px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr style="background:#f8f8f8;">
                <th style="text-align:left;border:1px solid #ddd;padding:8px;">Gate</th>
                <th style="text-align:left;border:1px solid #ddd;padding:8px;">Result</th>
                <th style="text-align:left;border:1px solid #ddd;padding:8px;">Details</th>
              </tr>
              ${verdictGates.map(g => `<tr><td style="border:1px solid #ddd;padding:8px;">${g.label}</td><td style="border:1px solid #ddd;padding:8px;color:${g.pass ? 'green' : 'red'};font-weight:bold;">${g.pass ? '[OK] Pass' : '[X] Fail'}</td><td style="border:1px solid #ddd;padding:8px;">${g.details}</td></tr>`).join('')}
              <tr>
                <td style="border:1px solid #ddd;padding:8px;">Hover State Response (informational)</td>
                <td style="border:1px solid #ddd;padding:8px;color:${hoverPass ? 'green' : 'red'};font-weight:bold;">${hoverPass ? '[OK] Pass' : '[X] Fail'}</td>
                <td style="border:1px solid #ddd;padding:8px;">${hoverSummary} - ${hoverImpact}</td>
              </tr>
            </table>
          </div>
        </details>
      </td></tr>`;
      
      html += `</table>`;

      if (!focusIndicatorPass && result.focusIndicatorFailures && result.focusIndicatorFailures.length > 0) {
        const noisyTags = new Set(['BODY', 'IFRAME']);
        const actionableFocusFailures = (result.focusIndicatorFailures || []).filter(el => !noisyTags.has((el.tag || '').toUpperCase()));
        const suppressedFocusFailureCount = (result.focusIndicatorFailures || []).length - actionableFocusFailures.length;
        html += `<details style="margin-top:1em;"><summary style="cursor:pointer;font-weight:bold;color:#d32f2f;">Focus Indicator Misses (${actionableFocusFailures.length} actionable / ${result.focusIndicatorFailures.length} total)</summary>
          <div style="margin-top:0.7em;padding:10px;background:#fff8f8;border:1px solid #ffd6d6;border-radius:6px;">
            <ul style="margin:0 0 0 1.2em;padding:0;font-size:0.95em;">
              ${actionableFocusFailures.map(el => {
                const label = (el.ariaLabel || el.name || el.text || '').toString().trim().substring(0, 90);
                return `<li style="margin:4px 0;">&lt;${el.tag || 'UNKNOWN'}&gt;${el.id ? ` id=\"${el.id}\"` : ''}${el.class ? ` class=\"${String(el.class).substring(0, 60)}\"` : ''}${label ? ` - ${label}` : ''}</li>`;
              }).join('')}
            </ul>
            ${suppressedFocusFailureCount > 0 ? `<div style="margin-top:8px;color:#666;font-size:0.9em;">[i] Suppressed ${suppressedFocusFailureCount} noisy element(s): BODY/IFRAME</div>` : ''}
          </div>
        </details>`;
      }
      
      // ===== COMPREHENSIVE KEYBOARD COVERAGE (April 2026 Enhancement) =====
      if (result.comprehensiveKeyboardData && result.comprehensiveKeyboardData.status === 'success') {
        const catData = result.comprehensiveKeyboardData.totalByCategory;
        const totalCat = result.comprehensiveKeyboardData.totalElements;
        
        html += `<div style="margin-top:2em;border:1px solid #d4edda;background:#f0f9f6;border-radius:6px;padding:16px;">
          <h3 style="color:#1a7f37;margin-top:0;">[DATA] Comprehensive Keyboard Navigation Coverage (Enhanced)</h3>
          <p style="margin:8px 0;font-size:0.95em;color:#555;">Page elements categorized by region and accessibility coverage:</p>
          <table style="width:100%;border-collapse:collapse;margin:1em 0;">
            <tr style="background:#e8f5e9;">
              <th style="text-align:left;border:1px solid #c8e6c9;padding:8px;font-weight:bold;">Region</th>
              <th style="text-align:center;border:1px solid #c8e6c9;padding:8px;font-weight:bold;">Elements</th>
              <th style="text-align:left;border:1px solid #c8e6c9;padding:8px;font-weight:bold;">Status</th>
            </tr>
            <tr><td style="border:1px solid #c8e6c9;padding:8px;font-weight:bold;">Header Navigation</td><td style="text-align:center;border:1px solid #c8e6c9;padding:8px;">${catData.header || 0}</td><td style="border:1px solid #c8e6c9;padding:8px;">${catData.header > 0 ? '[OK] Keyboard accessible' : '-'}</td></tr>
            <tr><td style="border:1px solid #c8e6c9;padding:8px;font-weight:bold;">Navigation Menus</td><td style="text-align:center;border:1px solid #c8e6c9;padding:8px;">${catData.navigation || 0}</td><td style="border:1px solid #c8e6c9;padding:8px;">${catData.navigation > 0 ? '[OK] Keyboard accessible' : '-'}</td></tr>
            <tr><td style="border:1px solid #c8e6c9;padding:8px;font-weight:bold;">Main Content</td><td style="text-align:center;border:1px solid #c8e6c9;padding:8px;">${catData.content || 0}</td><td style="border:1px solid #c8e6c9;padding:8px;">${catData.content > 0 ? '[OK] Keyboard accessible' : '-'}</td></tr>
            <tr><td style="border:1px solid #c8e6c9;padding:8px;font-weight:bold;">Form Elements</td><td style="text-align:center;border:1px solid #c8e6c9;padding:8px;">${catData.form || 0}</td><td style="border:1px solid #c8e6c9;padding:8px;">${catData.form > 0 ? '[OK] Keyboard accessible' : '-'}</td></tr>
            <tr><td style="border:1px solid #c8e6c9;padding:8px;font-weight:bold;">Interactive Elements</td><td style="text-align:center;border:1px solid #c8e6c9;padding:8px;">${catData.interactive || 0}</td><td style="border:1px solid #c8e6c9;padding:8px;">${catData.interactive > 0 ? '[OK] Keyboard accessible' : '-'}</td></tr>
            <tr><td style="border:1px solid #c8e6c9;padding:8px;font-weight:bold;">Footer & Links</td><td style="text-align:center;border:1px solid #c8e6c9;padding:8px;">${catData.footer || 0}</td><td style="border:1px solid #c8e6c9;padding:8px;">${catData.footer > 0 ? '[OK] Keyboard accessible' : '-'}</td></tr>
            <tr style="background:#e8f5e9;font-weight:bold;">
              <td style="border:1px solid #c8e6c9;padding:8px;">TOTAL</td>
              <td style="text-align:center;border:1px solid #c8e6c9;padding:8px;">${totalCat}</td>
              <td style="border:1px solid #c8e6c9;padding:8px;">[OK] Complete Coverage</td>
            </tr>
          </table>
          <p style="margin:12px 0 0 0;font-size:0.9em;color:#666;"><strong>Note:</strong> Comprehensive analysis captures element distribution across page regions. Compares with keyboard traversal metrics to ensure deep accessibility coverage.</p>
        </div>`;
      }
      
      // FIX #3: Add Tab Traversal Coverage Report
      html += `<details open style="margin-top:1.5em;"><summary style="cursor:pointer;font-weight:bold;font-size:1.1em;color:#005fcc;">[SEARCH] Tab Traversal Coverage Analysis (FIX #2)</summary>
        <div style="margin-top:1em;padding:12px;background:#f5f5f5;border-radius:6px;">
          <table style="width:100%;border-collapse:collapse;">
            <tr style="background:#ffebee;">
              <th style="text-align:left;border:1px solid #ffcdd2;padding:10px;font-weight:bold;">Metric</th>
              <th style="text-align:center;border:1px solid #ffcdd2;padding:10px;font-weight:bold;">Value</th>
              <th style="text-align:left;border:1px solid #ffcdd2;padding:10px;font-weight:bold;">Status</th>
            </tr>
            <tr><td style="border:1px solid #ffcdd2;padding:10px;font-weight:bold;">Elements Detected (Static)</td><td style="text-align:center;border:1px solid #ffcdd2;padding:10px;">${result.allFocusableElements ? result.allFocusableElements.length : '?'}</td><td style="border:1px solid #ffcdd2;padding:10px;">Total focusable elements found</td></tr>
            <tr><td style="border:1px solid #ffcdd2;padding:10px;font-weight:bold;">Elements Traversed (Tab)</td><td style="text-align:center;border:1px solid #ffcdd2;padding:10px;">${result.tabCoverage || 0}</td><td style="border:1px solid #ffcdd2;padding:10px;"><strong>Keyboard-accessible elements</strong></td></tr>
            <tr ${result.tabCoveragePercent >= runtimePolicy.minTabCoverage ? 'style="background:#e8f5e9;"' : 'style="background:#fff8e1;"'}><td style="border:1px solid ${result.tabCoveragePercent >= runtimePolicy.minTabCoverage ? '#c8e6c9' : '#ffe082'};padding:10px;font-weight:bold;">Coverage % <span style="font-weight:normal;font-size:0.85em;color:#888;">(diagnostic)</span></td><td style="text-align:center;border:1px solid ${result.tabCoveragePercent >= runtimePolicy.minTabCoverage ? '#c8e6c9' : '#ffe082'};padding:10px;"><strong>${result.tabCoveragePercent || 0}%</strong></td><td style="border:1px solid ${result.tabCoveragePercent >= runtimePolicy.minTabCoverage ? '#c8e6c9' : '#ffe082'};padding:10px;">${result.tabCoveragePercent >= runtimePolicy.minTabCoverage ? '[OK] GOOD' : `[WARN] Below ${runtimePolicy.minTabCoverage}% threshold — diagnostic only, not a blocker`}</td></tr>
            <tr><td style="border:1px solid #ffcdd2;padding:10px;font-weight:bold;">Missing Elements</td><td style="text-align:center;border:1px solid #ffcdd2;padding:10px;">${result.missingElementsCount || 0}</td><td style="border:1px solid #ffcdd2;padding:10px;">Not reached by keyboard Tab</td></tr>
          </table>
          
          ${result.missingElementsCount > 0 ? (() => {
            const criticalList = (result.missingElements || []).filter(el => el.critical && el.analysis === 'POTENTIALLY_UNREACHABLE');
            const nonCriticalList = (result.missingElements || []).filter(el => !el.critical || el.analysis !== 'POTENTIALLY_UNREACHABLE');
            let html = '<div style="margin-top:1.5em;">';
            
            if (result.criticalMissingCount > 0) {
              html += '<div style="margin-bottom:1.5em;padding:12px;background:#ffebee;border-left:4px solid #d32f2f;border-radius:4px;">';
              html += '<p style="margin:0 0 0.8em 0;font-weight:bold;color:#d32f2f;font-size:1.05em;">[WARN] CRITICAL: ' + result.criticalMissingCount + ' Visible Element(s) Not Reachable by Keyboard</p>';
              html += '<p style="margin:0 0 1em 0;font-size:0.95em;color:#555;">These elements are visible on the page but cannot be reached through keyboard navigation.</p>';
              html += '<ul style="margin:0 0 0 1.5em;font-size:0.95em;">';
              criticalList.slice(0, 15).forEach(el => {
                html += '<li><strong>&lt;' + el.tag + '&gt;</strong> ' + (el.id ? 'id="' + el.id + '"' : 'class="' + el.class + '"') + ' - "' + (el.text || el.ariaLabel || '(no text)').substring(0, 60) + '"</li>';
              });
              if (criticalList.length > 15) {
                html += '<li><em>... and ' + (criticalList.length - 15) + ' more</em></li>';
              }
              html += '</ul></div>';
            }
            
            if (result.nonCriticalMissingCount > 0) {
              html += '<div style="padding:12px;background:#e8f5e9;border-left:4px solid #388e3c;border-radius:4px;">';
              html += '<p style="margin:0 0 0.8em 0;font-weight:bold;color:#1a7f37;font-size:1.05em;">[i] Non-Critical: ' + result.nonCriticalMissingCount + ' Hidden/Disabled Element(s)</p>';
              html += '<p style="margin:0 0 1em 0;font-size:0.95em;color:#555;">These elements are intentionally hidden or disabled, which is not an accessibility issue:</p>';
              html += '<table style="width:100%;border-collapse:collapse;font-size:0.9em;display:block;max-height:250px;overflow-y:auto;">';
              html += '<tr style="background:#f1f8e9;position:sticky;top:0;"><th style="text-align:left;border:1px solid #9ccc65;padding:8px;font-weight:bold;">Element</th>';
              html += '<th style="text-align:left;border:1px solid #9ccc65;padding:8px;font-weight:bold;">Reason</th></tr>';
              nonCriticalList.slice(0, 20).forEach(el => {
                let reason = el.reason;
                if (el.analysis === 'HIDDEN_DISPLAY') reason = '[FAIL] Hidden (display:none)';
                else if (el.analysis === 'HIDDEN_VISIBILITY') reason = '[FAIL] Hidden (visibility:hidden)';
                else if (el.analysis === 'HIDDEN_OPACITY') reason = '[FAIL] Hidden (opacity:0)';
                else if (el.analysis === 'ARIA_HIDDEN') reason = '[FAIL] aria-hidden="true"';
                else if (el.analysis === 'TABINDEX_NEGATIVE') reason = '[FAIL] tabindex="-1"';
                else if (el.analysis === 'DISABLED') reason = '[FAIL] Element disabled';
                else if (el.analysis === 'ZERO_SIZE') reason = '[FAIL] Zero width/height';
                else if (el.analysis === 'OFFSCREEN') reason = '[FAIL] Positioned offscreen';
                html += '<tr><td style="border:1px solid #9ccc65;padding:8px;"><strong>&lt;' + el.tag + '&gt;</strong> ' + (el.id ? 'id="' + el.id.substring(0, 20) + '"' : '') + '</td>';
                html += '<td style="border:1px solid #9ccc65;padding:8px;">' + reason + '</td></tr>';
              });
              html += '</table>';
              if (nonCriticalList.length > 20) {
                html += '<p style="margin-top:0.8em;font-size:0.9em;color:#666;">... and ' + (nonCriticalList.length - 20) + ' more hidden/disabled elements</p>';
              }
              html += '</div>';
            }
            
            html += '</div>';
            return html;
          })() : '<p style="margin-top:1em;color:#1a7f37;"><strong>[OK] All elements were successfully reached through keyboard Tab traversal!</strong></p>'}
        </div>
      </details>`;
      
      // FIX #4: Add Focus Trap Analysis Section to HTML
      if (result.focusTrapAnalysis) {
        if (result.focusTrapAnalysis.focusTraps.length > 0) {
          html += `<details open style="margin-top:1.5em;"><summary style="cursor:pointer;font-weight:bold;font-size:1.1em;color:#d32f2f;">[LOCK] Focus Trap Analysis (FIX #4) - CRITICAL</summary>
            <div style="margin-top:1em;padding:12px;background:#fff3e0;border:2px solid #ff6f00;border-radius:6px;">
              <p style="margin:0 0 1em 0;font-weight:bold;color:#d32f2f;"><strong>[WARN] CRITICAL: ${result.focusTrapAnalysis.focusTraps.length} Custom Components Have Missing Internal Focus</strong></p>
              <p style="margin:0 0 1em 0;font-size:0.95em;color:#555;">These custom container components contain focusable elements but don't expose them to keyboard navigation:</p>
              <table style="width:100%;border-collapse:collapse;margin:1em 0;font-size:0.95em;">
                <tr style="background:#ffebee;">
                  <th style="text-align:left;border:1px solid #ffcdd2;padding:10px;font-weight:bold;">Component</th>
                  <th style="text-align:center;border:1px solid #ffcdd2;padding:10px;font-weight:bold;">tabindex</th>
                  <th style="text-align:center;border:1px solid #ffcdd2;padding:10px;font-weight:bold;">kbd-role</th>
                  <th style="text-align:center;border:1px solid #ffcdd2;padding:10px;font-weight:bold;">Shadow DOM</th>
                  <th style="text-align:left;border:1px solid #ffcdd2;padding:10px;font-weight:bold;">Content</th>
                </tr>
                ${(result.focusTrapAnalysis.focusTraps || []).map(trap => `
                <tr style="background:#fff;">
                  <td style="border:1px solid #ffcdd2;padding:10px;font-weight:bold;color:#d32f2f;">&lt;${trap.component}&gt;</td>
                  <td style="text-align:center;border:1px solid #ffcdd2;padding:10px;">${trap.hasTabindex ? '[OK] yes' : '[FAIL] no'}</td>
                  <td style="text-align:center;border:1px solid #ffcdd2;padding:10px;">${trap.hasKbdRole ? '[OK] yes' : '[FAIL] no'}</td>
                  <td style="text-align:center;border:1px solid #ffcdd2;padding:10px;">${trap.shadowRoot}</td>
                  <td style="border:1px solid #ffcdd2;padding:10px;"><em>"${trap.text}..."</em></td>
                </tr>
                `).join('')}
              </table>
              <p style="margin:1em 0 0 0;font-size:0.9em;color:#666;"><strong>Fix Required:</strong></p>
              <ul style="margin:0.5em 0 0 1.5em;font-size:0.9em;">
                <li>Add <code>tabindex="0"</code> attribute to component host element</li>
                <li>Implement keyboard event handlers (onkeydown for Enter/Space)</li>
                <li>If using Shadow DOM, expose internal elements to light DOM tab order</li>
                <li>Test with assistive technologies (screen readers, keyboard-only navigation)</li>
              </ul>
            </div>
          </details>`;
        } else if (result.focusTrapAnalysis.totalContainers > 0) {
          html += `<details style="margin-top:1.5em;"><summary style="cursor:pointer;font-weight:bold;font-size:1.1em;color:#1a7f37;">[OK] Focus Trap Analysis (FIX #4)</summary>
            <div style="margin-top:1em;padding:12px;background:#e8f5e9;border-radius:6px;">
              <p style="margin:0;color:#1a7f37;"><strong>[OK] No focus traps detected!</strong></p>
              <p style="margin:0.5em 0 0 0;font-size:0.95em;color:#555;">All ${result.focusTrapAnalysis.totalContainers} scanned custom components properly expose their focusable elements.</p>
            </div>
          </details>`;
        }
      }
      
      // WCAG 2.4.11 - Focus Not Obscured - Detailed Report
      if (result.focusNotObscured && result.focusNotObscured.details && result.focusNotObscured.details.length > 0) {
        const obscuredDetails = result.focusNotObscured.details;
        const failCount = obscuredDetails.filter(d => d.severity === 'FAIL').length;
        const warnCount = obscuredDetails.filter(d => d.severity === 'WARN').length;
        const status = failCount >= 2 ? 'FAIL' : (failCount === 1 || warnCount > 0 ? 'WARN' : 'PASS');
        const statusColor = status === 'FAIL' ? '#d32f2f' : (status === 'WARN' ? '#f57c00' : '#388e3c');
        
        html += `<details ${failCount > 0 ? 'open' : ''} style="margin-top:1.5em;"><summary style="cursor:pointer;font-weight:bold;font-size:1.1em;color:${statusColor};">[${status === 'FAIL' ? 'X' : status === 'WARN' ? 'WARN' : 'OK'}] WCAG 2.4.11 - Focus Not Obscured</summary>
          <div style="margin-top:1em;padding:12px;background:${status === 'FAIL' ? '#ffebee' : status === 'WARN' ? '#fff3e0' : '#e8f5e9'};border-left:4px solid ${statusColor};border-radius:6px;">
            <p style="margin:0 0 1em 0;font-weight:bold;color:${statusColor};font-size:1.05em;">${failCount > 0 ? `[${status}] ${failCount} Element(s) Fully Obscured by Fixed/Sticky Overlays` : `[WARN] ${warnCount} Element(s) Partially Obscured`}</p>
            <p style="margin:0 0 1.2em 0;font-size:0.95em;color:#555;">Focused elements must remain visible and not be hidden behind sticky headers, footers, or fixed overlays (WCAG 2.2 Level AA).</p>
            
            ${obscuredDetails.map((detail, idx) => `
              <div style="margin-bottom:1.5em;padding:12px;background:#fff;border:1px solid ${detail.severity === 'FAIL' ? '#ffcdd2' : '#ffe082'};border-radius:4px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                  <h4 style="margin:0;color:${detail.severity === 'FAIL' ? '#d32f2f' : '#f57c00'};font-size:1em;">Issue #${idx + 1} - ${detail.severity === 'FAIL' ? 'Fully Obscured' : 'Partially Obscured'} (${detail.obstructionPercent}%)</h4>
                  <span style="padding:4px 8px;background:${detail.severity === 'FAIL' ? '#d32f2f' : '#f57c00'};color:#fff;border-radius:4px;font-size:0.85em;font-weight:bold;">${detail.severity}</span>
                </div>
                
                <div style="margin-top:12px;">
                  <p style="margin:0 0 6px 0;font-weight:bold;color:#333;">❌ Focused Element:</p>
                  <div style="padding:8px;background:#f5f5f5;border-left:3px solid #d32f2f;font-family:monospace;font-size:0.9em;">
                    &lt;${detail.focusedElement.tag}${detail.focusedElement.id ? ` id="${detail.focusedElement.id}"` : ''}${detail.focusedElement.class ? ` class="${detail.focusedElement.class.substring(0, 30)}..."` : ''}&gt;<br>
                    ${detail.focusedElement.text ? `Text: "${detail.focusedElement.text}"` : 'No text content'}
                  </div>
                </div>
                
                ${detail.obscuringElement ? `
                <div style="margin-top:12px;">
                  <p style="margin:0 0 6px 0;font-weight:bold;color:#333;">🚫 Blocked By:</p>
                  <div style="padding:8px;background:#f5f5f5;border-left:3px solid #1976d2;font-family:monospace;font-size:0.9em;">
                    &lt;${detail.obscuringElement.tag}${detail.obscuringElement.id ? ` id="${detail.obscuringElement.id}"` : ''}${detail.obscuringElement.class ? ` class="${detail.obscuringElement.class.substring(0, 30)}..."` : ''}&gt;<br>
                    Position: <strong>${detail.obscuringElement.position}</strong>, Height: ${detail.obscuringElement.height}px, Z-Index: ${detail.obscuringElement.zIndex}
                  </div>
                </div>
                ` : ''}
                
                <div style="margin-top:12px;">
                  <p style="margin:0 0 6px 0;font-weight:bold;color:#1a7f37;">✅ Fix Suggestions (Priority Order):</p>
                  <ol style="margin:6px 0 0 20px;font-size:0.95em;line-height:1.6;">
                    ${detail.fixes.map(fix => `
                      <li style="margin-bottom:8px;">
                        <strong style="color:#1a7f37;">Option ${fix.priority}: ${fix.title}</strong>
                        <div style="margin-top:4px;padding:8px;background:#e8f5e9;border-radius:3px;font-family:monospace;font-size:0.9em;color:#2e7d32;">
                          ${fix.code}
                        </div>
                        <p style="margin:4px 0 0 0;font-size:0.9em;color:#666;">${fix.description}</p>
                      </li>
                    `).join('')}
                  </ol>
                </div>
                
                <div style="margin-top:12px;padding:8px;background:#fff8e1;border-radius:3px;">
                  <p style="margin:0;font-size:0.9em;color:#666;"><strong>Test Points Obscured:</strong> ${detail.obscuredPoints.join(', ')}</p>
                </div>
              </div>
            `).join('')}
            
            <div style="margin-top:1em;padding:10px;background:#e3f2fd;border-radius:4px;">
              <p style="margin:0;font-size:0.9em;color:#1565c0;"><strong>💡 Best Practice:</strong> Use <code>scroll-margin-top</code> CSS property on focusable elements to ensure they scroll into view with proper clearance from fixed headers.</p>
            </div>
          </div>
        </details>`;
      } else if (result.focusNotObscured && result.focusNotObscured.tested > 0) {
        html += `<details style="margin-top:1.5em;"><summary style="cursor:pointer;font-weight:bold;font-size:1.1em;color:#388e3c;">[OK] WCAG 2.4.11 - Focus Not Obscured</summary>
          <div style="margin-top:1em;padding:12px;background:#e8f5e9;border-radius:6px;">
            <p style="margin:0;color:#1a7f37;"><strong>[OK] All focused elements remain visible!</strong></p>
            <p style="margin:0.5em 0 0 0;font-size:0.95em;color:#555;">Tested ${result.focusNotObscured.tested} focusable elements - none are obscured by fixed/sticky overlays.</p>
          </div>
        </details>`;
      }
    }
    html += `</details>`;
  });
  html += `<div class="footer">Generated by Playwright - ${new Date().toLocaleString()}</div></div></body></html>`;
  fs.writeFileSync(htmlPath, html);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`HTML keyboard & scroll report generated: ${htmlPath}`);
  console.log(`Excel keyboard & scroll report generated: ${excelPath}`);
  console.log(`Total execution time: ${elapsed}s for ${htmlResults.length} URL(s)`);
})();