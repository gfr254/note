import assert from "node:assert/strict";
import test from "node:test";
import { requestValidatedPost } from "../src/article-validation.mjs";

const safeBody = "<p>" + "車両の整備記録と確認項目を整理する一般的な手順を説明します。".repeat(24) + "</p>";
const validPost = { title: "空冷VW購入前に確認したい整備記録", excerpt: "購入前の一般的な確認項目を整理します。", html: safeBody };
const unsupportedPost = { ...validPost, html: "<p>私は候補車を調べました。</p>" + safeBody };

test("retries unsupported personal experience with corrective feedback", async () => {
  const feedback = [];
  const result = await requestValidatedPost(async (instruction) => {
    feedback.push(instruction);
    return feedback.length === 1 ? unsupportedPost : validPost;
  });
  assert.equal(feedback.length, 2);
  assert.match(feedback[1], /unsupported personal experience/);
  assert.equal(result.post, validPost);
  assert.ok(result.plainTextLength >= 600);
});

test("fails closed after the bounded attempts", async () => {
  let calls = 0;
  await assert.rejects(
    requestValidatedPost(async () => { calls += 1; return unsupportedPost; }),
    /unsupported personal experience/
  );
  assert.equal(calls, 3);
});

test("allows general purchase and inspection guidance without first-person claims", async () => {
  const guidance = { ...validPost, html: "<p>購入した場合は整備記録を確認したいものです。</p>" + safeBody };
  const result = await requestValidatedPost(async () => guidance);
  assert.equal(result.post, guidance);
});
