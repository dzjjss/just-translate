import { interfaceLanguage } from './languages.js';
import { EN_MESSAGES } from './ui-messages.js';

/** Stateless gettext-style messages. Parameters are data and never translated or evaluated. */
export function translateUi(language, source, ...values) {
  const key = Array.isArray(source)
    ? source.reduce((text, part, index) => text + (index ? `{${index - 1}}` : '') + part, '')
    : String(source ?? '');
  const message = interfaceLanguage(language) === 'en' && Object.hasOwn(EN_MESSAGES, key) ? EN_MESSAGES[key] : key;
  return message.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index]) : match);
}

/** Only explicitly marked extension-owned markup is localized; page/profile text is untouched. */
export function localizeMarkup(root, language) {
  for (const element of root.querySelectorAll('[data-i18n]')) {
    element.textContent = translateUi(language, element.dataset.i18n);
  }
  for (const element of root.querySelectorAll('[data-i18n-parts]')) {
    for (const [index, text] of Object.entries(JSON.parse(element.dataset.i18nParts))) {
      const node = element.childNodes[Number(index)];
      if (node?.nodeType === 3) node.textContent = translateUi(language, text);
    }
  }
  for (const attribute of ['title', 'aria-label', 'placeholder']) {
    for (const element of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
      element.setAttribute(attribute, translateUi(language, element.getAttribute(`data-i18n-${attribute}`)));
    }
  }
}
