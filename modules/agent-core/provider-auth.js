import { mergeRequestHeaders, normalizeAgentHeaders } from './request-headers.js';
import { createRelayFetch, hasRelayTransport } from './relay-transport.js';

// A relay-configured preset sends the request through the Tavern process, which
// keeps transport-owned headers (notably `user-agent`) and skips browser CORS.
function buildFetchCheckpoint(requestHeaders, presetConfig) {
    if (hasRelayTransport(presetConfig)) {
        const relay = createRelayFetch({ timeoutMs: presetConfig?.timeoutMs });
        return (input, options) => relay(input, { ...options, headers: requestHeaders });
    }
    return (input, options) => globalThis.fetch(input, { ...options, headers: requestHeaders });
}

// SDK compatibility belongs here, never in saved presets or individual Agent apps.
const OPENAI_NO_AUTH_PLACEHOLDER = 'agent-core-no-auth';
// Keep the existing Messages wire version when upgrading the SDK.
const ANTHROPIC_API_VERSION = '2023-06-01';

export function normalizeAgentApiKey(value) {
    return String(value ?? '').trim();
}

/**
 * Resolve protocol authentication for a provider, then layer the user's explicit
 * request headers on top. Custom headers are the only source of extra identity:
 * ambient SDK/environment headers are never read, matching the existing
 * environment-isolation guarantee.
 * @param {string} provider Provider id used by the adapter.
 * @param {unknown} value Configured API key.
 * @param {unknown} [customHeaders] User-configured headers (object or text).
 * @returns {object} Authentication material, effective headers and SDK options.
 */
export function resolveAgentAuth(provider, value, customHeaders, options = {}) {
    const apiKey = normalizeAgentApiKey(value);
    const custom = normalizeAgentHeaders(customHeaders);
    if (provider === 'google') {
        // @google/genai accepts an explicitly empty header in browser and Node.
        // Remove this override when the SDK exposes a credential-free Gemini mode.
        const headers = mergeRequestHeaders({ 'x-goog-api-key': apiKey }, custom);
        return { apiKey, headers, sdkOptions: { apiKey, vertexai: false } };
    }
    if (provider === 'anthropic') {
        const headers = mergeRequestHeaders(apiKey ? { 'x-api-key': apiKey } : {}, custom);
        const requestHeaders = mergeRequestHeaders({
            'Content-Type': 'application/json', Accept: 'application/json',
            'anthropic-version': ANTHROPIC_API_VERSION,
            'anthropic-dangerous-direct-browser-access': 'true',
        }, { ...headers });
        return {
            apiKey,
            headers,
            sdkOptions: {
                apiKey,
                authToken: null,
                // SDK 1.x switched API keys to Bearer. Preserve the documented
                // x-api-key protocol used by existing native Anthropic relays.
                // Remove this override if that upstream header is retired.
                defaultHeaders: { ...requestHeaders, 'X-Api-Key': apiKey || null, Authorization: null },
                // SDK 1.x also imports arbitrary ANTHROPIC_CUSTOM_HEADERS from
                // the environment. Only this preset may supply request identity.
                fetch: buildFetchCheckpoint(requestHeaders, options),
            },
        };
    }
    const headers = mergeRequestHeaders(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, custom);
    const requestHeaders = mergeRequestHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }, headers);
    return {
        apiKey,
        headers,
        requestHeaders,
        sdkOptions: {
            // OpenAI SDK requires a nonempty constructor credential even when the
            // Authorization header is explicitly omitted. Never send this sentinel.
            // Remove it when the SDK supports credential-free construction.
            apiKey: apiKey || OPENAI_NO_AUTH_PLACEHOLDER,
            adminAPIKey: null,
            defaultHeaders: { Authorization: null, 'api-key': null, ...requestHeaders },
            // OpenAI SDK merges OPENAI_CUSTOM_HEADERS into SDK defaults. These
            // JSON-only Agent endpoints use CORE-owned headers, not ambient SDK
            // headers (which can contain credentials under arbitrary names).
            // Override Content-Type above before SDK encoding; isolate all headers
            // at its public fetch boundary without changing process-wide state.
            fetch: buildFetchCheckpoint(requestHeaders, options),
        },
    };
}
