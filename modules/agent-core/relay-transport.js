const RELAY_ENDPOINT = '/api/plugins/littlewhitebox-server/v1/chat/relay';
const CSRF_ENDPOINT = '/csrf-token';

// Some upstreams reject browser calls outright: a provider may refuse CORS
// preflight, or demand a `user-agent` the browser forbids setting. Forwarding
// through the Tavern process turns the call into an ordinary Node request, so
// every configured header reaches the upstream exactly as written.

let cachedRequestHeaders;

async function fetchCsrfHeaders() {
    // `/csrf-token` is Tavern's own token endpoint. Importing `script.js` would
    // require the host page's globals (iframe pages such as the summary app do
    // not load jQuery), so ask the server directly instead.
    const response = await fetch(CSRF_ENDPOINT, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`csrf_token_unavailable:${response.status}`);
    const body = await response.json();
    const token = String(body?.token || '');
    if (!token) throw new Error('csrf_token_empty');
    return { 'Content-Type': 'application/json', 'X-CSRF-Token': token };
}

async function relayRequestHeaders() {
    if (cachedRequestHeaders) return cachedRequestHeaders;
    try {
        cachedRequestHeaders = await fetchCsrfHeaders();
        return cachedRequestHeaders;
    } catch (error) {
        // Keep the failure visible: a relay call without a token is rejected by
        // the server with 403, and the caller reports that instead of a silent
        // network error.
        console.warn('[LittleWhiteBox] relay CSRF token unavailable', error?.message || error);
        return { 'Content-Type': 'application/json' };
    }
}

function flattenHeaders(source) {
    const out = {};
    if (!source) return out;
    if (typeof Headers !== 'undefined' && source instanceof Headers) {
        source.forEach((value, name) => { out[name] = value; });
        return out;
    }
    if (Array.isArray(source)) {
        for (const entry of source) if (Array.isArray(entry) && entry.length === 2) out[entry[0]] = entry[1];
        return out;
    }
    for (const [name, value] of Object.entries(source)) {
        if (value != null) out[name] = String(value);
    }
    return out;
}

function requestBody(init) {
    if (typeof init?.body === 'string') return init.body;
    if (init?.body == null) return '{}';
    return JSON.stringify(init.body);
}

export const RELAY_TRANSPORT_ID = 'littlewhitebox-relay';

/**
 * A `fetch` replacement that routes the SDK call through the Tavern process.
 * The relay echoes the upstream status, headers and body, so the caller's
 * response handling is unchanged.
 */
export function createRelayFetch({ timeoutMs } = {}) {
    return async function relayFetch(input, init = {}) {
        const target = typeof input === 'string' ? input : input?.url || String(input);
        const payload = {
            url: target,
            method: init?.method || 'POST',
            headers: flattenHeaders(init?.headers),
            body: requestBody(init),
            stream: true,
            ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
        };
        return fetch(RELAY_ENDPOINT, {
            method: 'POST',
            headers: await relayRequestHeaders(),
            body: JSON.stringify(payload),
            ...(init?.signal ? { signal: init.signal } : {}),
        });
    };
}

export function hasRelayTransport(config) {
    // The channel id doubles as the transport id, so a preset that only carries
    // `provider` (model listing builds its own config, for instance) is still
    // relayed instead of silently falling back to a direct browser request.
    return config?.transport === RELAY_TRANSPORT_ID || config?.provider === RELAY_TRANSPORT_ID;
}
