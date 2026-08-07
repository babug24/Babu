const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { chromium } = require('playwright');

// ========================== CONFIGURATION ==========================
const BASE_URL = 'https://www.nationwide.com/financial-professionals/products/investments/mutual-funds/fund-list/profile/';
const INPUT_CANDIDATES = ['input.xlsx', 'input.csv', 'HTML.txt', 'input.html', 'input.htm'];
const OUTPUT_DIR = 'report';
const OUTPUT_FILE_BASE = 'FundSectionAvailability';
const TIMEOUT = 30000; // 30 seconds per page
const UNAVAILABLE_MESSAGE = 'we apologize, fund performance is temporarily unavailable';

// ========================== SECTIONS TO CHECK ==========================
const sections = [
  { name: 'Portfolio Management', text: 'Portfolio management' },
  { name: 'Average Annual Returns', text: 'Average annual returns' },
  { name: 'Calendar Year Returns', text: 'Calendar year returns' },
  { name: 'Growth of 10K', text: 'Growth of 10K' },
  { name: 'Fees Expenses & Minimums', text: 'Fees, expenses and minimums' },
  { name: 'Asset Allocation', text: 'Asset allocation' },
  { name: 'Top 10 Holdings', text: 'Top 10 holdings' },
  { name: 'Sector Allocations', text: 'Sector allocations' },
  { name: 'Portfolio Characteristics', text: 'Portfolio characteristics' },
  { name: 'Style Details', text: 'Style details' },
  { name: 'Continent Allocation', text: 'Continent allocation' },
  { name: 'Credit Quality', text: 'Credit quality' },
  { name: 'Rankings & Ratings', text: 'Rankings and ratings' },
  { name: 'Distribution Information', text: 'Distribution information' }
];

// ========================== HELPER FUNCTIONS ==========================

/**
 * Read URLs from the available input file.
 * Supports Excel (.xlsx) and CSV files with a column named "URL".
 */
function resolveInputFile() {
  const overridePath = process.argv[2];
  if (overridePath && fs.existsSync(overridePath)) {
    return overridePath;
  }

  const existingFile = INPUT_CANDIDATES.find(file => fs.existsSync(file));
  if (!existingFile) {
    throw new Error(`Input file not found. Expected one of: ${INPUT_CANDIDATES.join(', ')}`);
  }
  return existingFile;
}

function normalizeUrl(value) {
  let val = value.toString().trim();
  if (!val) {
    return null;
  }

  if (!val.startsWith('http://') && !val.startsWith('https://')) {
    val = BASE_URL + val;
  }

  return val;
}

function isHtmlDumpFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ['.html', '.htm', '.txt'].includes(ext);
}

function inferFundFromHtml(html, source) {
  const metaMatch = html.match(/<meta[^>]+name=["']mutualFundsAPI["'][^>]+content=["']([^"']+)["']/i);
  if (metaMatch) {
    return metaMatch[1];
  }

  const titleMatch = html.match(/<title>([^<]+)/i);
  if (titleMatch) {
    const candidate = titleMatch[1].trim().split(/\s*[-–—]\s*/)[0];
    if (candidate) {
      return candidate;
    }
  }

  const codeMatch = html.match(/\b([A-Z0-9]{4,8})\b/);
  return codeMatch ? codeMatch[1] : path.basename(source);
}

async function readInputItems() {
  const inputFile = resolveInputFile();

  if (isHtmlDumpFile(inputFile)) {
    const html = fs.readFileSync(inputFile, 'utf8');
    const fund = inferFundFromHtml(html, inputFile);
    return [{ type: 'html', source: inputFile, html, fund }];
  }

  if (inputFile.endsWith('.csv')) {
    const content = fs.readFileSync(inputFile, 'utf8');
    const lines = content.split(/\r?\n/).filter(line => line.trim());

    if (lines.length === 0) {
      return [];
    }

    const headers = lines[0].split(',').map(header => header.trim().toLowerCase());
    const urlIndex = headers.indexOf('url');
    const fundcodeIndex = headers.indexOf('fundcode');

    if (urlIndex === -1 && fundcodeIndex === -1) {
      throw new Error('CSV input must contain a URL or FundCode column.');
    }

    const items = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split(',');
      const rawValue = (urlIndex !== -1 ? cells[urlIndex] : cells[fundcodeIndex]) || '';
      const normalized = normalizeUrl(rawValue);
      if (normalized) {
        items.push({ type: 'url', url: normalized });
      }
    }

    return items;
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputFile);
  const worksheet = workbook.getWorksheet(1); // first sheet

  const items = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return; // skip header
    const urlCell = row.getCell('URL');
    const normalized = normalizeUrl(urlCell && urlCell.value ? urlCell.value : '');
    if (normalized) {
      items.push({ type: 'url', url: normalized });
    }
  });

  return items;
}

/**
 * Process a single fund page and return results.
 */
async function processFundPage(page, url) {
  const ticker = url.split('/').pop() || 'unknown';
  const result = {
    url,
    fund: ticker,
  };

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(4000);
  } catch (firstError) {
    console.warn(`Initial load failed for ${url}: ${firstError.message}. Retrying with domcontentloaded...`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
      await page.waitForTimeout(4000);
    } catch (secondError) {
      console.error(`Error loading ${url}:`, secondError.message);
      sections.forEach(s => { result[s.name] = 'No'; });
      result.error = secondError.message;
      return result;
    }
  }

  const pageContent = await page.content().catch(() => '');
  return analyzeHtmlResult(pageContent, url);
}

function analyzeHtmlResult(html, source) {
  const result = {
    url: source,
    fund: inferFundFromHtml(html, source),
  };

  const lowerContent = html.toLowerCase();
  const hasWarningElement = lowerContent.includes(UNAVAILABLE_MESSAGE);

  let searchIndex = 0;
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const sectionText = section.text.toLowerCase();

    const sectionIndex = lowerContent.indexOf(sectionText, searchIndex);
    if (sectionIndex === -1) {
      result[section.name] = 'No';
      continue;
    }

    const nextSectionIndex = sections.slice(i + 1)
      .map(next => lowerContent.indexOf(next.text.toLowerCase(), sectionIndex + sectionText.length))
      .filter(idx => idx !== -1)
      .sort((a, b) => a - b)[0] || lowerContent.length;

    const sectionRegion = lowerContent.slice(sectionIndex, nextSectionIndex);
    const hasError = sectionRegion.includes(UNAVAILABLE_MESSAGE);
    if (hasError) {
      result.error = 'Fund performance temporarily unavailable';
      result[section.name] = 'Yes with error';
    } else {
      result[section.name] = 'Yes';
    }

    searchIndex = sectionIndex + sectionText.length;
  }

  if (!result.error && hasWarningElement) {
    result.error = 'Fund performance temporarily unavailable';
  }

  return result;
}

/**
 * Write results to Excel file.
 */
async function writeResults(results) {
  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Validation Results');

  // Build columns: URL, Fund, each section, and Availability Error
  const columns = [
    { header: 'URL', key: 'url', width: 40 },
    { header: 'Fund Name', key: 'fund', width: 15 },
    ...sections.map(s => ({ header: s.name, key: s.name, width: 25 })),
    { header: 'Availability Error', key: 'error', width: 40 }
  ];
  worksheet.columns = columns;

  // Add rows
  results.forEach(rowData => {
    worksheet.addRow(rowData);
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputFile = path.join(OUTPUT_DIR, `${OUTPUT_FILE_BASE}-${timestamp}.xlsx`);

  try {
    await workbook.xlsx.writeFile(outputFile);
    console.log(`Report written to ${outputFile}`);
  } catch (err) {
    if (err.code === 'EBUSY') {
      const fallbackFile = path.join(OUTPUT_DIR, `${OUTPUT_FILE_BASE}-${Date.now()}.xlsx`);
      console.warn(`Unable to write ${outputFile} because it is busy. Writing to ${fallbackFile} instead.`);
      await workbook.xlsx.writeFile(fallbackFile);
      console.log(`Report written to ${fallbackFile}`);
    } else {
      throw err;
    }
  }
}

// ========================== MAIN ==========================

(async () => {
  console.log('Reading input file...');
  let items;
  try {
    items = await readInputItems();
  } catch (err) {
    console.error('Failed to read input:', err.message);
    process.exit(1);
  }

  if (items.length === 0) {
    console.warn('No input items found. Exiting.');
    process.exit(0);
  }

  console.log(`Found ${items.length} fund(s) to validate.`);

  const results = [];
  let browser = null;
  let context = null;
  let page = null;

  const needsBrowser = items.some(item => item.type === 'url');
  if (needsBrowser) {
    browser = await chromium.launch({ headless: true }); // set false for debugging
    context = await browser.newContext();
    page = await context.newPage();
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    console.log(`[${i+1}/${items.length}] Processing ${item.type === 'html' ? item.source : item.url}...`);
    let result;

    if (item.type === 'html') {
      result = analyzeHtmlResult(item.html, item.source);
    } else {
      result = await processFundPage(page, item.url);
    }

    results.push(result);
    console.log('  Done.');
  }

  if (browser) {
    await browser.close();
  }

  // Write results
  await writeResults(results);
  console.log('Validation complete.');
})();