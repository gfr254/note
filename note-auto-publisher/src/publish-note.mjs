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

  // Editors may be rendered after client-side navigation or inside an iframe.
  // Discover actual editable controls in the main document and every frame,
  // then choose title/body using accessible labels before using a strict fallback.
  const fieldSelector = [
    "input:not([type='hidden']):not([disabled])",
    "textarea:not([disabled])",
    "[contenteditable='true']",
    "[contenteditable='plaintext-only']",
    "[role='textbox']"
  ].join(", ");
  const discoverFields = async () => {
    const found = [];
    for (const frame of page.frames()) {
      let items = [];
      try {
        items = await frame.locator(fieldSelector).evaluateAll((elements) => elements.map((element, index) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const visible = style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && (rect.width > 0 || rect.height > 0);
          const metadata = [
            element.getAttribute("placeholder"),
            element.getAttribute("aria-label"),
            element.getAttribute("name"),
            element.getAttribute("data-placeholder"),
            element.getAttribute("title"),
            element.getAttribute("data-testid")
          ].filter(Boolean).join(" ");
          const tagName = element.tagName.toLowerCase();
          const editable = element instanceof HTMLTextAreaElement ||
            element instanceof HTMLInputElement && element.type !== "hidden" ||
            element.getAttribute("contenteditable") === "true" ||
            element.getAttribute("contenteditable") === "plaintext-only" ||
            element.getAttribute("role") === "textbox";
          return { index, metadata, tagName, editable, visible };
        }));
      } catch {
        // A frame can detach while the editor is mounting; retry during polling.
      }
      for (const item of items) {
        if (item.visible && item.editable) found.push({ frame, ...item });
      }
    }
    return found;
  };

  let candidates = [];
  await page.waitForFunction(() => document.readyState === "complete", { timeout: 10_000 }).catch(() => {});
  for (let attempt = 0; attempt < 15; attempt += 1) {
    candidates = await discoverFields();
    const hasTitle = candidates.some(({ metadata }) => /title|タイトル|heading/i.test(metadata));
    const hasBody = candidates.some(({ metadata }) => /本文|body|content|article|記事/i.test(metadata));
    if (candidates.length >= 2 || hasTitle && hasBody) break;
    await page.waitForTimeout(1_000);
  }

  const titleCandidate = candidates.find(({ metadata }) => /title|タイトル|heading/i.test(metadata));
  const bodyCandidate = candidates.find(({ metadata }) => /本文|body|content|article|記事/i.test(metadata) && !/title|タイトル/i.test(metadata));
  let resolvedTitle = titleCandidate;
  let resolvedBody = bodyCandidate;

  if (!resolvedTitle) {
    resolvedTitle = candidates.find(({ tagName, metadata }) =>
      (tagName === "input" || tagName === "textarea") && !/body|本文|content|記事/i.test(metadata)
    );
  }
  if (!resolvedBody) {
    resolvedBody = candidates.find(({ tagName, metadata }) =>
      !/title|タイトル|heading/i.test(metadata) && (tagName === "textarea" || /本文|body|content|article|記事/i.test(metadata))
    );
  }

  // Safe fallback only when the page presents exactly two editable fields. Do not
  // type article content into an arbitrary control when the page layout is unclear.
  if ((!resolvedTitle || !resolvedBody || resolvedTitle.frame !== resolvedBody.frame || resolvedTitle.index === resolvedBody.index) && candidates.length === 2) {
    [resolvedTitle, resolvedBody] = candidates;
  }

  if (!resolvedTitle || !resolvedBody || resolvedTitle.frame === resolvedBody.frame && resolvedTitle.index === resolvedBody.index) {
    const diagnostics = {
      url: page.url(),
      pageTitle: await page.title().catch(() => ""),
      frames: page.frames().map((frame) => frame.url()),
      editableControls: candidates.map(({ metadata, tagName, frame }) => ({
        frameUrl: frame.url(),
        tagName,
        metadata
      }))
    };
    console.error("Note editor field detection diagnostics:", JSON.stringify(diagnostics));
    throw new Error(`Could not identify separate note title and body fields. See note-failure.png and sanitized editor diagnostics (page: ${page.url()}).`);
  }

  const title = resolvedTitle.frame.locator(fieldSelector).nth(resolvedTitle.index);
  const editor = resolvedBody.frame.locator(fieldSelector).nth(resolvedBody.index);
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
