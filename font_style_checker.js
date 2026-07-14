const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');

// ===== CONFIG =====
const CSV_FILE = 'urls.csv';
const HTML_REPORT = 'report.html';

const TARGET_TAG = 'ngx-nationwide-multi-option-promo';
const INNER_TAG = 'h2';
const STYLE_PROPS = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'color',
  'line-height',
];

// ===== SCRAPE LOGIC =====
async function scrapeUrl(url) {
  console.log(`  → Navigating to ${url}`);
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  // Set a reasonable timeout
  page.setDefaultTimeout(20000);

  const result = {
    url,
    componentFound: false,
    h2Found: false,
    h2Text: '',
    error: '',
    styles: {},
  };

  // Initialize styles to N/A
  for (const prop of STYLE_PROPS) {
    result.styles[prop] = 'N/A';
  }

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Run the extraction in the browser context
    const data = await page.evaluate(
      (target, inner, props) => {
        const output = {
          componentFound: false,
          h2Found: false,
          h2Text: '',
          error: '',
          styles: {},
        };

        // Find the custom component
        const component = document.querySelector(target);
        if (!component) {
          output.error = `Component "${target}" not found.`;
          return output;
        }
        output.componentFound = true;

        // Find <h2> inside the component
        const h2 = component.querySelector(inner);
        if (!h2) {
          output.error = `Component found, but no <${inner}> inside.`;
          output.h2Found = false;
          return output;
        }
        output.h2Found = true;
        output.h2Text = h2.textContent.trim() || '(empty text)';

        // Get computed styles
        const computed = getComputedStyle(h2);
        for (const prop of props) {
          output.styles[prop] = computed.getPropertyValue(prop) || 'N/A';
        }

        return output;
      },
      TARGET_TAG,
      INNER_TAG,
      STYLE_PROPS
    );

    // Merge results
    result.componentFound = data.componentFound;
    result.h2Found = data.h2Found;
    result.h2Text = data.h2Text;
    result.error = data.error;
    for (const prop of STYLE_PROPS) {
      if (data.styles[prop]) {
        result.styles[prop] = data.styles[prop];
      }
    }
  } catch (err) {
    result.error = `Navigation or evaluation error: ${err.message}`;
  }

  await browser.close();
  return result;
}

// ===== GENERATE HTML REPORT =====
function generateHtmlReport(results, timestamp) {
  const total = results.length;
  const compFound = results.filter((r) => r.componentFound).length;
  const h2Found = results.filter((r) => r.h2Found).length;
  const notFound = total - compFound;

  // Build table rows
  let rows = '';
  for (const row of results) {
    let rowClass = 'row-missing';
    if (row.componentFound && row.h2Found) rowClass = 'row-ok';
    else if (row.componentFound && !row.h2Found) rowClass = 'row-no-h2';

    const errorEsc = row.error.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    rows += `
      <tr class="${rowClass}">
        <td class="url-cell">${row.url}</td>
        <td>${row.componentFound ? '✅ Yes' : '❌ No'}</td>
        <td>${row.h2Found ? '✅ Yes' : '❌ No'}</td>
        <td class="h2-text">${row.h2Text || '—'}</td>
        <td class="error-cell">${errorEsc || '—'}</td>
        <td>${row.styles['font-family']}</td>
        <td>${row.styles['font-size']}</td>
        <td>${row.styles['font-weight']}</td>
        <td>${row.styles['font-style']}</td>
        <td>${row.styles['color']}</td>
        <td>${row.styles['line-height']}</td>
      </tr>
    `;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>H2 Font Style Report</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', Roboto, system-ui, sans-serif;
      background: #f4f6fa;
      padding: 30px 20px;
      color: #1e293b;
    }
    .container {
      max-width: 1400px;
      margin: 0 auto;
    }
    .header {
      background: linear-gradient(135deg, #0f2b5b 0%, #1a4a8a 100%);
      color: white;
      padding: 30px 35px;
      border-radius: 16px;
      margin-bottom: 30px;
      box-shadow: 0 8px 30px rgba(15, 43, 91, 0.25);
    }
    .header h1 {
      font-size: 28px;
      font-weight: 600;
      letter-spacing: -0.3px;
    }
    .header h1 span {
      background: rgba(255,255,255,0.15);
      padding: 2px 14px;
      border-radius: 40px;
      font-size: 18px;
      font-weight: 400;
      margin-left: 12px;
    }
    .header .timestamp {
      margin-top: 8px;
      font-size: 15px;
      opacity: 0.85;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 18px;
      margin-bottom: 32px;
    }
    .card {
      background: white;
      padding: 20px 22px;
      border-radius: 14px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.06);
      border-left: 6px solid #94a3b8;
    }
    .card .num {
      font-size: 34px;
      font-weight: 700;
      line-height: 1.2;
    }
    .card .label {
      font-size: 14px;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      font-weight: 500;
      margin-top: 4px;
    }
    .card-total { border-left-color: #0f2b5b; }
    .card-found { border-left-color: #10b981; }
    .card-h2 { border-left-color: #3b82f6; }
    .card-missing { border-left-color: #ef4444; }

    .table-wrap {
      background: white;
      border-radius: 16px;
      padding: 6px 4px 4px 4px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.05);
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
      min-width: 1000px;
    }
    th {
      background: #f8fafc;
      padding: 14px 12px;
      text-align: left;
      font-weight: 600;
      color: #1e293b;
      border-bottom: 2px solid #e2e8f0;
      white-space: nowrap;
    }
    td {
      padding: 12px 12px;
      border-bottom: 1px solid #f1f5f9;
      vertical-align: middle;
    }
    .url-cell {
      max-width: 260px;
      word-break: break-all;
      font-weight: 500;
    }
    .h2-text {
      font-weight: 600;
      color: #0f2b5b;
      max-width: 180px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .error-cell {
      color: #b91c1c;
      font-size: 13px;
      max-width: 200px;
    }

    /* Row color coding */
    .row-ok { background-color: #f0fdf4; }
    .row-ok:hover { background-color: #dcfce7; }
    .row-no-h2 { background-color: #fffbeb; }
    .row-no-h2:hover { background-color: #fef3c7; }
    .row-missing { background-color: #fef2f2; }
    .row-missing:hover { background-color: #fee2e2; }

    .badge {
      display: inline-block;
      padding: 2px 10px;
      border-radius: 40px;
      font-size: 12px;
      font-weight: 600;
    }
    .badge-ok { background: #10b981; color: white; }
    .badge-warn { background: #f59e0b; color: white; }
    .badge-miss { background: #ef4444; color: white; }

    .footer {
      margin-top: 30px;
      text-align: center;
      color: #94a3b8;
      font-size: 14px;
      border-top: 1px solid #e2e8f0;
      padding-top: 24px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>
        🧾 H2 Font Style Report
        <span>${TARGET_TAG}</span>
      </h1>
      <div class="timestamp">
        📅 ${timestamp}
      </div>
    </div>

    <div class="summary">
      <div class="card card-total"><div class="num">${total}</div><div class="label">Total URLs</div></div>
      <div class="card card-found"><div class="num">${compFound}</div><div class="label">✅ Component Found</div></div>
      <div class="card card-h2"><div class="num">${h2Found}</div><div class="label">📝 &lt;h2&gt; Found</div></div>
      <div class="card card-missing"><div class="num">${notFound}</div><div class="label">❌ Component Missing</div></div>
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>URL</th>
            <th>Component</th>
            <th>&lt;h2&gt;</th>
            <th>H2 Text</th>
            <th>Error / Status</th>
            <th>font-family</th>
            <th>font-size</th>
            <th>font-weight</th>
            <th>font-style</th>
            <th>color</th>
            <th>line-height</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
    <div class="footer">
      Report generated by Node.js + Puppeteer • ${new Date().toISOString().split('T')[0]}
    </div>
  </div>
</body>
</html>`;
}

// ===== MAIN =====
async function main() {
  console.log('🚀 Starting Node.js scraper...');

  // 1. Read CSV
  const urls = [];
  await new Promise((resolve, reject) => {
    fs.createReadStream(CSV_FILE)
      .pipe(csv())
      .on('data', (row) => {
        if (row.url && row.url.trim()) {
          urls.push(row.url.trim());
        }
      })
      .on('end', resolve)
      .on('error', reject);
  });

  if (urls.length === 0) {
    console.error(`❌ No URLs found in "${CSV_FILE}". Please ensure it has a column named "url".`);
    process.exit(1);
  }

  console.log(`📄 Found ${urls.length} URL(s) to process.\n`);

  // 2. Scrape each URL sequentially
  const results = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    console.log(`[${i + 1}/${urls.length}] Processing...`);
    const result = await scrapeUrl(url);
    results.push(result);
    console.log(`     Component: ${result.componentFound ? '✅' : '❌'}  |  H2: ${result.h2Found ? '✅' : '❌'}`);
  }

  console.log('\n✅ Scraping complete.\n');

  // 3. Generate HTML report
  const timestamp = new Date().toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });

  const html = generateHtmlReport(results, timestamp);
  fs.writeFileSync(HTML_REPORT, html, 'utf8');

  console.log(`📊 Graphical HTML report saved to: ${HTML_REPORT}`);
  console.log(`   Open it in your browser to view the results.`);
}

// Run it
main().catch((err) => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});