import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const root = new URL("../", import.meta.url);
const post = JSON.parse(await readFile(new URL("out/post.json", root), "utf8"));
const postText = String(post.html ?? "").replace(/<[^>]*>/g, " ");
const personalNarrative = /私|僕|わたし|ぼく|我が家|(?:調べ|調査|確認|比較|購入|運転|修理|整備|説明|感じ|驚き).{0,6}(?:しました|した|してきました|している|しています)/u;
if (
  typeof post.title !== "string" ||
  !post.title.trim() ||
  postText.length < 600 ||
  personalNarrative.test(`${post.title}\n${String(post.excerpt ?? "")}\n${postText}`)
) {
  throw new Error("Post failed publication safety checks; refusing to publish");
}
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

const browser = await chromium.launch({ headless: false });
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

  // note.com has used both native form controls and contenteditable/role=textbox
  // controls for its editor. Discover fields by their accessible metadata rather
  // than assuming the title is an input and the body is the second contenteditable.
  const fields = page.locator(
    'input:visible, textarea:visible, [contenteditable="true"]:visible, [role="textbox"]:visible'
  );
  const fieldInfo = await fields.evaluateAll((elements) => elements.map((element) => ({
    metadata: [
      element.getAttribute("placeholder"),
      element.getAttribute("aria-label"),
      element.getAttribute("name"),
      element.getAttribute("data-placeholder"),
      element.getAttribute("title")
    ].filter(Boolean).join(" "),
    editable: element.getAttribute("contenteditable") === "true" || element.getAttribute("role") === "textbox"
  })));
  const titleIndex = fieldInfo.findIndex(({ metadata }) => /title|タイトル/i.test(metadata));
  const bodyIndex = fieldInfo.findIndex(({ editable }, index) => editable && index !== titleIndex);
  const fallbackTitleIndex = titleIndex < 0 && fieldInfo.length >= 2 ? 0 : titleIndex;
  const fallbackBodyIndex = bodyIndex < 0 && fieldInfo.length >= 2
    ? (fallbackTitleIndex === 0 ? 1 : 0)
    : bodyIndex;

  if (fallbackTitleIndex < 0 || fallbackBodyIndex < 0) {
    throw new Error(
      `Could not identify separate note title and body fields (visible controls: ${JSON.stringify(fieldInfo)})`
    );
  }

  const title = fields.nth(fallbackTitleIndex);
  const editor = fields.nth(fallbackBodyIndex);
  await title.fill(post.title);
  await editor.click();
  await editor.evaluate((element, html) => {
    element.innerHTML = html;
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: null
    }));
  }, post.html);

  const publishSettings = page.getByRole("button", { name: /公開に進む|公開設定|公開する|投稿する/ }).first();
  await publishSettings.click();
  await page.waitForTimeout(500);

  const publishButton = page.getByRole("button", { name: /公開する|投稿する/ }).last();
  await publishButton.click();
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1_000);

  const editorPath = new URL(page.url()).pathname;
  const noteId = editorPath.match(/^\/notes\/([^/]+)\/publish\/?$/)?.[1];
  if (!noteId) {
    throw new Error("could not verify the published Note ID from the editor URL");
  }
  const publicResponse = await page.request.get("https://note.com/notes/" + noteId);
  if (!publicResponse.ok()) {
    throw new Error("public Note page verification failed with HTTP " + publicResponse.status());
  }
  const publicHtml = await publicResponse.text();
  const canonicalTag = [...publicHtml.matchAll(/<link\b[^>]*>/gi)].find(([tag]) => /\brel=["']canonical["']/i.test(tag))?.[0];
  const canonicalHref = canonicalTag?.match(/\bhref=["']([^"']+)["']/i)?.[1];
  if (!canonicalHref) {
    throw new Error("public Note page did not provide a canonical URL");
  }
  const publicUrl = new URL(canonicalHref);
  if (publicUrl.origin !== "https://note.com" || !publicUrl.pathname.endsWith("/n/" + noteId)) {
    throw new Error("public Note canonical URL does not match the published article");
  }
  const url = publicUrl.toString();
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
