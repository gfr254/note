export function htmlToText(html) {
  return String(html ?? "")
    .replace(/<br\s*\/?>(?=\s*)/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/(p|h1|h2|h3|h4|li|ul|ol|div)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/\n{3,}/g, "\n\n");
}

export function validateGeneratedPost(post) {
  const plainText = htmlToText(post.html).trim();
  const plainTextLength = plainText.replace(/\s+/g, "").length;
  const personalNarrative = /私|僕|わたし|ぼく|我が家|筆者自身/;
  if (personalNarrative.test(post.title + "\n" + post.excerpt + "\n" + plainText)) {
    throw new Error("Generated article contains unsupported personal experience; refusing to publish");
  }
  if (plainTextLength < 600) {
    throw new Error("Generated post is too short: " + plainTextLength + " characters");
  }
  return { plainText, plainTextLength };
}

export async function requestValidatedPost(requestPost, maxAttempts = 3) {
  let feedback = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const post = await requestPost(feedback);
    try {
      return { post, ...validateGeneratedPost(post) };
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      feedback = [
        "前回の候補は公開前の検証に合格しませんでした。記事テーマは変えずに修正してください。",
        "筆者の体験・行動・気持ちを一人称で書かず、与えられていない事実を追加しないでください。",
        "検証結果: " + String(error?.message || error),
        "安全条件と最低文字数は緩めないでください。JSON形式は維持してください。"
      ].join("\n");
    }
  }
  throw new Error("Generated article did not pass validation; refusing to publish");
}
