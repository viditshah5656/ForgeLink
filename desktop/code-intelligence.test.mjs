import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { codeQuery, codeSymbols, codeRelations, codeRenamePlan, codeOrganizeImportsPlan } from './code-intelligence.mjs';
import { RecoveryManager } from './recovery-manager.mjs';

test('code intelligence navigates a project and plans a semantic rename', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'forgelink-code-'));
  try {
    const main = path.join(workspace, 'main.ts');
    const other = path.join(workspace, 'other.ts');
    await fs.writeFile(path.join(workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'commonjs' }, include: ['*.ts'] }));
    await fs.writeFile(main, "export function greet(name: string) { return name; }\n// greet stays in this comment\n");
    await fs.writeFile(other, "import { greet } from './main';\nexport const answer = greet('Ada');\n");

    const symbols = codeSymbols({ workspace, file: main, query: 'greet' });
    assert.ok(symbols.symbols.some((item) => item.name === 'greet' && item.path === main));

    const definition = codeQuery({ workspace, file: other, line: 2, column: 23, kind: 'definition' });
    assert.ok(definition.locations.some((item) => item.path === main && item.line === 1));

    const references = codeQuery({ workspace, file: main, line: 1, column: 17, kind: 'references' });
    assert.ok(references.locations.some((item) => item.path === other));
    assert.ok(codeRelations({ workspace, file: main, kind: 'importers' }).locations.some((item) => item.path === other));
    const exports = codeRelations({ workspace, file: main, kind: 'exports' });
    assert.ok(exports.symbols.some((item) => item.name === 'greet'), JSON.stringify(exports));
    const callers = codeRelations({ workspace, file: main, line: 1, column: 17, kind: 'callers' });
    assert.ok(Array.isArray(callers.calls));

    const plan = codeRenamePlan({ workspace, file: main, line: 1, column: 17, newName: 'hello' });
    assert.equal(plan.changes.length, 2);
    assert.ok(plan.operations.some((item) => item.path === main && item.content.includes('function hello')));
    assert.ok(plan.operations.some((item) => item.path === other && item.content.includes('hello(\'Ada\')')));
    assert.ok(plan.operations.find((item) => item.path === main).content.includes('// greet stays in this comment'));
    assert.ok((await fs.readFile(main, 'utf8')).includes('function greet'));

    const recovery = new RecoveryManager({ dataDir: workspace, resolveRead: async (input) => input, resolveWrite: async (input) => input });
    await fs.appendFile(main, '// external edit\n');
    const stale = await recovery.begin(workspace);
    await assert.rejects(recovery.preview(stale.id, plan.operations), /File changed since semantic edit was planned/);
    await recovery.rollback(stale.id);

    const freshPlan = codeRenamePlan({ workspace, file: main, line: 1, column: 17, newName: 'hello' });
    const transaction = await recovery.begin(workspace);
    await recovery.preview(transaction.id, freshPlan.operations);
    await recovery.apply(transaction.id);
    await recovery.commit(transaction.id);
    assert.ok((await fs.readFile(main, 'utf8')).includes('function hello'));
    assert.ok((await fs.readFile(other, 'utf8')).includes("hello('Ada')"));
    await recovery.undo(transaction.id);
    assert.ok((await fs.readFile(main, 'utf8')).includes('function greet'));
    assert.ok((await fs.readFile(main, 'utf8')).includes('// external edit'));

    const unused = path.join(workspace, 'unused.ts');
    await fs.writeFile(unused, "import { greet } from './main';\nexport const value = 1;\n");
    const organized = codeOrganizeImportsPlan({ workspace, file: unused });
    assert.equal(organized.changed, true);
    assert.ok(!organized.operations[0].content.includes('import { greet }'));
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
