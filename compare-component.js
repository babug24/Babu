const { chromium } = require('playwright');
const fs = require('fs-extra');
const path = require('path');
const inquirer = require('inquirer');
const chalk = require('chalk');

// ── Load global config ────────────────────────────────────────────────────────
const CONFIG = require('./compare.config.js');

// ── Viewport preset (desktop) ────────────────────────────────────────────────
const DESKTOP_VIEWPORT = {
  width:     CONFIG.viewportWidth  || 1920,
  height:    CONFIG.viewportHeight || 1080,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  label:     'desktop'
};

// Default: use config values and skip all prompts.
// Pass --prompt to force interactive mode and override config values.
const USE_CONFIG = !process.argv.includes('--prompt');

if (USE_CONFIG) {
  console.log(chalk.cyan('\n⚙️  Config mode – running with values from compare.config.js (pass --prompt to override)'));
  console.log(chalk.cyan(`   DXA URL    : ${CONFIG.dxaUrl}`));
  console.log(chalk.cyan(`   Angular URL: ${CONFIG.angularUrl}`));
  console.log(chalk.cyan(`   Selector   : ${CONFIG.selector}`));
  console.log(chalk.cyan(`   Mode       : ${CONFIG.comparisonMode}`));
  console.log(chalk.cyan(`   Tolerance  : ${CONFIG.tolerance}%\n`));
} else {
  console.log(chalk.cyan('\n✏️  Prompt mode – enter values below (config defaults pre-filled)\n'));
}

// Create screenshots directory
const screenshotsDir = path.join(__dirname, 'screenshots');
fs.ensureDirSync(screenshotsDir);

// Create reports directory
const reportsDir = path.join(__dirname, 'reports');
fs.ensureDirSync(reportsDir);

// Color coding for report
const colors = {
  passed: '#4CAF50',
  failed: '#f44336',
  warning: '#ff9800',
  info: '#2196F3'
};

async function getUserInput() {
  // Config mode (default): skip prompts entirely, return config values directly
  if (USE_CONFIG) {
    // Resolve split selectors: if selectorDxa+selectorAngular are set, use them;
    // otherwise fall back to the shared selector for both pages.
    const selectorDxa     = CONFIG.selectorDxa     || CONFIG.selector;
    const selectorAngular = CONFIG.selectorAngular || CONFIG.selector;
    return {
      dxaUrl:          CONFIG.dxaUrl,
      angularUrl:      CONFIG.angularUrl,
      selector:        CONFIG.selector,
      selectorDxa,
      selectorAngular,
      preActionDxa:         CONFIG.preActionDxa         || null,
      preActionAngular:     CONFIG.preActionAngular     || null,
      preActionTextDxa:     CONFIG.preActionTextDxa     || null,
      preActionTextAngular: CONFIG.preActionTextAngular || null,
      comparisonMode:  CONFIG.comparisonMode,
      comparisonSpeed: CONFIG.comparisonSpeed || 'critical',
      tolerance:       CONFIG.tolerance
    };
  }

  // Prompt mode (--prompt flag): interactive, config values pre-filled as defaults
  const questions = [
    {
      type: 'input',
      name: 'dxaUrl',
      message: 'Enter DXA UAT URL (Baseline):',
      default: CONFIG.dxaUrl
    },
    {
      type: 'input',
      name: 'angularUrl',
      message: 'Enter Angular URL (New Version):',
      default: CONFIG.angularUrl
    },
    {
      type: 'input',
      name: 'selectorDxa',
      message: 'Enter DXA CSS Selector (leave blank to use shared selector):',
      default: CONFIG.selectorDxa || CONFIG.selector,
      validate: function(input) {
        if (input.trim() === '') return 'Selector cannot be empty';
        return true;
      }
    },
    {
      type: 'input',
      name: 'selectorAngular',
      message: 'Enter Angular CSS Selector (leave blank to use same as DXA):',
      default: CONFIG.selectorAngular || CONFIG.selectorDxa || CONFIG.selector
    },
    {
      type: 'list',
      name: 'comparisonMode',
      message: 'Select comparison mode:',
      choices: ['Standard CSS Properties', 'Pixel Perfect', 'Both'],
      default: CONFIG.comparisonMode
    },
    {
      type: 'list',
      name: 'comparisonSpeed',
      message: 'Select comparison speed (for components with many elements):',
      choices: [
        { name: 'Critical Properties Only (70% faster) - for large components', value: 'critical' },
        { name: 'Standard (all properties) - default', value: 'standard' },
        { name: 'Pixel Perfect (visual only, fastest) - screenshots only', value: 'pixel-perfect' }
      ],
      default: CONFIG.comparisonSpeed || 'critical'
    },
    {
      type: 'number',
      name: 'tolerance',
      message: 'Set tolerance % for numeric comparisons:',
      default: CONFIG.tolerance,
      validate: function(input) {
        if (input >= 0 && input <= 100) return true;
        return 'Please enter a number between 0 and 100';
      }
    }
  ];

  const answers = await inquirer.prompt(questions);
  // if Angular selector left blank or same, copy DXA selector
  if (!answers.selectorAngular || answers.selectorAngular.trim() === '') {
    answers.selectorAngular = answers.selectorDxa;
  }
  answers.selector = answers.selectorDxa; // kept for report label
  return answers;
}

// Key CSS properties to compare
const cssProperties = {
  layout: [
    'width', 'height', 'display', 'position',
    'top', 'right', 'bottom', 'left',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left'
  ],
  typography: [
    'font-family', 'font-size', 'font-weight', 'font-style',
    'line-height', 'letter-spacing', 'color', 'text-align',
    'text-transform', 'text-decoration'
  ],
  background: [
    'background-color', 'background-image', 'opacity'
  ],
  border: [
    'border-radius', 'border-width', 'border-style', 'border-color',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'
  ],
  flexGrid: [
    'flex', 'flex-grow', 'flex-shrink', 'flex-basis',
    'justify-content', 'align-items', 'gap'
  ],
  other: [
    'box-sizing', 'cursor', 'overflow', 'visibility',
    'transform', 'transition', 'box-shadow'
  ]
};

// Flatten all properties
const allProperties = Object.values(cssProperties).flat();

// Critical properties for fast comparisons (70% faster) - only essential visual properties
const criticalProperties = [
  // Layout (must match)
  'width', 'height', 'display', 'position',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  // Typography (must match)
  'font-size', 'font-weight', 'color', 'line-height',
  // Visual (must match)
  'background-color', 'border-radius', 'opacity'
];

// Get properties list based on speed mode
function getPropertiesToCompare(speedMode = 'standard') {
  switch(speedMode?.toLowerCase()) {
    case 'critical':
      return criticalProperties;
    case 'pixel-perfect':
      // Pixel perfect uses screenshots only, no property comparison needed
      return [];
    default: // 'standard'
      return allProperties;
  }
}

// ---------------------------------------------------------------------------
// Cookie / Consent Banner Handler (TrustArc)
// ---------------------------------------------------------------------------
async function handleCookieBanner(page, pageLabel = 'page') {
  // TrustArc banner selectors (iframe-based and direct DOM)
  const bannerSelectors = [
    '#truste-consent-button',
    '#truste-consent-track',
    'a#truste-consent-button',
    '.truste_overlay .pdynamicbutton a.call',
    '#trustarc-consent-buttons .btn-accept',
    'button[aria-label="Accept All Cookies"]',
    'button[title="Accept All Cookies"]',
    '[id*="truste"] [class*="accept"]',
    '[id*="onetrust-accept-btn-handler"]'
  ];

  try {
    // Check for TrustArc iframe first
    const frames = page.frames();
    let acceptButton = null;

    for (const frame of frames) {
      for (const sel of bannerSelectors) {
        try {
          const el = await frame.$(sel);
          if (el) {
            acceptButton = { element: el, frame };
            break;
          }
        } catch (_) { /* ignore per-frame errors */ }
      }
      if (acceptButton) break;
    }

    // Fallback: check main document
    if (!acceptButton) {
      for (const sel of bannerSelectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            acceptButton = { element: el, frame: page };
            break;
          }
        } catch (_) { /* ignore */ }
      }
    }

    if (acceptButton) {
      console.log(chalk.yellow(`  [Cookie Handler] TrustArc Banner is displayed - accepting cookies`));
      await acceptButton.element.click();

      // Wait for the banner / overlay to disappear
      try {
        await page.waitForFunction(() => {
          const overlay = document.querySelector('#truste-consent-track, .truste_overlay, #trustarc-consent-buttons');
          return !overlay || overlay.offsetParent === null || getComputedStyle(overlay).display === 'none';
        }, { timeout: 10000 });
      } catch (_) {
        // Banner may have been removed from DOM entirely — that's fine
      }

      console.log(chalk.green(`  [Cookie Handler] Cookie banner accepted successfully`));

      // ── Post-dismissal: wait for page to be fully loaded ──────────────────
      console.log(chalk.blue(`  [Cookie Handler] Banner successfully dismissed, additionally start validation page completely load and all elements loaded`));

      // 1. Wait for DOM content + network to settle
      await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});

      // 2. Wait until document.readyState === 'complete'
      await page.waitForFunction(() => document.readyState === 'complete', { timeout: 30000 }).catch(() => {});

      // 3. Wait for all images to finish loading
      await page.waitForFunction(() => {
        const imgs = Array.from(document.querySelectorAll('img'));
        return imgs.every(img => img.complete);
      }, { timeout: 15000 }).catch(() => {});

      // 4. Wait for no pending fetch/XHR (best-effort via performance entries)
      await page.waitForFunction(() => {
        if (typeof window.performance === 'undefined') return true;
        const pending = window.performance.getEntriesByType('resource')
          .filter(r => r.duration === 0 && r.initiatorType !== 'beacon');
        return pending.length === 0;
      }, { timeout: 10000 }).catch(() => {});

      // 5. Small stabilisation pause
      await page.waitForTimeout(1000);

      console.log(chalk.green(`  [Cookie Handler] âœ“ ${pageLabel} fully loaded and all elements ready`));

    } else {
      console.log(chalk.gray(`  [Cookie Handler] No cookie banner detected on ${pageLabel}`));

      // Still ensure the page is fully settled even without a banner
      await page.waitForFunction(() => document.readyState === 'complete', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
  } catch (err) {
    console.log(chalk.red(`  [Cookie Handler] Warning: cookie handler encountered an error on ${pageLabel}: ${err.message}`));
  }
}

// Function to normalize CSS values for comparison
function normalizeValue(value, property) {
  if (!value) return '';
  
  // Remove px, em, rem units for numeric comparison
  if (property.includes('width') || property.includes('height') || 
      property.includes('margin') || property.includes('padding') ||
      property.includes('font-size') || property.includes('line-height')) {
    const numericMatch = value.match(/^([\d.]+)(px|em|rem|%)?$/);
    if (numericMatch) {
      return parseFloat(numericMatch[1]);
    }
  }
  
  // Handle colors
  if (property.includes('color') || property === 'background-color' || property === 'border-color') {
    return value.toLowerCase().replace(/\s/g, '');
  }
  
  return value;
}

// Function to compare two values with tolerance
function compareValues(val1, val2, property, tolerance) {
  if (val1 === val2) return { match: true, diff: 0 };
  
  // Try numeric comparison
  const num1 = normalizeValue(val1, property);
  const num2 = normalizeValue(val2, property);
  
  if (typeof num1 === 'number' && typeof num2 === 'number') {
    const diffPercent = Math.abs((num2 - num1) / num1 * 100);
    const match = diffPercent <= tolerance;
    return { 
      match: match, 
      diff: diffPercent.toFixed(2),
      expected: val1,
      actual: val2
    };
  }
  
  return { 
    match: false, 
    diff: 'N/A',
    expected: val1 || 'not set',
    actual: val2 || 'not set'
  };
}

// Function to get computed styles of an element
/**
 * Normalize a user-supplied selector.
 * Rules:
 *  - Already a valid CSS selector start (. # [ * tag) â†’ use as-is
 *  - Starts with # followed by word chars              â†’ id selector, keep
 *  - Otherwise if it looks like a class name (no spaces, only word chars / hyphens / underscores)
 *    â†’ prepend '.' to treat it as a class selector
 * Examples:
 *   'yxt-SearchBar-form'  â†’ '.yxt-SearchBar-form'
 *   '.yxt-SearchBar-form' â†’ '.yxt-SearchBar-form'
 *   '#main-nav'           â†’ '#main-nav'
 *   'button.cta'          â†’ 'button.cta'  (already valid)
 */
/**
 * Normalize a user-supplied selector.
 * Rules:
 *  - Prefix  "tag:name"   â†’ use 'name' as-is (explicit tag selector, e.g. tag:ngx-web-login)
 *  - Already a valid CSS selector start (. # [ * tag) â†’ use as-is
 *  - Bare word with hyphen/uppercase â†’ prepend '.' (treat as class)
 * Examples:
 *   'tag:ngx-web-login'   â†’ 'ngx-web-login'   (Angular custom element tag)
 *   'nw-login-page'       â†’ '.nw-login-page'  (class name, auto-prefixed)
 *   '.nw-login-page'      â†’ '.nw-login-page'  (unchanged)
 *   '#main-nav'           â†’ '#main-nav'       (unchanged)
 */
function normalizeSelector(raw) {
  // Guard: if null, undefined or empty string – return empty and let caller handle it
  if (!raw || typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s) return '';

  // Explicit tag prefix: "tag:ngx-web-login" â†’ 'ngx-web-login'
  if (s.startsWith('tag:')) {
    const tagName = s.slice(4).trim();
    console.log(chalk.gray(`  [Selector] "${s}" â†’ tag selector "${tagName}"` ));
    return tagName;
  }

  // Already starts with a recognised CSS selector character
  if (/^[.#\[*a-zA-Z]/.test(s)) {
    // Compound selector (contains . # [ space > + ~) â†’ leave alone
    if (/^[a-zA-Z]/.test(s) && /[.#\[\s>+~]/.test(s)) return s;
    // Starts with CSS punctuation â†’ leave alone
    if (/^[.#\[*]/.test(s)) return s;
    // Bare word with hyphen or uppercase â†’ almost certainly a class name
    if (/[-A-Z]/.test(s)) {
      console.log(chalk.yellow(`  [Selector] "${s}" looks like a class name — auto-prefixing with "."`));
      return '.' + s;
    }
    // Plain lowercase word (div, span, p â€¦) â†’ tag name
    return s;
  }
  // Fallback: prepend dot
  console.log(chalk.yellow(`  [Selector] "${s}" has no CSS prefix — auto-prefixing with "."`));
  return '.' + s;
}

async function getElementStyles(page, selector, { skipScrollRetry = false, propertiesToExtract = allProperties } = {}) {
  try {
    const maxAttempts = skipScrollRetry ? 1 : 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Wait for the element (Playwright pierces shadow DOM automatically)
        await page.waitForSelector(selector, { timeout: CONFIG.selectorTimeout });

        // Use $eval so Playwright passes the actual element — works with shadow DOM
        const styles = await page.$eval(selector, (element, propsToExtract) => {
          const cs = window.getComputedStyle(element);
          const properties = {};
          for (const prop of propsToExtract) {
            properties[prop] = cs.getPropertyValue(prop);
          }
          const rect = element.getBoundingClientRect();
          return {
            properties,
            rect: { width: rect.width, height: rect.height, top: rect.top, left: rect.left },
            exists: true,
            tagName: element.tagName,
            className: element.className,
            innerHTML: element.innerHTML.substring(0, 500)
          };
        }, propertiesToExtract);

        if (styles && styles.exists) return styles;
        throw new Error('element disappeared between waitForSelector and $eval');

      } catch (e) {
        if (!skipScrollRetry && attempt < maxAttempts) {
          console.log(chalk.yellow(`  [Selector] Attempt ${attempt}/3 – "${selector}" not visible yet, retrying in ${attempt * 2}s...`));
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
          await page.waitForTimeout(attempt * 2000);
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.waitForTimeout(500);
        } else {
          throw e;
        }
      }
    }
  } catch (error) {
    console.log(chalk.yellow(`Warning: Element not found: ${selector}`));
    return { exists: false, error: error.message };
  }
}

// Function to take screenshot
async function takeScreenshot(page, url, selector, filename) {
  const result = { fullPath: null, elementPath: null, fullBase64: null, elementBase64: null, capturedElement: false };
  try {
    const screenshotPath = path.join(screenshotsDir, filename);

    // Full page screenshot – saved to disk AND captured as base64
    const fullBuffer = await page.screenshot({ fullPage: true });
    result.fullBase64 = `data:image/png;base64,${fullBuffer.toString('base64')}`;
    result.fullPath = screenshotPath.replace('.png', '-full.png');
    await fs.writeFile(result.fullPath, fullBuffer);

    // ── Element screenshot ────────────────────────────────────────────────────
    // Use Playwright's locator() which pierces shadow DOM (unlike page.$()),
    // then call .screenshot() directly – it auto-scrolls & clips to the element.
    try {
      const locator = page.locator(selector).first();

      // Confirm it's visible before attempting screenshot
      await locator.waitFor({ state: 'visible', timeout: 10000 });
      await locator.scrollIntoViewIfNeeded();
      await page.waitForTimeout(600); // let paint settle

      const elemBuffer = await locator.screenshot({ timeout: 15000 });
      result.elementBase64 = `data:image/png;base64,${elemBuffer.toString('base64')}`;
      result.elementPath = screenshotPath.replace('.png', '-element.png');
      result.capturedElement = true;
      await fs.writeFile(result.elementPath, elemBuffer);
      console.log(chalk.green(`  [Screenshot] Element captured: ${selector}`));
    } catch (elemErr) {
      console.log(chalk.yellow(`  [Screenshot] Element capture failed (${elemErr.message}), falling back to full-page`));
      result.elementBase64 = result.fullBase64; // fallback to full page
      result.capturedElement = false;
    }

    return result;
  } catch (error) {
    console.log(chalk.red(`Screenshot failed: ${error.message}`));
    return result;
  }
}

// Function to generate HTML report
async function generateReport(dxaData, angularData, comparisonResults, urls, selector, tolerance, timestamp, dxaScreenshot, angularScreenshot, selectorDxa, selectorAngular, viewportLabel = 'desktop', viewportWidth = 1920, viewportHeight = 1080, dxaPageTitle = '', angularPageTitle = '') {
  // Build a safe filename slug from the selector label (replace spaces/special chars with _)
  // Truncate to 80 chars to avoid Windows MAX_PATH (260 char) limit
  const rawSlug = selector.replace(/[^a-zA-Z0-9-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const selectorSlug = rawSlug.length > 80 ? rawSlug.substring(0, 80) : rawSlug;
  const reportPath = path.join(reportsDir, `${selectorSlug}_${viewportLabel}_comparison-report-${timestamp}.html`);
  
  let reportHTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>UI Comparison Report - ${selector} [${viewportLabel.toUpperCase()}]</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: #f5f5f5;
            padding: 20px;
        }
        .container {
            max-width: 1400px;
            margin: 0 auto;
            background: white;
            border-radius: 12px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
        }
        .header h1 { font-size: 28px; margin-bottom: 10px; }
        .header .meta { opacity: 0.9; font-size: 14px; }
        .summary {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            padding: 30px;
            background: #f8f9fa;
            border-bottom: 1px solid #e0e0e0;
        }
        .summary-card {
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
            text-align: center;
        }
        .summary-card .label { font-size: 14px; color: #666; margin-bottom: 8px; }
        .summary-card .value { font-size: 32px; font-weight: bold; }
        .summary-card .unit { font-size: 14px; color: #666; }
        .passed { color: #4CAF50; }
        .failed { color: #f44336; }
        .warning { color: #ff9800; }
        .comparison-section {
            padding: 30px;
            border-bottom: 1px solid #e0e0e0;
        }
        .comparison-title {
            font-size: 20px;
            font-weight: bold;
            margin-bottom: 20px;
            color: #333;
            border-left: 4px solid #667eea;
            padding-left: 15px;
        }
        .comparison-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 15px;
        }
        .comparison-table th,
        .comparison-table td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #e0e0e0;
        }
        .comparison-table th {
            background: #f8f9fa;
            font-weight: 600;
            color: #555;
        }
        .status-badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 600;
        }
        .status-pass { background: #e8f5e9; color: #2e7d32; }
        .status-fail { background: #ffebee; color: #c62828; }
        .diff-value {
            font-size: 12px;
            color: #666;
            margin-left: 8px;
        }
        .screenshots {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
            margin-top: 20px;
        }
        .screenshot-box {
            background: #f8f9fa;
            border-radius: 8px;
            padding: 15px;
        }
        .screenshot-box h4 {
            margin-bottom: 10px;
            color: #555;
        }
        .screenshot-box img {
            width: 100%;
            border-radius: 4px;
            border: 1px solid #e0e0e0;
        }
        .element-info {
            background: #f8f9fa;
            padding: 15px;
            border-radius: 8px;
            margin-top: 20px;
        }
        .element-info pre {
            background: white;
            padding: 10px;
            border-radius: 4px;
            overflow-x: auto;
            font-size: 12px;
        }
        @media (max-width: 768px) {
            .screenshots { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎨 UI Component Comparison Report</h1>
            <div style="display:inline-block;margin-bottom:10px;padding:4px 14px;border-radius:20px;font-size:13px;font-weight:700;background:${viewportLabel === 'mobile' ? 'rgba(255,152,0,0.85)' : 'rgba(33,150,243,0.85)'};color:#fff;letter-spacing:.5px">${viewportLabel.toUpperCase()} &nbsp;·&nbsp; ${viewportWidth}×${viewportHeight}</div>
            <div class="meta">
                <div>Component: <strong>${selector}</strong></div>
                <div>DXA URL: ${urls.dxa}</div>
                ${dxaPageTitle ? `<div style="font-size:12px;opacity:.85;margin-left:8px">↳ Page Title: <em>${dxaPageTitle.split(' | ')[0]}</em></div>` : ''}
                <div>Angular URL: ${urls.angular}</div>
                ${angularPageTitle ? `<div style="font-size:12px;opacity:.85;margin-left:8px">↳ Page Title: <em>${angularPageTitle.split(' | ')[0]}</em></div>` : ''}
                <div style="margin-top:8px;padding:8px 12px;background:rgba(255,255,255,0.15);border-radius:6px;font-family:monospace;font-size:13px">
                  <span style="opacity:.8">DXA Selector:</span>&nbsp;&nbsp;&nbsp;<strong>${selectorDxa || selector}</strong><br>
                  <span style="opacity:.8">Angular Selector:</span>&nbsp;<strong>${selectorAngular || selector}</strong>
                </div>
                <div>Comparison Date: ${new Date(timestamp).toLocaleString()}</div>
                <div>Tolerance: ${tolerance}%</div>
            </div>
        </div>
        
        <div class="summary">
            <div class="summary-card">
                <div class="label">Total Properties</div>
                <div class="value">${comparisonResults.total}</div>
            </div>
            <div class="summary-card">
                <div class="label">✅ Matched</div>
                <div class="value passed">${comparisonResults.passed}</div>
            </div>
            <div class="summary-card">
                <div class="label">❌ Mismatched</div>
                <div class="value failed">${comparisonResults.failed}</div>
            </div>
            <div class="summary-card">
                <div class="label">📊 Match Rate</div>
                <div class="value ${comparisonResults.passRate >= 80 ? 'passed' : (comparisonResults.passRate >= 60 ? 'warning' : 'failed')}">
                    ${comparisonResults.passRate}%
                </div>
            </div>
        </div>`;

  // Add element presence check
  if (!dxaData.exists) {
    reportHTML += `<div class="comparison-section">
        <div class="comparison-title">⚠️ Element Status</div>
        <div class="status-badge status-fail">DXA Element NOT FOUND</div>
    </div>`;
  }
  
  if (!angularData.exists) {
    reportHTML += `<div class="comparison-section">
        <div class="comparison-title">⚠️ Element Status</div>
        <div class="status-badge status-fail">Angular Element NOT FOUND</div>
    </div>`;
  }

  // Add comparison by category
  for (const [category, properties] of Object.entries(cssProperties)) {
    const categoryResults = comparisonResults.details.filter(d => properties.includes(d.property));
    if (categoryResults.length === 0) continue;
    
    reportHTML += `
        <div class="comparison-section">
            <div class="comparison-title">📐 ${category.charAt(0).toUpperCase() + category.slice(1)} Properties</div>
            <table class="comparison-table">
                <thead>
                    <tr><th>Property</th><th>DXA (Expected)</th><th>Angular (Actual)</th><th>Status</th><th>Diff</th></tr>
                </thead>
                <tbody>`;
    
    for (const result of categoryResults) {
      const statusClass = result.match ? 'status-pass' : 'status-fail';
      const statusText = result.match ? '✅ Pass' : '❌ Fail';
      
      reportHTML += `
        <tr>
          <td><strong>${result.property}</strong></td>
          <td>${result.expected}</td>
          <td>${result.actual}</td>
          <td><span class="status-badge ${statusClass}">${statusText}</span></td>
          <td>${result.diff !== 'N/A' ? result.diff + '%' : result.diff}</td>
        </tr>`;
    }
    
    reportHTML += `
                </tbody>
            </table>
        </div>`;
  }

  // Add screenshots
  const dxaImgSrc     = dxaScreenshot?.elementBase64     || dxaScreenshot?.fullBase64     || '';
  const angularImgSrc = angularScreenshot?.elementBase64 || angularScreenshot?.fullBase64 || '';
  const noImgPlaceholder = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="%23eee"/><text x="50%25" y="50%25" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="18" fill="%23999">Screenshot Not Available</text></svg>';

  // Badge indicating whether the snapshot is of the element or full-page fallback
  const dxaBadge     = dxaScreenshot?.capturedElement
    ? '<span style="background:#e8f5e9;color:#2e7d32;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600">&#9654; Element snapshot</span>'
    : '<span style="background:#fff3e0;color:#e65100;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600">&#9654; Full-page fallback</span>';
  const angularBadge = angularScreenshot?.capturedElement
    ? '<span style="background:#e8f5e9;color:#2e7d32;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600">&#9654; Element snapshot</span>'
    : '<span style="background:#fff3e0;color:#e65100;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600">&#9654; Full-page fallback</span>';

  reportHTML += `
        <div class="comparison-section">
            <div class="comparison-title">&#128248; Visual Comparison</div>
            <div style="margin-bottom:12px;font-size:13px;color:#555;background:#f0f4ff;border-left:4px solid #667eea;border-radius:4px;padding:8px 14px">
              <strong>Selector captured &mdash;</strong>
              &nbsp;DXA: <code>${selectorDxa || selector}</code>
              &nbsp;&nbsp;&nbsp;
              Angular: <code>${selectorAngular || selector}</code>
            </div>
            <div class="screenshots">
                <div class="screenshot-box">
                    <h4>DXA UAT (Baseline) &nbsp;${dxaBadge}</h4>
                    <img src="${dxaImgSrc || noImgPlaceholder}" alt="DXA Screenshot" style="max-width:100%;border:2px solid #667eea;border-radius:4px;">
                </div>
                <div class="screenshot-box">
                    <h4>Angular (New Version) &nbsp;${angularBadge}</h4>
                    <img src="${angularImgSrc || noImgPlaceholder}" alt="Angular Screenshot" style="max-width:100%;border:2px solid #4CAF50;border-radius:4px;">
                </div>
            </div>
        </div>`;

  // ── Unified Element Geometry Comparison table ──────────────────────────────
  if (dxaData.exists || angularData.exists) {
    const geo = [
      { label: 'Tag Name',   dxa: dxaData.exists ? dxaData.tagName   : 'N/A', ang: angularData.exists ? angularData.tagName   : 'N/A' },
      { label: 'Class Name', dxa: dxaData.exists ? (dxaData.className     || '(no class)') : 'N/A',
                             ang: angularData.exists ? (angularData.className || '(tag element — no class attr)') : 'N/A' },
      { label: 'Rendered Width',      dxa: dxaData.exists ? `${dxaData.rect.width.toFixed(2)}px`  : 'N/A', ang: angularData.exists ? `${angularData.rect.width.toFixed(2)}px`  : 'N/A' },
      { label: 'Rendered Height',     dxa: dxaData.exists ? `${dxaData.rect.height.toFixed(2)}px` : 'N/A', ang: angularData.exists ? `${angularData.rect.height.toFixed(2)}px` : 'N/A' },
      { label: 'Position Top',        dxa: dxaData.exists ? `${dxaData.rect.top.toFixed(2)}px`   : 'N/A', ang: angularData.exists ? `${angularData.rect.top.toFixed(2)}px`   : 'N/A' },
      { label: 'Position Left',       dxa: dxaData.exists ? `${dxaData.rect.left.toFixed(2)}px`  : 'N/A', ang: angularData.exists ? `${angularData.rect.left.toFixed(2)}px`  : 'N/A' },
    ];

    const geoRows = geo.map(r => {
      const numDxa = parseFloat(r.dxa);
      const numAng = parseFloat(r.ang);
      const isNumeric = !isNaN(numDxa) && !isNaN(numAng);
      const match = isNumeric
        ? Math.abs(numDxa - numAng) <= (numDxa * tolerance / 100)
        : r.dxa === r.ang;
      const diff = isNumeric && !match
        ? ` <span style="color:#f44336;font-size:11px">(\u0394${Math.abs(numDxa - numAng).toFixed(2)}px)</span>`
        : '';
      const rowStyle = match ? 'background:#e8f5e9' : 'background:#fff3e0';
      const badge    = match
        ? '<span style="color:#4CAF50;font-weight:bold">✅ Match</span>'
        : '<span style="color:#f44336;font-weight:bold">❌ Mismatch</span>';
      return `<tr style="${rowStyle}">
        <td style="padding:8px 12px;font-weight:500">${r.label}</td>
        <td style="padding:8px 12px;font-family:monospace">${r.dxa}</td>
        <td style="padding:8px 12px;font-family:monospace">${r.ang}${diff}</td>
        <td style="padding:8px 12px;text-align:center">${badge}</td>
      </tr>`;
    }).join('\n');

    reportHTML += `
        <div class="comparison-section">
            <div class="comparison-title">📐 Element Geometry &amp; Identity Comparison</div>
            <table style="width:100%;border-collapse:collapse;font-size:14px">
              <thead>
                <tr style="background:#1a1a2e;color:#fff">
                  <th style="padding:10px 12px;text-align:left">Property</th>
                  <th style="padding:10px 12px;text-align:left">🟦 DXA UAT (Baseline)</th>
                  <th style="padding:10px 12px;text-align:left">🟩 Angular (New Version)</th>
                  <th style="padding:10px 12px;text-align:center">Status</th>
                </tr>
              </thead>
              <tbody>
                ${geoRows}
              </tbody>
            </table>
        </div>`;
  }

  reportHTML += `
    </div>
</body>
</html>`;
  
  await fs.writeFile(reportPath, reportHTML);
  console.log(chalk.green(`\n📄 Report generated: ${reportPath}`));
  return reportPath;
}

// Main comparison function
// -- Per-viewport comparison helper -------------------------------------------
/**
 * Runs a full comparison for one viewport (desktop or mobile).
 * The orchestrator (compareComponents) handles selector resolution,
 * browser launch and viewport dispatching.
 */
async function runComparisonForViewport({
  browser, userInput, selectorDxa, selectorAngular, selector,
  viewportWidth, viewportHeight, userAgent, viewportLabel, timestamp
}) {
  const { dxaUrl, angularUrl, tolerance } = userInput;
  const preActionDxa         = userInput.preActionDxa         || null;
  const preActionAngular     = userInput.preActionAngular     || null;
  const preActionTextDxa     = userInput.preActionTextDxa     || null;
  const preActionTextAngular = userInput.preActionTextAngular || null;

  console.log(chalk.magenta.bold(`\n${'-'.repeat(55)}`));
  console.log(chalk.magenta.bold(`  Running ${viewportLabel.toUpperCase()} comparison (${viewportWidth}x${viewportHeight})...`));
  console.log(chalk.magenta.bold(`${'-'.repeat(55)}\n`));

  let dxaPage, angularPage;

  try {
    // Create browser contexts - each gets its own viewport / user-agent
    const contextOptions = {
      viewport: { width: viewportWidth, height: viewportHeight },
      userAgent
    };
    const dxaContext     = await browser.newContext(contextOptions);
    const angularContext = await browser.newContext(contextOptions);
    
    dxaPage = await dxaContext.newPage();
    angularPage = await angularContext.newPage();
    
    console.log(chalk.blue('📡 Navigating to DXA URL...'));
    try {
      await dxaPage.goto(dxaUrl, { waitUntil: 'load', timeout: CONFIG.navigationTimeout });
    } catch (navErr) {
      console.log(chalk.yellow(`  ⚠️  "load" timed out for DXA URL, retrying with "domcontentloaded"...`));
      await dxaPage.goto(dxaUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.navigationTimeout });
    }
    console.log(chalk.green(`âœ“ DXA page loaded â†’ ${dxaPage.url()}`));
    await handleCookieBanner(dxaPage, 'DXA page');
    const dxaPageTitle = await dxaPage.title();
    console.log('   Page Title (DXA): ' + dxaPageTitle);
    // Pre-action: click + optionally type to reveal the target element (DXA)
    if (preActionDxa) {
      console.log(chalk.cyan(`  ℹ️  Pre-action (DXA): waiting for "${preActionDxa}"...`));
      try {
        // Yext search widget loads asynchronously — scroll down to trigger it, then back up
        await dxaPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await dxaPage.waitForTimeout(2000);
        await dxaPage.evaluate(() => window.scrollTo(0, 0));
        await dxaPage.waitForTimeout(1000);

        await dxaPage.waitForSelector(preActionDxa, { timeout: CONFIG.selectorTimeout });
        // Scroll the element into view before clicking
        await dxaPage.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) el.scrollIntoView({ behavior: 'instant', block: 'center' });
        }, preActionDxa);
        await dxaPage.waitForTimeout(500);
        await dxaPage.click(preActionDxa);
        if (preActionTextDxa) {
          console.log(chalk.cyan(`  ℹ️  Pre-action (DXA): typing "${preActionTextDxa}"...`));
          await dxaPage.type(preActionDxa, preActionTextDxa, { delay: 80 });
          await dxaPage.waitForTimeout(2000); // wait for autocomplete suggestions
        } else {
          await dxaPage.waitForTimeout(1500);
        }
        console.log(chalk.green('  ✔ Pre-action done (DXA)'));
      } catch (e) {
        console.log(chalk.yellow(`  ⚠️  Pre-action failed on DXA page: ${e.message}`));
      }
    }
    
    console.log(chalk.blue('📡 Navigating to Angular URL...'));
    try {
      await angularPage.goto(angularUrl, { waitUntil: 'load', timeout: CONFIG.navigationTimeout });
    } catch (navErr) {
      console.log(chalk.yellow(`  ⚠️  "load" timed out for Angular URL, retrying with "domcontentloaded"...`));
      await angularPage.goto(angularUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.navigationTimeout });
    }
    console.log(chalk.green(`âœ“ Angular page loaded â†’ ${angularPage.url()}`));
    await handleCookieBanner(angularPage, 'Angular page');
    const angularPageTitle = await angularPage.title();
    console.log('   Page Title (Angular): ' + angularPageTitle);
    // Pre-action fires AFTER scrolls (see below) — removing early block
    
    // Wait for Angular to fully load (longer wait + scroll to trigger lazy rendering)
    await angularPage.waitForTimeout(4000);
    // Scroll the page to trigger any lazy-loaded / deferred Angular components
    await angularPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await angularPage.waitForTimeout(1000);
    await angularPage.evaluate(() => window.scrollTo(0, 0));
    await angularPage.waitForTimeout(500);

    // Pre-action (Angular): click + type AFTER page has settled, just before style extraction
    let preAngularStyles = null; // will be populated here if dropdown closes quickly
    if (preActionAngular) {
      // Try each comma-separated selector until one is found (Angular may use different class names)
      const angularPreSelectors = preActionAngular.split(',').map(s => s.trim());
      let foundPreSelector = null;
      for (const sel of angularPreSelectors) {
        try {
          await angularPage.waitForSelector(sel, { timeout: 5000 });
          foundPreSelector = sel;
          break;
        } catch (_) { /* try next */ }
      }
      if (foundPreSelector) {
        console.log(chalk.cyan(`  ℹ️  Pre-action (Angular): clicking "${foundPreSelector}"...`));
        try {
          await angularPage.click(foundPreSelector);
          if (preActionTextAngular) {
            console.log(chalk.cyan(`  ℹ️  Pre-action (Angular): typing "${preActionTextAngular}"...`));
            await angularPage.type(foundPreSelector, preActionTextAngular, { delay: 80 });

            const liSelector = selectorAngular;
            let liFound = false;

            // First try: li appears without navigation (inline autocomplete)
            try {
              await angularPage.waitForSelector(liSelector, { timeout: 3000 });
              liFound = true;
              console.log(chalk.green('  ✔ Target li appeared inline (autocomplete dropdown)'));
            } catch (_) { /* not inline — check for navigation */ }

            if (liFound) {
              // Capture styles IMMEDIATELY while dropdown is still open
              // Use $eval so Playwright handles shadow DOM (Angular Yext widget uses shadow DOM)
              try {
                preAngularStyles = await angularPage.$eval(selectorAngular, (element, propsToExtract) => {
                  const cs = window.getComputedStyle(element);
                  const properties = {};
                  for (const prop of propsToExtract) {
                    properties[prop] = cs.getPropertyValue(prop);
                  }
                  const rect = element.getBoundingClientRect();
                  return {
                    properties,
                    rect: { width: rect.width, height: rect.height, top: rect.top, left: rect.left },
                    exists: true,
                    tagName: element.tagName,
                    className: element.className,
                    innerHTML: element.innerHTML.substring(0, 500)
                  };
                }, allProperties);
                if (preAngularStyles?.exists) {
                  console.log(chalk.green('  ✔ Angular styles captured while dropdown is open'));
                } else {
                  preAngularStyles = null;
                  console.log(chalk.yellow('  ⚠️  Angular $eval returned null — will retry in getElementStyles'));
                }
              } catch (captureErr) {
                console.log(chalk.yellow(`  ⚠️  Angular styles pre-capture failed: ${captureErr.message}`));
              }
            } else {
              console.log(chalk.cyan('  ℹ️  No inline dropdown — submitting search (Enter) and waiting for results page...'));
              await angularPage.keyboard.press('Enter');
              try {
                await angularPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
              } catch (_) { /* navigation may have already happened */ }
              await angularPage.waitForTimeout(2000);
              console.log(chalk.cyan(`  ℹ️  Angular page after search: ${angularPage.url()}`));
            }
          } else {
            await angularPage.waitForTimeout(1500);
          }
          console.log(chalk.green('  ✔ Pre-action done (Angular)'));
        } catch (e) {
          console.log(chalk.yellow(`  ⚠️  Pre-action click/type failed on Angular page: ${e.message}`));
        }
      } else {
        console.log(chalk.yellow(`  ⚠️  Pre-action (Angular): none of these selectors found on page:\n     ${preActionAngular}`));
      }
    }

    // Resolve final display label (use pre-computed selector from outer scope)
    const toDisplayName = (sel) => sel.replace(/^[.#]/, '');
    const computedLabel = selectorDxa === selectorAngular
      ? toDisplayName(selectorDxa)
      : `${toDisplayName(selectorDxa)} vs ${toDisplayName(selectorAngular)}`;
    const selectorLabel = selector || computedLabel;

    console.log(chalk.blue(`\n🔍 Extracting styles for selector: ${selectorLabel}`));
    
    // Get properties to compare based on speed mode
    const propertiesToCompare = getPropertiesToCompare(userInput.comparisonSpeed || CONFIG.comparisonSpeed);
    console.log(chalk.gray(`   Speed Mode: ${userInput.comparisonSpeed || CONFIG.comparisonSpeed} (${propertiesToCompare.length} properties)`));
    
    // Get styles from both pages using their respective selectors.
    // Run in parallel so Angular styles are captured immediately (before its dropdown closes).
    // If Angular styles were already captured during pre-action, reuse them.
    const [dxaStyles, angularStyles] = await Promise.all([
      getElementStyles(dxaPage, selectorDxa, { propertiesToExtract: propertiesToCompare }),
      preAngularStyles ? Promise.resolve(preAngularStyles) : getElementStyles(angularPage, selectorAngular, { skipScrollRetry: true, propertiesToExtract: propertiesToCompare })
    ]);
    
    // Take screenshots
    console.log(chalk.blue('📸 Taking screenshots...'));
    const dxaScreenshot     = await takeScreenshot(dxaPage, dxaUrl, selectorDxa, `dxa-${timestamp}`);
    const angularScreenshot = await takeScreenshot(angularPage, angularUrl, selectorAngular, `angular-${timestamp}`);
    console.log(chalk.green('âœ“ Screenshots captured'));
    
    // Compare properties
    const comparisonResults = {
      total: 0,
      passed: 0,
      failed: 0,
      passRate: 0,
      details: []
    };
    
    if (dxaStyles?.properties && angularStyles?.properties) {
      for (const prop of propertiesToCompare) {
        const dxaValue = dxaStyles.properties[prop] || '';
        const angularValue = angularStyles.properties[prop] || '';
        
        const result = compareValues(dxaValue, angularValue, prop, tolerance);
        comparisonResults.total++;
        
        if (result.match) {
          comparisonResults.passed++;
        } else {
          comparisonResults.failed++;
        }
        
        comparisonResults.details.push({
          property: prop,
          expected: result.expected || dxaValue || 'not set',
          actual: result.actual || angularValue || 'not set',
          match: result.match,
          diff: result.diff
        });
      }
      
      comparisonResults.passRate = ((comparisonResults.passed / comparisonResults.total) * 100).toFixed(1);
    }

    // ── Geometry comparison (dimensions + position from getBoundingClientRect) ──
    if (dxaStyles?.rect && angularStyles?.rect) {
      const geometryFields = [
        { key: 'width',  label: 'Rendered Width (px)',  unit: 'px' },
        { key: 'height', label: 'Rendered Height (px)', unit: 'px' },
        { key: 'top',    label: 'Position Top (px)',    unit: 'px' },
        { key: 'left',   label: 'Position Left (px)',   unit: 'px' }
      ];
      for (const field of geometryFields) {
        const dxaVal     = parseFloat(dxaStyles.rect[field.key]   || 0);
        const angularVal = parseFloat(angularStyles.rect[field.key] || 0);
        const diff       = Math.abs(dxaVal - angularVal);
        const pctDiff    = dxaVal !== 0 ? ((diff / dxaVal) * 100).toFixed(1) : (angularVal !== 0 ? '100.0' : '0.0');
        const match      = diff <= (dxaVal * tolerance / 100);
        comparisonResults.total++;
        match ? comparisonResults.passed++ : comparisonResults.failed++;
        comparisonResults.details.push({
          property: `[Geometry] ${field.label}`,
          expected: `${dxaVal.toFixed(2)}${field.unit}`,
          actual:   `${angularVal.toFixed(2)}${field.unit}`,
          match,
          diff:     match ? null : `${diff.toFixed(2)}px (${pctDiff}%)`
        });
      }
      // Also compare tag name and class name
      const tagMatch   = dxaStyles.tagName   === angularStyles.tagName;
      const classMatch = dxaStyles.className === angularStyles.className;
      comparisonResults.total += 2;
      tagMatch   ? comparisonResults.passed++ : comparisonResults.failed++;
      classMatch ? comparisonResults.passed++ : comparisonResults.failed++;
      comparisonResults.details.push(
        { property: '[Geometry] Tag Name',   expected: dxaStyles.tagName,   actual: angularStyles.tagName,   match: tagMatch,   diff: tagMatch   ? null : 'Tag mismatch' },
        { property: '[Geometry] Class Name', expected: dxaStyles.className, actual: angularStyles.className, match: classMatch, diff: classMatch ? null : 'Class mismatch' }
      );
      comparisonResults.passRate = ((comparisonResults.passed / comparisonResults.total) * 100).toFixed(1);
    }
    
    // Generate report
    const reportPath = await generateReport(
      dxaStyles || { exists: false },
      angularStyles || { exists: false },
      comparisonResults,
      { dxa: dxaUrl, angular: angularUrl },
      selectorLabel,
      tolerance,
      timestamp,
      dxaScreenshot,
      angularScreenshot,
      selectorDxa,
      selectorAngular,
      viewportLabel,
      viewportWidth,
      viewportHeight,
      dxaPageTitle,
      angularPageTitle
    );
    
    // Print summary to console
    console.log(chalk.green.bold('\n📊 COMPARISON SUMMARY'));
    console.log(chalk.white('─'.repeat(50)));
    console.log(chalk.magenta(`Viewport : ${viewportLabel.toUpperCase()} (${viewportWidth}×${viewportHeight})`));
    console.log(chalk.cyan(`Component: ${selectorLabel}`));
    console.log(chalk.white(`Total Properties Compared: ${comparisonResults.total}`));
    console.log(chalk.green(`✅ Matched: ${comparisonResults.passed}`));
    console.log(chalk.red(`❌ Mismatched: ${comparisonResults.failed}`));
    console.log(chalk.yellow(`📊 Match Rate: ${comparisonResults.passRate}%`));
    
    // Show mismatches
    if (comparisonResults.failed > 0) {
      console.log(chalk.yellow.bold('\n⚠️ Mismatched Properties:'));
      const mismatches = comparisonResults.details.filter(d => !d.match);
      mismatches.slice(0, 10).forEach(m => {
        console.log(chalk.red(`  â€¢ ${m.property}: ${m.expected} â†’ ${m.actual} (diff: ${m.diff}%)`));
      });
      if (mismatches.length > 10) {
        console.log(chalk.gray(`  ... and ${mismatches.length - 10} more (see report for details)`));
      }
    }
    
    console.log(chalk.white('\n' + '─'.repeat(50)));
    console.log(chalk.green(`📄 Full report saved to: ${reportPath}`));
    console.log(chalk.blue(`ðŸ“ Screenshots saved in: ${screenshotsDir}`));
    
    // Open report automatically
    const { exec } = require('child_process');
    const openCommand = process.platform === 'win32' ? 'start' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
    exec(`${openCommand} "${reportPath}"`);

    return reportPath;

  } catch (error) {
    console.error(chalk.red(`❌ Error during ${viewportLabel} comparison:`), error);
  } finally {
    // Close only the page contexts - the browser is managed by the orchestrator
    if (dxaPage)     await dxaPage.context().close().catch(() => {});
    if (angularPage) await angularPage.context().close().catch(() => {});
  }
}

// -- Main orchestrator --------------------------------------------------------
async function compareComponents() {
  console.log(chalk.blue.bold('\n🚀 UI Component Comparison Tool\n'));

  const userInput = await getUserInput();
  const { dxaUrl, angularUrl } = userInput;

  // Resolve per-page selectors
  const rawDxa     = userInput.selectorDxa     || userInput.selector || '';
  const rawAngular = userInput.selectorAngular || userInput.selectorDxa || userInput.selector || '';

  if (!rawDxa) {
    console.log(chalk.red('\n❌ No selector configured. Set "selectorDxa" (or "selector") in compare.config.js and try again.\n'));
    process.exit(1);
  }

  const selectorDxa     = normalizeSelector(rawDxa);
  const selectorAngular = normalizeSelector(rawAngular);

  // Auto-generate a friendly report label
  const toDisplayName = (sel) => sel.replace(/^[.#]/, '');
  const selector = userInput.selector
    ? userInput.selector.replace(/^[.#]/, '')
    : (selectorDxa === selectorAngular
        ? toDisplayName(selectorDxa)
        : `${toDisplayName(selectorDxa)} vs ${toDisplayName(selectorAngular)}`);

  if (selectorDxa !== selectorAngular) {
    console.log(chalk.cyan('  ℹ️  Split-selector mode:'));
    console.log(chalk.cyan(`     DXA     selector: "${selectorDxa}"`));
    console.log(chalk.cyan(`     Angular selector: "${selectorAngular}"\n`));
  }

  // Guard: warn if both URLs are identical
  if (dxaUrl.trim() === angularUrl.trim()) {
    console.log(chalk.red('\n⚠️  WARNING: DXA URL and Angular URL are identical!'));
    console.log(chalk.red('   You are comparing a page against itself – results will always show 100% match.'));
    console.log(chalk.red('   Update "angularUrl" in compare.config.js to the correct Angular/new-version URL.\n'));
  }

  const timestamp = Date.now();
  const browser   = await chromium.launch({ headless: CONFIG.headless });

  try {
    await runComparisonForViewport({
      browser,
      userInput,
      selectorDxa,
      selectorAngular,
      selector,
      viewportWidth:  DESKTOP_VIEWPORT.width,
      viewportHeight: DESKTOP_VIEWPORT.height,
      userAgent:      DESKTOP_VIEWPORT.userAgent,
      viewportLabel:  DESKTOP_VIEWPORT.label,
      timestamp
    });
  } finally {
    await browser.close();
  }
}

// Run automatically only when executed directly (not when require()d by compare-mobile.js)
if (require.main === module) {
  compareComponents().catch(console.error);
}

// Export shared utilities for use by sibling scripts (e.g. compare-mobile.js)
module.exports = { runComparisonForViewport, getUserInput, normalizeSelector, CONFIG };
