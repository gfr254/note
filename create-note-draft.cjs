const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true
  });
  const context = await browser.newContext({
    storageState: "storage-state.json",
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo"
  });


  
  const page = await context.newPage();


  
  await page.goto('https://note.com/');
  await page.getByRole('link', { name: '新規投稿' }).click();

  console.log("現在のURL:", page.url());
  console.log("ページタイトル:", await page.title());
  console.log("textbox数:", await page.getByRole("textbox").count());

  
  await page.getByRole('textbox', { name: '記事タイトル' }).click();

  console.log("現在のURL:", page.url());
  console.log("ページタイトル:", await page.title());
  console.log("textbox数:", await page.getByRole("textbox").count());

  await page.getByRole("textbox", {
    name: "記事タイトル"
  }).click();

  
  await page.getByRole('textbox', { name: '記事タイトル' }).fill('空冷');
  await page.getByRole('textbox').filter({ hasText: /^$/ }).click();
  await page.getByRole('textbox').nth(1).fill('ビートル');

  // ---------------------
  await context.close();
  await browser.close();
})();
