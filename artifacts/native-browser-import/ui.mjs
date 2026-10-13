/** Production UI, disposable profiles, native helper with fake credentials. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const output=resolve('artifacts/native-browser-import/results'),fixture=JSON.parse(readFileSync(join(output,'fixture.json'),'utf8'));
const {chromium}=await import(pathToFileURL(process.env.PERRY_E2E_PLAYWRIGHT??join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')).href);
const browser=await chromium.launch({executablePath:fixture.browser,headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),checks={};
const check=(name,pass)=>{checks[name]=!!pass;assert.ok(pass,name);console.log(`PASS ${name}`);};
try{
 await page.addInitScript(key=>localStorage.setItem('perry.dashboard.key',key),fixture.key);
 await page.goto(`http://localhost:7388/chat/${fixture.chat}`);
 await page.getByRole('button',{name:'Open workspace',exact:true}).click();await page.getByRole('tab',{name:'Browser',exact:true}).click();
 check('personal Chrome connection is removed',await page.getByRole('button',{name:'Connect Chrome',exact:true}).count()===0);
 if(await page.getByRole('button',{name:'Open browser',exact:true}).isVisible()) await page.getByRole('button',{name:'Open browser',exact:true}).click();await page.getByRole('button',{name:'Resume Perry',exact:true}).waitFor();
 await page.getByRole('button',{name:'Browser actions',exact:true}).click();await page.getByRole('menuitem',{name:'Import from browser',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Import from your browser',exact:true});await dialog.getByRole('combobox',{name:'Import source profile',exact:true}).waitFor();await dialog.getByText('Google Chrome',{exact:false}).first().waitFor();
 check('compact profile and category dialog is present',await dialog.getByRole('switch').count()===4);
 check('passwords and cookies selected explicitly',await dialog.getByRole('switch',{name:'Saved passwords',exact:true}).getAttribute('aria-checked')==='true'&&await dialog.getByRole('switch',{name:'Cookies',exact:true}).getAttribute('aria-checked')==='true');
 check('history and extensions are opt in',await dialog.getByRole('switch',{name:'Browsing history',exact:true}).getAttribute('aria-checked')==='false'&&await dialog.getByRole('switch',{name:'Extensions',exact:true}).getAttribute('aria-checked')==='false');
 check('import requires Windows and replacement consent',await dialog.getByRole('button',{name:'Import',exact:true}).isDisabled());
 await dialog.screenshot({path:join(output,'import-light.png')});
 await page.emulateMedia({colorScheme:'dark'});await page.waitForFunction(()=>document.documentElement.classList.contains('dark'));await dialog.screenshot({path:join(output,'import-dark.png')});
 check('dark mode preserves import controls',await dialog.getByRole('button',{name:'Import',exact:true}).isVisible());
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Browser actions',exact:true}).click();await page.getByRole('menuitem',{name:'Import from browser',exact:true}).click();await dialog.getByRole('switch',{name:'Saved passwords',exact:true}).waitFor();await page.getByRole('menu').waitFor({state:'hidden'});await page.getByText('Reconnecting…',{exact:true}).waitFor({state:'hidden'});await page.screenshot({path:join(output,'import-mobile.png'),fullPage:true,animations:'disabled'});
 check('mobile import dialog fits',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await dialog.getByRole('checkbox').focus();await page.keyboard.press('Space');
 check('keyboard consent enables import',await dialog.getByRole('button',{name:'Import',exact:true}).isEnabled());
 await dialog.getByRole('button',{name:'Import',exact:true}).click();await dialog.waitFor({state:'hidden',timeout:30000});
 check('production native import finishes paused',await page.getByRole('button',{name:'Resume Perry',exact:true}).isVisible());
 await page.screenshot({path:join(output,'import-complete.png'),fullPage:true});checks.completed=true;
}catch(error){console.error(error);checks.completed=false;await page.screenshot({path:join(output,'ui-failure.png'),fullPage:true});process.exitCode=1;}
finally{await browser.close();writeFileSync(join(output,'ui-report.json'),JSON.stringify({checks,passed:checks.completed===true&&Object.values(checks).every(Boolean)},null,2));}
