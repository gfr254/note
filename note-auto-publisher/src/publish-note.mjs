import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const root = new URL("../", import.meta.url);
const post = JSON.parse(await readFile(new URL("out/post.json", root), "utf8"));
const stateUrl = new URL("state/published.json", root);
const state = await readState(stateUrl);

if (state.posts[post.postKey]) {
  await writeResult({
    status: "skipped",
    reason: "already-published",
    postKey: post.postKey,
    url: state.posts[post.postKey].url
  });
  console.log(JSON.stringify({ published: false, skipped: true, postKey: post.postKey }));
  process.exit(0);
}

if (process.env.PUBLISH_NOTE !== "true") {
  await writeResult({ status: "skipped", reason: "publishing-disabled", postKey: post.postKey });
  console.log(JSON.stringify({ published: false, skipped: true, reason: "publishing-disabled" }));
  process.exit(0);
}

const encodedState = process.env.NOTE_STORAGE_STATE_B64;
if (!encodedState) {
  throw new Error("NOTE_STORAGE_STATE_B64 is not set");
}

const authDir = await mkdtemp(join(tmpdir(), "note-auth-"));
const authPath = join(authDir, "storage-state.json");
await writeFile(authPath, Buffer.from(encodedState, "base64"));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: authPath });
const page = await context.newPage();
page.setDefaultTimeout(20_000);

try {
  await page.goto("https://note.com/notes/new", { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});

  if (
    page.url().includes("/login") ||
    await page.locator('input[type="email"], input[name="email"]').count()
  ) {
    throw new Error("note session is not authenticated; refresh NOTE_STORAGE_STATE_B64");
  }

  const title = page.locator(
    'input[placeholder*="タイトル"], textarea[placeholder*="タイトル"], input[name="title"]'
  ).first();
  await title.waitFor({ state: "visible" });
  await title.fill(post.title);

  const editor = page.locator('[contenteditable="true"]').first();
  await editor.waitFor({ state: "visible" });
  await editor.click();
  await editor.evaluate((element, html) => {
    element.innerHTML = html;
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: null
    }));
  }, post.html);

  const publishSettings = page.getByRole("button", { name: /公開設定|公開する|投稿する/ }).first();
  await publishSettings.click();
  await page.waitForTimeout(500);

  const publishButton = page.getByRole("button", { name: /公開する|投稿する/ }).last();
  await publishButton.click();
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1_000);

  const url = page.url();
  if (url.includes("/notes/new") || url.includes("/login")) {
    throw new Error(`note did not finish publishing; current URL: ${url}`);
  }

  state.posts[post.postKey] = {
    title: post.title,
    url,
    publishedAt: new Date().toISOString()
  };
  await writeState(stateUrl, state);
  await writeResult({ status: "published", postKey: post.postKey, title: post.title, url });
  console.log(JSON.stringify({ published: true, postKey: post.postKey, title: post.title, url }));
} catch (error) {
  await page.screenshot({
    path: new URL("out/note-failure.png", root).pathname,
    fullPage: true
  }).catch(() => {});
  throw error;
} finally {
  await context.close();
  await browser.close();
  await rm(authDir, { recursive: true, force: true });
}

async function readState(url) {
  try {
    const value = JSON.parse(await readFile(url, "utf8"));
    return { posts: value.posts && typeof value.posts === "object" ? value.posts : {} };
  } catch (error) {
    if (error.code === "ENOENT") return { posts: {} };
    throw error;
  }
}

async function writeState(url, value) {
  await writeFile(url, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeResult(value) {
  await writeFile(new URL("out/publish-result.json", root), `${JSON.stringify(value, null, 2)}\n`);
}