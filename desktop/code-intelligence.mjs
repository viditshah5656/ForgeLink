import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const MAX_PROJECT_FILES = 1500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_READ_BYTES = 32 * 1024 * 1024;
const MAX_RESULTS = 100;
const LIB_ROOT = path.dirname(ts.getDefaultLibFilePath({}));

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function allowedPath(root, candidate) {
  const absolute = path.resolve(candidate);
  if (!inside(root, absolute) && !inside(LIB_ROOT, absolute)) return false;
  try {
    const real = fs.realpathSync.native(absolute);
    return inside(root, real) || inside(LIB_ROOT, real);
  } catch { return false; }
}

function projectConfig(root, file, host) {
  for (let directory = path.dirname(file); inside(root, directory); directory = path.dirname(directory)) {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const candidate = path.join(directory, name);
      if (!host.fileExists(candidate)) continue;
      const loaded = ts.readConfigFile(candidate, host.readFile);
      if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
      const parsed = ts.parseJsonConfigFileContent(loaded.config, host, directory, undefined, candidate);
      if (parsed.errors.length) throw new Error(parsed.errors.slice(0, 3).map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('; '));
      return { configPath: candidate, files: parsed.fileNames, options: parsed.options };
    }
    if (directory === root) break;
  }
  return {
    configPath: null,
    files: [file],
    options: { allowJs: true, checkJs: false, noEmit: true, jsx: ts.JsxEmit.Preserve, moduleResolution: ts.ModuleResolutionKind.Node10, target: ts.ScriptTarget.ES2022 },
  };
}

function createContext(workspace, file) {
  const root = fs.realpathSync.native(path.resolve(workspace));
  const target = fs.realpathSync.native(path.resolve(file));
  if (!inside(root, target) || !SOURCE_EXTENSIONS.has(path.extname(target).toLowerCase())) {
    throw new Error('Choose a JavaScript or TypeScript source file inside the selected workspace');
  }
  const reads = new Map();
  let readBytes = 0;
  const safeFile = (candidate) => {
    if (!allowedPath(root, candidate)) return false;
    try { const stat = fs.statSync(candidate); return stat.isFile() && stat.size <= MAX_FILE_BYTES; }
    catch { return false; }
  };
  const safeDirectory = (candidate) => {
    if (!allowedPath(root, candidate)) return false;
    try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
  };
  const readFile = (candidate) => {
    if (!safeFile(candidate)) return undefined;
    const absolute = path.resolve(candidate);
    if (reads.has(absolute)) return reads.get(absolute);
    const size = fs.statSync(absolute).size;
    if (readBytes + size > MAX_READ_BYTES) throw new Error('Code analysis exceeded its 32 MiB read limit');
    const content = fs.readFileSync(absolute, 'utf8');
    reads.set(absolute, content);
    readBytes += size;
    return content;
  };
  const host = {
    fileExists: safeFile,
    readFile,
    directoryExists: safeDirectory,
    getDirectories: (directory) => safeDirectory(directory) ? ts.sys.getDirectories(directory).filter((item) => safeDirectory(item)) : [],
    readDirectory: (directory, extensions, excludes, includes, depth) => safeDirectory(directory)
      ? ts.sys.readDirectory(directory, extensions, excludes, includes, Math.min(depth ?? 12, 12)).filter((item) => safeFile(item)).slice(0, MAX_PROJECT_FILES + 1)
      : [],
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  };
  const project = projectConfig(root, target, host);
  const files = [...new Set([...project.files.filter((item) => safeFile(item)), target])];
  if (files.length > MAX_PROJECT_FILES) throw new Error(`Code analysis supports at most ${MAX_PROJECT_FILES} project files`);
  const deadline = Date.now() + 10_000;
  const serviceHost = {
    ...host,
    getScriptFileNames: () => files,
    getScriptVersion: (candidate) => { try { const stat = fs.statSync(candidate); return `${stat.mtimeMs}:${stat.size}`; } catch { return '0'; } },
    getScriptSnapshot: (candidate) => { const content = readFile(candidate); return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content); },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => project.options,
    getDefaultLibFileName: (options) => path.join(LIB_ROOT, ts.getDefaultLibFileName(options)),
    getNewLine: () => ts.sys.newLine,
    getCancellationToken: () => ({ isCancellationRequested: () => Date.now() > deadline, throwIfCancellationRequested: () => { if (Date.now() > deadline) throw new Error('Code analysis timed out'); } }),
  };
  const service = ts.createLanguageService(serviceHost);
  const program = service.getProgram();
  const source = program?.getSourceFile(target);
  if (!source) { service.dispose(); throw new Error('The selected source file could not be analyzed'); }
  return { root, target, project, service, program, source, readFile };
}

function position(context, line, column) {
  if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1) throw new Error('Line and column must start at 1');
  const starts = context.source.getLineStarts();
  if (line > starts.length) throw new Error('Line is beyond the end of the file');
  const start = starts[line - 1];
  const end = line < starts.length ? starts[line] : context.source.text.length;
  if (start + column - 1 > end) throw new Error('Column is beyond the end of the line');
  return start + column - 1;
}

function place(context, fileName, span) {
  const absolute = path.resolve(fileName);
  if (!inside(context.root, absolute) || !allowedPath(context.root, absolute)) return null;
  const source = context.program.getSourceFile(absolute);
  if (!source) return null;
  const start = source.getLineAndCharacterOfPosition(span.start);
  const end = source.getLineAndCharacterOfPosition(span.start + span.length);
  return { path: absolute, line: start.line + 1, column: start.character + 1, endLine: end.line + 1, endColumn: end.character + 1 };
}

function locations(context, entries) {
  return (entries || []).slice(0, MAX_RESULTS * 2).map((entry) => {
    const location = place(context, entry.fileName, entry.textSpan);
    return location && { ...location, name: entry.name ?? null, kind: entry.kind ?? null, isDefinition: Boolean(entry.isDefinition) };
  }).filter(Boolean).slice(0, MAX_RESULTS);
}

export function codeQuery({ workspace, file, line, column, kind }) {
  const context = createContext(workspace, file);
  try {
    const offset = position(context, line, column);
    const { service, target } = context;
    if (kind === 'definition') return { kind, locations: locations(context, service.getDefinitionAtPosition(target, offset)) };
    if (kind === 'references') return { kind, locations: locations(context, service.getReferencesAtPosition(target, offset)) };
    if (kind === 'implementations') return { kind, locations: locations(context, service.getImplementationAtPosition(target, offset)) };
    if (kind === 'type_definition') return { kind, locations: locations(context, service.getTypeDefinitionAtPosition(target, offset)) };
    if (kind === 'type' || kind === 'documentation') {
      const info = service.getQuickInfoAtPosition(target, offset);
      return { kind, display: info ? ts.displayPartsToString(info.displayParts).slice(0, 4000) : null, documentation: info ? ts.displayPartsToString(info.documentation).slice(0, 4000) : null };
    }
    if (kind === 'signature') {
      const info = service.getSignatureHelpItems(target, offset, undefined);
      return { kind, activeParameter: info?.argumentIndex ?? null, signatures: (info?.items ?? []).slice(0, 20).map((item) => ({
        label: ts.displayPartsToString(item.prefixDisplayParts) + item.parameters.map((parameter) => ts.displayPartsToString(parameter.displayParts)).join(ts.displayPartsToString(item.separatorDisplayParts)) + ts.displayPartsToString(item.suffixDisplayParts),
        documentation: ts.displayPartsToString(item.documentation).slice(0, 2000),
      })) };
    }
    throw new Error(`Unsupported code query: ${kind}`);
  } finally { context.service.dispose(); }
}

export function codeSymbols({ workspace, file, query = '' }) {
  const context = createContext(workspace, file);
  try {
    if (query) {
      return { scope: 'project', configPath: context.project.configPath, symbols: context.service.getNavigateToItems(query, MAX_RESULTS, undefined, true, true)
        .map((item) => ({ ...place(context, item.fileName, item.textSpan), name: item.name, kind: item.kind, containerName: item.containerName }))
        .filter((item) => item.path) };
    }
    const flatten = (items, depth = 0) => items.flatMap((item) => [
      ...(item.spans?.length ? [{ ...place(context, context.target, item.spans[0]), name: item.text, kind: item.kind, depth }] : []),
      ...(depth < 8 ? flatten(item.childItems ?? [], depth + 1) : []),
    ]);
    return { scope: 'file', configPath: context.project.configPath, symbols: flatten(context.service.getNavigationBarItems(context.target)).filter((item) => item.path).slice(0, MAX_RESULTS) };
  } finally { context.service.dispose(); }
}

export function codeRelations({ workspace, file, line, column, kind }) {
  const context = createContext(workspace, file);
  try {
    if (kind === 'importers') {
      return { kind, locations: locations(context, context.service.getFileReferences(context.target)) };
    }
    if (kind === 'exports') {
      const symbols = [];
      for (const statement of context.source.statements) {
        const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
        const names = [];
        if (exported && ts.isVariableStatement(statement)) names.push(...statement.declarationList.declarations.map((item) => item.name.getText(context.source)));
        else if (exported && statement.name) names.push(statement.name.getText(context.source));
        else if (ts.isExportDeclaration(statement)) {
          if (statement.exportClause && ts.isNamedExports(statement.exportClause)) names.push(...statement.exportClause.elements.map((item) => item.name.text));
          else names.push('*');
        } else if (ts.isExportAssignment(statement)) names.push('default');
        for (const name of names) symbols.push({ name, kind: ts.SyntaxKind[statement.kind], ...place(context, context.target, { start: statement.getStart(), length: statement.getWidth() }) });
      }
      return { kind, symbols: symbols.slice(0, MAX_RESULTS) };
    }
    if (kind !== 'callers' && kind !== 'callees') throw new Error(`Unsupported code relation: ${kind}`);
    const offset = position(context, line, column);
    const prepared = context.service.prepareCallHierarchy(context.target, offset);
    const item = Array.isArray(prepared) ? prepared[0] : prepared;
    if (!item) return { kind, calls: [] };
    const calls = kind === 'callers'
      ? context.service.provideCallHierarchyIncomingCalls(item.file, item.selectionSpan.start)
      : context.service.provideCallHierarchyOutgoingCalls(item.file, item.selectionSpan.start);
    return { kind, calls: calls.slice(0, MAX_RESULTS).map((call) => {
      const related = kind === 'callers' ? call.from : call.to;
      const location = place(context, related.file, related.selectionSpan);
      return location && { name: related.name, kind: related.kind, ...location };
    }).filter(Boolean) };
  } finally { context.service.dispose(); }
}

export function codeOrganizeImportsPlan({ workspace, file }) {
  const context = createContext(workspace, file);
  try {
    const edits = context.service.organizeImports({ type: 'file', fileName: context.target, mode: ts.OrganizeImportsMode.All }, { newLineCharacter: ts.sys.newLine }, {});
    if (edits.some((item) => item.isNewFile || path.resolve(item.fileName) !== context.target)) throw new Error('Import organization would change another file');
    const original = context.readFile(context.target);
    if (original === undefined) throw new Error('Source file could not be read');
    let content = original;
    let previousStart = content.length + 1;
    for (const change of edits.flatMap((item) => item.textChanges).sort((a, b) => b.span.start - a.span.start)) {
      const { start, length } = change.span;
      if (start + length > previousStart || start < 0 || start + length > content.length) throw new Error('Import edits overlap or are stale');
      content = content.slice(0, start) + change.newText + content.slice(start + length);
      previousStart = start;
    }
    return {
      changed: content !== original,
      operations: content === original ? [] : [{ kind: 'write', path: context.target, content, expectedSha256: crypto.createHash('sha256').update(original, 'utf8').digest('hex') }],
    };
  } finally { context.service.dispose(); }
}

export function codeRenamePlan({ workspace, file, line, column, newName }) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(newName)) throw new Error('New name must be a JavaScript or TypeScript identifier');
  const context = createContext(workspace, file);
  try {
    const offset = position(context, line, column);
    const info = context.service.getRenameInfo(context.target, offset, { allowRenameOfImportPath: false });
    if (!info.canRename) throw new Error(info.localizedErrorMessage || 'This symbol cannot be renamed');
    const references = context.service.findRenameLocations(context.target, offset, false, false, { providePrefixAndSuffixTextForRename: true }) ?? [];
    if (!references.length) throw new Error('No rename locations were found');
    if (references.length > 500) throw new Error('Rename exceeds 500 locations');
    const grouped = new Map();
    for (const reference of references) {
      const target = path.resolve(reference.fileName);
      if (!inside(context.root, target) || !allowedPath(context.root, target) || /(?:^|[\\/])node_modules(?:[\\/]|$)/i.test(target)) {
        throw new Error('Rename reaches an unapproved or dependency file');
      }
      if (!grouped.has(target)) grouped.set(target, []);
      grouped.get(target).push(reference);
    }
    if (grouped.size > 50) throw new Error('Rename exceeds the 50-file transaction limit');
    const operations = [];
    const changes = [];
    for (const [target, entries] of grouped) {
      let content = context.readFile(target);
      if (content === undefined) throw new Error(`Rename file could not be read: ${target}`);
      const expectedSha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
      const ordered = entries.sort((a, b) => b.textSpan.start - a.textSpan.start);
      let previousStart = content.length + 1;
      for (const entry of ordered) {
        const { start, length } = entry.textSpan;
        if (start + length > previousStart || start < 0 || start + length > content.length) throw new Error('Rename locations overlap or are stale');
        const replacement = `${entry.prefixText ?? ''}${newName}${entry.suffixText ?? ''}`;
        content = content.slice(0, start) + replacement + content.slice(start + length);
        previousStart = start;
      }
      if (Buffer.byteLength(content, 'utf8') > 5 * 1024 * 1024) throw new Error('Renamed file exceeds the transaction file limit');
      operations.push({ kind: 'write', path: target, content, expectedSha256 });
      changes.push({ path: target, occurrences: entries.length });
    }
    return { oldName: info.displayName, newName, changes, operations };
  } finally { context.service.dispose(); }
}

export const CODE_INTELLIGENCE_VERSION = ts.version;
