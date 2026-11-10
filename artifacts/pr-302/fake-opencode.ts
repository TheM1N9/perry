import { ndJsonStream } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const file = process.env.FIXTURE_STATE!;
const state = () => JSON.parse(readFileSync(file, 'utf8'));
if (args[0] === '--version') console.log('2.0.30');
else if (args[0] === 'models') { if (state().failModels) { console.error('model listing failed'); process.exit(1); } console.log('a/first\nz/configured'); }
else if (args[0] === 'auth' && args[1] === 'list') console.log(JSON.stringify(state().providers));
else if (args[0] === 'auth' && args[1] === 'logout') {
  const data = state();
  if (data.failLogout || !args[2] || !args[3]) process.exit(1);
  data.providers.find((p: any) => p.id === args[2]).connections = data.providers.find((p: any) => p.id === args[2]).connections.filter((c: any) => c.id !== args[3]);
  writeFileSync(file, JSON.stringify(data));
} else if (args[0] === 'acp') {
  const { default: plugin } = await import(new URL('index.js', JSON.parse(process.env.OPENCODE_CONFIG_CONTENT!).plugins.at(-1)).href);
  let evaluate: any;
  await plugin.setup({ permission: { hook: async (_: string, callback: any) => { evaluate = callback; } } });
  const stream = ndJsonStream(Writable.toWeb(process.stdout) as any, Readable.toWeb(process.stdin) as any);
  const { agent } = await import('@agentclientprotocol/sdk');
  const config = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'z/configured', options: [{value:'a/first', name:'First'}, {value:'z/configured', name:'Configured'}] }];
  const loose = { parse: (v: any) => v, safeParse: (v: any) => ({success: true, data:v}) } as any;
  await agent({ name:'fixture-opencode' })
    .onRequest('initialize', loose, () => ({ protocolVersion:1, agentCapabilities:{sessionCapabilities:{resume:{}}}, authMethods:[] }))
    .onRequest('session/new', loose, () => ({sessionId:'fixture-session',configOptions:config}))
    .onRequest('session/resume', loose, () => ({configOptions:config}))
    .onRequest('session/set_config_option', loose, ({params}: any) => { throw Error('Default model must remain unset: '+JSON.stringify(params)); })
    .onRequest('session/prompt', loose, async ({params, client}: any) => {
      const event = {effect:'allow'}; evaluate(event);
      if (event.effect !== 'ask') throw Error('Configured/saved allow bypassed approval');
      const denied = {effect:'deny'}; evaluate(denied); if(denied.effect !== 'deny') throw Error('deny overridden');
      const text = params.prompt.at(-1).text;
      const reply = await client.request('session/request_permission', {sessionId:params.sessionId, toolCall:{toolCallId:text, title:text, kind:text.includes('edit')?'edit':'execute',rawInput:{command:text}},options:[{optionId:'once',name:'Allow',kind:'allow_once'},{optionId:'no',name:'Deny',kind:'reject_once'}]});
      await client.notify('session/update', {sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:reply.outcome.optionId === 'once'?'executed':'denied'}}});
      return {stopReason:'end_turn'};
    }).connect(stream);
  process.stdin.on('end', () => process.exit(0));
} else process.exit(2);
