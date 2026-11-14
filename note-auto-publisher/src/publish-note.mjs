import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { htmlToText } from "./article-validation.mjs";

const root = new URL("../", import.meta.url);
const post = JSON.parse(await readFile(new URL("out/post.json", root), "utf8"));
if (typeof post.title !== "string" || !post.title.trim()) {
  throw new Error("Post failed publication safety checks: title is missing or empty");
}
if (typeof post.html !== "string" || !post.html.trim()) {
  throw new Error("Post failed publication safety checks: HTML body is missing or empty");
}
const postText = htmlToText(post.html);
const postTextLength = postText.replace(/\s+/g, "").length;
if (postTextLength < 600) {
  throw new Error(`Post failed publication safety checks: body has ${postTextLength} characters; minimum is 600`);
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

  // note.com has used native inputs, contenteditable fields, and role=textbox
  // editors over time. Match metadata-based selectors and inspect every frame,
  // since embedded editor implementations may place controls outside the main document.
  const fieldSelector = [
    "input:not([type='hidden'])",
    "textarea",
    "[contenteditable='true']",
    "[contenteditable='plaintext-only']",
    "[role='textbox']",
    "[aria-label*='タイトル']",
    "[aria-label*='タイトルを入力']",
    "[aria-label*='本文']",
    "[aria-label*='title']",
    "[aria-label*='body']",
    "[placeholder*='タイトル']",
    "[placeholder*='本文']",
    "[placeholder*='title']",
    "[placeholder*='body']",
    "[data-placeholder*='タイトル']",
    "[data-placeholder*='本文']",
    "[data-placeholder*='title']",
    "[data-placeholder*='body']",
    "[title*='タイトル']",
    "[title*='本文']",
    "[title*='title']",
    "[title*='body']"
  ].join(", ");

  const frames = page.frames();
  const fieldRecords = [];
  for (const [frameIndex, frame] of frames.entries()) {
    const fields = frame.locator(fieldSelector);
    const fieldInfo = await fields.evaluateAll((elements) => elements.map((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const isNativeControl = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
      const visible = style.display !== "none" && style.visibility !== "hidden" &&
        (rect.width > 0 || rect.height > 0 || isNativeControl);
      const metadata = [
        element.getAttribute("placeholder"),
        element.getAttribute("aria-label"),
        element.getAttribute("name"),
        element.getAttribute("data-placeholder"),
        element.getAttribute("title")
      ].filter(Boolean).join(" ");
      const editable = element instanceof HTMLTextAreaElement ||
        element instanceof HTMLInputElement && element.type !== "hidden" ||
        element.getAttribute("contenteditable") === "true" ||
        element.getAttribute("contenteditable") === "plaintext-only" ||
        element.getAttribute("role") === "textbox";
      return { metadata, editable, visible, tagName: element.tagName.toLowerCase() };
    }));
    fieldInfo.forEach((info, elementIndex) => fieldRecords.push({
      ...info,
      frameIndex,
      elementIndex,
      frame,
      frameUrl: frame.url()
    }));
  }

  const candidates = fieldRecords.filter(({ visible }) => visible);
  const titleIndex = candidates.findIndex(({ metadata, tagName }) =>
    /title|タイトル|heading/i.test(`${tagName} ${metadata}`));
  const bodyIndex = candidates.findIndex(({ editable, metadata, tagName }, index) =>
    editable && (/本文|body|content|text|記事|入力/i.test(`${tagName} ${metadata}`) || index !== titleIndex));
  const resolvedTitleIndex = titleIndex >= 0 ? titleIndex : (candidates.length >= 2 ? 0 : -1);
  const resolvedBodyIndex = bodyIndex >= 0 ? bodyIndex : (candidates.length >= 2 ? 1 : -1);

  if (resolvedTitleIndex < 0 || resolvedBodyIndex < 0) {
    const visibleControls = candidates.map(({ metadata, editable, tagName, frameIndex, frameUrl }) => ({
      metadata, editable, tagName, frameIndex, frameUrl
    }));
    throw new Error(
      `Could not identify separate note title and body fields on ${page.url()} (visible controls: ${JSON.stringify(visibleControls)}, frames: ${JSON.stringify(frames.map((frame) => frame.url()))})`
    );
  }

  const titleRecord = candidates[resolvedTitleIndex];
  const bodyRecord = candidates[resolvedBodyIndex];
  const title = titleRecord.frame.locator(fieldSelector).nth(titleRecord.elementIndex);
  const editor = bodyRecord.frame.locator(fieldSelector).nth(bodyRecord.elementIndex);
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
