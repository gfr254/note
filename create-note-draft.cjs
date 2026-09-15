const { chromium } = require("playwright");

const TITLE = "空冷ワーゲンビートルの魅力";
const BODY = "群馬の魅力を旧車で巡り情報発信します。";

async function findVisible(frame, selectors, fromEnd = false) {
  for (const selector of selectors) {
    const locator = frame.locator(selector);
    const count = await locator.count();

    const start = fromEnd ? count - 1 : 0;
    const end = fromEnd ? -1 : count;
    const step = fromEnd ? -1 : 1;

    for (let i = start; i !== end; i += step) {
      try {
        if (await locator.nth(i).isVisible()) {
          return locator.nth(i);
        }
      } catch {
        // 画面更新中に要素が消えた場合は次の候補へ進む
      }
    }
  }

  return null;
}

async function printCandidates(page) {
  for (const [index, frame] of page.frames().entries()) {
    try {
      const elements = await frame.locator(
        "input, textarea, [contenteditable='true'], button"
      ).evaluateAll((items) =>
        items.map((element, index) => ({
          index,
          tag: element.tagName,
          type: element.getAttribute("type"),
          placeholder: element.getAttribute("placeholder"),
          ariaLabel: element.getAttribute("aria-label"),
          name: element.getAttribute("name"),
          contenteditable: element.getAttribute("contenteditable")
        }))
      );

      console.log(`frame ${index} URL: ${frame.url()}`);
      console.log(
        `frame ${index} elements:`,
        JSON.stringify(elements)
      );
    } catch (error) {
      console.log(
        `frame ${index} の要素取得に失敗:`,
        error.message
      );
    }
  }
}

(async () => {
  const browser = await chromium.launch({
    headless: true
  });

  try {
    const context = await browser.newContext({
      storageState: "storage-state.json",
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo"
    });

    const page = await context.newPage();

    page.on("pageerror", (error) => {
      console.log("ページJavaScriptエラー:", error.message);
    });

    const response = await page.goto(
      "https://editor.note.com/new",
      {
        waitUntil: "domcontentloaded"
      }
    );

    await page.waitForTimeout(15000);

    console.log(
      "HTTPステータス:",
      response ? response.status() : "取得できませんでした"
    );
    console.log("現在のURL:", page.url());
    console.log("ページタイトル:", await page.title());
    console.log(
      "document.readyState:",
      await page.evaluate(() => document.readyState)
    );

    console.log(
      "body文字数:",
      await page.locator("body").innerText().then((text) => text.length)
    );

    console.log(
      "body直下の要素:",
      JSON.stringify(
        await page.locator("body > *").evaluateAll((elements) =>
          elements.slice(0, 20).map((element) => ({
            tag: element.tagName,
            id: element.id,
            className: String(element.className).slice(0, 100)
          }))
        )
      )
    );

    await printCandidates(page);

    const titleSelectors = [
      'input[placeholder*="記事タイトル"]',
      'input[placeholder*="タイトル"]',
      'input[aria-label*="記事タイトル"]',
      'input[aria-label*="タイトル"]',
      'input[name*="title"]',
      'textarea[placeholder*="記事タイトル"]',
      'textarea[placeholder*="タイトル"]',
      '[contenteditable="true"][data-placeholder*="タイトル"]',
      '[contenteditable="true"][aria-label*="タイトル"]'
    ];

    const bodySelectors = [
      '[contenteditable="true"][data-placeholder*="本文"]',
      '[contenteditable="true"][aria-label*="本文"]',
      'textarea[placeholder*="本文"]',
      '[contenteditable="true"]',
      "textarea"
    ];

    let titleInput = null;
    let bodyInput = null;

    for (const frame of page.frames()) {
      if (!titleInput) {
        titleInput = await findVisible(frame, titleSelectors);
      }

      if (!bodyInput) {
        bodyInput = await findVisible(
          frame,
          bodySelectors,
          true
        );
      }
    }

    if (!titleInput) {
      throw new Error(
        "記事タイトル欄が見つかりません。上の「elements」情報を確認してください。"
      );
    }

    if (!bodyInput) {
      throw new Error(
        "本文欄が見つかりません。上の「elements」情報を確認してください。"
      );
    }

    await titleInput.fill(TITLE);
    await bodyInput.fill(BODY);

    await page.waitForTimeout(1000);

    const saveSelectors = [
      'button:has-text("下書き保存")',
      '[role="button"]:has-text("下書き保存")',
      'button:has-text("保存")',
      '[role="button"]:has-text("保存")'
    ];

    let saveButton = null;

    for (const frame of page.frames()) {
      if (!saveButton) {
        saveButton = await findVisible(frame, saveSelectors);
      }
    }

    if (!saveButton) {
      throw new Error(
        "下書き保存ボタンが見つかりません。公開操作は実行していません。"
      );
    }

    console.log("下書き保存ボタンをクリックします。");

    await saveButton.click();

    await page.waitForTimeout(3000);

    console.log("下書き保存処理が完了しました。");
    console.log("完了時URL:", page.url());
  } finally {
    await browser.close();
  }
})();
