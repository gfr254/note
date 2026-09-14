# note 自動投稿サーバー

GitHub Actionsのcronで、空冷フォルクスワーゲン・ビートルの記事を生成し、noteへ自動公開します。

## GitHub Secrets

リポジトリの **Settings → Secrets and variables → Actions** に次のSecretを登録します。

- `OPENAI_API_KEY` — 記事生成に使うOpenAI APIキー
- `NOTE_STORAGE_STATE_B64` — noteへログイン済みのPlaywright storage stateをBase64化した値

`NOTE_STORAGE_STATE_B64` は、ログイン情報そのものをコードや通常の環境変数に置かず、ログイン済みブラウザセッションだけをActionsへ渡すために使います。2段階認証が有効な場合も、最初のセッション作成は手元のブラウザで行えます。

## セッションの作成

ローカルでPlaywrightを使ってnoteにログインし、`storage-state.json`を保存します。そのファイルをBase64化してGitHub Secretへ登録してください。

```bash
cd note-auto-publisher
npm install
npx playwright install chromium
npx playwright codegen --save-storage=storage-state.json https://note.com/login
base64 -w 0 storage-state.json
```

ブラウザが開いたらnoteへログインし、ログイン完了後に閉じます。`storage-state.json`は秘密情報を含むため、Gitへコミットしないでください。

## 実行

- 毎日、日本時間の午前9時を目安に実行します。GitHub Actionsの仕様上、数分から遅れることがあります。
- Actionsの `workflow_dispatch` から手動実行できます。
- 同じ日付の記事は `state/published.json` で管理し、再実行による重複公開を防ぎます。
- 失敗時はActionsのArtifactに `note-failure.png` があれば、noteの画面状態を確認できます。

note側の画面変更やログインセッションの期限切れで公開が止まる可能性があるため、初回は手動実行で確認してください。