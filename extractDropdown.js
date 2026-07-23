const puppeteer = require('puppeteer');
const fs = require('fs');
const csv = require('csv-parser');
const ExcelJS = require('exceljs');

// ---------- CONFIG ----------
const INPUT_CSV = process.argv[2] || 'urls.csv';
// Add timestamp to avoid file lock conflicts
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUTPUT_EXCEL = `dropdown_report_${timestamp}.xlsx`;
const HEADLESS = true; // Set to true for headless

// ---------- HELPERS ----------
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function readUrls() {
  return new Promise((resolve, reject) => {
    const urls = [];
    fs.createReadStream(INPUT_CSV)
      .pipe(csv())
      .on('data', row => { if (row.url) urls.push(row.url.trim()); })
      .on('end', () => resolve(urls))
      .on('error', reject);
  });
}

function filterOptions(options) {
  return options.filter(opt => {
    const trimmed = opt.trim();
    return trimmed !== '' && trimmed.toLowerCase() !== 'select';
  });
}

async function getDropdownOptions(page, url, index) {
  console.log(`  → Navigating to ${url} ...`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

  await page.waitForFunction(
    () => document.readyState === 'complete',
    { timeout: 30000 }
  );
  await sleep(3000);

  let found = false;
  let options = [];

  // Strategy 1: #bolt-select-wrapper
  try {
    await page.waitForSelector('#bolt-select-wrapper', { timeout: 5000 });
    found = true;
    console.log('  ✓ Found #bolt-select-wrapper');
    options = await extractOptionsFromWrapper(page);
  } catch (e) {
    console.log('  ⚠️  #bolt-select-wrapper not found, trying other strategies...');
  }

  // Strategy 2: native <select>
  if (!found) {
    try {
      await page.waitForSelector('select', { timeout: 5000 });
      found = true;
      console.log('  ✓ Found native <select> element');
      options = await page.evaluate(() => {
        const selects = document.querySelectorAll('select');
        let allOptions = [];
        selects.forEach(select => {
          const opts = Array.from(select.options).map(o => o.textContent.trim());
          allOptions = allOptions.concat(opts);
        });
        return allOptions;
      });
    } catch (e) {
      console.log('  ⚠️  No <select> element found');
    }
  }

  // Strategy 3: shadow DOM
  if (!found) {
    try {
      const shadowResult = await page.evaluate(() => {
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
          if (el.shadowRoot) {
            const shadowSelect = el.shadowRoot.querySelector('select, [role="listbox"], .dropdown');
            if (shadowSelect) {
              const options = shadowSelect.querySelectorAll('option, li, .option, [role="option"]');
              return Array.from(options).map(o => o.textContent.trim()).filter(Boolean);
            }
          }
        }
        return null;
      });
      if (shadowResult && shadowResult.length > 0) {
        found = true;
        options = shadowResult;
        console.log(`  ✓ Found ${options.length} option(s) in shadow DOM`);
      }
    } catch (e) {
      console.log('  ⚠️  No shadow DOM dropdown found');
    }
  }

  // Strategy 4: iframes
  if (!found) {
    try {
      const frames = page.frames();
      for (const frame of frames) {
        if (frame !== page.mainFrame()) {
          try {
            const frameOptions = await frame.evaluate(() => {
              const select = document.querySelector('select, [role="listbox"], .dropdown');
              if (!select) return null;
              const opts = select.querySelectorAll('option, li, .option, [role="option"]');
              return Array.from(opts).map(o => o.textContent.trim()).filter(Boolean);
            });
            if (frameOptions && frameOptions.length > 0) {
              found = true;
              options = frameOptions;
              console.log(`  ✓ Found ${options.length} option(s) in iframe`);
              break;
            }
          } catch (e) {}
        }
      }
    } catch (e) {
      console.log('  ⚠️  No iframe dropdown found');
    }
  }

  if (!found) {
    console.log('  ⚠️  No dropdown element found. Saving HTML for debugging...');
    const html = await page.content();
    fs.writeFileSync(`debug_page_${index}.html`, html);
    await page.screenshot({ path: `screenshot_${index}.png`, fullPage: true });
    return [];
  }

  if (options.length === 0) {
    console.log('  ⚠️  Found dropdown but no options visible. Trying to click to expand...');
    try {
      await page.click('#bolt-select-wrapper [role="button"], #bolt-select-wrapper button, select, .dropdown-toggle');
      await sleep(2000);
      options = await extractOptionsFromWrapper(page);
      if (options.length === 0) {
        options = await page.evaluate(() => {
          const selects = document.querySelectorAll('select');
          let allOptions = [];
          selects.forEach(select => {
            const opts = Array.from(select.options).map(o => o.textContent.trim());
            allOptions = allOptions.concat(opts);
          });
          return allOptions;
        });
      }
    } catch (e) {
      console.log('  ⚠️  Could not click to expand dropdown');
    }
  }

  const filtered = filterOptions(options);
  console.log(`  ✓ Found ${filtered.length} option(s) after filtering (removed "Select")`);
  return filtered;
}

async function extractOptionsFromWrapper(page) {
  return await page.evaluate(() => {
    const wrapper = document.querySelector('#bolt-select-wrapper');
    if (!wrapper) return [];

    let items = wrapper.querySelectorAll('li, .option, .item, [role="option"]');
    let texts = Array.from(items).map(el => el.textContent.trim()).filter(Boolean);

    if (texts.length === 0) {
      const select = wrapper.querySelector('select');
      if (select) {
        texts = Array.from(select.options).map(o => o.textContent.trim());
      }
    }

    if (texts.length === 0) {
      const allText = wrapper.textContent.trim();
      if (allText) {
        texts = allText.split('\n').map(t => t.trim()).filter(Boolean);
      }
    }

    return texts;
  });
}

// ---------- MAIN ----------
(async () => {
  console.log(`📄 Reading CSV: ${INPUT_CSV}`);
  let urls = [];
  try {
    urls = await readUrls();
  } catch (err) {
    console.error(`❌ Could not read '${INPUT_CSV}':`, err.message);
    return;
  }

  if (!urls.length) {
    console.error(`❌ No URLs found in '${INPUT_CSV}'.`);
    return;
  }

  console.log(`📋 ${urls.length} URL(s) loaded.`);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  const results = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    console.log(`\n🔍 Processing [${i+1}/${urls.length}]: ${url}`);
    const opts = await getDropdownOptions(page, url, i+1);
    if (opts.length) {
      opts.forEach(o => results.push({ URL: url, Option: o }));
    } else {
      results.push({ URL: url, Option: 'NO OPTIONS FOUND' });
    }
    await sleep(2000);
  }

  await browser.close();

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Dropdown Options');
  ws.columns = [
    { header: 'URL', key: 'URL', width: 70 },
    { header: 'Option', key: 'Option', width: 50 }
  ];
  results.forEach(r => ws.addRow(r));
  await wb.xlsx.writeFile(OUTPUT_EXCEL);
  console.log(`\n✅ Report saved to ${OUTPUT_EXCEL}`);
})();