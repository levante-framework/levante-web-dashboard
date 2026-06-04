#!/usr/bin/env node

const { chromium } = require('playwright');

async function checkAuth() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto('https://levante-cockpit.vercel.app/partner-audio-dashboard.html', { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    
    const html = await page.content();
    console.log('Page HTML (first 2000 chars):');
    console.log(html.substring(0, 2000));
    
    console.log('\nSearching for auth keywords...');
    const hasLogin = html.toLowerCase().includes('login');
    const hasSignIn = html.toLowerCase().includes('sign in');
    const hasAuth = html.toLowerCase().includes('authenticate');
    const hasPassword = html.toLowerCase().includes('password');
    
    console.log('Has "login":', hasLogin);
    console.log('Has "sign in":', hasSignIn);
    console.log('Has "authenticate":', hasAuth);
    console.log('Has "password":', hasPassword);
    
    await page.screenshot({ path: 'auth-page.png', fullPage: true });
    console.log('\nScreenshot saved: auth-page.png');
    
    console.log('\nWaiting 30s for manual inspection...');
    await page.waitForTimeout(30000);
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await browser.close();
  }
}

checkAuth();
