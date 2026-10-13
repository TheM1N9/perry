/** Production helper with disposable keys only; no Windows elevation required. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
const output=resolve('artifacts/native-browser-import/results'),fixture=JSON.parse(readFileSync(join(output,'fixture.json'),'utf8'));
process.env.PERRY_HOME=fixture.home;delete process.env.PERRY_IMPORT_HELPER_PATH;
const {nativeImportHelper,importKeys,clearImportKeys,ownPasswordValues}=await import('../../server/browser-import-native');const web=await import('../../convex/lib/browser');
const checks:Record<string,boolean>={};
try{
 await nativeImportHelper();
 const profile=web.profileDirectory(fixture.chat),local=JSON.parse(readFileSync(join(profile,'Local State'),'utf8'));
 let rejected=false;try{const keys=await importKeys(fixture.root,local.os_crypt.encrypted_key,false);clearImportKeys(keys);}catch{rejected=true;}
 checks.productionHelperRejectsFixtureRoots=rejected;assert.ok(rejected);
 const passwords=await ownPasswordValues(profile);checks.productionHelperRedactsOwnedCredentials=passwords.length===1;assert.ok(passwords.length===1);
 console.log('PASS production helper scope and owned credential redaction');
}catch{console.error('Production helper verification failed.');process.exitCode=1;}
finally{writeFileSync(join(output,'helper-security-report.json'),JSON.stringify({checks,passed:Object.keys(checks).length===2&&Object.values(checks).every(Boolean),ownerCredentialsRead:false},null,2));}
