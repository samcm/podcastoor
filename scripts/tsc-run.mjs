import ts from "typescript";

const noEmit = process.argv.includes("--noEmit");
const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, "tsconfig.json");
if (!configPath) {
  console.error("tsconfig.json not found");
  process.exit(1);
}

const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) {
  report([config.error]);
  process.exit(1);
}

const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd(), noEmit ? { noEmit: true } : {});
if (parsed.errors.length > 0) {
  report(parsed.errors);
  process.exit(1);
}

const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = [
  ...program.getOptionsDiagnostics(),
  ...program.getGlobalDiagnostics(),
  ...program.getSyntacticDiagnostics(),
  ...program.getSemanticDiagnostics()
];
if (diagnostics.length > 0) {
  report(diagnostics);
}

let emitSkipped = false;
if (!noEmit && diagnostics.every((diagnostic) => diagnostic.category !== ts.DiagnosticCategory.Error)) {
  const emit = program.emit();
  emitSkipped = emit.emitSkipped;
  if (emit.diagnostics.length > 0) report(emit.diagnostics);
  diagnostics.push(...emit.diagnostics);
}

if (emitSkipped || diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
  process.exit(1);
}

function report(diagnostics) {
  const host = {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => ts.sys.newLine
  };
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
}
