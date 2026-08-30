/**
 * 只开必要的规则。
 *
 * 这个配置的由来：一次「把预检 prompt 改成 YAML」的字符串替换静默失败，
 * 而 README 和测试都当它成功了 —— 一个从未生效的功能在三个版本里活着。
 * 同一轮里还留下两处重复对象键和一个未使用的 import。
 * 这些全是机械检查一秒钟能抓的东西，不该占用判断力。
 *
 * 所以规则集刻意保持小：能拦住"改动没落地"和"改完留残渣"就够，
 * 不做风格审美，那属于 Prettier 的活，现在不引。
 */
export default [
  {
    files: ['src/**/*.js', 'test/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        chrome: 'readonly',
        document: 'readonly',
        window: 'readonly',
        location: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        Node: 'readonly',
        Element: 'readonly',
        MutationObserver: 'readonly',
        IntersectionObserver: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        DOMException: 'readonly',
        Blob: 'readonly',
        URL: 'readonly',
        localStorage: 'readonly',
        navigator: 'readonly',
        getComputedStyle: 'readonly',
        matchMedia: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        CSSStyleSheet: 'readonly',
        global: 'readonly',
        process: 'readonly',
        structuredClone: 'readonly'
      }
    },
    rules: {
      // 这次真出过事的三条
      'no-dupe-keys': 'error',
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      // 同类的低级失误，顺手一起拦
      'no-dupe-args': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-duplicate-imports': 'error',
      'no-unreachable': 'error',
      'no-self-assign': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  }
];
