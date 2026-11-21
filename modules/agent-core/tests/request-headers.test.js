import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { normalizeAgentHeaders, mergeRequestHeaders, formatAgentHeaders } from '../request-headers.js';
import { normalizeAgentPreset } from '../config.js';
import { resolveAgentAuth } from '../provider-auth.js';
import { createAgentAdapter } from '../provider-config.js';

const messages = [{ role: 'user', content: 'ping' }];

// Minimal OpenAI-compatible response so a real request reaches the mock server.
const OPENAI_REPLY = JSON.stringify({
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
});

async function mockServer(t) {
    const requests = [];
    const server = createServer((request, response) => {
        const respond = async () => {
            let raw = '';
            for await (const chunk of request) raw += chunk;
            requests.push({ url: request.url, headers: request.headers, body: raw });
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(OPENAI_REPLY);
        };
        respond().catch(error => response.destroy(error));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

test('header text parses from Name: Value lines and JSON objects alike', () => {
    const lines = normalizeAgentHeaders('x-opencode-session: sess-123\nHTTP-Referer: https://example.com');
    assert.deepEqual(lines, {
        'x-opencode-session': 'sess-123',
        'HTTP-Referer': 'https://example.com',
    });
    assert.deepEqual(normalizeAgentHeaders({ 'x-opencode-session': 'sess-123' }), { 'x-opencode-session': 'sess-123' });
    assert.deepEqual(normalizeAgentHeaders('{"x-opencode-session":"sess-123"}'), { 'x-opencode-session': 'sess-123' });
    assert.deepEqual(normalizeAgentHeaders(''), {});
    assert.deepEqual(normalizeAgentHeaders(null), {});
    assert.deepEqual(normalizeAgentHeaders([]), {});
});

test('header values cannot inject a second header and transport-owned names are dropped', () => {
    const headers = normalizeAgentHeaders({
        'x-session': 'value\r\nX-Injected: yes',
        Host: 'evil.example',
        'Content-Length': '999',
        Connection: 'close',
        'bad name': 'spaces are invalid',
        'x-empty': '   ',
        'x-ok': 'kept',
    });
    assert.equal(headers['x-session'], 'value X-Injected: yes');
    assert.equal(headers['Host'], undefined);
    assert.equal(headers['Content-Length'], undefined);
    assert.equal(headers['Connection'], undefined);
    assert.equal(headers['bad name'], undefined);
    assert.equal(headers['x-empty'], undefined);
    assert.equal(headers['x-ok'], 'kept');
});

test('a custom header replaces its protocol default regardless of case', () => {
    assert.deepEqual(
        mergeRequestHeaders({ Authorization: 'Bearer old' }, { authorization: 'Bearer new' }),
        { authorization: 'Bearer new' },
    );
    assert.deepEqual(
        mergeRequestHeaders({ 'Content-Type': 'application/json' }, { 'x-opencode-session': 's1' }),
        { 'Content-Type': 'application/json', 'x-opencode-session': 's1' },
    );
});

test('configured headers round-trip through the preset normalizer and the form formatter', () => {
    const preset = normalizeAgentPreset({ headers: 'x-opencode-session: sess-9' });
    assert.deepEqual(preset.headers, { 'x-opencode-session': 'sess-9' });
    assert.equal(formatAgentHeaders(preset.headers), 'x-opencode-session: sess-9');
    // A preset saved before this feature carries no headers and must stay valid.
    assert.deepEqual(normalizeAgentPreset({}).headers, {});
});

test('provider auth exposes custom headers on the request and SDK fetch boundary', () => {
    const headers = { 'x-opencode-session': 'sess-42' };
    for (const provider of ['openai-compatible', 'openai-responses', 'anthropic', 'google']) {
        const auth = resolveAgentAuth(provider, 'test-key', headers);
        assert.equal(auth.headers['x-opencode-session'], 'sess-42', `${provider} headers`);
        if (auth.requestHeaders) {
            assert.equal(auth.requestHeaders['x-opencode-session'], 'sess-42', `${provider} requestHeaders`);
        }
        if (auth.sdkOptions?.defaultHeaders) {
            assert.equal(auth.sdkOptions.defaultHeaders['x-opencode-session'], 'sess-42', `${provider} defaultHeaders`);
        }
    }
});

test('an OpenAI-compatible request actually carries the injected session header', async t => {
    const service = await mockServer(t);
    const adapter = createAgentAdapter({
        provider: 'openai-compatible',
        baseUrl: service.baseUrl,
        model: 'test-model',
        apiKey: 'test-key',
        headers: { 'x-opencode-session': 'sess-abc', 'HTTP-Referer': 'https://example.com' },
    });
    const result = await adapter.chat({ messages, tools: null, stream: false });
    assert.equal(result.text, 'OK');
    assert.equal(service.requests.length, 1);
    assert.equal(service.requests[0].headers['x-opencode-session'], 'sess-abc');
    assert.equal(service.requests[0].headers['http-referer'], 'https://example.com');
    // The default credential header still applies alongside custom headers.
    assert.equal(service.requests[0].headers.authorization, 'Bearer test-key');
});

test('a configured header can replace the default authorization header', async t => {
    const service = await mockServer(t);
    const adapter = createAgentAdapter({
        provider: 'openai-compatible',
        baseUrl: service.baseUrl,
        model: 'test-model',
        apiKey: '',
        headers: { Authorization: 'Bearer relay-issued-token' },
    });
    await adapter.chat({ messages, tools: null, stream: false });
    assert.equal(service.requests[0].headers.authorization, 'Bearer relay-issued-token');
});
