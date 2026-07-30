/**
 * ============================================================
 *  Multi-Device Mobile Comparison Script
 * ============================================================
 *
 * Runs mobile comparisons for:
 * - iOS (iPhone 15 Pro - Latest)
 * - Android (Samsung Galaxy S24 - Latest)
 * - Tablet (iPad Air - Latest)
 *
 * Usage:
 *   node compare-mobile-devices.js           → runs with compare.config.js values
 *   node compare-mobile-devices.js --prompt  → interactive mode
 *
 * Reports will be generated for each device type.
 * ============================================================
 */

'use strict';

const { chromium } = require('playwright');
const chalk = require('chalk');

// Import shared engine
const {
  runComparisonForViewport,
  getUserInput,
  normalizeSelector,
  CONFIG
} = require('./compare-component.js');

// Device configurations for latest devices
const MOBILE_DEVICES = {
  ios: {
    name: 'iPhone 15 Pro (iOS)',
    width: 390,
    height: 844,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) ' +
               'AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
               'Version/18.0 Mobile/15E148 Safari/604.1',
    label: 'mobile-ios'
  },
  android: {
    name: 'Samsung Galaxy S24 (Android)',
    width: 393,
    height: 851,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-S921B) ' +
               'AppleWebKit/537.36 (KHTML, like Gecko) ' +
               'Chrome/132.0.0.0 Mobile Safari/537.36',
    label: 'mobile-android'
  },
  tablet: {
    name: 'iPad Air 6th Gen (Tablet)',
    width: 820,
    height: 1180,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) ' +
               'AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
               'Version/18.0 Mobile/15E148 Safari/604.1',
    label: 'tablet'
  }
};

async function compareMultipleDevices() {
  console.log(chalk.blue.bold('\n📱 Multi-Device Mobile Comparison Tool\n'));
  console.log(chalk.cyan('Testing devices:'));
  console.log(chalk.cyan('  • iPhone 15 Pro (Latest iOS)'));
  console.log(chalk.cyan('  • Samsung Galaxy S24 (Latest Android)'));
  console.log(chalk.cyan('  • iPad Air 6th Gen (Latest Tablet)\n'));

  const userInput = await getUserInput();
  
  // Force critical mode for faster mobile comparisons
  userInput.comparisonSpeed = 'critical';
  
  const { dxaUrl, angularUrl } = userInput;

  // Resolve selectors
  const rawDxa = userInput.selectorDxa || userInput.selector || '';
  const rawAngular = userInput.selectorAngular || userInput.selectorDxa || userInput.selector || '';

  if (!rawDxa) {
    console.log(chalk.red('\n❌ No selector configured. Set "selectorDxa" (or "selector") in compare.config.js.\n'));
    process.exit(1);
  }

  const selectorDxa = normalizeSelector(rawDxa);
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
    console.log(chalk.red('\n⚠️  WARNING: URLs are identical - results will show 100% match.\n'));
  }

  const timestamp = Date.now();
  const browser = await chromium.launch({ headless: CONFIG.headless });

  const results = [];
  let completedCount = 0;
  const devices = Object.values(MOBILE_DEVICES);

  try {
    console.log(chalk.magenta.bold(`\n${'='.repeat(70)}`));
    console.log(chalk.magenta.bold(`  Running ${devices.length} device comparisons...`));
    console.log(chalk.magenta.bold(`${'='.repeat(70)}\n`));

    for (const device of devices) {
      console.log(chalk.cyan(`\n[${completedCount + 1}/${devices.length}] ${device.name}`));
      console.log(chalk.gray(`Viewport: ${device.width}×${device.height}`));

      try {
        await runComparisonForViewport({
          browser,
          userInput,
          selectorDxa,
          selectorAngular,
          selector,
          viewportWidth: device.width,
          viewportHeight: device.height,
          userAgent: device.userAgent,
          viewportLabel: device.label,
          timestamp
        });

        results.push({ device: device.name, status: '✅ PASSED' });
        completedCount++;
        console.log(chalk.green(`✅ ${device.name} comparison completed\n`));
      } catch (error) {
        results.push({ device: device.name, status: `❌ FAILED: ${error.message}` });
        console.log(chalk.red(`❌ ${device.name} comparison failed: ${error.message}\n`));
      }
    }

  } finally {
    await browser.close();
  }

  // Print summary
  console.log(chalk.blue.bold('\n📊 MULTI-DEVICE COMPARISON SUMMARY\n'));
  console.log(chalk.white('─'.repeat(70)));
  results.forEach(r => {
    const icon = r.status.includes('PASSED') ? '✅' : '❌';
    console.log(`${icon} ${r.device}`);
  });
  console.log(chalk.white('─'.repeat(70)));
  console.log(chalk.green(`\n✅ Completed: ${completedCount}/${devices.length}`));
  console.log(chalk.cyan(`\n📄 All reports saved to: ./reports/\n`));
}

// Run if executed directly
if (require.main === module) {
  compareMultipleDevices().catch(console.error);
}

module.exports = { compareMultipleDevices };
