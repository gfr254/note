import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const brief = JSON.parse(await readFile(new URL("../content/brief.json", import.meta.url), "utf8"));
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

const value = (name, fallback) => process.env[name]?.trim() || fallback;
const request = {
  theme: value("BLOG_TOPIC", brief.theme),
  audience: value("BLOG_AUDIENCE", brief.audience),
  angle: value("BLOG_ANGLE", brief.angle),
  tone: value("BLOG_TONE", brief.tone),
  platform: value("BLOG_PLATFORM", "note"),
  length: value("BLOG_LENGTH", "1800〜2500文字")
};

const systemPrompt = [
  "あなたは日本語の個人メディア編集者です。",
  "空冷VWをこれから購入したい読者に役立つ、誠実で読みやすい記事を作ってください。",
  "筆者は現時点で空冷VWを所有していません。",
  "筆者が所有、運転、修理、整備したような一人称の体験談を書いてはいけません。",
  "公開情報、販売情報、専門家の説明、オーナーの体験談を区別して紹介してください。",
  "年式、価格、走行距離、修理費、燃費、故障原因、店舗名、日付など、入力されていない具体情報を創作してはいけません。",
  "確認できない内容は断定せず、『確認が必要です』『一般的には』『販売店や専門店に相談してください』などの表現を使ってください。",
  "整備や安全に関する内容は、危険な作業を断定的に勧めず、専門店や有資格者への相談を促してください。",
  "広告やアフィリエイトを含める場合は、広告であることが分かる表現を入れてください。",
  "本文HTMLはh2、h3、p、ul、li、strong、em、brだけを使ってください。",
  "script、style、iframe、画像URL、外部リンク、Markdownは使わないでください。",
  "記事では空冷VWの購入前調査、費用、現車確認、維持管理、オーナーの声を中心に扱ってください。",
  "タイトルは記事の中心キーワードと読者の具体的な疑問・目的が伝わる自然な日本語にしてください。ブランド名だけの固定タイトルやキーワードの羅列は禁止します。",
  "note向けに独自の切り口を設け、Livedoor・はてな・Steemitの記事を全文転載・言い換えしないでください。"
].join("\n");
const userPrompt = [
  "次の企画から、ブログ記事を1本作成してください。",
  "出力先: " + request.platform,
  "希望文字数: " + request.length,
  "テーマ: " + request.theme,
  "想定読者: " + request.audience,
  "記事の切り口: " + request.angle,
  "文体: " + request.tone,
  "制約: " + brief.facts.join(" / "),
  "筆者は現時点で空冷VWを所有していません。",
  "所有、運転、修理、整備を自分の体験として書かないでください。",
  "公開情報、販売情報、専門家の説明、オーナーの体験談を区別してください。",
  "確認できない具体的な数字、店舗名、車両情報、故障内容を創作しないでください。",
  "JSONのみで返してください。キーはtitle、excerpt、tags、html、slugに固定します。",
  "titleは中心キーワードを自然に含む30文字前後の読者向けタイトル、excerptは80〜120文字で記事の答えと対象読者を伝えてください。tagsは3〜6個、htmlは本文HTML、slugは英小文字とハイフンだけにしてください。"
].join("\n");
async function requestPost(extraInstructions = "") {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ model, temperature: 0.7, response_format: { type: "json_object" }, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt + (extraInstructions ? "\n" + extraInstructions : "") }] })
  });
  if (!response.ok) throw new Error("OpenAI API failed (" + response.status + "): " + await response.text());
  const payload = await response.json();
  const raw = payload.choices?.[0]?.message?.content;
  if (!raw) throw new Error("OpenAI returned no message content");
  let post;
  try { post = JSON.parse(raw); } catch (error) { throw new Error("OpenAI returned invalid JSON: " + error.message); }
  for (const key of ["title", "excerpt", "html", "slug"]) if (typeof post[key] !== "string" || !post[key].trim()) throw new Error("Generated post is missing a valid " + key);
  if (!Array.isArray(post.tags) || post.tags.length === 0) throw new Error("Generated post is missing tags");
  return post;
}
let post = await requestPost();



let plainText = htmlToText(post.html).trim();
let plainTextLength = plainText.replace(/\s+/g, "").length;
if (plainTextLength < 600) throw new Error("Generated post is too short: " + plainTextLength + " characters");
if (plainTextLength < 1200) console.warn("Generated post is shorter than requested: " + plainTextLength + " characters");
const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const out = new URL("../out/", import.meta.url);
    let previousOutput = null;
    try {
      previousOutput = JSON.parse(await readFile(new URL("post.json", out), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const normalizeDedupeText = (value) => String(value ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, "\"").replace(/&#39;|&apos;/gi, "'").normalize("NFKC").toLocaleLowerCase("ja").replace(/\s+/g, " ").trim();
    const fingerprint = (title, html) => ({ titleHash: createHash("sha256").update(normalizeDedupeText(title)).digest("hex"), bodyHash: createHash("sha256").update(normalizeDedupeText(html)).digest("hex") });
    const history = Array.isArray(previousOutput?.dedupeHistory) ? previousOutput.dedupeHistory : [];
    if (previousOutput?.title && previousOutput?.html) history.unshift(fingerprint(previousOutput.title, previousOutput.html));
    let candidate = fingerprint(post.title, post.html);
    const candidateBodyLength = normalizeDedupeText(post.html).length;
    const duplicate = history.find((entry) => entry.titleHash === candidate.titleHash || (candidateBodyLength >= 80 && entry.bodyHash === candidate.bodyHash));
    if (duplicate) {
      const repeatedTitle = post.title;
      const repeatedBody = plainText.slice(0, 4000);
      console.warn("Duplicate Note draft detected; requesting one distinct replacement.");
      post = await requestPost([
        "前回の候補が既存下書きと重複しました。別の切り口で記事を再生成してください。",
        "重複したタイトル: " + repeatedTitle,
        "重複した本文の冒頭（再利用禁止）: " + repeatedBody,
        "同じタイトルや文章の言い換えではなく、企画の範囲内で別の判断材料・調査観点を扱ってください。入力にない事実や体験は追加しないでください。"
      ].join("\n"));
      
      plainText = htmlToText(post.html).trim();
      plainTextLength = plainText.replace(/\s+/g, "").length;
      if (plainTextLength < 600) throw new Error("Regenerated post is too short: " + plainTextLength + " characters");
      candidate = fingerprint(post.title, post.html);
      const retryBodyLength = normalizeDedupeText(post.html).length;
      const repeatedAgain = history.find((entry) => entry.titleHash === candidate.titleHash || (retryBodyLength >= 80 && entry.bodyHash === candidate.bodyHash));
      if (repeatedAgain) throw new Error("再生成後も過去のNote下書きと重複したため、重複防止のため保存を中止しました。");
    }
    const dedupeHistory = [candidate, ...history.filter((entry) => entry.titleHash !== candidate.titleHash && entry.bodyHash !== candidate.bodyHash)].slice(0, 1000);
    const output = { ...post, dedupeHistory, postKey: post.slug + "-" + date, generatedAt: new Date().toISOString(), model, platform: request.platform, request, sourceBrief: brief.theme, plainTextLength };
await mkdir(out, { recursive: true });
await writeFile(new URL("post.json", out), JSON.stringify(output, null, 2) + "\n");
await writeFile(new URL("post.txt", out), post.title + "\n\n" + post.excerpt + "\n\n" + plainText + "\n\nタグ: " + post.tags.map(tag => "#" + tag.replace(/^#/, "")).join(" ") + "\n");
await writeFile(new URL("post.md", out), "# " + post.title + "\n\n" + post.excerpt + "\n\n" + htmlToMarkdown(post.html) + "\n\n" + post.tags.map(tag => "#" + tag.replace(/^#/, "")).join(" ") + "\n");
await writeFile(new URL("post.html", out), "<!doctype html><meta charset=\"utf-8\"><title>" + escapeHtml(post.title) + "</title><article><h1>" + escapeHtml(post.title) + "</h1><p>" + escapeHtml(post.excerpt) + "</p>" + post.html + "<p>" + post.tags.map(tag => "#" + escapeHtml(tag.replace(/^#/, ""))).join(" ") + "</p></article>");
console.log(JSON.stringify({ generated: true, postKey: output.postKey, title: output.title, platform: output.platform, tags: output.tags, plainTextLength: output.plainTextLength }));

function htmlToText(html) { return html.replace(/<br\s*\/?>(?=\s*)/gi, "\n").replace(/<li[^>]*>/gi, "- ").replace(/<\/(p|h1|h2|h3|h4|li|ul|ol|div)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/\n{3,}/g, "\n\n"); }
function htmlToMarkdown(html) { return html.replace(/<h2[^>]*>(.*?)<\/h2>/gi, "\n## $1\n").replace(/<h3[^>]*>(.*?)<\/h3>/gi, "\n### $1\n").replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n").replace(/<br\s*\/?>(?=\s*)/gi, "\n").replace(/<\/(p|div)>/gi, "\n\n").replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**").replace(/<em[^>]*>(.*?)<\/em>/gi, "*$1*").replace(/<[^>]+>/g, "").trim(); }
function escapeHtml(text) { return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;"); }
