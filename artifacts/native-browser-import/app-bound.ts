/** Two manual UAC prompts; only a disposable DPAPI/App-Bound fixture, never owner data. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCipheriv, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
const output=resolve("artifacts/native-browser-import/results"), fixture=JSON.parse(readFileSync(join(output,"fixture.json"),"utf8"));
process.env.PERRY_HOME=fixture.home;process.env.PERRY_IMPORT_CHROME_ROOT=fixture.root;process.env.PERRY_IMPORT_HELPER_PATH=fixture.helper;process.env.PERRY_BROWSER_PATH=fixture.browser;process.env.PERRY_BROWSER_VIEW="1";process.env.PERRY_BROWSER_IMPORT="1";
const {importKeys,clearImportKeys}=await import('../../server/browser-import-native');
const {nativeProfiles,nativeImport}=await import('../../server/browser-import');
const {controlBrowser}=await import('../../server/browser-host');
const {browserState}=await import('../../lib/browser-protocol');
const web=await import('../../convex/lib/browser');
const quote=(text:string)=>`'${text.replaceAll("'","''")}'`;
const flag=process.env.PERRY_APP_BOUND_FIXTURE_FLAG==='3'?3:1;
const fakeCng=randomBytes(32),wrapping=Buffer.from(flag===3?'CCF8A1CEC56605B8517552BA1A2D061C03A29E90274FB2FCF59BA4B75C392390':'B31C6E241AC846728DA9C1FAC4936651CFFB944D143AB816276BCC6DA0284787','hex');
if(flag===3)wrapping.forEach((byte,index)=>wrapping[index]=byte^fakeCng[index]);
const fakeKey=randomBytes(32),iv=randomBytes(12),wrap=createCipheriv('aes-256-gcm',wrapping,iv);
const payload=Buffer.concat([Buffer.from([flag]),...(flag===3?[fakeCng]:[]),iv,wrap.update(fakeKey),wrap.final(),wrap.getAuthTag()]);wrapping.fill(0);
const checks:Record<string,boolean>={};let state;
try {
  console.log('Waiting for Windows approval to create the disposable App-Bound fixture.');
  const args=['--fixture-wrap',fixture.root,payload.toString('base64')].map(value=>`"${value}"`).join(' ');
  await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$p=Start-Process -FilePath ${quote(fixture.helper)} -ArgumentList ${quote(args)} -Verb RunAs -WindowStyle Hidden -Wait -PassThru;exit $p.ExitCode`],{windowsHide:true,timeout:120000});
  checks.systemAndUserDpapiFixture=true;
  const local=JSON.parse(readFileSync(join(fixture.root,'Local State'),'utf8'));
  const legacy=await importKeys(fixture.root,local.os_crypt.encrypted_key,false);
  const file=join(fixture.root,'Default','Login Data'),db=new DatabaseSync(file);
  const row=db.prepare("SELECT password_value FROM logins WHERE username_value='fixture-user'").get()!;
  const original=Buffer.from(row.password_value as Uint8Array);
  const plain=Buffer.from('disposable-app-bound-password');clearImportKeys(legacy);
  const recordIv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',fakeKey,recordIv);const protectedValue=Buffer.concat([Buffer.from('v20'),recordIv,cipher.update(plain),cipher.final(),cipher.getAuthTag()]);plain.fill(0);
  db.prepare("UPDATE logins SET password_value=? WHERE username_value='fixture-user'").run(protectedValue);db.close();
  state=browserState.parse(await controlBrowser(fixture.chat,{action:'start'},true));
  console.log('Waiting for Windows approval to migrate the disposable protected password.');
  const imported=await nativeImport(fixture.chat,state.identity!,nativeProfiles()[0].id,{passwords:true,cookies:false,history:false,extensions:false});
  checks.appBoundPasswordMigrated=imported.passwords===1;
  const own=new DatabaseSync(join(web.profileDirectory(fixture.chat),'Default','Login Data'),{readOnly:true});const stored=Buffer.from(own.prepare("SELECT password_value FROM logins WHERE username_value='fixture-user'").get()!.password_value as Uint8Array);own.close();
  checks.nativeDestinationEncryption=stored.subarray(0,3).toString()==='v10';
  console.log(JSON.stringify(checks));
} catch(error) {console.error('Disposable native UAC check failed; see the safe fixture status and report.');if(Object.keys(checks).length) console.error(error instanceof Error?error.message:'Native helper failed');process.exitCode=1;}
finally {fakeKey.fill(0);fakeCng.fill(0);payload.fill(0);if(web.browserControl(fixture.chat).current)await web.withBrowserView(fixture.chat,async()=>{await web.hostCommand('Browser.close').catch(()=>{});web.closeBrowser();});writeFileSync(join(output,flag===3?'app-bound-cng-report.json':'app-bound-report.json'),JSON.stringify({checks,format:flag,passed:Object.keys(checks).length===3&&Object.values(checks).every(Boolean),ownerCredentialsRead:false},null,2));}
process.exit(Object.keys(checks).length===3&&Object.values(checks).every(Boolean)?0:1);
