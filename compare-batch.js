/**
 * Batch Comparison Script
 * Runs multiple component comparisons in sequence for efficient testing
 * 
 * Usage: node compare-batch.js
 */

const { runComparisonForViewport, getUserInput, normalizeSelector, CONFIG } = require('./compare-component.js');
const { chromium } = require('playwright');
const chalk = require('chalk');

// Define components to compare (add as many as you need)
// TIP: Use simple, specific selectors that are more likely to exist
const componentsToCompare = [
  {
    name: 'Contact Page - Main Heading',
    selectorDxa: 'h1',                    // Simple: first h1 on page
    selectorAngular: 'h1'                 // Same on both
  },
  {
    name: 'Contact Form - Email Field',
    selectorDxa: '#voc-email',            // ID selector (more reliable)
    selectorAngular: '#voc-email'         // Same ID
  },
  {
    name: 'Contact Form - Message Field',
    selectorDxa: '#voc-message',          // ID selector
    selectorAngular: '#voc-message'       // Same ID
  },
  {
    name: 'Contact Form - Submit Button',
    selectorDxa: '#submit',               // ID selector
    selectorAngular: '#submit'            // Same ID
  }
];

async function runBatchComparisons() {
  console.log(chalk.blue.bold('\n🚀 Batch Component Comparison Tool\n'));

  const userInput = await getUserInput();
  
  // Force critical mode for batch comparisons (faster)
  userInput.comparisonSpeed = 'critical';
  
  const timestamp = Date.now();
  const browser = await chromium.launch({ headless: CONFIG.headless });

  let completedCount = 0;
  let failedCount = 0;
  const results = [];

  try {
    console.log(chalk.cyan(`📋 Running ${componentsToCompare.length} comparisons...\n`));

    for (const component of componentsToCompare) {
      console.log(chalk.magenta.bold(`\n[${ completedCount + 1}/${componentsToCompare.length}] ${component.name}`));
      console.log(chalk.gray('─'.repeat(60)));

      try {
        const selectorDxa = normalizeSelector(component.selectorDxa);
        const selectorAngular = normalizeSelector(component.selectorAngular);

        await runComparisonForViewport({
          browser,
          userInput,
          selectorDxa,
          selectorAngular,
          selector: component.name,
          viewportWidth: 1920,
          viewportHeight: 1080,
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          viewportLabel: 'desktop',
          timestamp: Date.now()
        });

        completedCount++;
        results.push({ component: component.name, status: '✅ PASSED' });
        console.log(chalk.green(`✅ ${component.name} - comparison completed\n`));
      } catch (error) {
        failedCount++;
        results.push({ component: component.name, status: `❌ FAILED: ${error.message}` });
        console.log(chalk.red(`❌ ${component.name} - comparison failed: ${error.message}\n`));
      }
    }

  } finally {
    await browser.close();
  }

  // Print summary
  console.log(chalk.blue.bold('\n📊 BATCH COMPARISON SUMMARY\n'));
  console.log(chalk.white('─'.repeat(70)));
  results.forEach(r => {
    const icon = r.status.includes('PASSED') ? '✅' : '❌';
    console.log(`${icon} ${r.component}`);
  });
  console.log(chalk.white('─'.repeat(70)));
  console.log(chalk.green(`\n✅ Completed: ${completedCount}/${componentsToCompare.length}`));
  if (failedCount > 0) {
    console.log(chalk.red(`❌ Failed: ${failedCount}/${componentsToCompare.length}`));
  }
  console.log(chalk.cyan(`\n📄 All reports saved to: ./reports/\n`));
}

// Run if executed directly
if (require.main === module) {
  runBatchComparisons().catch(console.error);
}

module.exports = { runBatchComparisons };
