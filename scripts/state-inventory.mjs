// Static state definitions, not live object counts. See docs/STATE.md for scope.
import fs from 'node:fs';
import path from 'node:path';
import { Linter } from 'eslint';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MUTATORS = new Set(['set', 'add', 'delete', 'clear', 'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse']);
const TRANSIENT = new Set(['packMachineBatch', 'parseMachineBatch', 'buildPlainDigest', 'extractRepeatedSourceTerms',
  'parseTranslationResponse', 'buildSources', 'beginGate', 'flush', 'sleep', 'createExecution', 'translateMachineWithRecovery']);
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
function dataFields(node) {
  if (node?.type === 'ConditionalExpression') return [...dataFields(node.consequent), ...dataFields(node.alternate)];
  if (node?.type === 'LogicalExpression') return dataFields(node.right);
  if (node?.type !== 'ObjectExpression') return [];
  return node.properties.flatMap(p => {
    if (p.type === 'SpreadElement') return dataFields(p.argument);
    return p.kind === 'init' && !p.method && !/Function/.test(p.value.type) ? [p.key.name || p.key.value] : [];
  }).sort();
}

function owner(node) {
  for (let p = node; p; p = p.parent) {
    if (/Function/.test(p.type)) {
      const name = p.id?.name || p.parent?.key?.name || p.parent?.id?.name;
      if (name) return name;
    }
  }
  return 'module';
}
function mutation(reference) {
  if (reference.isWrite() && !reference.init) return true;
  let node = reference.identifier;
  while (node.parent?.type === 'MemberExpression' && node.parent.object === node) node = node.parent;
  const parent = node.parent;
  if (parent?.type === 'AssignmentExpression' && parent.left === node) return true;
  if (parent?.type === 'UpdateExpression') return true;
  return parent?.type === 'CallExpression' && parent.callee === node && MUTATORS.has(node.property?.name);
}
function selected(variable) {
  const def = variable.defs[0];
  if (def?.type !== 'Variable') return false;
  const refs = variable.references;
  const held = variable.scope.type === 'module' || refs.some(ref => ref.from.variableScope !== variable.scope.variableScope);
  if (!held) return false;
  // Empty runtime containers may be mutated through aliases/helper arguments.
  const init = def.node.init;
  const resource = init?.type === 'NewExpression' &&
    (/^(MutationObserver|AbortController)$/.test(init.callee.name) ||
    (/^(Map|WeakMap|Set|WeakSet)$/.test(init.callee.name) && !init.arguments.length));
  const timer = init?.type === 'CallExpression' && /^(setTimeout|setInterval)$/.test(init.callee.name);
  return refs.some(mutation) || resource || timer;
}

export function inventory(root = ROOT) {
  const rows = [];
  const linter = new Linter();
  for (const file of walk(path.join(root, 'src')).filter(file => file.endsWith('.js'))) {
    const relative = path.relative(root, file).replaceAll(path.sep, '/');
    const messages = linter.verify(fs.readFileSync(file, 'utf8'), {
      languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      plugins: { inventory: { rules: { collect: { create(context) {
        const source = context.sourceCode;
        return { 'Program:exit'() {
          for (const scope of source.scopeManager.scopes) {
            for (const variable of scope.variables.filter(selected)) {
              const node = variable.defs[0].node;
              const mutations = variable.references.filter(mutation);
              const fields = new Set(dataFields(node.init));
              if (node.init?.type === 'CallExpression') {
                const factory = source.ast.body.map(n => n.declaration || n).find(n => n.id?.name === node.init.callee.name);
                const returned = factory?.body?.body?.find(n => n.type === 'ReturnStatement');
                for (const field of dataFields(returned?.argument)) fields.add(field);
              }
              for (const ref of mutations) {
                const member = ref.identifier.parent;
                if (member.type === 'MemberExpression' && !member.computed) fields.add(member.property.name);
              }
              for (const method of MUTATORS) fields.delete(method);
              rows.push({ file: relative, owner: owner(node), name: variable.name,
                kind: node.init?.type === 'NewExpression' ? node.init.callee.name : 'binding',
                lifetime: TRANSIENT.has(owner(node)) ? 'request-or-scan' : 'retained', fields: [...fields].sort() });
            }
          }
        }, AssignmentExpression(node) {
          if (node.left.type === 'MemberExpression' && node.left.object.type === 'ThisExpression') {
            rows.push({ file: relative, owner: 'class', name: `this.${node.left.property.name}`, kind: 'field',
              lifetime: relative.endsWith('/logger.js') ? 'request-or-scan' : 'retained', fields: [] });
          }
          if (node.left.type === 'MemberExpression' && node.left.object.name === 'unit' && !node.left.computed) {
            rows.push({ file: relative, owner: 'unit-writes', name: node.left.property.name,
              kind: 'record-write', lifetime: 'schema-write', fields: [] });
          }
        }, ObjectExpression(node) {
          const fields = dataFields(node);
          const hasMap = node.properties.some(p => p.value?.type === 'NewExpression' && /Map|Set/.test(p.value.callee.name));
          const scope = owner(node);
          const variable = node.parent.type === 'VariableDeclarator' ? node.parent.id.name : null;
          const assigned = node.parent.type === 'AssignmentExpression' ? source.getText(node.parent.left) : null;
          const returnedUnit = scope === 'makeUnit' && node.parent.type === 'ReturnStatement';
          const storedRecord = ['putCached', 'add'].includes(scope) && node.parent.type === 'CallExpression';
          const namedRecord = (scope === 'openSession' && variable === 'record') ||
            (scope === 'record' && variable === 'row') || assigned === 'app.preflightSnapshot' ||
            (['writePreflightCache', 'beginPreflightCache'].includes(scope) && node.parent.type === 'CallExpression') ||
            node.parent.parent?.id?.name === 'DEFAULT_SETTINGS';
          if (hasMap || returnedUnit || storedRecord || namedRecord) rows.push({
            file: relative, owner: relative.endsWith('/preflight-cache.js') ? 'preflight-entry' : scope,
            name: assigned || variable || 'record', kind: 'record-schema',
            lifetime: 'schema', fields
          });
        } };
      } } } } },
      rules: { 'inventory/collect': 'error' }
    });
    if (messages.some(m => m.fatal)) throw Error(`${relative}: cannot parse`);
  }
  const merged = new Map();
  for (const row of rows) {
    const key = `${row.file}:${row.owner}:${row.name}`;
    const previous = merged.get(key);
    merged.set(key, { ...row, fields: [...new Set([...(previous?.fields || []), ...row.fields])].sort() });
  }
  return [...merged.values()]
    .sort((a, b) => `${a.file}:${a.owner}:${a.name}`.localeCompare(`${b.file}:${b.owner}:${b.name}`));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : ROOT;
  console.log(JSON.stringify(inventory(root), null, 2));
}
