'use strict';

// Server-side relay for chat completion requests.
//
// The browser cannot talk to every upstream directly: a provider that rejects
// CORS preflight (opencode.ai among them) or that inspects `user-agent` is
// unreachable from a fetch call, because the browser forbids setting
// transport-owned headers. Forwarding through the Tavern process makes the
// request an ordinary Node request, so every configured header — including
// `user-agent` — reaches the upstream exactly as written.

const RELAY_PATH = '/v1/chat/relay';
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 180000;

// Headers Node's fetch computes itself; letting a caller set them breaks framing.
const TRANSPORT_OWNED = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'keep-alive']);

function relayFailure(code, status, message) {
    return Object.assign(new Error(message || code), { code, status });
}

function parseTarget(value) {
    let url;
    try {
        url = new URL(String(value || ''));
    } catch {
        throw relayFailure('relay_url_invalid', 400);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw relayFailure('relay_url_invalid', 400);
    // A base URL commonly ends with a slash while the caller appends
    // `/chat/completions`; collapse the resulting empty segments so the upstream
    // does not see `//` and answer 404.
    url.pathname = url.pathname.replace(/\/{2,}/g, '/');
    return url;
}

function parseHeaders(value) {
    let input = value;
    if (typeof input === 'string') {
        try {
            input = JSON.parse(input);
        } catch {
            throw relayFailure('relay_headers_invalid', 400);
        }
    }
    if (input == null) return {};
    if (typeof input !== 'object' || Array.isArray(input)) throw relayFailure('relay_headers_invalid', 400);
    const headers = {};
    for (const [name, raw] of Object.entries(input)) {
        const key = String(name).trim();
        if (!key || TRANSPORT_OWNED.has(key.toLowerCase())) continue;
        if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(key)) throw relayFailure('relay_headers_invalid', 400);
        // A value may not smuggle a second header into the request.
        headers[key] = String(raw ?? '').replace(/[\r\n]+/g, ' ').trim();
    }
    return headers;
}

function parseBody(value) {
    if (value == null) return '{}';
    if (typeof value === 'string') {
        if (Buffer.byteLength(value) > MAX_REQUEST_BYTES) throw relayFailure('relay_body_too_large', 413);
        return value;
    }
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) throw relayFailure('relay_body_too_large', 413);
    return encoded;
}

function registerChatRelayRoutes(router) {
    router.get('/v1/chat/relay/status', (_req, res) => res.status(200).send({ ok: true, capability: 'chat-relay-v1' }));

    router.post(RELAY_PATH, async (req, res) => {
        if (!req.user?.profile?.handle) {
            return res.status(403).send({ ok: false, code: 'authenticated_profile_required' });
        }
        let target, headers, body;
        try {
            target = parseTarget(req.body?.url);
            headers = parseHeaders(req.body?.headers);
            body = parseBody(req.body?.body);
        } catch (error) {
            return res.status(error.status || 400).send({ ok: false, code: error.code, error: error.message });
        }
        if (!headers['content-type'] && !headers['Content-Type']) headers['content-type'] = 'application/json';

        const timeoutMs = Number.isInteger(req.body?.timeoutMs) && req.body.timeoutMs > 0
            ? Math.min(req.body.timeoutMs, 600000) : DEFAULT_TIMEOUT_MS;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        // `req` emits close as soon as its body is consumed, so only the
        // response tells us the client actually went away.
        const abort = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', abort);
        try {
            const upstream = await fetch(target, { method: 'POST', headers, body, signal: controller.signal });
            res.status(upstream.status);
            const contentType = upstream.headers.get('content-type');
            if (contentType) res.setHeader('content-type', contentType);
            // Forward the upstream body verbatim, streaming when the caller asked
            // for it so the adapter's SSE parsing is unchanged.
            if (!upstream.body) return res.end();
            const { Readable } = require('node:stream');
            if (req.body?.stream !== false) {
                Readable.fromWeb(upstream.body).on('error', error => res.destroy(error)).pipe(res);
                return undefined;
            }
            const text = await upstream.text();
            return res.send(text);
        } catch (error) {
            if (controller.signal.aborted) {
                if (res.headersSent) return res.destroy();
                return res.status(504).send({ ok: false, code: 'relay_timeout' });
            }
            if (res.headersSent) return res.destroy(error);
            return res.status(502).send({ ok: false, code: 'relay_upstream_unreachable', error: String(error?.message || error) });
        } finally {
            clearTimeout(timer);
            res.off?.('close', abort);
        }
    });
}

module.exports = { registerChatRelayRoutes, RELAY_PATH, CHAT_RELAY_CAPABILITY: 'chat-relay-v1' };
