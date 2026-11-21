import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentAdapter } from '../provider-config.js';
import { hasRelayTransport, RELAY_TRANSPORT_ID } from '../relay-transport.js';

// A provider that rejects browser calls (CORS preflight, or a required
// `user-agent`) must go through the Tavern process. These tests pin the wiring:
// the relay provider selects the relay transport, and its requests never hit
// the upstream origin directly from the browser.

const messages = [{ role: 'user', content: 'ping' }];

function stubFetch(t) {
    const calls = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input?.url || String(input);
        calls.push({ url, init });
        if (url.includes('/csrf-token')) {
            return new Response(JSON.stringify({ token: 'test-csrf-token' }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.includes('/v1/chat/relay')) {
            return new Response(JSON.stringify({
                choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
            }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        throw new Error(`browser fetch must not reach the upstream directly: ${url}`);
    };
    t.after(() => { globalThis.fetch = original; });
    return calls;
}

const config = (overrides = {}) => ({
    provider: RELAY_TRANSPORT_ID,
    baseUrl: 'https://opencode.invalid/zen/go/v1',
    model: 'test-model',
    apiKey: 'test-key',
    headers: 'x-opencode-session: sess-relay\nuser-agent: opencode/latest/2.2.5/cli',
    prefixMode: 'custom',
    customPrefix: '',
    ...overrides,
});

test('the relay provider is the only one marked as relayed', () => {
    assert.equal(hasRelayTransport({ transport: RELAY_TRANSPORT_ID }), true);
    // A config that only names the channel must relay too.
    assert.equal(hasRelayTransport({ provider: RELAY_TRANSPORT_ID }), true);
    assert.equal(hasRelayTransport({ transport: 'openai-compatible' }), false);
    assert.equal(hasRelayTransport({}), false);
    assert.equal(hasRelayTransport(null), false);
});

test('a relay adapter forwards the call through the Tavern relay endpoint', async t => {
    const calls = stubFetch(t);
    const adapter = createAgentAdapter(config());
    const result = await adapter.chat({ messages, tools: null, stream: false });
    assert.equal(result.text, 'OK');
    // The relay first obtains a CSRF token, then posts the forwarded request.
    const relayCalls = calls.filter(call => call.url.includes('/v1/chat/relay'));
    assert.equal(relayCalls.length, 1);
    assert.match(relayCalls[0].url, /\/api\/plugins\/littlewhitebox-server\/v1\/chat\/relay$/);
    assert.equal(relayCalls[0].init.headers['X-CSRF-Token'], 'test-csrf-token');
    const payload = JSON.parse(relayCalls[0].init.body);
    assert.equal(payload.url, 'https://opencode.invalid/zen/go/v1/chat/completions');
    // Headers the browser refuses to set must survive into the relay payload.
    assert.equal(payload.headers['user-agent'], 'opencode/latest/2.2.5/cli');
    assert.equal(payload.headers['x-opencode-session'], 'sess-relay');
    assert.equal(payload.headers.Authorization, 'Bearer test-key');
});

test('a direct provider still calls the upstream itself', async t => {
    const calls = stubFetch(t);
    const adapter = createAgentAdapter(config({ provider: 'openai-compatible' }));
    // The SDK wraps transport failures, so assert on the recorded attempts.
    const failures = await adapter.chat({ messages, tools: null, stream: false })
        .then(() => [], error => [error]);
    assert.equal(failures.length, 1, 'the direct call fails because the stub refuses it');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://opencode.invalid/zen/go/v1/chat/completions');
    assert.equal(calls.some(call => call.url.includes('/v1/chat/relay')), false);
});
