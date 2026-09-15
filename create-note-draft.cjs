const { chromium } = require('playwright');

const TITLE = '空冷ワーゲンビートルの魅力';
const BODY = '群馬の魅力を旧車で巡り情報発信します。';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: 'storage-state.json' });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  page.on('console', msg => console.log('[browser]', msg.type(), msg.text()));
  page.on('pageerror', error => console.log('[pageerror]', error.message));

  try {
    await page.goto('https://note.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('Home URL:', page.url());

    await page.getByRole('link', { name: '新規投稿' }).click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(3000);
    console.log('Editor URL:', page.url());

    let title = page.getByRole('textbox', { name: '記事タイトル' });
    if (await title.count() === 0) {
      title = page.locator('input[placeholder*="タイトル"], textarea[placeholder*="タイトル"], input[aria-label*="タイトル"]').first();
    }
    console.log('Title candidates:', await title.count());
    if (await title.count() === 0) {
      console.log('Body text:', (await page.locator('body').innerText()).slice(0, 2000));
      throw new Error('記事タイトル欄が表示されませんでした。');
    }
    await title.waitFor({ state: 'visible', timeout: 60000 });
    await title.fill(TITLE);

    let editor = page.locator('[contenteditable="true"]').first();
    if (await editor.count() === 0) {
      const textboxes = page.getByRole('textbox');
      editor = textboxes.nth(1);
    }
    console.log('Editor candidates:', await editor.count());
    await editor.waitFor({ state: 'visible', timeout: 60000 });
    await editor.fill(BODY);

    await page.waitForTimeout(5000);
    console.log('Draft fields filled:', TITLE);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
})();
