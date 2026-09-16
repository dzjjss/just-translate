const CUSTOM = '__jt_custom_model__';

/** The select and explicit custom input own the draft; no parallel model cache. */
export function createModelPicker(select, custom, knownModels, labels = {}) {
  function read() {
    return select.value === CUSTOM ? custom.value.trim() : select.value;
  }

  function options(ids, value = read()) {
    select.replaceChildren();
    const add = (id, text) => {
      const option = select.ownerDocument.createElement('option');
      option.value = id;
      option.textContent = text;
      select.append(option);
    };
    add('', labels.empty?.() || 'Select a model');
    const models = [...new Set([...(Array.isArray(ids) ? ids : []), value].filter(id => typeof id === 'string' && id.trim() && id !== CUSTOM))];
    for (const id of models) add(id, id);
    add(CUSTOM, labels.custom?.() || 'Custom model…');
    select.value = value === CUSTOM ? CUSTOM : value || '';
    custom.hidden = select.value !== CUSTOM;
  }

  return {
    get value() { return read(); },
    set value(value) {
      const next = String(value || '').trim();
      custom.value = next === CUSTOM ? next : '';
      options(knownModels(), next);
    },
    replaceOptions(ids) {
      const editing = select.value === CUSTOM;
      options(ids);
      if (editing) { select.value = CUSTOM; custom.hidden = false; }
    },
    changed() {
      custom.hidden = select.value !== CUSTOM;
      if (!custom.hidden) custom.focus();
    },
    relabel() {
      select.options[0].textContent = labels.empty?.() || 'Select a model';
      select.options[select.options.length - 1].textContent = labels.custom?.() || 'Custom model…';
    }
  };
}
