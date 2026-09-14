import { mkdir, readFile, writeFile } from "node:fs/promises";

const brief = JSON.parse(await readFile(new URL("../content/brief.json", import.meta.url), "utf8"));
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

if (!apiKey) {
  throw new Error("OPENAI_API_KEY is not set");
}

const systemPrompt = [
  "あなたは日本語の個人メディア編集者です。",
  "空冷フォルクスワーゲン・ビートルを題材に、読者が最後まで読みたくなる記事を作ります。",
  "与えられた企画と事実だけを使い、実在しない体験、店名、価格、日付、走行距離、故障診断を創作しないでください。",
  "具体的な整備を勧める場合は、安全を優先し、必要なら専門店へ相談する表現にしてください。",
  "本文はnoteに貼り付けられるHTMLにし、h2、h3、p、ul、li、strong、em、brだけを使ってください。",
  "script、style、iframe、画像URL、Markdown、外部リンクは使わないでください。",
  "一人称の自然な日本語で、広告っぽくせず、旧車との暮らしの実感と読者に役立つ視点を入れてください。"
].join("\n");

const userPrompt = [
  "次の企画から、noteに公開する記事を1本作成してください。",
  "",
  JSON.stringify(brief, null, 2),
  "",
  "JSONのみで返してください。キーは次の5つに固定します。",
  "- title: 30文字前後のタイトル",
  "- excerpt: 80〜120文字程度の導入要約",
  "- tags: 3〜6個のタグ配列",
  "- html: 1800〜2500文字程度の本文HTML",
  "- slug: 英小文字とハイフンだけの短い識別子"
].join("\n");

const response = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    model,
    temperature: 0.7,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  })
});

if (!response.ok) {
  throw new Error(`OpenAI API failed (${response.status}): ${await response.text()}`);
}

const payload = await response.json();
const content = payload.choices?.[0]?.message?.content;
if (!content) {
  throw new Error("OpenAI returned no message content");
}

let post;
try {
  post = JSON.parse(content);
} catch (error) {
  throw new Error(`OpenAI returned invalid JSON: ${error.message}`);
}

for (const key of ["title", "excerpt", "html"]) {
  if (typeof post[key] !== "string" || !post[key].trim()) {
    throw new Error(`Generated post is missing a valid ${key}`);
  }
}
if (!Array.isArray(post.tags) || post.tags.length === 0) {
  throw new Error("Generated post is missing tags");
}

const plainTextLength = post.html.replace(/<[^>]*>/g, "").replace(/\s+/g, "").length;
if (plainTextLength < 1400) {
  throw new Error(`Generated post is too short: ${plainTextLength} characters`);
}

const date = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
}).format(new Date());

const output = {
  ...post,
  postKey: `${brief.slug}-${date}`,
  generatedAt: new Date().toISOString(),
  model,
  sourceBrief: brief.theme,
  plainTextLength
};

await mkdir(new URL("../out/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../out/post.json", import.meta.url),
  `${JSON.stringify(output, null, 2)}\n`
);

console.log(JSON.stringify({
  generated: true,
  postKey: output.postKey,
  title: output.title,
  tags: output.tags,
  plainTextLength: output.plainTextLength
}));