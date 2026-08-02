#!/usr/bin/env node

/**
 * Fund API vs UI Validation Script
 * ---------------------------------
 * Reads a configuration file (JSON) with a list of funds, each specifying
 * the API URL, page URL, and the fields to validate.
 * For each fund, it fetches the API data, extracts UI values using selectors,
 * normalises both sides, compares them, and generates a detailed report.
 */

const { chromium } = require('playwright');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================
// 1. NORMALIZATION FUNCTIONS (built-in)
// ============================================================

const NORMALIZERS = {
  // Simple trim
  trim: (val) => (val ?? '').toString().trim(),

  // Percentage: remove '%', parse to number, format to 2 decimals
  percent: (val) => {
    if (typeof val === 'string') {
      val = val.replace(/%/g, '').trim();
    }
    const num = parseFloat(val);
    return isNaN(num) ? '' : num.toFixed(2);
  },

  // Currency: remove '$', commas, parse number, return as string with no decimals
  currency: (val) => {
    if (typeof val === 'string') {
      // Handle suffixes like K, M, B (e.g., "$940.8M")
      const wordNormalized = val
        .replace(/million/gi, 'M')
        .replace(/billion/gi, 'B')
        .replace(/thousand/gi, 'K');
      const clean = wordNormalized.replace(/[$,\s]/g, '').trim();
      const match = clean.match(/^([\d.]+)\s*([KMB]?)$/i);
      if (match) {
        let num = parseFloat(match[1]);
        const suffix = match[2].toUpperCase();
        if (suffix === 'K') num *= 1e3;
        else if (suffix === 'M') num *= 1e6;
        else if (suffix === 'B') num *= 1e9;
        return num.toFixed(0);
      }
      return clean;
    }
    // API raw number
    const num = parseFloat(val);
    return isNaN(num) ? '' : num.toFixed(0);
  },

  // Date: try to parse and format as YYYY-MM-DD (or just trim)
  date: (val) => {
    if (typeof val === 'string') {
      // Attempt to parse common date formats
      const trimmed = val.trim();
      // If it looks like a date with slashes, try to standardize
      // For simplicity, we just trim and return as-is – you can enhance this
      return trimmed;
    }
    return (val ?? '').toString().trim();
  },

  // Number: parse float, keep as string with 2 decimals (or as-is)
  number: (val) => {
    const num = parseFloat(val);
    return isNaN(num) ? '' : num.toString();
  }
};

// ============================================================
// 2. HELPERS
// ============================================================

/**
 * Load configuration from JSON file.
 */
function loadConfig(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function parseCsvRows(rawCsv) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < rawCsv.length; i += 1) {
    const ch = rawCsv[i];

    if (ch === '"') {
      if (inQuotes && rawCsv[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }

    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && rawCsv[i + 1] === '\n') {
        i += 1;
      }

      row.push(cell);
      if (row.some((value) => (value || '').trim().length > 0)) {
        rows.push(row);
      }
      row = [];
      cell = '';
      continue;
    }

    cell += ch;
  }

  row.push(cell);
  if (row.some((value) => (value || '').trim().length > 0)) {
    rows.push(row);
  }

  return rows;
}

function resolveTickerCsvPath(configPath, tickerCsv) {
  if (!tickerCsv || typeof tickerCsv !== 'string') {
    throw new Error('tickerCsv must be a non-empty string when provided.');
  }

  return path.isAbsolute(tickerCsv)
    ? tickerCsv
    : path.resolve(path.dirname(configPath), tickerCsv);
}

function loadFundCodesFromCsv(csvPath, csvColumn) {
  if (!fs.existsSync(csvPath)) {
    throw new Error(`Ticker CSV file not found: ${csvPath}`);
  }

  const raw = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsvRows(raw);
  if (rows.length === 0) {
    return [];
  }

  const header = rows[0].map((cell) => (cell || '').trim());
  const dataRows = rows.slice(1);
  if (dataRows.length === 0) {
    return [];
  }

  const requestedColumn = (csvColumn || '').toString().trim().toLowerCase();
  let columnIndex = -1;
  if (requestedColumn) {
    columnIndex = header.findIndex((h) => h.toLowerCase() === requestedColumn);
  }

  if (columnIndex < 0) {
    columnIndex = header.findIndex((h) => {
      const value = h.toLowerCase();
      return value === 'fundcode' || value === 'ticker';
    });
  }

  if (columnIndex < 0) {
    columnIndex = 0;
  }

  const uniqueCodes = new Set();
  for (const row of dataRows) {
    const value = (row[columnIndex] || '').toString().trim();
    if (value) {
      uniqueCodes.add(value);
    }
  }

  return [...uniqueCodes];
}

/**
 * Ensure a directory exists; create if not.
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function escapeHtml(value) {
  return (value ?? '')
    .toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTimestampForFilename(dateValue = new Date()) {
  const year = dateValue.getFullYear();
  const month = String(dateValue.getMonth() + 1).padStart(2, '0');
  const day = String(dateValue.getDate()).padStart(2, '0');
  const hours = String(dateValue.getHours()).padStart(2, '0');
  const minutes = String(dateValue.getMinutes()).padStart(2, '0');
  const seconds = String(dateValue.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}_${hours}${minutes}${seconds}`;
}

function sanitizeForFilename(value) {
  return (value || 'share-class')
    .toString()
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function getDefaultReportPaths(configPath, configs) {
  const reportsDir = path.join(path.dirname(configPath), 'reports');
  const shareClassRaw = configs.length === 1
    ? (configs[0].fundCode || configs[0].shareClass || 'share-class')
    : 'multi-share-class';
  const shareClass = sanitizeForFilename(shareClassRaw);
  const stamp = formatTimestampForFilename(new Date());
  const baseName = `${shareClass}_validation-report_${stamp}`;

  return {
    json: path.join(reportsDir, `${baseName}.json`),
    html: path.join(reportsDir, `${baseName}.html`),
    excel: path.join(reportsDir, `${baseName}.xlsx`)
  };
}

function applyTemplateString(value, vars) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{(\w+)\}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : '';
  });
}

function resolveConfigTemplates(value, vars) {
  if (Array.isArray(value)) {
    return value.map((item) => resolveConfigTemplates(item, vars));
  }

  if (value && typeof value === 'object') {
    const resolved = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      resolved[key] = resolveConfigTemplates(nestedValue, vars);
    }
    return resolved;
  }

  return applyTemplateString(value, vars);
}

function expandConfigs(configs, configPath) {
  const expanded = [];

  for (const config of configs) {
    const fundCodes = Array.isArray(config.fundCodes) ? config.fundCodes : null;
    if (fundCodes && fundCodes.length > 0) {
      for (const code of fundCodes) {
        const trimmed = (code ?? '').toString().trim();
        if (!trimmed) continue;
        const clone = { ...config, fundCode: trimmed };
        delete clone.fundCodes;
        expanded.push(clone);
      }
      continue;
    }

    if (typeof config.tickerCsv === 'string' && config.tickerCsv.trim().length > 0) {
      const csvPath = resolveTickerCsvPath(configPath, config.tickerCsv);
      const csvFundCodes = loadFundCodesFromCsv(csvPath, config.csvColumn);

      for (const code of csvFundCodes) {
        const clone = { ...config, fundCode: code };
        delete clone.fundCodes;
        expanded.push(clone);
      }
      continue;
    }

    expanded.push(config);
  }

  return expanded;
}

function buildHtmlReport(reportData) {
  const { timestamp, totalFunds, passedFunds, failedFunds, reports } = reportData;
  const overallPassPct = totalFunds > 0 ? Math.round((passedFunds / totalFunds) * 100) : 0;

  const fundSections = reports.map((report) => {
    const totalFields = report.fields.length;
    const passFields = report.fields.filter((f) => f.passed).length;
    const fieldPassPct = totalFields > 0 ? Math.round((passFields / totalFields) * 100) : 0;
    const uiChecksRows = (report.uiChecks || []).map((check) => {
      const statusClass = check.passed ? 'pass' : 'fail';
      return `
        <tr>
          <td>${escapeHtml(check.label)}</td>
          <td>${escapeHtml(check.expectedText || '')}</td>
          <td>${escapeHtml(check.actualText || '')}</td>
          <td class="${statusClass}">${check.passed ? 'PASS' : 'FAIL'}</td>
        </tr>`;
    }).join('');

    const fieldRows = report.fields.map((field) => {
      const statusClass = field.passed ? 'pass' : 'fail';
      return `
        <tr>
          <td>${escapeHtml(field.label)}</td>
          <td>${escapeHtml(typeof field.apiField === 'string' ? field.apiField : JSON.stringify(field.apiField))}</td>
          <td>${escapeHtml(field.apiRaw == null ? '' : field.apiRaw)}</td>
          <td>${escapeHtml(field.uiShownValue == null ? (field.uiRaw == null ? '' : field.uiRaw) : field.uiShownValue)}</td>
          <td class="${statusClass}">${field.passed ? 'PASS' : 'FAIL'}</td>
        </tr>`;
    }).join('');

    const errors = (report.errors || []).map((err) => `<li>${escapeHtml(err)}</li>`).join('');
    const screenshot = report.screenshotPath
      ? `<p><strong>Screenshot:</strong> ${escapeHtml(report.screenshotPath)}</p>`
      : '';

    return `
      <section class="card">
        <h2>Fund ${escapeHtml(report.fundCode)} - ${report.passed ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>'}</h2>
        <p><strong>API URL:</strong> ${escapeHtml(report.apiUrl)}</p>
        <p><strong>Page URL:</strong> ${escapeHtml(report.pageUrl)}</p>
        <p><strong>Timestamp:</strong> ${escapeHtml(report.timestamp)}</p>
        <div class="progress-wrap">
          <div class="progress-label">Field Match Score: ${fieldPassPct}% (${passFields}/${totalFields})</div>
          <div class="progress-bar"><span style="width:${fieldPassPct}%"></span></div>
        </div>
        ${screenshot}
        ${errors ? `<div><strong>Errors:</strong><ul>${errors}</ul></div>` : ''}

        <h3>UI Checks</h3>
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Expected</th>
              <th>Actual</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${uiChecksRows || '<tr><td colspan="4">No UI checks</td></tr>'}
          </tbody>
        </table>

        <h3>Field Validation</h3>
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>API Field</th>
              <th>API Value</th>
              <th>UI Value</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${fieldRows}
          </tbody>
        </table>
      </section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Fund API vs UI Validation Report</title>
  <style>
    body { font-family: Segoe UI, Arial, sans-serif; margin: 20px; color: #1f2937; background: #f6f8fb; }
    h1, h2, h3 { margin: 0 0 10px 0; }
    .summary { display: flex; gap: 16px; margin: 16px 0; flex-wrap: wrap; }
    .pill { background: #fff; border: 1px solid #d1d5db; border-radius: 999px; padding: 8px 14px; }
    .card { background: #fff; border: 1px solid #d1d5db; border-radius: 10px; padding: 16px; margin: 18px 0; }
    .hero { background: #fff; border: 1px solid #d1d5db; border-radius: 10px; padding: 14px; margin: 16px 0 20px; display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
    .score-ring { width: 92px; height: 92px; border-radius: 50%; display: grid; place-items: center; background: conic-gradient(#0f766e ${overallPassPct}%, #e5e7eb 0); }
    .score-ring::before { content: ''; width: 68px; height: 68px; border-radius: 50%; background: #fff; position: absolute; }
    .score-ring-value { position: relative; font-weight: 700; font-size: 18px; }
    .progress-wrap { margin: 12px 0 8px; }
    .progress-label { font-size: 13px; margin-bottom: 6px; }
    .progress-bar { height: 9px; background: #e5e7eb; border-radius: 999px; overflow: hidden; }
    .progress-bar > span { display: block; height: 100%; background: linear-gradient(90deg, #0f766e, #1d4ed8); }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { border: 1px solid #e5e7eb; padding: 8px; font-size: 13px; text-align: left; vertical-align: top; }
    th { background: #f3f4f6; }
    .pass { color: #0f766e; font-weight: 700; }
    .fail { color: #b91c1c; font-weight: 700; }
  </style>
</head>
<body>
  <h1>Fund API vs UI Validation Report</h1>
  <p><strong>Generated:</strong> ${escapeHtml(timestamp)}</p>
  <div class="summary">
    <div class="pill">Funds tested: <strong>${totalFunds}</strong></div>
    <div class="pill">Passed: <strong class="pass">${passedFunds}</strong></div>
    <div class="pill">Failed: <strong class="fail">${failedFunds}</strong></div>
  </div>
  <section class="hero">
    <div class="score-ring"><div class="score-ring-value">${overallPassPct}%</div></div>
    <div>
      <h3>Overall Validation Score</h3>
      <div>Score is based on funds that passed all configured field comparisons.</div>
    </div>
  </section>
  ${fundSections}
</body>
</html>`;
}

async function writeExcelReport(reportData, excelPath) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Fund API Validator';
  workbook.created = new Date();

  const summarySheet = workbook.addWorksheet('Summary');
  summarySheet.columns = [
    { header: 'Metric', key: 'metric', width: 30 },
    { header: 'Value', key: 'value', width: 40 }
  ];
  summarySheet.addRows([
    { metric: 'Generated Timestamp', value: reportData.timestamp },
    { metric: 'Funds Tested', value: reportData.totalFunds },
    { metric: 'Funds Passed', value: reportData.passedFunds },
    { metric: 'Funds Failed', value: reportData.failedFunds }
  ]);

  const fieldsSheet = workbook.addWorksheet('Field Validation');
  fieldsSheet.columns = [
    { header: 'Fund', key: 'fund', width: 14 },
    { header: 'Label', key: 'label', width: 34 },
    { header: 'API Field', key: 'apiField', width: 42 },
    { header: 'API Raw', key: 'apiRaw', width: 24 },
    { header: 'UI Raw', key: 'uiRaw', width: 24 },
    { header: 'API Value', key: 'apiDisplay', width: 26 },
    { header: 'UI Value', key: 'uiDisplay', width: 26 },
    { header: 'Status', key: 'status', width: 12 }
  ];

  for (const report of reportData.reports) {
    for (const field of report.fields) {
      fieldsSheet.addRow({
        fund: report.fundCode,
        label: field.label,
        apiField: typeof field.apiField === 'string' ? field.apiField : JSON.stringify(field.apiField),
        apiRaw: field.apiRaw == null ? '' : String(field.apiRaw),
        uiRaw: field.uiShownValue == null
          ? (field.uiRaw == null ? '' : String(field.uiRaw))
          : String(field.uiShownValue),
        apiDisplay: field.apiRaw == null ? '' : String(field.apiRaw),
        uiDisplay: field.uiRaw == null ? '' : String(field.uiRaw),
        status: field.passed ? 'PASS' : 'FAIL'
      });
    }
  }

  const uiSheet = workbook.addWorksheet('UI Checks');
  uiSheet.columns = [
    { header: 'Fund', key: 'fund', width: 14 },
    { header: 'Label', key: 'label', width: 34 },
    { header: 'Expected', key: 'expected', width: 24 },
    { header: 'Actual', key: 'actual', width: 24 },
    { header: 'Required', key: 'required', width: 12 },
    { header: 'Status', key: 'status', width: 12 }
  ];

  for (const report of reportData.reports) {
    for (const check of report.uiChecks || []) {
      uiSheet.addRow({
        fund: report.fundCode,
        label: check.label,
        expected: check.expectedText || '',
        actual: check.actualText || '',
        required: check.required ? 'Yes' : 'No',
        status: check.passed ? 'PASS' : 'FAIL'
      });
    }
  }

  for (const sheet of [summarySheet, fieldsSheet, uiSheet]) {
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1F2937' } };
    headerRow.alignment = { vertical: 'middle', horizontal: 'left' };
  }

  fieldsSheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const statusCell = row.getCell(8);
    if (statusCell.value === 'PASS') {
      statusCell.font = { bold: true, color: { argb: '0F766E' } };
    } else {
      statusCell.font = { bold: true, color: { argb: 'B91C1C' } };
    }
  });

  uiSheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const statusCell = row.getCell(6);
    if (statusCell.value === 'PASS') {
      statusCell.font = { bold: true, color: { argb: '0F766E' } };
    } else {
      statusCell.font = { bold: true, color: { argb: 'B91C1C' } };
    }
  });

  await workbook.xlsx.writeFile(excelPath);
}

/**
 * Resolve a nested object path using dot notation (e.g., "a.b.c").
 */
function getValueByPath(obj, pathExpression) {
  if (!pathExpression || typeof pathExpression !== 'string') {
    return undefined;
  }

  return pathExpression.split('.').reduce((acc, key) => {
    if (acc == null) return undefined;
    return acc[key];
  }, obj);
}

/**
 * Resolve API value from a string path or object rule.
 */
function resolveApiValue(apiData, apiField) {
  if (typeof apiField === 'string') {
    return getValueByPath(apiData, apiField);
  }

  if (!apiField || typeof apiField !== 'object') {
    return undefined;
  }

  if (apiField.type === 'arrayFind') {
    const sourceArray = getValueByPath(apiData, apiField.source);
    if (!Array.isArray(sourceArray)) return undefined;

    const whereField = apiField?.where?.field;
    const whereEquals = apiField?.where?.equals;
    const pickField = apiField.pick;
    if (!whereField || typeof pickField !== 'string') return undefined;

    const match = sourceArray.find((item) => {
      const actual = item?.[whereField];
      if (typeof whereEquals === 'undefined') {
        return typeof actual !== 'undefined';
      }
      return String(actual).toLowerCase() === String(whereEquals).toLowerCase();
    });

    return match ? match[pickField] : undefined;
  }

  return undefined;
}

/**
 * Extract a value using a regex. If a capture group exists, use group 1.
 */
function extractWithRegexDetails(value, regexPattern) {
  if (typeof regexPattern !== 'string' || regexPattern.length === 0) {
    const fallback = value == null ? '' : String(value);
    return { value: fallback, matchedText: fallback };
  }

  const text = (value ?? '').toString();
  const match = text.match(new RegExp(regexPattern));
  if (!match) return { value: '', matchedText: '' };

  return {
    value: typeof match[1] !== 'undefined' ? match[1] : match[0],
    matchedText: match[0]
  };
}

function isPageInTemporaryErrorState(pageText) {
  const text = (pageText || '').toLowerCase();
  return (
    text.includes('experiencing technical difficulties') ||
    text.includes('submitting your request...') ||
    text.includes('category name')
  );
}

/**
 * Fetch API data with timeout.
 */
async function fetchApiData(apiUrl, timeout = 10000, headers = {}, apiTls = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const resolvedHeaders = { ...headers };
  // Allow a placeholder to auto-generate a unique message id per request.
  if (
    !resolvedHeaders['X-NW-Message-ID'] ||
    resolvedHeaders['X-NW-Message-ID'] === 'headerMsgId'
  ) {
    resolvedHeaders['X-NW-Message-ID'] = crypto.randomUUID();
  }

  const allowSelfSigned = apiTls && apiTls.allowSelfSigned === true;
  const previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (allowSelfSigned) {
    // Non-prod helper: allows internal cert chains that are not trusted locally.
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  try {
    const response = await fetch(apiUrl, {
      signal: controller.signal,
      headers: resolvedHeaders
    });
    clearTimeout(timer);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    clearTimeout(timer);
    const causeMessage = error?.cause?.message ? ` | cause: ${error.cause.message}` : '';
    throw new Error(`API request failed: ${error.message}${causeMessage}`);
  } finally {
    if (allowSelfSigned) {
      if (typeof previousTlsSetting === 'undefined') {
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      } else {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting;
      }
    }
  }
}

/**
 * Extract UI value using a selector.
 */
async function getUiValue(page, selector, timeout = 5000) {
  try {
    const element = await page.locator(selector).first();
    await element.waitFor({ state: 'visible', timeout });
    const text = await element.textContent();
    return (text || '').trim();
  } catch (error) {
    console.warn(`  ⚠️ Could not read selector "${selector}" – ${error.message}`);
    return '';
  }
}

/**
 * Count matching child elements within a root selector.
 */
async function getUiCount(page, selector, countSelector, timeout = 5000) {
  try {
    const root = page.locator(selector).first();
    await root.waitFor({ state: 'visible', timeout });
    const matcher = countSelector ? root.locator(countSelector) : root.locator('*');
    const count = await matcher.count();
    return count.toString();
  } catch (error) {
    console.warn(`  ⚠️ Could not count elements for selector "${selector}" – ${error.message}`);
    return '';
  }
}

/**
 * Wait until core fund values appear on the page (not placeholders).
 */
async function waitForFundDataReady(page, apiData, timeout = 30000) {
  const requiredValues = [
    apiData?.fundName,
    apiData?.cusip,
    apiData?.inceptionDate,
    apiData?.morningstarCategory
  ]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim());

  if (requiredValues.length === 0) {
    return;
  }

  await page.waitForFunction(
    (values) => {
      const bodyText = document.body?.innerText || '';
      return values.every((value) => bodyText.includes(value));
    },
    requiredValues,
    { timeout }
  );
}

/**
 * Validate presence (and optional text) of required UI components.
 */
async function runUiChecks(page, uiChecks = []) {
  const results = [];

  for (const check of uiChecks) {
    const {
      label,
      selector,
      expectedText,
      matchType = 'contains',
      timeout = 10000,
      required = true
    } = check;
    let passed = false;
    let actualText = '';
    let error = '';

    try {
      const element = page.locator(selector).first();
      await element.waitFor({ state: 'visible', timeout });
      actualText = ((await element.textContent()) || '').trim();

      if (typeof expectedText === 'string' && expectedText.length > 0) {
        const expected = expectedText.trim();
        const mode = (matchType || 'contains').toLowerCase();

        if (mode === 'equals') {
          passed = actualText === expected;
        } else if (mode === 'regex') {
          const pattern = new RegExp(expected);
          passed = pattern.test(actualText);
        } else {
          // Default behavior is a resilient contains check.
          passed = actualText.includes(expected);
        }
      } else {
        passed = true;
      }

      // Optional checks are reported but should not fail the run.
      if (!required && !passed) {
        passed = true;
      }
    } catch (e) {
      error = e.message;
      passed = required ? false : true;
    }

    results.push({
      label,
      matchType,
      required,
      expectedText: expectedText || null,
      actualText,
      passed,
      error
    });
  }

  return results;
}

/**
 * Apply normalization based on type.
 */
function normalizeValue(value, type) {
  const normalizer = NORMALIZERS[type] || NORMALIZERS.trim;
  return normalizer(value);
}

function compareFieldValues(apiNorm, uiNorm, field = {}) {
  const mode = field.compareMode || 'strict';

  if (mode === 'currencyRoundedMillion1dp') {
    const apiNum = parseFloat(apiNorm);
    const uiNum = parseFloat(uiNorm);
    if (!isNaN(apiNum) && !isNaN(uiNum)) {
      const roundedApi = Math.round((apiNum / 1e6) * 10) / 10;
      const roundedUi = Math.round((uiNum / 1e6) * 10) / 10;
      return roundedApi === roundedUi;
    }
  }

  return apiNorm === uiNorm;
}

// ============================================================
// 3. MAIN VALIDATION FUNCTION
// ============================================================

/**
 * Validate a single fund configuration.
 */
async function validateFund(config, browser) {
  const {
    fundCode,
    apiUrl,
    pageUrl,
    pageUrls,
    fields,
    uiChecks = [],
    apiHeaders = {},
    apiTls = {},
    pageLoad = {}
  } = config;

  const targetPageUrls = Array.isArray(pageUrls) && pageUrls.length > 0
    ? pageUrls
    : [pageUrl].filter(Boolean);

  console.log(`\n🔍 Validating fund: ${fundCode}`);
  console.log(`   API : ${apiUrl}`);
  console.log(`   Page candidates: ${targetPageUrls.join(' | ')}`);

  const report = {
    fundCode,
    apiUrl,
    pageUrl: targetPageUrls[0] || '',
    attemptedPageUrls: targetPageUrls,
    timestamp: new Date().toISOString(),
    passed: false,
    fields: [],
    uiChecks: [],
    errors: [],
    screenshotPath: null
  };

  // --- Step 1: Fetch API data ---
  let apiData;
  try {
    apiData = await fetchApiData(apiUrl, 10000, apiHeaders, apiTls);
  } catch (error) {
    const msg = `API error: ${error.message}`;
    report.errors.push(msg);
    console.error(`  ❌ ${msg}`);
    return report;
  }

  // --- Step 2: Open page ---
  const page = await browser.newPage();
  try {
    const timeout = Number(pageLoad.timeoutMs) > 0 ? Number(pageLoad.timeoutMs) : 60000;
    const primaryWaitUntil = pageLoad.waitUntil || 'domcontentloaded';
    const maxHealthRetries = Number(pageLoad.retries) >= 0 ? Number(pageLoad.retries) : 2;
    const waitStrategy = [primaryWaitUntil, 'load', 'networkidle'].filter(
      (value, index, arr) => arr.indexOf(value) === index
    );

    let selectedPageUrl = '';
    let lastPageError = null;

    for (const candidateUrl of targetPageUrls) {
      let pageIsUsable = false;
      let navigationError = null;

      for (const waitUntil of waitStrategy) {
        try {
          await page.goto(candidateUrl, { waitUntil, timeout });
          navigationError = null;
          break;
        } catch (err) {
          if (err?.message && err.message.includes('interrupted by another navigation')) {
            await page.waitForLoadState('domcontentloaded', { timeout });
            navigationError = null;
            break;
          }
          navigationError = err;
        }
      }

      if (navigationError) {
        lastPageError = navigationError;
        continue;
      }

      for (let healthAttempt = 0; healthAttempt <= maxHealthRetries; healthAttempt += 1) {
        if (healthAttempt > 0) {
          console.warn(`  ⚠️ Page data not ready (${candidateUrl}) attempt ${healthAttempt}/${maxHealthRetries}. Retrying page load...`);
          await page.reload({ waitUntil: primaryWaitUntil, timeout });
        }

        try {
          await waitForFundDataReady(page, apiData, Math.min(timeout, 30000));
        } catch (waitErr) {
          console.warn(`  ⚠️ Data readiness wait timed out on ${candidateUrl} attempt ${healthAttempt + 1}: ${waitErr.message}`);
        }

        const pageText = await page.locator('body').innerText();
        if (!isPageInTemporaryErrorState(pageText)) {
          pageIsUsable = true;
          break;
        }
      }

      if (pageIsUsable) {
        selectedPageUrl = candidateUrl;
        break;
      }

      lastPageError = new Error(`Page loaded but stayed in temporary/incomplete state: ${candidateUrl}`);
    }

    if (!selectedPageUrl) {
      throw lastPageError || new Error('No usable page URL found');
    }

    report.pageUrl = selectedPageUrl;
    console.log(`  ✅ Using page URL: ${selectedPageUrl}`);

    // Use explicit UI checks first when provided, else fall back to first data field.
    if (uiChecks.length > 0) {
      const checks = await runUiChecks(page, uiChecks);
      report.uiChecks = checks;
      const failedChecks = checks.filter((c) => !c.passed);

      if (failedChecks.length > 0) {
        for (const failed of failedChecks) {
          const msg = `UI check failed: ${failed.label}${failed.error ? ` - ${failed.error}` : ''}`;
          report.errors.push(msg);
          console.error(`  ❌ ${msg}`);
        }
      } else {
        console.log(`  ✅ UI checks passed (${checks.length})`);
      }
    } else if (fields.length > 0) {
      const firstSelector = fields[0].selector;
      await page.locator(firstSelector).first().waitFor({ state: 'visible', timeout: 10000 });
    }
  } catch (error) {
    const msg = `Page navigation error: ${error.message}`;
    report.errors.push(msg);
    console.error(`  ❌ ${msg}`);
    await page.close();
    return report;
  }

  // --- Step 3: Validate each field ---
  let allPassed = true;
  let cachedPageText = null;

  for (const field of fields) {
    const {
      label,
      apiField,
      selector,
      normalize = 'trim',
      uiRegex,
      timeout = 5000,
      uiSource = 'selector',
      uiExtract,
      countSelector
    } = field;

    // Get raw values
    const apiRaw = resolveApiValue(apiData, apiField);
    let uiRawExtracted = '';
    if (uiSource === 'pageTitle') {
      uiRawExtracted = await page.title();
    } else if (uiSource === 'pageText') {
      if (cachedPageText == null) {
        cachedPageText = await page.locator('body').innerText();
      }
      uiRawExtracted = cachedPageText;
    } else if (uiExtract === 'count') {
      uiRawExtracted = await getUiCount(page, selector, countSelector, timeout);
    } else {
      uiRawExtracted = await getUiValue(page, selector, timeout);
    }

    const regexDetails = extractWithRegexDetails(uiRawExtracted, uiRegex);
    const uiRaw = regexDetails.value;
    const uiShownValue = regexDetails.matchedText || uiRaw;

    // Normalize
    const apiNorm = normalizeValue(apiRaw, normalize);
    const uiNorm = normalizeValue(uiRaw, normalize);

    const passed = compareFieldValues(apiNorm, uiNorm, field);
    if (!passed) allPassed = false;

    const result = {
      label,
      apiField,
      apiRaw,
      uiRaw,
      uiShownValue,
      apiNorm,
      uiNorm,
      passed
    };
    report.fields.push(result);

    // Log
    const status = passed ? '✅' : '❌';
    console.log(`  ${status} ${label}`);
    if (!passed) {
      console.log(`     Expected: ${apiNorm} (raw: ${apiRaw})`);
      console.log(`     Actual  : ${uiNorm} (raw: ${uiRaw})`);
    }
  }

  // --- Step 4: Screenshot on failure ---
  if (!allPassed) {
    const screenshotDir = path.join(__dirname, 'screenshots');
    ensureDir(screenshotDir);
    const filename = `${fundCode}_${Date.now()}.png`;
    const screenshotPath = path.join(screenshotDir, filename);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    report.screenshotPath = screenshotPath;
    console.log(`  📸 Screenshot saved: ${screenshotPath}`);
  }

  await page.close();

  report.passed = allPassed;
  const total = report.fields.length;
  const passedCount = report.fields.filter(f => f.passed).length;
  const failedCount = total - passedCount;
  console.log(`  Summary: ${passedCount}/${total} passed, ${failedCount} failed`);

  return report;
}

// ============================================================
// 4. RUNNER
// ============================================================

async function run() {
  // Command-line arguments: config file path, optional report path
  const args = process.argv.slice(2);
  const configPath = args[0] || path.join(__dirname, 'test-config.json');

  // Load config first so the default report name can include share class.
  let configs;
  try {
    configs = loadConfig(configPath);
  } catch (error) {
    console.error(`❌ Failed to load config: ${error.message}`);
    process.exit(1);
  }

  if (!Array.isArray(configs) || configs.length === 0) {
    console.error('❌ Config must be a non-empty array of fund objects.');
    process.exit(1);
  }

  configs = expandConfigs(configs, configPath);
  if (configs.length === 0) {
    console.error('❌ No valid fund configs found after fundCodes/tickerCsv expansion.');
    process.exit(1);
  }

  const defaultPaths = getDefaultReportPaths(configPath, configs);
  const reportPath = args[1] || defaultPaths.json;
  const htmlReportPath = args[2] || defaultPaths.html;
  const excelReportPath = args[3] || defaultPaths.excel;

  console.log('========================================');
  console.log(' Fund API vs UI Validation');
  console.log('========================================');
  console.log(`Config: ${configPath}`);
  console.log(`Report: ${reportPath}`);
  console.log(`HTML  : ${htmlReportPath}`);
  console.log(`Excel : ${excelReportPath}`);

  console.log(`\nLoaded ${configs.length} fund(s) to validate.`);

  const globalHeadless = process.env.HEADLESS !== 'false';
  // Launch browser once; can override with HEADLESS=false when needed.
  const browser = await chromium.launch({ headless: globalHeadless });

  const allReports = [];
  for (const config of configs) {
    const runtimeConfig = resolveConfigTemplates(config, { fundCode: config.fundCode });

    // Ensure required fields exist
    const hasPage = Boolean(runtimeConfig.pageUrl) || (Array.isArray(runtimeConfig.pageUrls) && runtimeConfig.pageUrls.length > 0);
    if (!runtimeConfig.fundCode || !runtimeConfig.apiUrl || !hasPage || !Array.isArray(runtimeConfig.fields)) {
      console.error(`⚠️ Skipping invalid config: missing required fields.`, config);
      continue;
    }
    const report = await validateFund(runtimeConfig, browser);
    allReports.push(report);
  }

  await browser.close();

  // Summary
  const totalFunds = allReports.length;
  const passedFunds = allReports.filter(r => r.passed).length;
  const failedFunds = totalFunds - passedFunds;

  console.log('\n\n========== FINAL SUMMARY ==========');
  console.log(`Funds tested : ${totalFunds}`);
  console.log(`Passed       : ${passedFunds}`);
  console.log(`Failed       : ${failedFunds}`);
  console.log('=====================================\n');

  // Write JSON report
  const reportData = {
    timestamp: new Date().toISOString(),
    totalFunds,
    passedFunds,
    failedFunds,
    reports: allReports
  };
  ensureDir(path.dirname(reportPath));
  fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2), 'utf8');
  console.log(`📄 Report saved: ${reportPath}`);

  // Write HTML report
  const html = buildHtmlReport(reportData);
  fs.writeFileSync(htmlReportPath, html, 'utf8');
  console.log(`📄 HTML report saved: ${htmlReportPath}`);

  // Write Excel report
  await writeExcelReport(reportData, excelReportPath);
  console.log(`📄 Excel report saved: ${excelReportPath}`);

  // Exit with non-zero code if any failure (for CI)
  process.exit(failedFunds > 0 ? 1 : 0);
}

// ============================================================
// 5. EXECUTE
// ============================================================

if (require.main === module) {
  run().catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}

module.exports = { validateFund, loadConfig };