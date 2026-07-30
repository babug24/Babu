/**
 * ============================================================
 *  Mobile Validation Script – NW Interstellar Browser Comparison
 * ============================================================
 *
 * Runs a MOBILE-ONLY comparison (390×844, iPhone UA).
 * All config (URLs, selectors, pre-actions, tolerance, etc.)
 * is read from compare.config.js — nothing is duplicated here.
 *
 * Usage:
 *   node compare-mobile.js           → runs with compare.config.js values
 *   node compare-mobile.js --prompt  → interactive / override mode
 *
 * Report filename will contain  _mobile_  to distinguish it from
 * desktop reports.
 * ============================================================
 */

'use strict';

const { chromium } = require('playwright');
const chalk        = require('chalk');

// ── Import shared engine from compare-component.js ───────────────────────────
const {
  runComparisonForViewport,
  getUserInput,
  normalizeSelector,
  CONFIG
} = require('./compare-component.js');

// ── Mobile viewport definition ───────────────────────────────────────────────
const MOBILE_VIEWPORT = {
  width:     390,
  height:    844,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) ' +
             'AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
             'Version/16.0 Mobile/15E148 Safari/604.1',
  label: 'mobile'
};

// ── Main entry point ─────────────────────────────────────────────────────────
async function compareMobile() {
  console.log(chalk.blue.bold('\n📱 Mobile Validation Tool\n'));
  console.log(chalk.magenta(`   Viewport : ${MOBILE_VIEWPORT.width}×${MOBILE_VIEWPORT.height} (iPhone)`));
  console.log(chalk.magenta(`   UA       : ${MOBILE_VIEWPORT.userAgent.slice(0, 60)}...\n`));

  const userInput = await getUserInput();
  const { dxaUrl, angularUrl } = userInput;

  // Resolve selectors
  const rawDxa     = userInput.selectorDxa     || userInput.selector || '';
  const rawAngular = userInput.selectorAngular || userInput.selectorDxa || userInput.selector || '';

  if (!rawDxa) {
    console.log(chalk.red('\n❌ No selector configured. Set "selectorDxa" (or "selector") in compare.config.js.\n'));
    process.exit(1);
  }

  const selectorDxa     = normalizeSelector(rawDxa);
  const selectorAngular = normalizeSelector(rawAngular);

  // Build display label
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

  // Guard: identical URLs
  if (dxaUrl.trim() === angularUrl.trim()) {
    console.log(chalk.red('\n⚠️  WARNING: DXA URL and Angular URL are identical!'));
    console.log(chalk.red('   Results will always show 100% match.'));
    console.log(chalk.red('   Update "angularUrl" in compare.config.js.\n'));
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
      viewportWidth:  MOBILE_VIEWPORT.width,
      viewportHeight: MOBILE_VIEWPORT.height,
      userAgent:      MOBILE_VIEWPORT.userAgent,
      viewportLabel:  MOBILE_VIEWPORT.label,
      timestamp
    });
  } finally {
    await browser.close();
  }
}

compareMobile().catch(console.error);

