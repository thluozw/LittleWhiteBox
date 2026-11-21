import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createPreset, assertPreset, assertSettings, TEXT_API_VERSION } from '../model.js';
import { generateText, listTextModels } from '../runtime.js';

const OPENAI_REPLY = JSON.stringify({
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
});

async function mockServer(t) {
    const requests = [];
    const server = createServer((request, response) => {
        const respond = async () => {
            for await (const chunk of request) void chunk;
            requests.push({ url: request.url, headers: request.headers });
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(request.method === 'GET'
                ? JSON.stringify({ data: [{ id: 'listed-model' }] })
                : OPENAI_REPLY);
        };
        respond().catch(error => response.destroy(error));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return { baseUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

function presetWith(overrides) {
    return createPreset('p1', '测试', {
        provider: 'openai-compatible', model: 'test-model', apiKey: 'test-key',
        prefixMode: 'custom', customPrefix: '', stream: false, ...overrides,
    });
}

test('a preset keeps configured headers as text and rejects a non-string value', () => {
    assert.equal(createPreset('p', 'n', { headers: 'x-opencode-session: s1' }).headers, 'x-opencode-session: s1');
    assert.equal(createPreset('p', 'n', {}).headers, '');
    assert.throws(() => assertPreset({ ...createPreset('p', 'n', {}), headers: { a: 'b' } }));
    // A preset saved before this field existed stays valid.
    const legacy = createPreset('p', 'n', {});
    delete legacy.headers;
    assert.equal(assertPreset(legacy).headers, undefined);
    assert.equal(assertSettings({
        version: TEXT_API_VERSION,
        presets: [{ ...createPreset('p', 'n', {}), headers: 'x-opencode-session: s1' }],
        bindings: { summary: 'p', planner: null, outline: null },
    }).presets[0].headers, 'x-opencode-session: s1');
});

test('text API generation and model listing carry the injected session header', async t => {
    const service = await mockServer(t);
    const preset = presetWith({
        baseUrl: service.baseUrl,
        headers: 'x-opencode-session: sess-xyz\nHTTP-Referer: https://example.com',
    });

    const result = await generateText(preset, { messages: [{ role: 'user', content: 'ping' }] });
    assert.equal(result.text, 'OK');

    await listTextModels(preset);
    assert.equal(service.requests.length, 2);
    for (const request of service.requests) {
        assert.equal(request.headers['x-opencode-session'], 'sess-xyz', `${request.url} session header`);
        assert.equal(request.headers['http-referer'], 'https://example.com', `${request.url} referer`);
        assert.equal(request.headers.authorization, 'Bearer test-key', `${request.url} credential`);
    }
});

test('an empty header field sends no extra headers', async t => {
    const service = await mockServer(t);
    await generateText(presetWith({ baseUrl: service.baseUrl }), { messages: [{ role: 'user', content: 'ping' }] });
    assert.equal(service.requests[0].headers['x-opencode-session'], undefined);
    assert.equal(service.requests[0].headers.authorization, 'Bearer test-key');
});

test('a configured header replaces the default authorization header', async t => {
    const service = await mockServer(t);
    await generateText(presetWith({
        baseUrl: service.baseUrl, apiKey: '',
        headers: 'Authorization: Bearer relay-token',
    }), { messages: [{ role: 'user', content: 'ping' }] });
    assert.equal(service.requests[0].headers.authorization, 'Bearer relay-token');
});
