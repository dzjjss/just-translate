/** 页面有多个 DOM 根，但仍只有一套翻译会话；这些遍历不保留根或节点的登记表。 */
export function parentInPage(node) {
  return node?.assignedSlot || node?.parentElement || node?.getRootNode?.().host || null;
}

export function closestInPage(node, selector) {
  let element = node?.nodeType === Node.ELEMENT_NODE ? node : parentInPage(node);
  while (element) {
    if (element.matches(selector)) return element;
    element = parentInPage(element);
  }
  return null;
}

export function containsInPage(root, node) {
  for (let current = node; current; current = parentInPage(current)) {
    if (current === root) return true;
  }
  return false;
}

export function isOwnNode(node) {
  return Boolean(closestInPage(node, '.byom-t, #byom-hud, #byom-fab'));
}

/** 顺着实际渲染树读取；不把未分配到插槽的 light DOM 再翻一次。 */
export function renderedChildren(node) {
  if (node.shadowRoot) return node.shadowRoot.childNodes;
  if (node.nodeName === 'SLOT') {
    const assigned = node.assignedNodes({ flatten: true });
    if (assigned.length) return assigned;
  }
  return node.childNodes;
}

/** 监听、样式清理需要访问所有开放根，包括刚被隐藏的组件。正文是否可翻由提取器判断。 */
export function* pageRoots(scope = document) {
  yield scope;
  if (scope.shadowRoot && !isOwnNode(scope)) yield* pageRoots(scope.shadowRoot);
  for (const element of scope.querySelectorAll('*')) {
    if (element.shadowRoot && !isOwnNode(element)) yield* pageRoots(element.shadowRoot);
  }
}

export function* queryPage(selector) {
  for (const root of pageRoots()) yield* root.querySelectorAll(selector);
}
