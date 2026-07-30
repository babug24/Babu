/**
 * ============================================================
 *  compare-page.js  –  Complete E2E Full-Page Comparison
 * ============================================================
 *
 * Scans EVERY visible element on both DXA and Angular pages,
 * matches them 1-to-1 using a multi-signal scoring system,
 * compares all CSS properties + geometry + screenshots,
 * and produces one consolidated HTML report.
 *
 * Usage:
 *   node compare-page.js             → uses compare.config.js URLs (no prompts)
 *   node compare-page.js --prompt    → interactive URL entry
 * ============================================================
 */

const { chromium } = require('playwright');
const fs           = require('fs-extra');
const path         = require('path');
const inquirer     = require('inquirer');
const chalk        = require('chalk');

// ── Load global config ────────────────────────────────────────────────────────
const CONFIG     = require('./compare.config.js');
const USE_CONFIG = !process.argv.includes('--prompt');

// ── Output directories ────────────────────────────────────────────────────────
const screenshotsDir = path.join(__dirname, 'screenshots');
const reportsDir     = path.join(__dirname, 'reports');
fs.ensureDirSync(screenshotsDir);
fs.ensureDirSync(reportsDir);

// ── CSS property groups to compare ───────────────────────────────────────────
const cssProperties = {
  layout:     ['width','height','display','position','top','right','bottom','left',
                'margin-top','margin-right','margin-bottom','margin-left',
                'padding-top','padding-right','padding-bottom','padding-left'],
  typography: ['font-family','font-size','font-weight','font-style',
                'line-height','letter-spacing','color','text-align',
                'text-transform','text-decoration'],
  background: ['background-color','background-image','opacity'],
  border:     ['border-radius','border-width','border-style','border-color',
                'border-top-width','border-right-width','border-bottom-width','border-left-width'],
  flexGrid:   ['flex','flex-grow','flex-shrink','flex-basis',
                'justify-content','align-items','gap'],
  other:      ['box-sizing','cursor','overflow','visibility',
                'transform','transition','box-shadow']
};
const allCssProps = Object.values(cssProperties).flat();

// ── Tags whose individual nodes are not useful to compare ────────────────────
const SKIP_TAGS = new Set([
  'script','style','noscript','meta','link','title','head',
  'html','body','template','slot','svg','path','defs','g',
  'use','symbol','clippath','mask','lineargradient','radialgradient'
]);

// ── Assign a human-readable category from element attributes ─────────────────
function categoryForEl(tag, role, classes) {
  if (/^h[1-6]$/.test(tag))                                         return 'Headings';
  if (tag === 'button' || role === 'button')                         return 'Buttons';
  if (tag === 'a')                                                   return 'Links';
  if (['input','textarea','select'].includes(tag))                   return 'Inputs';
  if (['img','picture','figure'].includes(tag))                      return 'Images';
  if (tag === 'nav' || role === 'navigation')                        return 'Navigation';
  if (['ul','ol','li'].includes(tag))                                return 'Lists';
  if (['table','thead','tbody','tr','td','th'].includes(tag))        return 'Tables';
  if (tag === 'form')                                                return 'Forms';
  if (['header','footer'].includes(tag))                             return 'Header / Footer';
  if (['section','article','aside','main'].includes(tag))            return 'Sections';
  if (role === 'dialog'  || /modal|dialog/i.test(classes))           return 'Modals';
  if (role === 'alert'   || /alert|banner|notif/i.test(classes))     return 'Alerts';
  if (tag === 'label')                                               return 'Labels';
  if (['p','span','strong','em','small','abbr','code','pre','blockquote'].includes(tag))
                                                                     return 'Content';
  if (/bolt-|nw-|nationwide-/i.test(classes))                        return 'Custom Components';
  if (tag === 'div')                                                 return 'Containers';
  return 'Other';
}

// ── CSS value normalisation ───────────────────────────────────────────────────
function normalizeValue(value, property) {
  if (!value) return '';
  const dimProps = [
    'width','height','top','right','bottom','left',
    'margin-top','margin-right','margin-bottom','margin-left',
    'padding-top','padding-right','padding-bottom','padding-left',
    'font-size','line-height','letter-spacing',
    'border-top-width','border-right-width','border-bottom-width','border-left-width',
    'border-width','border-radius','gap','flex-basis'
  ];
  if (dimProps.includes(property)) {
    const m = value.match(/^([\d.]+)(px|em|rem|%|vw|vh)?$/);
    if (m) return parseFloat(m[1]);
  }
  if (property.includes('color') || property === 'background-color')
    return value.toLowerCase().replace(/\s/g, '');
  return value.trim();
}

function compareValues(v1, v2, property, tolerance) {
  const a = (v1 || '').trim();
  const b = (v2 || '').trim();
  if (a === b) return { match: true, diff: 0, expected: a, actual: b };
  const n1 = normalizeValue(a, property);
  const n2 = normalizeValue(b, property);
  if (typeof n1 === 'number' && typeof n2 === 'number') {
    const base    = n1 === 0 ? 1 : Math.abs(n1);
    const diffPct = Math.abs((n2 - n1) / base * 100);
    return { match: diffPct <= tolerance, diff: diffPct.toFixed(2), expected: a, actual: b };
  }
  return { match: false, diff: 'N/A', expected: a || '(empty)', actual: b || '(empty)' };
}

function compareStyles(dxaEl, angEl, tolerance) {
  let passed = 0, failed = 0;
  const details = [];
  for (const prop of allCssProps) {
    const v1  = (dxaEl.properties  || {})[prop] || '';
    const v2  = (angEl  && angEl.properties ? angEl.properties[prop] : '') || '';
    const res = compareValues(v1, v2, prop, tolerance);
    details.push({ property: prop, ...res });
    res.match ? passed++ : failed++;
  }
  const passRate = Math.round((passed / (passed + failed)) * 100);
  return { total: passed + failed, passed, failed, passRate, details };
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Cookie / consent banner ───────────────────────────────────────────────────
async function handleCookieBanner(page, label = 'page') {
  const selectors = [
    '#truste-consent-button','#truste-consent-track',
    'a#truste-consent-button','.truste_overlay .pdynamicbutton a.call',
    '#trustarc-consent-buttons .btn-accept',
    'button[aria-label="Accept All Cookies"]',
    'button[title="Accept All Cookies"]',
    '[id*="onetrust-accept-btn-handler"]'
  ];
  try {
    let acceptButton = null;
    for (const frame of page.frames()) {
      for (const sel of selectors) {
        try { const el = await frame.$(sel); if (el) { acceptButton = { el, frame }; break; } } catch (_) {}
      }
      if (acceptButton) break;
    }
    if (!acceptButton) {
      for (const sel of selectors) {
        try { const el = await page.$(sel); if (el) { acceptButton = { el, frame: page }; break; } } catch (_) {}
      }
    }
    if (acceptButton) {
      console.log(chalk.yellow(`  [Cookie] Accepting banner on ${label}`));
      await acceptButton.el.click();
      await page.waitForFunction(() => document.readyState === 'complete', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1500);
      console.log(chalk.green(`  [Cookie] ✔ Banner dismissed on ${label}`));
    } else {
      await page.waitForFunction(() => document.readyState === 'complete', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
  } catch (err) {
    console.log(chalk.red(`  [Cookie] Warning on ${label}: ${err.message}`));
  }
}

// ── Scroll full page to trigger lazy-loaded content ───────────────────────────
async function scrollFullPage(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let scrolled = 0;
      const step   = 500;
      const id = setInterval(() => {
        window.scrollBy(0, step);
        scrolled += step;
        if (scrolled >= document.body.scrollHeight) {
          clearInterval(id);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 100);
    });
  });
  await page.waitForTimeout(1200);
}

// ── Discover ALL visible elements ─────────────────────────────────────────────
async function discoverAllElements(page, label = '') {
  console.log(chalk.gray(`  [${label}] Scrolling to expose lazy content...`));
  await scrollFullPage(page);
  console.log(chalk.gray(`  [${label}] Scanning every visible element...`));

  const raw = await page.evaluate(({ props, skipTags }) => {
    const skip = new Set(skipTags);

    // Build a stable CSS selector path (up to 4 levels)
    function buildPath(el) {
      const parts = [];
      let cur = el;
      for (let d = 0; d < 4 && cur && cur !== document.body; d++) {
        const tag = cur.tagName.toLowerCase();
        if (cur.id) {
          try { parts.unshift(`#${CSS.escape(cur.id)}`); break; } catch (_) {}
        }
        const cls = Array.from(cur.classList)
          .filter(c => !c.match(/^(ng-|_nghost|_ngcontent|ember-|js-|is-|has-)/))
          .slice(0, 3)
          .map(c => { try { return `.${CSS.escape(c)}`; } catch (_) { return ''; } })
          .filter(Boolean).join('');
        let nth = '';
        if (cur.parentElement) {
          const sibs = Array.from(cur.parentElement.children).filter(s => s.tagName === cur.tagName);
          if (sibs.length > 1) nth = `:nth-of-type(${sibs.indexOf(cur) + 1})`;
        }
        parts.unshift(`${tag}${cls}${nth}`);
        cur = cur.parentElement;
      }
      return parts.join(' > ');
    }

    const nodes  = Array.from(document.querySelectorAll('*'));
    const result = [];

    for (const el of nodes) {
      const tag = el.tagName.toLowerCase();
      if (skip.has(tag)) continue;

      const rect  = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      // Must be visible and have meaningful size
      if (rect.width < 2 || rect.height < 2)          continue;
      if (style.display     === 'none')                continue;
      if (style.visibility  === 'hidden')              continue;
      if (parseFloat(style.opacity) < 0.05)            continue;

      // Collect identity attributes
      const directText = Array.from(el.childNodes)
        .filter(n => n.nodeType === 3)
        .map(n => n.textContent.trim()).join(' ').trim();
      const fullText    = (el.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 120);
      const ariaLabel   = el.getAttribute('aria-label') || el.getAttribute('title') || '';
      const id          = el.id || '';
      const classes     = Array.from(el.classList).slice(0, 8).join(' ');
      const role        = el.getAttribute('role') || '';
      const placeholder = el.getAttribute('placeholder') || '';
      const href        = el.getAttribute('href') || '';
      const src         = (el.getAttribute('src') || '').substring(0, 100);
      const alt         = el.getAttribute('alt') || '';
      const type        = el.getAttribute('type') || '';
      const name        = el.getAttribute('name') || '';

      // Skip featureless container divs/spans with no identity signal
      const hasSignal = directText || ariaLabel || id || placeholder || href || src || role || alt || type || name;
      if (!hasSignal && ['div','span'].includes(tag)) continue;

      const properties = {};
      for (const p of props) properties[p] = style.getPropertyValue(p);

      result.push({
        tag, id, classes, role, ariaLabel, placeholder, href, src,
        alt, type, name, directText, textContent: fullText,
        index: result.length,
        cssSelector: buildPath(el),
        properties,
        rect: {
          width:  Math.round(rect.width  * 100) / 100,
          height: Math.round(rect.height * 100) / 100,
          top:    Math.round(rect.top    * 100) / 100,
          left:   Math.round(rect.left   * 100) / 100
        },
        exists:    true,
        tagName:   tag,
        className: el.className
      });
    }
    return result;
  }, { props: allCssProps, skipTags: Array.from(SKIP_TAGS) });

  // Assign categories in Node.js (uses the categoryForEl function)
  for (const el of raw) {
    el.category = categoryForEl(el.tag, el.role, el.classes);
  }

  console.log(chalk.green(`  [${label}] ${raw.length} visible elements discovered`));
  return raw;
}

// ── Match DXA elements to Angular elements ────────────────────────────────────
/**
 * Scoring (higher = more confident match):
 *   +5  same id
 *   +4  same ariaLabel (non-empty)
 *   +4  same placeholder (non-empty)
 *   +4  same alt text (non-empty)
 *   +3  same directText (≥ 3 chars)
 *   +2  same textContent prefix (≥ 15 chars)
 *   +2  same role (non-empty)
 *   +2  same tag
 *   +1  same href
 *   +1  page vertical position within 120px
 *   +1–3 per shared CSS class (max 3)
 *
 * Minimum score to accept: 3
 * Each Angular element is used at most once (greedy best-first).
 */
function matchElements(dxaElements, angularElements) {
  const pairs   = [];
  const usedAng = new Set();

  for (const dxa of dxaElements) {
    let bestMatch = null;
    let bestScore = 0;

    for (let ai = 0; ai < angularElements.length; ai++) {
      if (usedAng.has(ai)) continue;
      const ang = angularElements[ai];
      let score = 0;

      if (dxa.id          && ang.id          && dxa.id === ang.id)            score += 5;
      if (dxa.ariaLabel   && ang.ariaLabel   && dxa.ariaLabel === ang.ariaLabel) score += 4;
      if (dxa.placeholder && ang.placeholder && dxa.placeholder === ang.placeholder) score += 4;
      if (dxa.alt         && ang.alt         && dxa.alt === ang.alt)           score += 4;
      if (dxa.directText  && ang.directText  &&
          dxa.directText.length >= 3 && dxa.directText === ang.directText)     score += 3;
      if (dxa.textContent.length >= 15 && ang.textContent.length >= 15) {
        const n = Math.min(dxa.textContent.length, ang.textContent.length, 50);
        if (dxa.textContent.substring(0, n) === ang.textContent.substring(0, n)) score += 2;
      }
      if (dxa.role && ang.role && dxa.role === ang.role)                       score += 2;
      if (dxa.tag  === ang.tag)                                                score += 2;
      if (dxa.href && ang.href && dxa.href === ang.href)                       score += 1;
      if (Math.abs(dxa.rect.top - ang.rect.top) < 120)                        score += 1;

      const noFw = c => !c.match(/^(ng-|_nghost|_ngcontent|ember-|js-)/);
      const dc   = new Set((dxa.classes||'').split(/\s+/).filter(Boolean).filter(noFw));
      const ac   = new Set((ang.classes||'').split(/\s+/).filter(Boolean).filter(noFw));
      score += Math.min([...dc].filter(c => ac.has(c)).length, 3);

      if (score > bestScore) { bestScore = score; bestMatch = { el: ang, idx: ai }; }
    }

    const accepted = bestScore >= 3 ? bestMatch : null;
    if (accepted) usedAng.add(accepted.idx);

    const identity =
      dxa.ariaLabel   || dxa.placeholder || dxa.directText ||
      dxa.alt         || dxa.textContent.substring(0, 60) ||
      dxa.id          || `<${dxa.tag}>[${dxa.index}]`;

    pairs.push({ dxa, angular: accepted ? accepted.el : null, score: bestScore, identity: identity.trim() });
  }

  // Angular-only elements (no DXA match)
  const usedAngEls = new Set(pairs.filter(p => p.angular).map(p => p.angular));
  for (const ang of angularElements) {
    if (usedAngEls.has(ang)) continue;
    const identity = ang.ariaLabel || ang.placeholder || ang.directText ||
                     ang.alt || ang.textContent.substring(0, 60) ||
                     ang.id || `<${ang.tag}>[${ang.index}]`;
    pairs.push({ dxa: null, angular: ang, score: 0, identity: identity.trim(), angularOnly: true });
  }

  return pairs;
}

// ── Full-page screenshot ──────────────────────────────────────────────────────
async function takeFullScreenshot(page, filename) {
  try {
    const p   = path.join(screenshotsDir, filename);
    const buf = await page.screenshot({ fullPage: true });
    await fs.writeFile(p, buf);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch (e) {
    console.log(chalk.red(`  [Screenshot] ${e.message}`));
    return null;
  }
}

// ── User input ────────────────────────────────────────────────────────────────
async function getUserInput() {
  if (USE_CONFIG) {
    console.log(chalk.cyan('\n⚙️  Config mode – values from compare.config.js'));
    console.log(chalk.cyan(`   DXA URL    : ${CONFIG.dxaUrl}`));
    console.log(chalk.cyan(`   Angular URL: ${CONFIG.angularUrl}`));
    console.log(chalk.cyan(`   Mode       : Complete E2E Full-Page Scan\n`));
    return { dxaUrl: CONFIG.dxaUrl, angularUrl: CONFIG.angularUrl, tolerance: CONFIG.tolerance || 5 };
  }
  return inquirer.prompt([
    { type: 'input',  name: 'dxaUrl',     message: 'DXA UAT URL (Baseline):',    default: CONFIG.dxaUrl },
    { type: 'input',  name: 'angularUrl', message: 'Angular URL (New Version):', default: CONFIG.angularUrl },
    { type: 'number', name: 'tolerance',  message: 'Numeric tolerance (%):', default: CONFIG.tolerance || 5 }
  ]);
}

// ── HTML Report ───────────────────────────────────────────────────────────────
async function generatePageReport({ pairs, urls, tolerance, timestamp, dxaScreenshotB64, angularScreenshotB64 }) {
  const matchedPairs  = pairs.filter(p => p.dxa && p.angular);
  const dxaOnlyPairs  = pairs.filter(p => p.dxa && !p.angular);
  const angOnlyPairs  = pairs.filter(p => p.angularOnly);
  const allRates      = matchedPairs.map(p => p.comparison.passRate);
  const avgPassRate   = allRates.length ? Math.round(allRates.reduce((a,b)=>a+b,0)/allRates.length) : 0;

  const noImg = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200"><rect width="800" height="200" fill="%23eee"/><text x="50%25" y="50%25" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="18" fill="%23999">Screenshot Not Available</text></svg>';

  // ── Category stats table ───────────────────────────────────────────────────
  const catStats = {};
  for (const p of pairs) {
    const cat = ((p.dxa || p.angular) || {}).category || 'Other';
    if (!catStats[cat]) catStats[cat] = { matched: 0, dxaOnly: 0, angOnly: 0, rates: [] };
    if (p.dxa && p.angular)  { catStats[cat].matched++;  catStats[cat].rates.push(p.comparison.passRate); }
    else if (p.dxa)            catStats[cat].dxaOnly++;
    else                       catStats[cat].angOnly++;
  }

  const catRows = Object.entries(catStats)
    .sort((a, b) => {
      const ta = a[1].matched + a[1].dxaOnly + a[1].angOnly;
      const tb = b[1].matched + b[1].dxaOnly + b[1].angOnly;
      return tb - ta;
    })
    .map(([cat, s]) => {
      const avg   = s.rates.length ? Math.round(s.rates.reduce((a,b)=>a+b,0)/s.rates.length) : null;
      const color = avg === null ? '#999' : avg >= 80 ? '#4CAF50' : avg >= 60 ? '#ff9800' : '#f44336';
      return `<tr>
        <td style="padding:8px 12px">${escHtml(cat)}</td>
        <td style="padding:8px 12px;text-align:center">${s.matched + s.dxaOnly + s.angOnly}</td>
        <td style="padding:8px 12px;text-align:center">${s.matched}</td>
        <td style="padding:8px 12px;text-align:center;color:#e65100">${s.dxaOnly}</td>
        <td style="padding:8px 12px;text-align:center;color:#1565c0">${s.angOnly}</td>
        <td style="padding:8px 12px;text-align:center;font-weight:bold;color:${color}">${avg !== null ? avg+'%' : 'N/A'}</td>
      </tr>`;
    }).join('\n');

  // ── Element detail block renderer ─────────────────────────────────────────
  function renderPair(p) {
    // Angular-only element
    if (p.angularOnly) {
      const a = p.angular;
      return `
      <details style="margin-bottom:8px;border:1px solid #bbdefb;border-radius:5px;overflow:hidden">
        <summary style="padding:9px 13px;background:#e3f2fd;cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:12px;font-weight:600">
            <span style="background:#1565c0;color:#fff;padding:2px 6px;border-radius:3px;margin-right:6px;font-size:10px">${escHtml(a.category)}</span>
            <span style="background:#0d47a1;color:#fff;padding:2px 6px;border-radius:3px;margin-right:6px;font-size:10px">Angular Only</span>
            &lt;${escHtml(a.tag)}&gt; — ${escHtml(p.identity.substring(0,70))}
          </span>
          <span style="font-size:11px;color:#1565c0">➕ New in Angular</span>
        </summary>
        <div style="padding:10px 13px;font-size:11px;background:#f8fbff">
          Selector: <code>${escHtml(a.cssSelector)}</code> &nbsp;|&nbsp;
          Text: ${escHtml((a.textContent||'').substring(0,100))} &nbsp;|&nbsp;
          Size: ${a.rect.width}×${a.rect.height}px
        </div>
      </details>`;
    }

    const found    = !!p.angular;
    const passRate = found ? p.comparison.passRate : null;
    const hColor   = !found ? '#b71c1c' : passRate >= 80 ? '#2e7d32' : passRate >= 60 ? '#e65100' : '#b71c1c';
    const failCnt  = found ? p.comparison.details.filter(d => !d.match).length : 0;

    const geoRows = found ? (() => {
      const fields = [
        ['Width',  p.dxa.rect.width  + 'px', p.angular.rect.width  + 'px', p.dxa.rect.width,  p.angular.rect.width ],
        ['Height', p.dxa.rect.height + 'px', p.angular.rect.height + 'px', p.dxa.rect.height, p.angular.rect.height],
        ['Top',    p.dxa.rect.top    + 'px', p.angular.rect.top    + 'px', p.dxa.rect.top,    p.angular.rect.top   ],
        ['Left',   p.dxa.rect.left   + 'px', p.angular.rect.left   + 'px', p.dxa.rect.left,   p.angular.rect.left  ],
      ];
      return `<tr style="background:#f0f4ff"><td colspan="5" style="padding:6px 9px;font-weight:700;font-size:11px">📐 Geometry</td></tr>` +
        fields.map(([lbl, dv, av, dn, an]) => {
          const match = Math.abs(dn - an) <= (Math.abs(dn) * tolerance / 100 + 1);
          const delta = !match ? ` <span style="color:#f44336;font-size:10px">(Δ${Math.abs(dn-an).toFixed(1)}px)</span>` : '';
          return `<tr style="${match ? '' : 'background:#fff5f5'}">
            <td style="padding:5px 9px;font-size:11px;color:#555">${lbl}</td>
            <td style="padding:5px 9px;font-family:monospace;font-size:11px">${dv}</td>
            <td style="padding:5px 9px;font-family:monospace;font-size:11px">${av}${delta}</td>
            <td style="padding:5px 9px;text-align:center">${match ? '✅' : '❌'}</td>
            <td></td></tr>`;
        }).join('');
    })() : '';

    const cssRows = found
      ? p.comparison.details.map(d => `
          <tr style="${d.match ? '' : 'background:#fff5f5'}">
            <td style="padding:4px 8px;font-family:monospace;font-size:11px;color:#555">${escHtml(d.property)}</td>
            <td style="padding:4px 8px;font-family:monospace;font-size:11px;word-break:break-all">${escHtml(d.expected)}</td>
            <td style="padding:4px 8px;font-family:monospace;font-size:11px;word-break:break-all">${escHtml(d.actual)}</td>
            <td style="padding:4px 8px;text-align:center">${d.match ? '✅' : '❌'}</td>
            <td style="padding:4px 8px;font-size:10px;color:#888">${d.diff !== '0' && d.diff !== 0 && d.diff !== 'N/A' ? d.diff+'%' : d.diff === 'N/A' ? 'N/A' : ''}</td>
          </tr>`).join('')
      : `<tr><td colspan="5" style="padding:12px;text-align:center;color:#b71c1c;font-weight:bold">⚠️ No matching element found on Angular page</td></tr>`;

    return `
    <details style="margin-bottom:8px;border:1px solid #ddd;border-radius:5px;overflow:hidden">
      <summary style="padding:9px 13px;background:${hColor}12;cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:12px;font-weight:600">
          <span style="background:${hColor};color:#fff;padding:2px 6px;border-radius:3px;margin-right:6px;font-size:10px">${escHtml(p.dxa.category)}</span>
          &lt;${escHtml(p.dxa.tag)}&gt; — ${escHtml(p.identity.substring(0,70))}
          ${failCnt ? `<span style="color:${hColor};font-size:10px;margin-left:6px">(${failCnt} CSS diff${failCnt>1?'s':''})</span>` : ''}
        </span>
        <span style="font-size:11px;color:${hColor}">${found ? passRate+'% match' : '⚠️ Not found'}</span>
      </summary>
      <div style="padding:12px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;font-size:11px">
          <div style="background:#f0f4ff;padding:8px;border-radius:5px">
            <strong>🟦 DXA</strong>  tag:&lt;${escHtml(p.dxa.tag)}&gt;${p.dxa.id ? '  id:<code>'+escHtml(p.dxa.id)+'</code>' : ''}<br>
            <code style="word-break:break-all;font-size:10px">${escHtml(p.dxa.cssSelector)}</code><br>
            Text: ${escHtml((p.dxa.directText||p.dxa.textContent||'').substring(0,80))}<br>
            ${p.dxa.ariaLabel ? 'aria-label: '+escHtml(p.dxa.ariaLabel)+'<br>' : ''}
            ${p.dxa.placeholder ? 'placeholder: '+escHtml(p.dxa.placeholder)+'<br>' : ''}
            Size: ${p.dxa.rect.width}×${p.dxa.rect.height}px
          </div>
          <div style="background:#f0fff4;padding:8px;border-radius:5px">
            ${found
              ? `<strong>🟩 Angular</strong>  tag:&lt;${escHtml(p.angular.tag)}&gt;${p.angular.id ? '  id:<code>'+escHtml(p.angular.id)+'</code>' : ''}<br>
                 <code style="word-break:break-all;font-size:10px">${escHtml(p.angular.cssSelector)}</code><br>
                 Text: ${escHtml((p.angular.directText||p.angular.textContent||'').substring(0,80))}<br>
                 ${p.angular.ariaLabel ? 'aria-label: '+escHtml(p.angular.ariaLabel)+'<br>' : ''}
                 ${p.angular.placeholder ? 'placeholder: '+escHtml(p.angular.placeholder)+'<br>' : ''}
                 Size: ${p.angular.rect.width}×${p.angular.rect.height}px`
              : '<span style="color:#b71c1c;font-weight:bold">⚠️ No Angular match found</span>'}
          </div>
        </div>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:#1a1a2e;color:#fff">
              <th style="padding:6px 8px;text-align:left;font-size:11px">Property</th>
              <th style="padding:6px 8px;text-align:left;font-size:11px">🟦 DXA</th>
              <th style="padding:6px 8px;text-align:left;font-size:11px">🟩 Angular</th>
              <th style="padding:6px 8px;text-align:center;font-size:11px">Status</th>
              <th style="padding:6px 8px;text-align:left;font-size:11px">Diff</th>
            </tr>
          </thead>
          <tbody>${geoRows}${cssRows}</tbody>
        </table>
      </div>
    </details>`;
  }

  // ── Group by category ─────────────────────────────────────────────────────
  const byCategory = {};
  for (const p of pairs) {
    const cat = ((p.dxa || p.angular) || {}).category || 'Other';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(p);
  }

  const categorySections = Object.entries(byCategory)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([cat, catPairs]) => {
      const matched  = catPairs.filter(p => p.dxa && p.angular).length;
      const rates    = catPairs.filter(p => p.dxa && p.angular).map(p => p.comparison.passRate);
      const avg      = rates.length ? Math.round(rates.reduce((a,b)=>a+b,0)/rates.length) : null;
      const secColor = avg === null ? '#546e7a' : avg >= 80 ? '#2e7d32' : avg >= 60 ? '#e65100' : '#b71c1c';
      return `
      <div style="margin-bottom:22px">
        <div style="background:${secColor};color:#fff;padding:10px 15px;border-radius:6px 6px 0 0;
                    display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:14px;font-weight:700">${escHtml(cat)}</span>
          <span style="font-size:12px;opacity:.9">
            ${catPairs.length} element${catPairs.length!==1?'s':''}
            &nbsp;|&nbsp; ${matched} matched
            ${avg !== null ? ' &nbsp;|&nbsp; avg '+avg+'% CSS match' : ''}
          </span>
        </div>
        <div style="border:1px solid #ddd;border-top:none;padding:12px;background:#fafafa;border-radius:0 0 6px 6px">
          ${catPairs.map(p => renderPair(p)).join('\n')}
        </div>
      </div>`;
    }).join('\n');

  // ── Build HTML document ───────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>E2E Full-Page Comparison – ${new Date(timestamp).toLocaleDateString()}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif; background:#f3f4f6; padding:16px; }
    .container { max-width:1500px; margin:0 auto; background:#fff; border-radius:12px;
                 box-shadow:0 2px 12px rgba(0,0,0,.12); overflow:hidden; }
    .header { background:linear-gradient(135deg,#0d1b2a 0%,#1b2a4a 50%,#0f3460 100%);
              color:#fff; padding:28px 30px; }
    .header h1 { font-size:22px; margin-bottom:10px; }
    .header .meta { opacity:.85; font-size:13px; line-height:2; }
    .summary { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr));
               gap:12px; padding:20px; background:#f8f9fa; border-bottom:1px solid #e0e0e0; }
    .card { background:#fff; padding:14px; border-radius:8px;
            box-shadow:0 1px 4px rgba(0,0,0,.1); text-align:center; }
    .card .lbl { font-size:11px; color:#666; margin-bottom:4px; }
    .card .val { font-size:26px; font-weight:800; }
    .green  { color:#2e7d32; } .orange { color:#e65100; } .red    { color:#b71c1c; }
    .blue   { color:#1565c0; } .purple { color:#6a1b9a; }
    .section { padding:22px; border-bottom:1px solid #eee; }
    .section-title { font-size:16px; font-weight:700; margin-bottom:14px; color:#333;
                     border-left:4px solid #0f3460; padding-left:12px; }
    .screenshots { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-top:10px; }
    .ss-box { background:#f8f9fa; border-radius:8px; padding:10px; }
    .ss-box h4 { margin-bottom:7px; color:#555; font-size:12px; }
    .ss-box img { width:100%; border:1px solid #ddd; border-radius:4px; }
    details > summary::-webkit-details-marker { display:none; }
    details > summary::before { content:'▶ '; font-size:9px; color:#bbb; }
    details[open] > summary::before { content:'▼ '; }
    @media(max-width:900px) { .screenshots { grid-template-columns:1fr; } }
  </style>
</head>
<body>
<div class="container">

  <!-- Header -->
  <div class="header">
    <h1>🔬 Complete E2E Full-Page Comparison Report</h1>
    <div class="meta">
      <div>🟦 DXA URL: <strong>${escHtml(urls.dxa)}</strong></div>
      <div>🟩 Angular URL: <strong>${escHtml(urls.angular)}</strong></div>
      <div>📅 Generated: ${new Date(timestamp).toLocaleString()}</div>
      <div>⚙️ CSS Tolerance: ${tolerance}%</div>
    </div>
  </div>

  <!-- Summary Cards -->
  <div class="summary">
    <div class="card"><div class="lbl">DXA Elements Scanned</div><div class="val blue">${pairs.filter(p=>p.dxa).length}</div></div>
    <div class="card"><div class="lbl">Angular Elements Scanned</div><div class="val blue">${pairs.filter(p=>p.angular).length}</div></div>
    <div class="card"><div class="lbl">✅ Matched Pairs</div><div class="val green">${matchedPairs.length}</div></div>
    <div class="card"><div class="lbl">⚠️ DXA Only (missing)</div><div class="val orange">${dxaOnlyPairs.length}</div></div>
    <div class="card"><div class="lbl">➕ Angular Only (new)</div><div class="val purple">${angOnlyPairs.length}</div></div>
    <div class="card">
      <div class="lbl">📊 Avg CSS Match</div>
      <div class="val ${avgPassRate>=80?'green':avgPassRate>=60?'orange':'red'}">${avgPassRate}%</div>
    </div>
  </div>

  <!-- Page Screenshots -->
  <div class="section">
    <div class="section-title">📸 Full-Page Screenshots</div>
    <div class="screenshots">
      <div class="ss-box"><h4>🟦 DXA UAT (Baseline)</h4><img src="${dxaScreenshotB64||noImg}" alt="DXA"></div>
      <div class="ss-box"><h4>🟩 Angular (New Version)</h4><img src="${angularScreenshotB64||noImg}" alt="Angular"></div>
    </div>
  </div>

  <!-- Category summary table -->
  <div class="section">
    <div class="section-title">📂 Category Summary</div>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="background:#0d1b2a;color:#fff">
          <th style="padding:9px 12px;text-align:left">Category</th>
          <th style="padding:9px 12px;text-align:center">Total</th>
          <th style="padding:9px 12px;text-align:center">Matched</th>
          <th style="padding:9px 12px;text-align:center;color:#ffcc80">DXA Only</th>
          <th style="padding:9px 12px;text-align:center;color:#90caf9">Angular Only</th>
          <th style="padding:9px 12px;text-align:center">Avg CSS Match</th>
        </tr>
      </thead>
      <tbody>${catRows}</tbody>
    </table>
  </div>

  <!-- Element-by-Element -->
  <div class="section">
    <div class="section-title">🔬 Element-by-Element Comparisons (click to expand)</div>
    ${categorySections}
  </div>

</div>
</body>
</html>`;

  const reportPath = path.join(reportsDir, `e2e-full-page-${timestamp}.html`);
  await fs.writeFile(reportPath, html);
  return reportPath;
}

// ── Robust page loader (avoids networkidle timeout on busy sites) ────────────
async function loadPage(page, url, label) {
  const timeout = CONFIG.navigationTimeout || 90000;
  console.log(chalk.gray(`  [${label}] Navigating...`));

  // Strategy 1: try 'load' (fires after all resources, much faster than networkidle)
  try {
    await page.goto(url, { waitUntil: 'load', timeout });
    console.log(chalk.gray(`  [${label}] 'load' event fired`));
  } catch (err) {
    // Strategy 2: fall back to 'domcontentloaded' + manual wait
    console.log(chalk.yellow(`  [${label}] 'load' timed out – retrying with domcontentloaded: ${err.message}`));
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      console.log(chalk.gray(`  [${label}] 'domcontentloaded' fired`));
    } catch (err2) {
      // Strategy 3: just navigate and wait whatever we have
      console.log(chalk.yellow(`  [${label}] domcontentloaded also timed out – proceeding with partial load`));
      await page.goto(url, { waitUntil: 'commit', timeout: 30000 }).catch(() => {});
    }
  }

  // Wait for readyState === 'complete' (best-effort, 30 s)
  await page.waitForFunction(() => document.readyState === 'complete',
    { timeout: 30000 }).catch(() => {});

  // Extra settle time for JS frameworks (Angular, React) to finish rendering
  await page.waitForTimeout(2500);
  console.log(chalk.green(`  [${label}] Page ready ✔`));
}

// ── Entry Point ───────────────────────────────────────────────────────────────
async function run() {
  console.log(chalk.blue.bold('\n🔬 Complete E2E Full-Page Comparison Tool'));
  console.log(chalk.gray('   Scans every visible element — no category filters, no limits\n'));

  const { dxaUrl, angularUrl, tolerance } = await getUserInput();
  const timestamp = Date.now();

  const browser = await chromium.launch({
    headless: CONFIG.headless !== false,
    args: ['--no-sandbox','--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    viewport: { width: CONFIG.viewportWidth || 1920, height: CONFIG.viewportHeight || 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
  });

  const dxaPage = await context.newPage();
  const angPage = await context.newPage();

  // [1] Load DXA
  console.log(chalk.blue(`[1/4] Loading DXA: ${dxaUrl}`));
  await loadPage(dxaPage, dxaUrl, 'DXA');
  await handleCookieBanner(dxaPage, 'DXA');
  const dxaScreenshot = await takeFullScreenshot(dxaPage, `dxa-e2e-${timestamp}.png`);

  // [2] Load Angular
  console.log(chalk.blue(`\n[2/4] Loading Angular: ${angularUrl}`));
  await loadPage(angPage, angularUrl, 'Angular');
  await handleCookieBanner(angPage, 'Angular');
  const angularScreenshot = await takeFullScreenshot(angPage, `angular-e2e-${timestamp}.png`);

  // [3] Discover all elements
  console.log(chalk.blue('\n[3/4] Scanning all elements on both pages...'));
  const dxaElements = await discoverAllElements(dxaPage, 'DXA');
  const angElements = await discoverAllElements(angPage, 'Angular');

  await browser.close();

  // [4] Match + compare
  console.log(chalk.blue('\n[4/4] Matching elements and comparing styles...'));
  const rawPairs = matchElements(dxaElements, angElements);

  const pairs = rawPairs.map(p => ({
    ...p,
    comparison: (p.dxa && p.angular)
      ? compareStyles(p.dxa, p.angular, tolerance)
      : { total: 0, passed: 0, failed: 0, passRate: 0, details: [] }
  }));

  const matched  = pairs.filter(p => p.dxa && p.angular).length;
  const dxaOnly  = pairs.filter(p => p.dxa && !p.angular).length;
  const angOnly  = pairs.filter(p => p.angularOnly).length;
  const rates    = pairs.filter(p => p.dxa && p.angular).map(p => p.comparison.passRate);
  const avgRate  = rates.length ? Math.round(rates.reduce((a,b)=>a+b,0)/rates.length) : 0;

  console.log(chalk.green(`\n  ✔ ${matched} element pairs matched and compared`));
  console.log(chalk.yellow(`  ⚠  ${dxaOnly} elements found ONLY on DXA (possibly removed from Angular)`));
  console.log(chalk.blue(`  ➕  ${angOnly} elements found ONLY on Angular (new additions)`));
  console.log(chalk.cyan(`  📊  Average CSS match rate: ${avgRate}%\n`));

  const reportPath = await generatePageReport({
    pairs,
    urls: { dxa: dxaUrl, angular: angularUrl },
    tolerance,
    timestamp,
    dxaScreenshotB64:     dxaScreenshot,
    angularScreenshotB64: angularScreenshot
  });

  console.log(chalk.green.bold(`✅ Report saved: ${reportPath}\n`));
}

run().catch(err => {
  console.error(chalk.red('\n❌ Fatal error:'), err.message);
  process.exit(1);
});
