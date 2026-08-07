const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { chromium } = require('playwright');

// ========================== CONFIGURATION ==========================
const BASE_URL = 'https://www.nationwide.com/financial-professionals/products/investments/mutual-funds/fund-list/profile/';
const INPUT_CANDIDATES = ['input.xlsx', 'input.csv'];
const OUTPUT_DIR = 'report';
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'FundSectionValidation.xlsx');
const TIMEOUT = 30000; // 30 seconds per page

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

async function readInputUrls() {
  const inputFile = resolveInputFile();

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

    const urls = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split(',');
      const rawValue = (urlIndex !== -1 ? cells[urlIndex] : cells[fundcodeIndex]) || '';
      const normalized = normalizeUrl(rawValue);
      if (normalized) {
        urls.push(normalized);
      }
    }

    return urls;
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputFile);
  const worksheet = workbook.getWorksheet(1); // first sheet

  const urls = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return; // skip header
    const urlCell = row.getCell('URL');
    const normalized = normalizeUrl(urlCell && urlCell.value ? urlCell.value : '');
    if (normalized) {
      urls.push(normalized);
    }
  });

  return urls;
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
      // Mark all sections as "No" if page fails
      sections.forEach(s => { result[s.name] = 'No'; });
      return result;
    }
  }

  // Check each section
  for (const section of sections) {
    try {
      const locator = page.getByText(section.text, { exact: false });
      const isVisible = await locator.first().isVisible().catch(() => false);
      result[section.name] = isVisible ? 'Yes' : 'No';
    } catch (err) {
      // If any error, treat as not found
      result[section.name] = 'No';
    }
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

  // Build columns: URL, Fund, then each section
  const columns = [
    { header: 'URL', key: 'url', width: 40 },
    { header: 'Fund Name', key: 'fund', width: 15 },
    ...sections.map(s => ({ header: s.name, key: s.name, width: 25 }))
  ];
  worksheet.columns = columns;

  // Add rows
  results.forEach(rowData => {
    worksheet.addRow(rowData);
  });

  // Write file
  try {
    await workbook.xlsx.writeFile(OUTPUT_FILE);
    console.log(`Report written to ${OUTPUT_FILE}`);
  } catch (err) {
    if (err.code === 'EBUSY') {
      const fallbackFile = path.join(OUTPUT_DIR, `FundSectionValidation-${Date.now()}.xlsx`);
      console.warn(`Unable to write ${OUTPUT_FILE} because it is busy. Writing to ${fallbackFile} instead.`);
      await workbook.xlsx.writeFile(fallbackFile);
      console.log(`Report written to ${fallbackFile}`);
    } else {
      throw err;
    }
  }
}

// ========================== MAIN ==========================

(async () => {
  console.log('Reading URLs from input file...');
  let urls;
  try {
    urls = await readInputUrls();
  } catch (err) {
    console.error('Failed to read input:', err.message);
    process.exit(1);
  }

  if (urls.length === 0) {
    console.warn('No URLs found in input file. Exiting.');
    process.exit(0);
  }

  console.log(`Found ${urls.length} fund(s) to validate.`);

  const browser = await chromium.launch({ headless: true }); // set false for debugging
  const context = await browser.newContext();
  const page = await context.newPage();

  const results = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    console.log(`[${i+1}/${urls.length}] Processing ${url}...`);
    const result = await processFundPage(page, url);
    results.push(result);
    console.log(`  Done.`);
  }

  await browser.close();

  // Write results
  await writeResults(results);
  console.log('Validation complete.');
})();