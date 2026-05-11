import puppeteer from 'puppeteer';
const URL = 'https://pulseup.me/results?source=chat&parent=yes&gender=boy&child_age=8&children=boy%3A8&borough=manhattan&interests=arts_crafts%2Cplaygrounds%2Coutdoor%2Cclasses%2Cscience%2Canimals';
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });

// Capture API requests
const apiCalls = [];
page.on('response', async (res) => {
  const u = res.url();
  if (u.includes('/api/events')) {
    try {
      const j = await res.json();
      apiCalls.push({ url: u.replace('https://pulseup.me',''), total: j.total, events: (j.events||[]).slice(0,3).map(e => `${e.title.slice(0,40)} (${e.age_best_from}-${e.age_best_to})`) });
    } catch {}
  }
});

await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise(r => setTimeout(r, 5000));

console.log('Final URL:', page.url());
console.log('\n=== /api/events calls intercepted ===');
for (const c of apiCalls.slice(-5)) {
  console.log(`  ${c.url.slice(0,120)}`);
  console.log(`     → total=${c.total}, first events: ${c.events.join(', ')}`);
}

// Take screenshot
await page.screenshot({ path: 'final-test.png' });
console.log('\nScreenshot saved');

// Also get raw text from filter area
const innerText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
console.log('\n=== Page text sample ===');
console.log(innerText.slice(0, 1500));

await browser.close();
