import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
process.env.PERRY_HOME = fileURLToPath(new URL('./synthetic-home', import.meta.url));
process.env.PERRY_API_KEY = 'synthetic-markdown-only';
process.env.TEMP = process.env.TMP = fileURLToPath(new URL('.', import.meta.url));
globalThis.fetch = () => { throw new Error('Network disabled'); };
const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { default: Markdown } = await import('react-markdown');
const { default: gfm } = await import('remark-gfm');
const { default: breaks } = await import('remark-breaks');
const { streamingMarkdown } = await import('../../../components/dashboard/chat/streaming-markdown.ts');
const render = (text, streaming) => renderToStaticMarkup(createElement(Markdown, {remarkPlugins: [gfm, [streamingMarkdown, {streaming}], breaks]}, text));
const plain = text => renderToStaticMarkup(createElement(Markdown, {remarkPlugins:[gfm, breaks]}, text));
const cases = [
 ['open fence', '```js\nconst x = 1', '<code class="language-js">const x = 1\n</code>'],
 ['tilde fence', '~~~js\nconst x = 1', '<code class="language-js">const x = 1\n</code>'],
 ['bold', '**bold', '<strong>bold</strong>'],
 ['emphasis', '*italic', '<em>italic</em>'],
 ['underscore', '__bold', '<strong>bold</strong>'],
 ['strike', '~~gone', '<del>gone</del>'],
 ['code', '`a * b', '<code>a * b</code>'],
 ['nested', '**bold *italic', '<strong>bold <em>italic</em></strong>'],
 ['nested inline code', '**bold `code', '<strong>bold <code>code</code></strong>'],
 ['header', '| Name | Value |', '<th>Name</th><th>Value</th>'],
 ['partial header', '| Nam', '<th>Nam</th>'],
 ['delimiter', '| Name | Value |\n| --', '<th>Name</th><th>Value</th>'],
 ['no leading pipe', 'Name | Value\n--- |', '<th>Name</th><th>Value</th>'],
 ['table body', '| Name | Value |\n| --- | --- |\n| a', '<td>a</td><td></td>'],
 ['list', '- **bold', '<strong>bold</strong>'],
 ['quote', '> **bold', '<strong>bold</strong>'],
 ['heading', '## **bold', '<strong>bold</strong>'],
];
const unchanged = ['plain words', 'some_word_here', '\\*literal', '**complete**', '*complete*', '~~complete~~', '`complete`', '```js\n**literal\n```', '[note](/brain/123)', '[skill](/apps/skills?skill=demo)', '- [x] done\n- [ ] waiting', '| a | b |\n| :--- | ---: |\n| 1 | 2 |', '<script>alert(1)</script>', '[bad](javascript:alert%281%29)', 'prose | in a sentence', '**old\n\nplain tail', '    **code', '**ended\n\n'];
const evidence = [];
for (const [name,text,expected] of cases) {
 const html=render(text,true); assert.ok(html.includes(expected), `${name}: ${html}`);
 assert.equal(render(text,false),plain(text),`static ${name}`);
 evidence.push({name,text,html});
}
for(const text of unchanged) {
 assert.equal(render(text,true),plain(text),`unchanged ${text}`);
 assert.equal(render(text,false),plain(text),`static ${text}`);
}
// Every prefix after a table/fence is identifiable must avoid raw structural markers.
for(const text of ['| Name | Value |\n| --- | --- |\n| a | 1 |','```js\nconst x = 1\n```']) {
 for(let n=1;n<=text.length;n++) {
  const prefix=text.slice(0,n), html=render(prefix,true);
  if(text.startsWith('|')) assert.ok(!html.includes('<p>|'),`table prefix ${n}: ${html}`);
  if(text.startsWith('```') && n>=3) assert.ok(html.startsWith('<pre>'),`fence prefix ${n}: ${html}`);
 }
}
const huge='**'+ 'x'.repeat(5000);
assert.equal(render(huge,true),plain(huge),'oversize tail falls back to native');
assert.equal(render('**other',true),'<p><strong>other</strong></p>','no cross-message state');
writeFileSync(new URL('./render-evidence.json',import.meta.url),JSON.stringify({checks:cases.length+unchanged.length,prefixChecks:'| Name | Value |\n| --- | --- |\n| a | 1 |'.length+'```js\nconst x = 1\n```'.length,staticIdentical:true,evidence},null,2)+'\n');
console.log(`PASS: ${cases.length} repair fixtures, ${unchanged.length} unchanged/static fixtures, character-prefix fence/table runs, bounded fallback; render-evidence.json written`);
