import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const root = resolve('.batch-work/batch-2/254');
process.env.PERRY_HOME = join(root, 'synthetic-home');
process.env.DASHBOARD_KEY = 'synthetic-254-dashboard';
process.env.PERRY_CREDENTIAL_KEY = '42'.repeat(32);
process.env.COMPOSIO_API_KEY = 'synthetic-254-provider';
process.env.PERRY_ENGINE = 'fake';
let networkAttempts = 0;
globalThis.fetch = async ()=>{
    networkAttempts++;
    throw Error('Network forbidden in task 254');
};
mkdirSync(process.env.PERRY_HOME, {
    recursive: true
});
const { Runtime } = await import('../../../server/runtime.ts');
const { v } = await import('convex/values');
const { internalQuery, internalAction } = await import('../../../convex/_generated/server.js');
const { default: schema } = await import('../../../convex/schema.ts');
const composio = await import('../../../convex/composio.ts');
const connectorHealth = await import('../../../convex/connectorHealth.ts');
const connectorAccounts = await import('../../../convex/connectorAccounts.ts');
const { fake } = await import('./fake-sdk.mjs');
const sql = new DatabaseSync(':memory:');
const runtime = new Runtime(sql, schema, {
    composio,
    connectorHealth,
    connectorAccounts,
    verify: {
        read: internalAction({
            args: {},
            handler: (ctx)=>composio.internetRead(ctx, {
                    operation: 'read',
                    url: 'https://github.com/synthetic/repo',
                    limit: 1,
                    connector: {
                        accountId: 'github-primary',
                        slug: 'GITHUB_GET_REPO',
                        args: {}
                    }
                }, 'github', new AbortController().signal)
        })
    },
    secrets: {
        get: internalQuery({
            args: {
                name: v.string()
            },
            handler: async ()=>'synthetic-254-provider'
        })
    }
}, {
    storageDir: join(root, 'synthetic-home/storage')
});
await runtime.stop();
const action = (name, args = {})=>runtime.runAction(`composio:${name}`, args, {
        internal: true
    });
const mutate = (name, args)=>runtime.runMutation(`connectorHealth:${name}`, args, {
        internal: true
    });
const health = async ()=>(await runtime.runQuery('connectorHealth:read', {
        accounts: fake.accounts.map((a)=>({
                accountId: a.id,
                toolkit: a.toolkit.slug
            }))
    }, {
        internal: true
    })).value;
const checks = [];
try {
    const execute = ()=>action('execute', {
            slug: 'SLACK_SEND_MESSAGE',
            args: {
                text: 'synthetic'
            }
        });
    fake.selected = 'missing';
    fake.outcome = {
        error: 'No connected account'
    };
    assert.equal((await execute()).ok, false);
    assert.deepEqual(await health(), {});
    checks.push('never-connected does not create expired health');
    fake.metadataMissing = true;
    fake.outcome = {
        data: {
            ok: true
        }
    };
    assert.equal((await execute()).ok, true);
    assert.deepEqual(await health(), {});
    fake.metadataMissing = false;
    checks.push('router helpers without metadata retain execution and never guess account health');
    fake.selected = 'primary';
    fake.outcome = {
        error: 'OAuth token revoked SYNTHETIC_SECRET_SENTINEL'
    };
    const revoked = await execute();
    assert.equal(revoked.ok, false);
    assert.match(revoked.error, /Reconnect/);
    assert(!JSON.stringify(revoked).includes('SYNTHETIC_SECRET_SENTINEL'));
    assert.equal(fake.calls.at(-1).account, 'primary');
    assert.deepEqual(Object.keys(await health()), [
        'primary'
    ]);
    let accounts = await action('accounts');
    assert.equal(accounts.accounts.find((a)=>a.id === 'primary').status, 'EXPIRED');
    assert.equal(accounts.accounts.find((a)=>a.id === 'alternate').status, 'ACTIVE');
    checks.push('revocation pins and marks only primary; response sanitized; UI account data distinguishes alternate');
    const stale = (await health()).primary;
    fake.refreshStatus = 'INITIATED';
    fake.redirect = 'https://synthetic.example.test/oauth';
    const pending = await action('authorize', {
        toolkit: 'slack',
        accountId: 'primary',
        callbackUrl: 'https://synthetic.example.test/callback'
    });
    assert(pending.redirectUrl);
    assert((await health()).primary !== undefined);
    checks.push('pending reconnect retains health');
    fake.refreshStatus = 'ACTIVE';
    const activeRedirect = await action('authorize', {
        toolkit: 'slack',
        accountId: 'primary'
    });
    assert.equal(activeRedirect.status, 'ACTIVE');
    assert(activeRedirect.redirectUrl);
    assert((await health()).primary !== undefined);
    checks.push('ACTIVE with OAuth redirect remains unconfirmed and retains health');
    const before = fake.calls.length;
    assert((await action('authorize', {
        toolkit: 'github',
        accountId: 'primary'
    })).error);
    assert((await action('authorize', {
        toolkit: 'slack',
        accountId: 'foreign'
    })).error);
    assert.equal(fake.calls.length, before);
    checks.push('wrong toolkit and foreign account cannot refresh');
    await new Promise((r)=>setTimeout(r, 5));
    fake.refreshStatus = 'ACTIVE';
    fake.redirect = null;
    assert.equal((await action('authorize', {
        toolkit: 'slack',
        accountId: 'primary'
    })).status, 'ACTIVE');
    assert.deepEqual(await health(), {});
    assert.equal(fake.calls.at(-1).refresh, 'primary');
    assert.equal(fake.calls.at(-1).options.validateCredentials, true);
    await mutate('observe', {
        accountId: 'primary',
        toolkit: 'slack',
        startedAt: stale,
        expired: true
    });
    assert.deepEqual(await health(), {});
    checks.push('successful exact reconnect clears stale health and rejects older failure');
    for (const error of [
        '401 Unauthorized project API key SYNTHETIC_SECRET_SENTINEL',
        '403 Forbidden insufficient permissions',
        '429 rate limit OAuth token expired',
        '503 service unavailable OAuth token expired',
        'coupon expired'
    ]){
        fake.outcome = {
            error
        };
        assert.equal((await execute()).ok, false);
        assert.deepEqual(await health(), {});
    }
    fake.outcome = new Error('wrapped token expired', {
        cause: Object.assign(new Error('down'), {
            status: 503
        })
    });
    assert.equal((await execute()).ok, false);
    assert.deepEqual(await health(), {});
    checks.push('401, 403, 429, 503, cause-chain outage, unrelated expiry never mark auth expired');
    await new Promise((r)=>setTimeout(r, 5));
    fake.outcome = new Error('invalid_grant SYNTHETIC_SECRET_SENTINEL');
    assert.equal((await execute()).ok, false);
    assert((await health()).primary !== undefined);
    checks.push('thrown explicit invalid_grant persists account health');
    await new Promise((r)=>setTimeout(r, 5));
    fake.outcome = {
        data: {
            messageId: 'synthetic-id'
        }
    };
    assert.equal((await execute()).ok, true);
    assert.deepEqual(await health(), {});
    checks.push('successful pinned execution clears old auth health');
    await new Promise((r)=>setTimeout(r, 5));
    fake.outcome = {
        error: 'OAuth token expired'
    };
    await execute();
    fake.probes = true;
    accounts = await action('accounts');
    assert.equal(accounts.accounts.find((a)=>a.id === 'primary').status, 'ACTIVE');
    assert.deepEqual(await health(), {});
    checks.push('successful read-only identity probe clears recovered account');
    await new Promise((r)=>setTimeout(r, 5));
    fake.probes = false;
    fake.outcome = {
        error: 'OAuth token revoked'
    };
    await execute();
    assert.deepEqual(await action('disconnect', {
        accountId: 'primary'
    }), {});
    assert.equal(fake.accounts.length, 1);
    assert.equal(fake.accounts[0].id, 'alternate');
    assert.equal(runtime.store.all('connectorHealth').some((a)=>a.accountId === 'primary'), false);
    checks.push('disconnect removes exact health and preserves alternate');
    fake.accounts.push({
        id: 'github-primary',
        status: 'ACTIVE',
        toolkit: {
            slug: 'github'
        },
        alias: 'github@example.test'
    });
    const read = ()=>runtime.runAction('verify:read', {}, {
            internal: true
        });
    fake.outcome = {
        error: '429 rate limit OAuth token expired'
    };
    assert.equal((await read()).error.code, 'rate_limited');
    assert.deepEqual(await health(), {});
    fake.outcome = {
        error: '503 service unavailable OAuth token expired'
    };
    assert.notEqual((await read()).error.code, 'expired_auth');
    assert.deepEqual(await health(), {});
    await new Promise((r)=>setTimeout(r, 5));
    fake.outcome = {
        error: 'OAuth token revoked SYNTHETIC_SECRET_SENTINEL'
    };
    const denied = await read();
    assert.equal(denied.error.code, 'expired_auth');
    assert(!JSON.stringify(denied).includes('SYNTHETIC_SECRET_SENTINEL'));
    assert((await health())['github-primary'] !== undefined);
    assert.equal(fake.calls.at(-1).account, 'github-primary');
    await new Promise((r)=>setTimeout(r, 5));
    fake.outcome = {
        data: {
            name: 'synthetic'
        }
    };
    assert((await read()).data);
    assert.deepEqual(await health(), {});
    checks.push('internetRead records exact account, clears on success, and prioritizes rate limit/outage over expiry prose');
    assert(!JSON.stringify(runtime.store.all('connectorHealth')).includes('SYNTHETIC_SECRET_SENTINEL'));
    assert.equal(networkAttempts, 0);
    checks.push('health has no provider payload; network attempts zero');
    writeFileSync(join(root, 'e2e-result.json'), JSON.stringify({
        passed: true,
        checks,
        networkAttempts,
        sqlite: 'memory',
        scheduler: 'stopped before mutations',
        sdk: 'fake; installed interface inspected',
        schema: 'integrated source; no overlay'
    }, null, 2) + '\n');
    console.log(JSON.stringify({
        passed: true,
        checks: checks.length,
        artifact: '.batch-work/batch-2/254/e2e-result.json'
    }));
} catch (error) {
    writeFileSync(join(root, 'e2e-result.json'), JSON.stringify({
        passed: false,
        checks,
        networkAttempts,
        error: error instanceof Error ? error.message : 'unknown'
    }, null, 2) + '\n');
    throw error;
} finally{
    await runtime.stop();
    sql.close();
}
