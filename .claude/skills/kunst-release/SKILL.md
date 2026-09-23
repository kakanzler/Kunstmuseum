---
name: kunst-release
description: Commit, push, and ship a Kunstmuseum build. Use when the user says release / リリース / インストール / ビルドして配布 / "commit push release" / 「デスクトップにインストール」, or after finishing a change they want installed. Runs verification, commits, pushes, builds the NSIS installer, and installs it silently.
---

# Kunstmuseum リリース手順

検証 → コミット → push → インストーラビルド → サイレントインストール までを一息で行う。
**途中で落ちたら止まって報告する**(半端に進んだ状態を黙って進めない)。

## 0. 事前チェック

```powershell
git status --short
git branch --show-current
git log '@{u}..HEAD' --oneline   # 未 push があるか
```

- **すでに全部済んでいることがある**。作業直後に依頼されると、コミット・push・リリースが
  完了済みなのに一式やり直そうとしがち。まずここを見て、**やることが無ければ「もう出ている」と報告して終わる**
  (インストール済みかは `D:\Program Files\my_original_app\kunstmuseum\Kunstmuseum.exe` の時刻で確認)
- 身に覚えのない未追跡ファイルは**勝手に `git add` しない**。ユーザーのものか確認する
- `dist/` と `node_modules/` は gitignore 済み。インストーラをコミットしない

## 1. 検証(飛ばさない)

```powershell
npm test          # store / fsops / レイアウトモデル / 再生順の単体テスト
npm run smoke     # 実アプリを一時フォルダ・一時 userData で 2 回起動して自動操作
```

- どちらも終了コード 0、smoke は `[smoke] overall: PASS` と `renderer errors: 0` を確認してから先へ進む
- smoke は**本物の userData(%APPDATA%\Kunstmuseum)には触れない**。フィクスチャは一時フォルダに作って自分で消す

## 2. コミット & push

```powershell
git add <変更したファイルを明示>
git commit -m "<何をなぜ変えたか>"
git push
```

- **main へ直接コミット & push するのがこのリポジトリの運用**(2026-09-23 にユーザーが決定)。
  別ブランチにいる場合は、ユーザーに確認してから main へ fast-forward マージする
- **force push はしない**(`--force` / `--force-with-lease` とも禁止)。拒否されたら止めて報告
- `git add -A` / `git add .` で一括追加しない(未追跡の私物を巻き込む)

## 3. インストーラをビルド

```powershell
pwsh ./release.ps1              # 検証(npm test + smoke)→ electron-builder → dist\Kunstmuseum-Setup-<version>.exe
pwsh ./release.ps1 -SkipVerify  # §1 を直前に通したと確認できたときだけ。大きな警告が出る
```

- 成果物: `dist\Kunstmuseum-Setup-<version>.exe`(NSIS, x64, 約 110 MB)。
  中身の `app.asar` には `src/**` と `package.json` と本番依存(cytoscape)だけが入る
- **迷ったら `-SkipVerify` を付けない**。付けたら報告にその旨を必ず書く

## 4. サイレントインストール

```powershell
pwsh ./release.ps1 -Install     # §3 に続けてインストールまで
```

スクリプトが行うこと・確認すること:

1. インストール先 `D:\Program Files\my_original_app\kunstmuseum` から起動中の `Kunstmuseum.exe` があれば**中断**
   (強制終了はしない。タグ・レイアウトの保存はデバウンスされているので、kill すると直前の編集が消えうる)
2. `Start-Process $setup -ArgumentList "/S /D=$InstallDir" -Wait`
3. `Kunstmuseum.exe` の存在・**LastWriteTime・サイズ**を表示し、`dist\win-unpacked` と
   `Kunstmuseum.exe` / `resources\app.asar` のサイズを突き合わせる(上書きが黙ってスキップされていないか)
4. デスクトップ(`[Environment]::GetFolderPath('Desktop')`。OneDrive にリダイレクトされていることがある)と
   スタートメニュー(`GetFolderPath('Programs')`)の `Kunstmuseum.lnk` を確認

手で確かめるなら:

```powershell
Get-Item "D:\Program Files\my_original_app\kunstmuseum\Kunstmuseum.exe" | Select-Object LastWriteTime, Length
Test-Path (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Kunstmuseum.lnk')
Test-Path (Join-Path ([Environment]::GetFolderPath('Programs')) 'Kunstmuseum.lnk')
```

- ユーザーデータ(`%APPDATA%\Kunstmuseum\library.json`: タグ・登録フォルダ・レイアウト・設定)は
  インストール/更新/アンインストールのどれでも**触られない**。`npm start` と同じ場所なので開発版と共有される

## つまずきポイント

| 症状 | 原因 / 対処 |
|---|---|
| `Kunstmuseum is running from ...` で中断 | インストール先のアプリが起動中。**ユーザーに閉じてもらう**(kill しない)。`npm start` の開発版(`node_modules\electron\dist\electron.exe`)はロックしないので開いたままでよい |
| インストール後もアプリが古いまま / 別の場所に入った | NSIS の **`/D=` は最後・引用符なし**でないと効かない。`"/S /D=$InstallDir"` の形を崩さない |
| `Kunstmuseum.exe` が消えている | Defender が未署名 exe を誤検知して隔離した。除外の追加(`Add-MpPreference -ExclusionPath "<インストール先>"`)は**システム設定なのでユーザー本人が昇格シェルで行う**。エージェントは Defender 設定を変えない |
| 初回ビルドが遅い / ダウンロードが走る | electron-builder が初回に Electron 本体の zip と NSIS ツールをキャッシュ(`%LOCALAPPDATA%\electron`・`electron-builder\Cache`)へ落とす。2 回目以降は速い |
| `dist\...` を上書きできない(EBUSY / EPERM) | 前回のインストーラや `dist\win-unpacked\Kunstmuseum.exe` を開いたまま。閉じてから再実行 |
| smoke がタイムアウト・全画面にならない | smoke は**対話デスクトップセッションが必要**(ウィンドウを表示し、スクリーン表示モードで一時的に全画面化する)。リモートの非対話セッションやロック画面では通らない |
| `STALE INSTALL` | インストール済みファイルがビルドと一致しない(起動中で上書きがスキップされた等)。アプリを完全に閉じて再インストール |

## 報告

完了報告には必ず次を含める:

- **push したコミット**(ハッシュとブランチ)
- **インストール結果**: `Kunstmuseum.exe` のパス・**LastWriteTime・サイズ**、デスクトップとスタートメニューのショートカットの有無
- 検証結果(`npm test` の件数、smoke の PASS / renderer errors)。**`-SkipVerify` を使った場合はその旨を明示**
