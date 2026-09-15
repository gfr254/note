# ブログ記事作成プロジェクト

GitHub Actionsで、空冷かずひろブランドをテーマにしたnote用ブログ記事を生成し、手動でコピペするためのプロジェクトです。

このプロジェクトはnoteへログインしたり、自動投稿したりしません。記事の生成までを自動化します。

## 生成されるファイル

Actions実行後、note-auto-publisher/out/ に次のファイルが作成されます。

- post.txt — タイトル・本文・タグをまとめたコピペ用テキスト
- post.html — 本文確認用HTML
- post.md — Markdown形式
- post.json — タイトル、本文、タグ、生成日時などのデータ

同じファイル一式はActionsのArtifactとしてもダウンロードできます。

## 必要なSecret

GitHubリポジトリの Settings → Secrets and variables → Actions に次を登録します。

- OPENAI_API_KEY — 記事生成に使うOpenAI APIキー

任意でRepository variable OPENAI_MODELを設定できます。未設定時は gpt-4o-mini を使います。

## 実行方法

1. GitHubのActionsを開く
2. Generate blog articleを選ぶ
3. Run workflowを押す
4. 出力先は note、テーマは空冷かずひろブランドのまま実行する
5. 完了後、Artifactまたはリポジトリの note-auto-publisher/out/post.txt を開く
6. 内容を確認してnoteへ手動でコピペする

テーマや読者などを入力画面で指定した場合は、その入力が初期設定より優先されます。ブランドの由来、商品、実績、価格などの固有情報は、事実を入力した場合だけ記事に含めてください。

## 安全方針

- note、Steemit、はてなブログ、ライブドアブログへの自動投稿は行いません
- ログイン情報、storage state、Playwrightは記事生成Workflowでは使いません
- 実在しないブランド情報、店舗名、価格、整備履歴、走行ルートなどを創作しないよう生成指示に含めています
