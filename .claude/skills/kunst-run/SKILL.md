---
name: kunst-run
description: Launch Kunstmuseum (Electron) for development or manual testing, and run its unit tests and smoke test. Use when asked to run/start/open the app, check that a change works in the running app, or run the tests.
---

# Kunstmuseum 起動・テスト手順

## 開発起動

```powershell
npm install   # 初回のみ(Electron 本体は初回起動時にダウンロードされる)
npm start     # = electron .
```

- データは `%APPDATA%\Kunstmuseum\library.json`(インストール版と共有)。開発中に本物のタグやレイアウトを壊したくないときは smoke を使う
- 起動確認: `Get-Process electron | Where-Object { $_.MainWindowTitle -like "*Kunstmuseum*" }`
- DevTools は F12
- 開発版は `node_modules\electron\dist\electron.exe` で動くので、インストール先(`D:\Program Files\my_original_app\kunstmuseum`)をロックしない

## 単体テスト

```powershell
npm test               # node --test "test/*.test.js"(store / fsops / レイアウトモデル / 再生順)
node --test test/      # 同じ内容(test/index.js が全 *.test.js を読み込む)
```

フィクスチャは `KM_TEST_TMP`(未指定なら OS の一時フォルダ)に作られ、テスト自身が消す。

## スモークテスト(実アプリの自動操作)

```powershell
npm run smoke                        # 一時フォルダにテスト画像、別 userData で 2 回起動(2 回目はレイアウト復元確認)
$env:KM_SMOKE_BULK = 5000; npm run smoke; Remove-Item Env:KM_SMOKE_BULK   # 大量画像
$env:KM_SMOKE_EXE = "D:\Program Files\my_original_app\kunstmuseum\Kunstmuseum.exe"; npm run smoke; Remove-Item Env:KM_SMOKE_EXE   # インストール版を検証
```

- 合格条件: `[smoke] overall: PASS`、各 phase で `renderer errors: 0`
- **対話デスクトップが必要**(ウィンドウ表示・スクリーン表示モードで一時的に全画面化する)
- 本物の userData には触れない(`KM_SMOKE_USERDATA` に一時フォルダを渡す)

## 停止

ウィンドウを閉じる(保存はデバウンスされているので、**強制終了しない**)。
スクリプトから止めるなら `(Get-Process electron | ? MainWindowTitle -like "*Kunstmuseum*").CloseMainWindow()`。
