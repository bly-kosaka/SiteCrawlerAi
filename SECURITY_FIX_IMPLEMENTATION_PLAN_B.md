# SiteCrawlerAI セキュリティ強化実装計画 (堅牢案B)

## 1. 目的

本計画は、現行の固定値署名Cookie方式を、サーバー側セッション管理方式へ移行するための実装設計である。

到達目標:
- セッションの即時失効を可能にする
- 有効期限をサーバー側で強制する
- セッション漏えい時の被害時間を短縮する
- 既存のクライアント互換性を極力維持する

## 2. 現状の課題

現行実装では、Cookie値として固定文字列を署名し、署名検証のみで認証している。
この方式は偽造耐性はある一方、以下の課題がある。

- サーバー側で期限を検証できない
- ログアウトで漏えい済みトークンを無効化できない
- 強制ログアウトや全体失効を運用で行いにくい

## 3. 方針

セッションは以下の二系統を併用する。

- ブラウザ利用: セッションID Cookie認証
- スクリプト連携: x-api-key ヘッダー認証 (既存互換)

これにより、フロントエンドに秘密情報を保持しない設計を維持しつつ、運用可能な失効モデルを導入する。

## 4. 新セッション方式の設計

### 4.1 セッションID

- 形式: 32バイト以上の乱数を base64url で表現
- 例: 43文字前後
- 要件: 推測困難であること。連番禁止。

### 4.2 Cookie

- Cookie名: scai_session
- 値: セッションID (署名不要。高エントロピーのランダム値を直接使用)
- 属性:
  - HttpOnly: true
  - Secure: 本番のみ true
  - SameSite: Lax
  - Path: /
  - Max-Age: 省略可能 (ブラウザ終了で破棄) または短期

注記:
- 有効期限の真実はサーバー側セッションストアのTTLで管理する。

### 4.3 サーバー側セッションストア

推奨は Redis。

キー設計:
- キー: scai:sess:<sessionId>
- 値(JSON):
  - createdAt
  - lastSeenAt
  - uaHash (任意)
  - ipHash (任意)
  - authMethod (apiKeyLogin)
- TTL:
  - アイドル期限: 12時間 (例)
  - 絶対期限: 7日 (例)

更新方針:
- 認証済みリクエストで lastSeenAt を更新
- 過剰更新を避けるため、N分単位でtouchする

### 4.4 ログイン

- POST /api/login
  - API_KEYを定数時間比較
  - 既存Cookieがあれば古いセッションを削除
  - 新しいsessionIdを発行してRedisへ保存
  - scai_session Cookieを再設定

### 4.5 認証フック

onRequestの判定順:
1. 公開パスを許可
2. scai_session CookieがあればRedis照会
3. セッション有効なら通過
4. なければ x-api-key を検証
5. いずれも不一致なら401

### 4.6 ログアウト

- POST /api/logout
  - Cookie内sessionIdに対応するRedisキーを削除
  - scai_session を clearCookie

## 5. API影響

基本は互換維持。

- 維持:
  - POST /api/login
  - POST /api/logout
  - GET /api/me
  - x-api-key 認証
- 任意拡張:
  - /api/me の応答に expiresAt を追加

フロントエンドは credentials: include のままで変更不要。

## 6. 設定追加

必須環境変数:
- SESSION_STORE=redis
- REDIS_URL=redis://...
- SESSION_IDLE_TTL_SEC=43200
- SESSION_ABSOLUTE_TTL_SEC=604800

既存:
- API_KEY
- TRUST_PROXY
- CORS_ORIGIN

起動ガード:
- NODE_ENV=production かつ SESSION_STORE=redis のとき REDIS_URL 未設定なら起動失敗

## 7. 実装差分 (対象ファイル)

- server/src/index.ts
  - 署名固定値Cookie検証を廃止
  - Redisセッション検証を追加
  - login/logout/meの処理をセッション方式へ更新

- server/src/security/session.ts (新規)
  - sessionId発行
  - Redis save/get/delete/touch
  - TTL/絶対期限判定

- server/src/security/session-store.ts (新規)
  - ストアインターフェース
  - Redis実装

- server/package.json
  - redisクライアント依存追加

## 8. 段階移行手順 (ダウンタイム無し)

Phase 0: 事前デプロイ
- 新コードをデュアル受理モードで投入
- 受理順:
  - 新セッションID Cookie
  - 旧 signed-ok Cookie (後方互換)

Phase 1: 発行切替
- loginで新セッションIDのみ発行
- 旧Cookieは受理のみ継続

Phase 2: 監視
- 24-72時間、401率とlogin失敗率を監視
- 異常がなければ旧Cookie受理を停止

Phase 3: 後片付け
- 旧ロジック削除
- ドキュメント更新

## 9. ロールバック手順

- 即時: フラグで旧signed-ok受理を再有効化
- 代替: Redis障害時は x-api-key の運用手順を一時案内
- ロールバック条件:
  - login 401率の急増
  - Redis接続障害の継続
  - APIレイテンシの閾値超過

## 10. テスト計画

機能テスト:
- 未認証アクセスで401
- 正常loginでCookie発行
- Cookieで保護APIアクセス成功
- logout後は同Cookieで401
- x-api-keyは継続成功

セキュリティテスト:
- 推測容易なsessionIdが生成されない
- 無効sessionIdで401
- 期限切れsessionIdで401
- logout済みsessionIdの再利用不可
- Redisキー削除後の再利用不可

運用テスト:
- Redis再起動時の挙動
- 高負荷時のtouch更新頻度
- proxy配下でのrate-limit精度

## 11. 同時実施推奨: robotsキャッシュ是正

別件だが同時実施の優先度は高い。

- 問題:
  - robotsキャッシュがプロセス全体共有
  - クロール間でassertPublicHost再検証をスキップし得る

- 対策:
  - robotsキャッシュをクロール単位に移動
  - もしくはTTL付きにし、検証のみ毎回実行

対象:
- server/src/crawler/robots.ts
- server/src/crawler/engine.ts

## 12. 受け入れ基準

- セッション漏えい時、TTL経過またはlogoutで再利用不能
- 管理者が強制失効できる
- フロントエンド変更なしで既存操作が継続
- x-api-key 連携が後方互換で維持
- 監視指標(login成功率、401率、P95遅延)が許容範囲
