#!/usr/bin/env node

/**
 * E2E Test for Partner Audio Approval UI - Enhanced Text Persistence
 * 
 * Tests:
 * 1. Enhanced text field editing persists after page refresh
 * 2. Metadata (updatedAt/updatedBy) appears after regeneration
 */

const { chromium } = require('playwright');

const TEST_MARKER = '[E2E_TEST_1773265775191]';
const TARGET_URL = 'https://levante-cockpit.vercel.app/partner-audio-dashboard.html';

async function runE2ETest() {
  console.log('=== Partner Audio Approval E2E Test ===');
  console.log('Target URL:', TARGET_URL);
  console.log('Test Marker:', TEST_MARKER);
  console.log('');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const results = {
    testMarker: TEST_MARKER,
    url: TARGET_URL,
    timestamp: new Date().toISOString(),
    steps: [],
    persistence: null,
    metadata: null,
    testedLanguage: null,
    testedItemId: null,
    errors: []
  };

  try {
    // Step 1: Navigate to URL
    console.log('Step 1: Navigating to', TARGET_URL);
    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 30000 });
    results.steps.push({ step: 1, action: 'navigate', status: 'success' });
    
    // Step 2: Wait for content to load
    console.log('Step 2: Waiting for content to load...');
    await page.waitForTimeout(3000);
    
    // Check for auth/login blocks
    const pageTitle = await page.title();
    const pageContent = await page.content();
    
    if (pageContent.includes('login') || pageContent.includes('sign in') || pageContent.includes('authenticate')) {
      console.log('⚠️  Authentication required - test blocked');
      results.errors.push('Authentication/login required - cannot proceed');
      results.steps.push({ step: 2, action: 'check_auth', status: 'blocked', reason: 'auth_required' });
      await browser.close();
      return results;
    }
    
    results.steps.push({ step: 2, action: 'wait_for_content', status: 'success' });
    
    // Step 3: Find and select a language with pending items
    console.log('Step 3: Looking for language selector and pending items...');
    
    // Wait for language selector
    const languageSelector = await page.waitForSelector('#languageSelect', { timeout: 10000 }).catch(() => null);
    
    if (!languageSelector) {
      console.log('⚠️  Language selector not found');
      results.errors.push('Language selector not found on page');
      results.steps.push({ step: 3, action: 'find_language_selector', status: 'failed' });
      await browser.close();
      return results;
    }
    
    // Get available languages
    const languages = await page.$$eval('#languageSelect option', options => 
      options.map(opt => ({ value: opt.value, text: opt.textContent.trim() }))
    ).then(opts => opts.filter(o => o.value !== ''));
    
    console.log('Available languages:', languages.map(l => l.text).join(', '));
    
    // Select first language (or find one with pending items)
    if (languages.length > 0) {
      const selectedLang = languages[0];
      await page.selectOption('#languageSelect', selectedLang.value);
      results.testedLanguage = selectedLang.text;
      console.log('Selected language:', selectedLang.text);
      await page.waitForTimeout(2000);
    } else {
      results.errors.push('No languages available in selector');
      results.steps.push({ step: 3, action: 'select_language', status: 'failed' });
      await browser.close();
      return results;
    }
    
    results.steps.push({ step: 3, action: 'select_language', status: 'success', language: results.testedLanguage });
    
    // Step 4: Find an item with enhanced text field
    console.log('Step 4: Looking for items with enhanced text fields...');
    
    const items = await page.$$('.pending-item, .approved-item, [data-item-id]');
    
    if (items.length === 0) {
      console.log('⚠️  No items found on page');
      results.errors.push('No approval items found');
      results.steps.push({ step: 4, action: 'find_items', status: 'failed' });
      await browser.close();
      return results;
    }
    
    console.log(`Found ${items.length} items`);
    
    // Find first item with enhanced text field
    let targetItem = null;
    let targetItemId = null;
    let enhancedTextField = null;
    
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const itemId = await item.getAttribute('data-item-id').catch(() => null);
      const textField = await item.$('.audio-enhanced-input').catch(() => null);
      
      if (textField) {
        targetItem = item;
        targetItemId = itemId || `item-${i}`;
        enhancedTextField = textField;
        console.log(`Selected item: ${targetItemId}`);
        break;
      }
    }
    
    if (!enhancedTextField) {
      console.log('⚠️  No enhanced text field found');
      results.errors.push('No enhanced text field found in any item');
      results.steps.push({ step: 4, action: 'find_enhanced_field', status: 'failed' });
      await browser.close();
      return results;
    }
    
    results.testedItemId = targetItemId;
    results.steps.push({ step: 4, action: 'find_enhanced_field', status: 'success', itemId: targetItemId });
    
    // Step 5: Get original text and append test marker
    console.log('Step 5: Editing enhanced text field...');
    
    const originalText = await enhancedTextField.inputValue();
    console.log('Original text:', originalText.substring(0, 50) + '...');
    
    const newText = originalText + ' ' + TEST_MARKER;
    await enhancedTextField.fill(newText);
    
    // Verify the text was entered
    const enteredText = await enhancedTextField.inputValue();
    if (!enteredText.includes(TEST_MARKER)) {
      console.log('⚠️  Test marker not found in field after edit');
      results.errors.push('Failed to enter test marker in text field');
      results.steps.push({ step: 5, action: 'edit_text', status: 'failed' });
      await browser.close();
      return results;
    }
    
    console.log('✓ Test marker added to text field');
    results.steps.push({ step: 5, action: 'edit_text', status: 'success', marker: TEST_MARKER });
    
    // Step 6: Click Regenerate Audio button
    console.log('Step 6: Clicking Regenerate Audio button...');
    
    const regenerateBtn = await targetItem.$('button:has-text("Regenerate Audio"), button:has-text("Generate Audio")').catch(() => null);
    
    if (!regenerateBtn) {
      console.log('⚠️  Regenerate button not found');
      results.errors.push('Regenerate Audio button not found');
      results.steps.push({ step: 6, action: 'click_regenerate', status: 'failed' });
      await browser.close();
      return results;
    }
    
    await regenerateBtn.click();
    console.log('✓ Clicked Regenerate Audio');
    
    // Step 7: Wait for completion indicator
    console.log('Step 7: Waiting for regeneration to complete...');
    await page.waitForTimeout(5000); // Wait for API call
    
    // Look for success indicators
    const successIndicators = [
      '.success-message',
      '.toast-success',
      '[data-status="success"]',
      'text=Success',
      'text=Complete'
    ];
    
    let foundSuccess = false;
    for (const selector of successIndicators) {
      const indicator = await page.$(selector).catch(() => null);
      if (indicator) {
        foundSuccess = true;
        console.log('✓ Success indicator found:', selector);
        break;
      }
    }
    
    if (!foundSuccess) {
      console.log('⚠️  No explicit success indicator found (may still have succeeded)');
    }
    
    results.steps.push({ step: 7, action: 'wait_for_completion', status: foundSuccess ? 'success' : 'uncertain' });
    
    // Step 8: Refresh the page
    console.log('Step 8: Refreshing page...');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    results.steps.push({ step: 8, action: 'refresh_page', status: 'success' });
    
    // Step 9: Navigate back to same language and item
    console.log('Step 9: Navigating back to same language and item...');
    
    // Re-select language
    await page.selectOption('#languageSelect', results.testedLanguage).catch(() => {
      console.log('⚠️  Could not re-select language');
    });
    await page.waitForTimeout(2000);
    
    // Find the same item
    const itemsAfterRefresh = await page.$$('.approval-item, .audio-item, [data-item-id]');
    let targetItemAfterRefresh = null;
    
    for (const item of itemsAfterRefresh) {
      const itemId = await item.getAttribute('data-item-id').catch(() => null);
      if (itemId === targetItemId) {
        targetItemAfterRefresh = item;
        break;
      }
    }
    
    if (!targetItemAfterRefresh && itemsAfterRefresh.length > 0) {
      // Fallback: use first item
      targetItemAfterRefresh = itemsAfterRefresh[0];
      console.log('⚠️  Could not find exact item, using first item');
    }
    
    if (!targetItemAfterRefresh) {
      console.log('⚠️  Could not find target item after refresh');
      results.errors.push('Target item not found after refresh');
      results.steps.push({ step: 9, action: 'find_item_after_refresh', status: 'failed' });
      await browser.close();
      return results;
    }
    
    results.steps.push({ step: 9, action: 'find_item_after_refresh', status: 'success' });
    
    // Step 10: Verify text persistence
    console.log('Step 10: Verifying text persistence...');
    
    const textFieldAfterRefresh = await targetItemAfterRefresh.$('.audio-enhanced-input').catch(() => null);
    
    if (!textFieldAfterRefresh) {
      console.log('⚠️  Enhanced text field not found after refresh');
      results.errors.push('Enhanced text field not found after refresh');
      results.persistence = 'FAIL';
      results.steps.push({ step: 10, action: 'verify_persistence', status: 'failed' });
    } else {
      const textAfterRefresh = await textFieldAfterRefresh.inputValue();
      console.log('Text after refresh:', textAfterRefresh.substring(0, 100) + '...');
      
      if (textAfterRefresh.includes(TEST_MARKER)) {
        console.log('✅ PASS: Text persistence verified - test marker found!');
        results.persistence = 'PASS';
        results.steps.push({ step: 10, action: 'verify_persistence', status: 'success' });
      } else {
        console.log('❌ FAIL: Text persistence failed - test marker NOT found');
        results.persistence = 'FAIL';
        results.steps.push({ step: 10, action: 'verify_persistence', status: 'failed' });
      }
    }
    
    // Step 11: Verify metadata display
    console.log('Step 11: Verifying metadata display...');
    
    const metadataSelectors = [
      '.metadata',
      '.updated-at',
      '.updated-by',
      '[data-updated-at]',
      '[data-updated-by]',
      'text=Updated',
      'text=updatedAt',
      'text=updatedBy'
    ];
    
    let foundMetadata = false;
    let metadataText = '';
    
    for (const selector of metadataSelectors) {
      const metadata = await targetItemAfterRefresh.$(selector).catch(() => null);
      if (metadata) {
        foundMetadata = true;
        metadataText = await metadata.textContent();
        console.log('✓ Metadata found:', metadataText);
        break;
      }
    }
    
    if (foundMetadata) {
      console.log('✅ PASS: Metadata display verified');
      results.metadata = 'PASS';
      results.steps.push({ step: 11, action: 'verify_metadata', status: 'success', metadata: metadataText });
    } else {
      console.log('❌ FAIL: Metadata not found');
      results.metadata = 'FAIL';
      results.steps.push({ step: 11, action: 'verify_metadata', status: 'failed' });
    }
    
    // Capture console errors
    page.on('console', msg => {
      if (msg.type() === 'error') {
        results.errors.push(`Console error: ${msg.text()}`);
      }
    });
    
    // Capture network errors
    page.on('requestfailed', request => {
      results.errors.push(`Network error: ${request.url()} - ${request.failure().errorText}`);
    });
    
  } catch (error) {
    console.error('❌ Test failed with error:', error.message);
    results.errors.push(`Test exception: ${error.message}`);
  } finally {
    await browser.close();
  }

  return results;
}

// Run the test
runE2ETest().then(results => {
  console.log('\n=== TEST RESULTS ===');
  console.log('Persistence:', results.persistence || 'N/A');
  console.log('Metadata:', results.metadata || 'N/A');
  console.log('Language:', results.testedLanguage || 'N/A');
  console.log('Item ID:', results.testedItemId || 'N/A');
  console.log('Errors:', results.errors.length > 0 ? results.errors.join('; ') : 'None');
  console.log('\nFull results:');
  console.log(JSON.stringify(results, null, 2));
  
  process.exit(results.persistence === 'PASS' && results.metadata === 'PASS' ? 0 : 1);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
