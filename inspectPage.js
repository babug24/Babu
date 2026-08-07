const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const BASE_URL = 'https://www.nationwide.com/financial-professionals/products/investments/mutual-funds/fund-list/profile/';
const INPUT_CSV = 'input.csv';

function readInputUrls() {
  const content = fs.readFileSync(path.resolve(__dirname, INPUT_CSV), 'utf8');
  const lines = content.split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) {
    throw new Error(`No fund codes found in ${INPUT_CSV}`);
  }

  const headers = lines[0].split(',').map(header => header.trim().toLowerCase());
  const urlIndex = headers.indexOf('url');
  const fundcodeIndex = headers.indexOf('fundcode');
  if (urlIndex === -1 && fundcodeIndex === -1) {
    throw new Error(`CSV input must contain a URL or FundCode column.`);
  }

  const values = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    const rawValue = (urlIndex !== -1 ? cells[urlIndex] : cells[fundcodeIndex] || '').trim();
    if (!rawValue) {
      continue;
    }
    values.push(rawValue.startsWith('http://') || rawValue.startsWith('https://')
      ? rawValue
      : BASE_URL + rawValue);
  }

  return values;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const urls = readInputUrls();
    if (urls.length === 0) {
      throw new Error(`No valid URLs or fund codes found in ${INPUT_CSV}`);
    }
    for (const url of urls) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      console.log('loaded', url);
      const inner = await page.locator('body').innerText();
      const snippets = [
        'Portfolio management',
        'Average annual returns',
        'Calendar year returns',
        'Growth of 10K',
        'Fees, expenses and minimums',
        'Asset allocation',
        'Top 10 holdings',
        'Sector allocations',
        'Portfolio characteristics',
        'Style details',
        'Continent allocation',
        'Credit quality',
        'Rankings and ratings',
        'Distribution information'
      ];
      for (const snip of snippets) {
        const found = inner.toLowerCase().includes(snip.toLowerCase());
        console.log(`${snip}: ${found}`);
      }
      console.log('HTML length', (await page.content()).length);
    }
  } catch (e) {
    console.error('ERROR', e.message);
  } finally {
    await browser.close();
  }
})();
