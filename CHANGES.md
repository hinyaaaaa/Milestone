# Milestone v1.0.1

## 適用方法（GitHub Desktop）
1. この zip の `files/` の中身を、Milestone リポジトリのフォルダ直下に **上書きコピー**
2. GitHub Desktop で差分を確認 → Commit → Push
※ この `CHANGES.md` 自体はコピーしないでください。
※ `public_data.json` は定期実行(bot)が更新するため、今回のzipには含めていません（上書きされません）。

## 変更（機能の変更なし・セキュリティ修正）
- `escapeHtml()` が `"` を変換していなかったため、動画タイトルに `"` が含まれると `alt` / `aria-label` 属性を壊せた問題を修正（`& < > " '` を変換）
- `href` / `src` に入る動画ID・サムネイルURLを検査（動画IDは英数字・`_`・`-`、サムネイルは `ytimg.com` のみ。現在の全 4,506 件が通過することを確認済み）
- チャンネル表示名も `escapeHtml()` を通すように変更
- バージョン **v1.0.1** を導入: `app.js` の `APP_VERSION`、画面下部の表示（`index.html` / `style.css`）、`CHANGELOG.md`

## 確認したこと
- `"` ` onload="..."` を含む動画タイトルを実際にHTMLへ組み込み、属性が増えない（`src` と `alt` のみ）こと、`alt` は元のタイトルのまま保持されること

## 手動で必要なこと（コード外）
- Google Cloud コンソールで `YT_API_KEY` を「YouTube Data API v3 のみ」に制限してください（GitHub Actions のIPは固定できないためIP制限は不可）
