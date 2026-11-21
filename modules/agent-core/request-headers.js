/**
 * User-configured request header normalization and merging.
 *
 * Two invariants hold here:
 * 1. A configured header value is rendered onto a single line, so a value can
 *    never inject an additional header.
 * 2. Only explicitly configured headers take part. Ambient SDK or environment
 *    headers are never read, matching the provider-auth environment isolation.
 */

// Header names a page cannot set and that would corrupt the transport itself.
const FORBIDDEN_HEADER_NAMES = new Set([
    'host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'keep-alive',
]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Normalize user-supplied request headers from either a JSON object/string or
 * `Name: Value` lines.
 * @param {unknown} value Saved or typed configuration value.
 * @returns {Record<string, string>} Header names to single-line values.
 */
export function normalizeAgentHeaders(value) {
    let source = value;
    if (typeof source === 'string') {
        const text = source.trim();
        if (!text) return {};
        try { source = JSON.parse(text); }
        catch {
            source = {};
            for (const line of text.split(/\r?\n/)) {
                const match = line.match(/^\s*([^:]+?)\s*[:=]\s*(.*)$/);
                if (match) source[match[1]] = match[2];
            }
        }
    }
    if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
    const headers = {};
    for (const [rawName, rawValue] of Object.entries(source)) {
        const name = String(rawName ?? '').trim();
        if (!name || !HEADER_NAME_PATTERN.test(name)) continue;
        if (FORBIDDEN_HEADER_NAMES.has(name.toLowerCase())) continue;
        const headerValue = String(rawValue ?? '').replace(/[\r\n]+/g, ' ').trim();
        if (!headerValue) continue;
        headers[name] = headerValue;
    }
    return headers;
}

/**
 * Render configured headers as editable `Name: Value` lines for a textarea.
 * @param {unknown} headers Saved headers (object or text).
 * @returns {string} One `Name: Value` line per header.
 */
export function formatAgentHeaders(headers) {
    return Object.entries(normalizeAgentHeaders(headers))
        .map(([name, value]) => `${name}: ${value}`)
        .join('\n');
}

/**
 * Merge explicit user headers over protocol headers. A user header replaces any
 * default that differs only by case, so `authorization` never duplicates
 * `Authorization`.
 * @param {Record<string, string>} base Protocol-owned headers.
 * @param {Record<string, string>} [custom] User-configured headers.
 * @returns {Record<string, string>} Effective request headers.
 */
export function mergeRequestHeaders(base = {}, custom = {}) {
    const merged = { ...base };
    const existing = new Map(Object.keys(base).map(name => [name.toLowerCase(), name]));
    for (const [name, value] of Object.entries(custom || {})) {
        const duplicate = existing.get(name.toLowerCase());
        if (duplicate && duplicate !== name) delete merged[duplicate];
        merged[name] = value;
    }
    return merged;
}
