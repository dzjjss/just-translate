import { waitForReply } from '../shared/action-feedback.js';
import { patchSettings } from '../shared/settings.js';
import { listProviders } from '../shared/provider-catalog.js';

const ACCOUNT_FIELDS = ['apiBase', 'apiKey', 'model'];
const RULE_FIELDS = ['background', 'rulesText', 'customPrompt'];
const same = (left, right, keys) => keys.every(key => (left[key] || '') === (right[key] || ''));

/** Visible drafts live in the inputs. Only unsaved offscreen accounts need a copy.
 * The background owns write ordering; configVersion orders acknowledgements here.
 */
export function createSettingsForm(field, initial) {
  let saved = initial;
  let providerId = initial.providerId;
  const drafts = new Map();

  function account(id) {
    if (id === saved.providerId) return saved;
    const provider = listProviders().find(item => item.id === id) || {};
    return saved.accounts?.[id] || {
      apiBase: provider.defaultBase || '', apiKey: '', model: provider.defaultModel || ''
    };
  }

  function readModel(id = providerId) {
    const provider = listProviders().find(item => item.id === id) || {};
    return {
      providerId: id,
      apiBase: provider.fixedBase ? provider.defaultBase : field('apiBase').value.trim(),
      apiKey: field('apiKey').value.trim(),
      model: field('model').value.trim()
    };
  }

  function readRules() {
    return Object.fromEntries(RULE_FIELDS.map(key => [key, field(key).value.trim()]));
  }

  function changed(group) {
    if (group === 'rules') return !same(readRules(), saved, RULE_FIELDS);
    return providerId !== saved.providerId || !same(readModel(), account(providerId), ACCOUNT_FIELDS) ||
      [...drafts].some(([id, draft]) => id !== providerId && !same(draft, account(id), ACCOUNT_FIELDS));
  }

  function remember() {
    const model = readModel();
    if (same(model, account(providerId), ACCOUNT_FIELDS)) drafts.delete(providerId);
    else drafts.set(providerId, Object.fromEntries(ACCOUNT_FIELDS.map(key => [key, model[key]])));
  }

  function switchProvider(nextId) {
    remember();
    providerId = nextId;
    const next = drafts.get(nextId) || account(nextId);
    drafts.delete(nextId);
    const provider = listProviders().find(item => item.id === nextId) || {};
    for (const key of ACCOUNT_FIELDS) field(key).value = next[key] || '';
    if (provider.fixedBase) field('apiBase').value = provider.defaultBase;
  }

  async function write(patch) {
    const next = await waitForReply(patchSettings(structuredClone(patch)));
    if (Number(next.configVersion) >= Number(saved.configVersion || 0)) saved = next;
    for (const [id, draft] of drafts) {
      if (same(draft, account(id), ACCOUNT_FIELDS)) drafts.delete(id);
    }
    return saved;
  }

  function applyModel() {
    const model = readModel();
    const accounts = Object.fromEntries(drafts);
    accounts[providerId] = Object.fromEntries(ACCOUNT_FIELDS.map(key => [key, model[key]]));
    return write({ ...model, accounts });
  }

  return { get saved() { return saved; }, readModel, changed, switchProvider, write,
    applyModel, applyRules: () => write(readRules()) };
}
