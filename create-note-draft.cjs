const { chromium } = require('playwright');

const TITLE = '空冷ワーゲンビートルの魅力';
const BODY = '群馬の魅力を旧車で巡り情報発信します。';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-web-security', '--disable-features=IsolateOrigins,site-per-process']
  });
  const context = await browser.newContext({ storageState: 'storage-state.json' });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  page.on('console', msg => console.log('[browser]', msg.type(), msg.text()));
  page.on('pageerror', error => console.log('[pageerror]', error.message));
  page.on('requestfailed', request => console.log('[requestfailed]', request.url(), request.failure()?.errorText));

  try {
    await page.goto('https://note.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('Home URL:', page.url());

    const newPost = page.getByRole('link', { name: '新規投稿' });
    await newPost.waitFor({ state: 'visible', timeout: 60000 });
    const popupPromise = page.waitForEvent('popup', { timeout: 5000 }).catch(() => null);
    await newPost.click();
    const popup = await popupPromise;
    const editorPage = popup || page;
    await editorPage.waitForLoadState('domcontentloaded').catch(() => {});
    await editorPage.waitForTimeout(5000);
    await editorPage.bringToFront().catch(() => {});
    console.log('Editor URL:', editorPage.url());
    console.log('Open pages:', context.pages().map(p => p.url()).join(' | '));

    let title = editorPage.getByRole('textbox', { name: '記事タイトル' });
    if (await title.count() === 0) {
      title = editorPage.locator('input[placeholder*="タイトル"], textarea[placeholder*="タイトル"], input[aria-label*="タイトル"]').first();
    }
    await title.waitFor({ state: 'visible', timeout: 45000 });
    await title.fill(TITLE);

    let editor = editorPage.locator('[contenteditable="true"]').first();
    if (await editor.count() === 0) editor = editorPage.getByRole('textbox').nth(1);
    await editor.waitFor({ state: 'visible', timeout: 45000 });
    await editor.fill(BODY);

    await editorPage.waitForTimeout(5000);
    console.log('Draft fields filled:', TITLE);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
})();
