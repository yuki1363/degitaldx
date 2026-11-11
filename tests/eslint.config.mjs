// ESLint 設定（静的検査）。実行: cd tests && npm run lint（リポジトリのルートを基準に検査する）
//   目的は「書き間違いの早期発見」。実行時エラーになる誤り（未定義の変数・重複キー・到達しないコード等）を
//   ブラウザで試す前に見つける。コードの書き方（見た目）は強制しない。
//   ビルド工程なしの方針のため、検査はテスト用の依存（tests/node_modules）だけで完結させる。
import globals from 'globals';

// 実際のバグになりやすいものだけをエラーにする。unused は警告（引数・catch の未使用は許容）
const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-unreachable': 'error',
  'no-const-assign': 'error',
  'no-self-assign': 'error',
  'no-redeclare': 'error',
  'no-import-assign': 'error',
  'no-setter-return': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-loss-of-precision': 'error',
  'no-cond-assign': 'error',
  'no-sparse-arrays': 'warn',
  'no-fallthrough': 'warn',
  'no-useless-catch': 'warn',
  'no-async-promise-executor': 'warn',
  'no-constant-condition': ['warn', { checkLoops: false }],
  'getter-return': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
};

const base = { ecmaVersion: 'latest', sourceType: 'module' };

export default [
  { ignores: ['**/node_modules/**', 'js/vendor/**', '.wrangler/**'] },
  // 画面（ブラウザ）。同梱ライブラリ（Chart.js・jsQR・JSZip 等）はグローバルで読み込まれる
  {
    files: ['js/**/*.js'],
    languageOptions: { ...base, globals: { ...globals.browser, Chart: 'readonly', jsQR: 'readonly', JSZip: 'readonly', Encoding: 'readonly', QRCode: 'readonly' } },
    rules,
  },
  // Service Worker
  { files: ['sw.js'], languageOptions: { ...base, globals: { ...globals.serviceworker } }, rules },
  // API（Pages Functions ＝ Workers ランタイム）
  { files: ['functions/**/*.js'], languageOptions: { ...base, globals: { ...globals.serviceworker } }, rules },
  // テスト・スクリプト（Node。E2E は page.evaluate 内でブラウザのグローバルや、電気設備点検ページ
  //   （electrical/index.html）が定義しているグローバル関数・同梱ライブラリも使う）
  {
    files: ['tests/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      ...base,
      globals: {
        ...globals.node, ...globals.browser, Chart: 'readonly',
        showTab: 'readonly', openRecord: 'readonly', editRecord: 'readonly', getRecords: 'readonly',
        saveRecord: 'readonly', deleteRecordById: 'readonly', pushConfigToServer: 'readonly',
      },
    },
    rules,
  },
];
