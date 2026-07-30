/**
 * ============================================================
 *  Global Configuration – NW Interstellar Browser Comparison
 * ============================================================
 *
 * Edit the values below to set permanent defaults.
 *
 * Running modes:
 *   node compare-component.js           → uses this config, NO prompts (default)
 *   node compare-component.js --prompt  → shows interactive prompts (config values pre-filled)
 */

module.exports = {

  // ── URLs ──────────────────────────────────────────────────
  /** DXA UAT baseline URL */
  dxaUrl: 'https://nationwide.com/financial-professionals/products/investments/mutual-funds/fund-list/profile/NWALX',

  /** Angular (new version) URL */
  angularUrl: 'https://it.nwdotcom-ng.apps.nwie.net/financial-professionals/products/investments/mutual-funds/fund-list/profile/NWALX',

// ── Component selectors ───────────────────────────────

  selector:        null,                               // optional label — auto-generated from selectorDxa/selectorAngular if omitted
  selectorDxa:     '#p85400',          // DXA: entire help center banner
  selectorAngular: '#p85400 > section > div > ngx-nationwide-fund-highlights > div',                   // Angular: equivalent banner container

  // ── Pre-action clicks (optional) ──────────────────────────
  // Click a trigger element BEFORE extracting the target selector.
  // Use this when the target only appears after user interaction (e.g. opening a dropdown/autocomplete).
  // Set to null to skip.
  //preActionDxa:     '.js-yext-query.yxt-SearchBar-input',   // DXA: click the search input to open the suggestion list
  //preActionAngular: null,   // Angular: disabled to prevent disrupting element validation

  // Text to TYPE into the search input to trigger autocomplete suggestions.
  // Set to null to only click (no typing).
  //preActionTextDxa:     'How do I view my auto insurance',  // typed into DXA search box
  //preActionTextAngular: 'How do I view my auto insurance',  // typed into Angular search box

  // ── Comparison settings ───────────────────────────────────
  /**
   * Comparison mode:
   *   'Standard CSS Properties' | 'Pixel Perfect' | 'Both'
   */
  comparisonMode: 'Both',

  /**
   * Speed mode - when true, only compares critical CSS properties
   * (layout, typography, colors) instead of all 50+ properties.
   * Reduces comparison time by 70-80% for components with many elements.
   * Set to 'critical' for fast mode, 'standard' for all properties, or 'pixel-perfect' for visual-only
   */
  comparisonSpeed: 'critical',  // 'critical' | 'standard' | 'pixel-perfect'

  /**
   * Tolerance % for numeric CSS value comparisons (0–100).
   * E.g. 5 means a ±5 % difference is still considered a PASS.
   */
  tolerance: 0,

  // ── Browser / viewport ───────────────────────────────────
  /** Viewport width in px */
  viewportWidth: 1920,

  /** Viewport height in px */
  viewportHeight: 1080,

  /** Whether to run the browser headlessly */
  headless: true,


  // ── Timeouts (ms) ─────────────────────────────────────────
  /** Timeout for page.goto() */
  navigationTimeout: 90000,

  /** Timeout for waitForSelector() */
  selectorTimeout: 30000,

};
