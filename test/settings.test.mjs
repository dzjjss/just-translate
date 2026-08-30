/**
 * 设置迁移测试。
 *
 * 这类 bug 极其隐蔽：读取是 { ...DEFAULT_SETTINGS, ...stored }，
 * 任意字段一旦持久化，当前整张表都会写入 storage，之后改 DEFAULT_SETTINGS 可能对老用户无效。
 * autoPreflight 从 false 改成 true 就是这么静默失效的 —— 老用户一次预检都没跑过。
 */
import assert from 'node:assert';

let stored = {};
global.chrome = {
  storage: {
    local: {
      async get(key) {
        return key in stored ? { [key]: JSON.parse(JSON.stringify(stored[key])) } : {};
      },
      async set(obj) {
        Object.assign(stored, JSON.parse(JSON.stringify(obj)));
      }
    },
    onChanged: { addListener() {} }
  }
};

const { getSettings, getSettingsAndPersistMigration } = await import('../src/shared/settings.js');
const { toRuntimeConfig, classifyRuntimeConfigChange } = await import('../src/shared/settings.js');

let failed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('老用户存着的 autoPreflight:false 会被迁移翻正', async () => {
  // 模拟旧版本已经持久化过设置的用户：整张表都写死了，且没有版本号
  stored = {
    settings: {
      providerId: 'deepseek',
      apiBase: 'https://api.deepseek.com',
      apiKey: 'sk-old',
      model: 'deepseek-v4-flash',
      autoPreflight: false
    }
  };
  const s = await getSettingsAndPersistMigration();
  assert.equal(s.autoPreflight, true, '改默认值救不了老用户，必须靠迁移');
  assert.equal(s.apiKey, 'sk-old', '迁移不该动用户自己填的东西');
  assert.equal(stored.settings.schemaVersion, 13, '迁移结果必须落盘');
  assert.equal(stored.settings.autoPreflight, true);
});

test('扁平三件套迁成账户，且不覆盖已有账户', async () => {
  assert.equal(stored.settings.accounts.deepseek.apiKey, 'sk-old', '旧配置没有落成账户');
});

test('迁移是幂等的：用户手动关掉之后不会被反复打开', async () => {
  // 已经迁过的用户把预检关掉
  stored.settings.autoPreflight = false;
  const again = await getSettingsAndPersistMigration();
  assert.equal(again.autoPreflight, false, '迁移重跑了，把用户手动关掉的开关又打开了');
});

test('三个跳过开关合并成 smartFilter，老用户关过的选择要沿用', async () => {
  stored = { settings: { skipSameScript: true, skipSingleToken: false, skipTightLayout: true } };
  const s = await getSettingsAndPersistMigration();
  assert.equal(s.smartFilter, false, '老用户关过其中一个，合并后不该被重新打开');
  assert.equal('skipSingleToken' in stored.settings, false, '旧字段没有清掉，会一直躺在存储里');
  assert.equal('temperature' in stored.settings, false, '已删的设置项没有清掉');

  stored = { settings: { skipSameScript: true, skipSingleToken: true, skipTightLayout: true } };
  assert.equal((await getSettingsAndPersistMigration()).smartFilter, true);
});

test('Gemini 官方端点的退役 2.0 默认模型迁到当前 Flash，自定义网关不乱改', async () => {
  stored = {
    settings: {
      schemaVersion: 3,
      providerId: 'gemini',
      apiBase: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: 'AIza-old',
      model: 'gemini-2.0-flash',
      accounts: {
        gemini: {
          apiBase: 'https://generativelanguage.googleapis.com/v1beta/openai',
          apiKey: 'AIza-old',
          model: 'gemini-2.0-flash-lite'
        }
      }
    }
  };
  const migrated = await getSettingsAndPersistMigration();
  assert.equal(migrated.model, 'gemini-3.7-flash');
  assert.equal(migrated.accounts.gemini.model, 'gemini-3.7-flash');

  stored = {
    settings: {
      schemaVersion: 3,
      providerId: 'gemini',
      apiBase: 'https://gateway.example.com/v1',
      model: 'gemini-2.0-flash',
      accounts: {}
    }
  };
  assert.equal((await getSettingsAndPersistMigration()).model, 'gemini-2.0-flash');
});

test('退役设置键（useGlossary / lazy / alwaysOn）迁移后被删除', async () => {
  stored = { settings: { schemaVersion: 4, useGlossary: false, lazy: true, alwaysOn: true } };
  const migrated = await getSettingsAndPersistMigration();
  assert.equal('useGlossary' in migrated, false);
  assert.equal('lazy' in migrated, false);
  assert.equal('alwaysOn' in migrated, false);
  assert.equal('useGlossary' in stored.settings, false);
  assert.equal('lazy' in stored.settings, false);
  assert.equal('alwaysOn' in stored.settings, false);
});

test('旧 Beta 字段迁移为正式的语义一致性观测，并默认开启', async () => {
  stored = { settings: { schemaVersion: 7, experimentalAlignedTerms: true } };
  const migrated = await getSettingsAndPersistMigration();
  assert.equal(migrated.semanticConsistency, true);
  assert.equal('betaConsistency' in migrated, false);
  assert.equal('experimentalAlignedTerms' in migrated, false);
  assert.equal(stored.settings.schemaVersion, 13);
});


test('Sunset Orange 迁移只改旧默认主题，不覆盖用户自定义，也不切模型', async () => {
  stored = { settings: {
    schemaVersion: 8,
    providerId: 'openai', apiBase: 'https://api.openai.com/v1', apiKey: 'sk-user', model: 'gpt-user',
    translationColor: 'inherit', textColorLight: '#1f1f2e', textColorDark: '#e8e8f4',
    accentColorLight: '#5A4FE0', accentColorDark: '#8A80FF'
  } };
  const migrated = await getSettingsAndPersistMigration();
  assert.equal(migrated.providerId, 'openai', '视觉迁移不该顺手切到 DeepSeek');
  assert.equal(migrated.model, 'gpt-user', '视觉迁移不该覆盖已有模型');
  assert.equal(migrated.translationColor, 'custom');
  assert.equal(migrated.textColorLight, '#9A4F2D');
  assert.equal(migrated.accentColorLight, '#F2783C');

  stored = { settings: {
    schemaVersion: 8,
    translationColor: 'custom', textColorLight: '#123456', textColorDark: '#abcdef',
    accentColorLight: '#654321', accentColorDark: '#fedcba'
  } };
  const custom = await getSettingsAndPersistMigration();
  assert.equal(custom.textColorLight, '#123456');
  assert.equal(custom.accentColorLight, '#654321');
});

test('升级到 v13 会启用带安全门槛的整页优先策略', async () => {
  stored = { settings: { schemaVersion: 12, wholePageTranslation: false } };
  const migrated = await getSettingsAndPersistMigration();
  assert.equal(migrated.wholePageTranslation, true);
  assert.equal(stored.settings.schemaVersion, 13);
});

test('升级到 v12 会把 precedent 注入作为独立 Beta 默认关闭', async () => {
  stored = { settings: { schemaVersion: 11, semanticConsistency: true, semanticPrecedent: true } };
  const migrated = await getSettingsAndPersistMigration();
  assert.equal(migrated.semanticConsistency, true, '既有观测默认状态不应丢失');
  assert.equal(migrated.semanticPrecedent, false, '新实验不能继承旧开关的行为权限');
  assert.equal(stored.settings.schemaVersion, 13);
});

test('全新用户直接拿到当前默认值', async () => {
  stored = {};
  const s = await getSettings();
  assert.equal(s.autoPreflight, true);
  assert.equal(s.contentRootOnly, true, '正文优先应当默认开启');
  assert.equal(s.semanticConsistency, true, '语义一致性观测应默认开启');
  assert.equal(s.semanticPrecedent, false, '跨批先例注入是 Beta，不应替用户默认开启');
  assert.equal(s.wholePageTranslation, true, '安全范围内的整页翻译应默认开启');
  assert.equal(s.providerId, 'deepseek', 'fresh install 默认服务商应为 DeepSeek');
  assert.equal(s.apiBase, 'https://api.deepseek.com');
  assert.equal(s.model, 'deepseek-v4-flash');
  assert.equal(s.translationColor, 'custom');
  assert.equal(s.textColorLight, '#9A4F2D');
  assert.equal(s.accentColorLight, '#F2783C');
});

test('配置热更新按语义分类：页面只看 runtime contract', () => {
  const baseSettings = {
    providerId: 'openai', apiBase: 'https://api.openai.com/v1', model: 'gpt-a', customPrompt: '',
    targetLang: '简体中文', presetId: 'auto', background: '', rulesText: '', autoPreflight: true,
    siteRules: [], translationStyle: 'bar', smartFilter: true, maxCharsPerChunk: 2800,
    wholePageTranslation: false, semanticConsistency: true, semanticPrecedent: false
  };
  const base = toRuntimeConfig(baseSettings);

  const style = classifyRuntimeConfigChange(base, { ...base, translationStyle: 'tint' });
  assert.deepEqual(style.presentation, ['translationStyle']);
  assert.equal(style.semantic, false);

  const langRuntime = toRuntimeConfig({ ...baseSettings, targetLang: 'English' });
  assert.equal(classifyRuntimeConfigChange(base, langRuntime).semantic, true);

  const consistencyRuntime = toRuntimeConfig({ ...baseSettings, semanticConsistency: false });
  assert.equal(consistencyRuntime.semanticConsistency, false, '语义一致性观测必须下发到 content');
  const consistencyChange = classifyRuntimeConfigChange(base, consistencyRuntime);
  assert.equal(consistencyChange.semantic, false, '纯观测开关不应改变翻译语义');
  assert.deepEqual(consistencyChange.observation, ['semanticConsistency']);

  const precedentRuntime = toRuntimeConfig({ ...baseSettings, semanticPrecedent: true });
  assert.equal(precedentRuntime.semanticPrecedent, true, 'precedent Beta 必须下发到 content');
  assert.equal(classifyRuntimeConfigChange(base, precedentRuntime).semantic, true, 'precedent 注入必须进入 semanticRevision');

  const wholePageRuntime = toRuntimeConfig({ ...baseSettings, wholePageTranslation: true });
  assert.equal(wholePageRuntime.wholePageTranslation, true, '整页优先策略必须下发到 content 调度器');
  assert.equal(
    classifyRuntimeConfigChange(base, wholePageRuntime).semantic,
    true,
    '整页与分批不能在同一 PageSession 中途混用'
  );

  // content 根本看不到 model 字段，但 opaque revision 会变，因此仍能可靠开新 session
  const modelRuntime = toRuntimeConfig({ ...baseSettings, model: 'gpt-b' });
  assert.equal('model' in modelRuntime, false);
  assert.equal(classifyRuntimeConfigChange(base, modelRuntime).semantic, true);

  const extract = classifyRuntimeConfigChange(base, { ...base, smartFilter: false });
  assert.deepEqual(extract.extraction, ['smartFilter']);
  assert.equal(extract.semantic, false);

  assert.equal(classifyRuntimeConfigChange(base, { ...base }).semantic, false);
});

for (const [name, fn] of cases) {
  try {
    await fn();
    console.log('  ✓', name);
  } catch (e) {
    failed++;
    console.error('  ✗', name, '\n   ', e.message);
  }
}
console.log(failed ? `\n${failed} 个用例失败` : `\n${cases.length} 个用例全部通过`);
process.exit(failed ? 1 : 0);
