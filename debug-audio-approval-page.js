#!/usr/bin/env node

/**
 * Debug script to examine the audio approval page structure
 */

const { chromium } = require('playwright');

const TARGET_URL = 'https://levante-cockpit.vercel.app/partner-audio-dashboard.html';

async function debugPage() {
  console.log('Debugging page:', TARGET_URL);
  
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 30000 });
    console.log('✓ Page loaded');
    
    await page.waitForTimeout(3000);
    
    // Take screenshot
    await page.screenshot({ path: 'debug-audio-approval.png', fullPage: true });
    console.log('✓ Screenshot saved: debug-audio-approval.png');
    
    // Get page title
    const title = await page.title();
    console.log('Page title:', title);
    
    // Get all selects
    const selects = await page.$$('select');
    console.log(`Found ${selects.length} select elements`);
    
    for (let i = 0; i < selects.length; i++) {
      const select = selects[i];
      const id = await select.getAttribute('id');
      const name = await select.getAttribute('name');
      const className = await select.getAttribute('class');
      console.log(`  Select ${i}: id="${id}", name="${name}", class="${className}"`);
      
      const options = await select.$$('option');
      console.log(`    Options: ${options.length}`);
    }
    
    // Get all buttons
    const buttons = await page.$$('button');
    console.log(`Found ${buttons.length} button elements`);
    
    for (let i = 0; i < Math.min(buttons.length, 10); i++) {
      const button = buttons[i];
      const text = await button.textContent();
      const className = await button.getAttribute('class');
      console.log(`  Button ${i}: "${text.trim()}", class="${className}"`);
    }
    
    // Get all textareas
    const textareas = await page.$$('textarea');
    console.log(`Found ${textareas.length} textarea elements`);
    
    for (let i = 0; i < Math.min(textareas.length, 5); i++) {
      const textarea = textareas[i];
      const placeholder = await textarea.getAttribute('placeholder');
      const name = await textarea.getAttribute('name');
      const className = await textarea.getAttribute('class');
      console.log(`  Textarea ${i}: placeholder="${placeholder}", name="${name}", class="${className}"`);
    }
    
    // Get all divs with data attributes
    const dataItems = await page.$$('[data-item-id], [data-id], .item, .approval-item');
    console.log(`Found ${dataItems.length} potential item containers`);
    
    // Get page HTML structure (first 2000 chars)
    const html = await page.content();
    console.log('\nPage HTML (first 2000 chars):');
    console.log(html.substring(0, 2000));
    
    // Check console messages
    const messages = [];
    page.on('console', msg => messages.push(`${msg.type()}: ${msg.text()}`));
    
    await page.waitForTimeout(2000);
    
    if (messages.length > 0) {
      console.log('\nConsole messages:');
      messages.forEach(msg => console.log('  ' + msg));
    }
    
    console.log('\nPress Ctrl+C to close browser...');
    await page.waitForTimeout(30000);
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await browser.close();
  }
}

debugPage();
