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

  // note.com has used both native form controls and contenteditable/role=textbox
  // controls for its editor. Discover fields by their accessible metadata rather
  // than assuming the title is an input and the body is the second contenteditable.
  // Some editor states render the fields lazily or temporarily hide them while the
  // page is still loading. Wait for candidate inputs to appear before falling back
  // to the heuristic selection below.
  const fieldSelector = 'input, textarea, [contenteditable="true"], [role="textbox"]';
  await page.waitForFunction(
    (selector) => {
      const elements = [...document.querySelectorAll(selector)];
      if (elements.length < 2) return false;
      return elements.some((element) => {
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") {
          return false;
        }
        return element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element.getAttribute("contenteditable") === "true" ||
          element.getAttribute("role") === "textbox";
      });
    },
    fieldSelector,
    { timeout: 15_000 }
  ).catch(() => {});

  const fields = page.locator(fieldSelector);
  const fieldInfo = await fields.evaluateAll((elements) => elements.map((element) => {
    const style = window.getComputedStyle(element);
    const visible = style.display !== "none" && style.visibility !== "hidden" && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const metadata = [
      element.getAttribute("placeholder"),
      element.getAttribute("aria-label"),
      element.getAttribute("name"),
      element.getAttribute("data-placeholder"),
      element.getAttribute("title")
    ].filter(Boolean).join(" ");
    const editable = element.getAttribute("contenteditable") === "true" || element.getAttribute("role") === "textbox" ||
      (element instanceof HTMLTextAreaElement) ||
      (element instanceof HTMLInputElement && element.type !== "hidden");
    const tagName = element.tagName.toLowerCase();
    return { metadata, editable, visible, tagName };
  }));

  const candidates = fieldInfo.length > 0 ? fieldInfo : [];
  const titleIndex = candidates.findIndex(({ metadata, tagName, editable }) =>
    /title|タイトル/i.test(metadata) ||
    (!editable && /title|タイトル/i.test(tagName + " " + metadata))
  );
  const bodyIndex = candidates.findIndex(({ editable, metadata }, index) =>
    editable && (index !== titleIndex || /本文|body|content|text|記事/i.test(metadata))
  );
  const fallbackTitleIndex = titleIndex >= 0
    ? titleIndex
    : candidates.findIndex(({ editable, metadata, tagName }) => {
      const label = `${tagName} ${metadata}`.toLowerCase();
      return !editable && /title|タイトル/i.test(label);
    });
  const fallbackBodyIndex = bodyIndex >= 0
    ? bodyIndex
    : candidates.findIndex(({ editable, metadata, tagName }) => {
      const label = `${tagName} ${metadata}`.toLowerCase();
      return editable || /本文|body|content|text|記事/i.test(label);
    });

  const resolvedTitleIndex = fallbackTitleIndex >= 0 ? fallbackTitleIndex : (candidates.length >= 2 ? 0 : -1);
  const resolvedBodyIndex = fallbackBodyIndex >= 0 ? fallbackBodyIndex : (candidates.length >= 2 ? 1 : -1);

  if (resolvedTitleIndex < 0 || resolvedBodyIndex < 0) {
    throw new Error(
      `Could not identify separate note title and body fields (visible controls: ${JSON.stringify(candidates)})`
    );
  }

  const title = fields.nth(resolvedTitleIndex);
  const editor = fields.nth(resolvedBodyIndex);
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
