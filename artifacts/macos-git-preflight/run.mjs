// Whole-installer E2E with stand-in tools, no downloads or real configuration.
// pnpm exec node artifacts/macos-git-preflight/run.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const repo=path.resolve(import.meta.dirname,"../..");
const base=path.resolve(repo,".batch-work/macos-git-preflight");
fs.mkdirSync(base,{recursive:true});
const scratch=fs.mkdtempSync(path.join(base,"run-"));
const shell=process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/sh";
const unix=value=>process.platform === "win32" ? value.replaceAll("\\","/").replace(/^([a-z]):/i,(_,drive)=>`/${drive.toLowerCase()}`) : value;
const script=`#!/bin/sh
tool=\${0##*/}
printf '%s %s\\n' "$tool" "$*" >> "$TEST_LOG"
case "$tool" in
  uname) case "$1" in -s) echo "$TEST_OS";; -m) echo arm64;; esac ;;
  git)
    if [ "$TEST_GIT" = broken ]; then echo 'xcode-select: note: No developer tools were found, requesting install.' >&2; exit 1; fi
    if [ "$1" = --version ]; then echo 'git version 2.50.0'; exit 0; fi
    if [ "$1" = clone ]; then for dest do :; done; mkdir -p "$dest/.git" "$dest/scripts" "$dest/pet"; fi ;;
  node) if [ "$1" = --version ]; then echo v22.23.3; fi ;;
  npm) if [ "$1" = prefix ]; then echo "$HOME/npm"; else echo 'Unexpected npm install' >&2;exit 99;fi ;;
  pnpm) if [ "$1" = --version ]; then echo 10.34.7; fi ;;
  bun) if [ "$1" = --version ]; then echo 1.4.3; fi ;;
  curl) echo 'Network disabled by fixture' >&2; exit 99 ;;
  xcode-select) exit 0 ;;
esac
`;
const report={platform:process.platform,checks:{},cases:{},scratchBytes:0};
for(const os of ["Darwin","Linux"]) for(const git of ["broken","working"]) for(const pet of [false,true]) {
  const name=`${os}-${git}-${pet?"pet":"full"}`;
  const home=path.join(scratch,name),bin=path.join(home,"tools"),log=path.join(home,"calls.log");fs.mkdirSync(bin,{recursive:true});
  for(const tool of ["git","node","npm","pnpm","bun","curl","uname","xcode-select"]) {const file=path.join(bin,tool);fs.writeFileSync(file,script);fs.chmodSync(file,0o755);}
  const env={HOME:unix(home),PATH:`${unix(bin)}:/usr/bin:/bin`,SHELL:"/bin/sh",TEST_SHELL:process.platform === "win32" ? "/usr/bin/sh" : "/bin/sh",PERRY_HOME:unix(path.join(home,"state")),PERRY_DIR:unix(path.join(home,"checkout")),PERRY_REPO:unix(path.join(home,"nonexistent-fixture-repo")),TEST_BIN:unix(bin),PERRY_NO_SETUP:"1",PERRY_TELEMETRY_DISABLED:"1",TEST_LOG:unix(log),TEST_OS:os,TEST_GIT:git,TEMP:unix(scratch),TMP:unix(scratch)};
  if(process.platform === "win32") {env.SYSTEMROOT=process.env.SYSTEMROOT;env.WINDIR=process.env.WINDIR;}
  if(pet) env.PERRY_PET="http://127.0.0.1:1 FAKE-CODE";
  // Git for Windows' launcher prepends real executables to PATH. Reset it
  // inside the shell, then prove every executable is the fixture before running.
  const guard='export PATH="$TEST_BIN:/usr/bin:/bin"; for tool in git node npm pnpm bun curl uname xcode-select; do [ "$(command -v "$tool")" = "$TEST_BIN/$tool" ] || exit 97; done; exec "$TEST_SHELL" "$1"';
  const args=[...(process.platform === "win32" ? ["--noprofile","--norc"] : []),"-c",guard,"fixture",unix(path.join(repo,"install.sh"))];
  const run=()=>spawnSync(shell,args,{cwd:repo,env,encoding:"utf8",timeout:15000});
  const result=run();const output=(result.stdout??"")+(result.stderr??"");const calls=fs.readFileSync(log,"utf8");
  const broken=git === "broken";
  const noEffects=!/git (clone|-C)|pnpm install|npm install|curl |bun --cwd/.test(calls) && !fs.existsSync(path.join(home,".profile")) && !fs.existsSync(path.join(home,".zshrc"));
  const guidance=os === "Darwin" ? /Command Line Tools/.test(output) && /git --version/.test(output) : /Git.*(not working|could not run)/i.test(output);
  let ok=broken ? result.status !== 0 && noEffects && guidance : result.status === 0 && /git clone/.test(calls);
  let rerunStatus;
  if(!broken) {const second=run();rerunStatus=second.status;ok &&= second.status===0 && /git -C .* pull --ff-only/.test(fs.readFileSync(log,"utf8"));}
  report.checks[name]=Boolean(ok); console.log(JSON.stringify({case:name,ok:Boolean(ok),exit:result.status}));
  report.cases[name]={exit:result.status,rerunStatus,noEffects:broken?noEffects:undefined,calls:calls.trim().split("\n"),output:output.replaceAll(unix(home),"<home>").replace(/\u001b\[[0-9;]*m/g,"")};
}
const bytes=folder=>fs.readdirSync(folder,{withFileTypes:true}).reduce((total,item)=>total+(item.isDirectory()?bytes(path.join(folder,item.name)):fs.statSync(path.join(folder,item.name)).size),0);
report.scratchBytes=bytes(scratch);report.ok=Object.values(report.checks).every(Boolean);
fs.writeFileSync(new URL("./result.json",import.meta.url),JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({checks:report.checks,scratchBytes:report.scratchBytes,ok:report.ok}));
process.exitCode=report.ok?0:1;
