import ts from 'typescript';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

function sources(directory) {
  return readdirSync(directory,{withFileTypes:true}).flatMap(entry => entry.isDirectory()
    ? ['node_modules','build','dist'].includes(entry.name) ? [] : sources(join(directory,entry.name))
    : /\.(mjs|ts|js|jsx)$/.test(entry.name) ? [join(directory,entry.name)] : []);
}
// Catch undefined runtime symbols in both the composition root and dashboard.
// TypeScript's full service validation is also performed by build:ts.
const program=ts.createProgram([...sources('backend'),...sources('frontend/src')],{allowJs:true,checkJs:true,noEmit:true,skipLibCheck:true,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext});
const diagnostics=ts.getPreEmitDiagnostics(program).filter(diagnostic => [2304,2552].includes(diagnostic.code));
for(const diagnostic of diagnostics) {
  const location=diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start || 0);
  console.error(`${diagnostic.file?.fileName}:${(location?.line || 0)+1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText,' ')}`);
}
if(diagnostics.length) process.exitCode=1;
