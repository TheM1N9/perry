// Render the actual Markdown/provider/parser/UI with synthetic path registrations.
// No filesystem file is opened and no network/backend/engine is started.
import fs from "node:fs";
import { registerHooks } from "node:module";
import { resolve, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
const repo=resolve(import.meta.dirname,"../..");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/link") specifier="next/link.js";
    if (specifier === "@/lib/highlighter") return {url:"fixture:highlighter",shortCircuit:true};
    if (specifier.startsWith("@/")) specifier=pathToFileURL(resolve(repo,specifier.slice(2))).href;
    try {return next(specifier,context);} catch(error) {
      if (!specifier.startsWith("file:") && !specifier.startsWith(".")) throw error;
      for(const extension of [".tsx",".ts"]) {try{return next(specifier+extension,context);}catch{}}
      throw error;
    }
  },
  load(url,context,next) {
    if(url === "fixture:highlighter") return {format:"module",shortCircuit:true,source:"export async function loadHighlighter(){return null;}"};
    if(url.startsWith(pathToFileURL(repo).href) && !url.includes("node_modules") && [".ts",".tsx"].includes(extname(fileURLToPath(url)))) {
      return {format:"module",shortCircuit:true,source:ts.transpileModule(fs.readFileSync(new URL(url),"utf8"),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText};
    }
    return next(url,context);
  },
});
const {Markdown,ChatFiles}=await import(pathToFileURL(resolve(repo,"components/dashboard/chat/markdown.tsx")).href);
const cases={
  windows:"[report](W:/fixture/report.md)",
  windowsWithLine:"[report](W:/fixture/report.md:12)",
  windowsBackslash:"[report](<W:\\fixture\\report.md>)",
  windowsFileUrl:"[report](file:///W:/fixture/report.md)",
  relative:"[report](report.md)",
  unknown:"[report](W:/unregistered/report.md)",
  unsafe:"[report](javascript:alert%281%29)",
};
const report={checks:{},notes:{}};
for(const [name,text] of Object.entries(cases)) {
  const html=renderToStaticMarkup(React.createElement(ChatFiles.Provider,{value:[{path:"W:\\fixture\\report.md",url:"/api/media/fake?preview"}]},React.createElement(Markdown,{text})));
  report.checks[name]=["unknown","unsafe"].includes(name) ? !html.includes('href=') : html.includes('href="/api/media/fake?preview"');
  report.notes[name]=html;
}
report.ok=Object.values(report.checks).every(Boolean);
fs.writeFileSync(new URL("./file-result.json",import.meta.url),JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report));process.exitCode=report.ok?0:1;
