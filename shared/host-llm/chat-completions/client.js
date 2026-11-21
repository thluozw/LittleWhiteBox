import { readSseEventsFromResponse } from './sse.js';
import { resolveModelFamily } from '../model-family.js';
import { getHostRequestHeaders } from '../../host-request-headers.js';
import { extractModelListIds } from '../../common/model-list.js';
export { setHostRequestHeadersProvider as setHostChatCompletionsRequestHeadersProvider } from '../../host-request-headers.js';

export const HOST_CHAT_COMPLETIONS_SOURCE_OPENAI = 'openai';
export const HOST_CHAT_COMPLETIONS_SOURCE_CLAUDE = 'claude';
export const HOST_CHAT_COMPLETIONS_SOURCE_MAKERSUITE = 'makersuite';
export const HOST_CHAT_COMPLETIONS_STATUS_ENDPOINT = '/api/backends/chat-completions/status';
export const HOST_CHAT_COMPLETIONS_GENERATE_ENDPOINT = '/api/backends/chat-completions/generate';
export const HOST_CHAT_COMPLETIONS_DEFAULT_REVERSE_PROXY = Object.freeze({
    [HOST_CHAT_COMPLETIONS_SOURCE_CLAUDE]: 'https://api.anthropic.com/v1',
    [HOST_CHAT_COMPLETIONS_SOURCE_MAKERSUITE]: 'https://generativelanguage.googleapis.com',
});

const requestHeadersProvider = getHostRequestHeaders;

function normalizeBaseUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

function usesMaxCompletionTokens(model = '') {
    return resolveModelFamily(model) === 'openai';
}

function normalizeReverseProxyForSource(value, source) {
    const baseUrl = normalizeBaseUrl(value);
    if (source === HOST_CHAT_COMPLETIONS_SOURCE_CLAUDE) {
        if (!baseUrl || /\/v\d[\w.-]*$/i.test(baseUrl)) return baseUrl;
        return `${baseUrl}/v1`;
    }
    if (source === HOST_CHAT_COMPLETIONS_SOURCE_MAKERSUITE) {
        return baseUrl.replace(/\/v\d[\w.-]*$/i, '');
    }
    return baseUrl;
}

async function buildHeaders(provider = requestHeadersProvider, extraHeaders = {}) {
    if (typeof provider !== 'function') {
        throw new Error('宿主请求头未注册，无法调用酒馆后端。');
    }
    const providedHeaders = await provider();
    return {
        'Content-Type': 'application/json',
        ...providedHeaders,
        // User-configured headers win over host defaults so a relay that needs
        // its own identity header can be reached through the Tavern backend.
        ...(extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {}),
        Accept: 'application/json',
    };
}

function redactHeaders(headers = {}) {
    const redacted = {};
    Object.entries(headers || {}).forEach(([key, value]) => {
        redacted[key] = /authorization|cookie|csrf|token|api[-_]?key/i.test(key)
            ? '[redacted]'
            : value;
    });
    return redacted;
}

async function buildGenerateRequest(payload = {}, stream = false, headersProvider = requestHeadersProvider, extraHeaders = {}) {
    const rawHeaders = await buildHeaders(headersProvider, extraHeaders);
    const request = {
        url: HOST_CHAT_COMPLETIONS_GENERATE_ENDPOINT,
        method: 'POST',
        headers: redactHeaders(rawHeaders),
        body: {
            ...payload,
            stream: !!stream,
        },
    };
    Object.defineProperty(request, 'rawHeaders', {
        value: rawHeaders,
        enumerable: false,
    });
    return request;
}

/**
 * Presets that carry custom headers need ST's *custom* source: the openai branch
 * builds its own headers and silently drops anything we attach, while custom
 * merges `custom_include_headers`. Switching here keeps the Tavern process as the
 * sender, so no browser CORS applies and transport-owned headers survive.
 */
function applyCustomHeadersToPayload(payload = {}, extraHeaders = {}) {
    const entries = Object.entries(extraHeaders || {}).filter(([, value]) => value != null && value !== '');
    if (!entries.length) return payload;
    const baseUrl = String(payload.custom_url || payload.reverse_proxy || '').trim();
    if (!baseUrl) return payload;
    const apiKey = String(payload.proxy_password || '').trim();
    const hasAuth = entries.some(([name]) => name.toLowerCase() === 'authorization');
    // The custom branch reads its key from ST's own secret store, so carry the
    // preset key on the request itself.
    if (apiKey && !hasAuth) entries.push(['Authorization', `Bearer ${apiKey}`]);
    return {
        ...payload,
        chat_completion_source: 'custom',
        custom_url: baseUrl,
        reverse_proxy: undefined,
        proxy_password: undefined,
        custom_include_headers: entries.map(([name, value]) => `${name}: ${value}`).join('\n'),
    };
}

export async function buildHostChatCompletionGenerateRequest(payload = {}, stream = false, extraHeaders = {}) {
    // Custom headers ride in the payload (custom_include_headers); attaching them
    // to the request to Tavern itself is redundant and can trip its CORS checks.
    return await buildGenerateRequest(applyCustomHeadersToPayload(payload, extraHeaders), stream, requestHeadersProvider);
}

function looksLikeHtmlDocument(text = '') {
    return /^\s*(?:<!DOCTYPE\s+html\b|<html\b)/i.test(String(text || ''));
}

function isCsrfFailureText(text = '') {
    return /invalid csrf token/i.test(String(text || ''));
}

function buildCsrfRefreshMessage() {
    return '酒馆当前页面的 CSRF token 已失效，请按 F5 刷新并重新进入酒馆后再试。';
}

function decodeHtmlCodePoint(value = '', radix = 10) {
    const codePoint = Number.parseInt(String(value || ''), radix);
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF
        ? String.fromCodePoint(codePoint)
        : '';
}

function decodeHtmlText(text = '') {
    return String(text || '')
        .replace(/&nbsp;|&#160;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&#x([0-9a-f]+);?/gi, (_match, hex) => decodeHtmlCodePoint(hex, 16))
        .replace(/&#([0-9]+);?/g, (_match, number) => decodeHtmlCodePoint(number));
}

function summarizeHtmlDocument(text = '') {
    const html = String(text || '');
    const title = decodeHtmlText((html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '')
        .replace(/\s+/g, ' ')
        .trim();
    const body = decodeHtmlText(html
        .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' '))
        .replace(/\s+/g, ' ')
        .trim();
    const summary = title || body;
    return summary.length > 240 ? `${summary.slice(0, 237)}...` : summary;
}

function responseFailureContext(response = null) {
    const status = Number(response?.status);
    const statusText = String(response?.statusText || '').trim();
    let contentType = '';
    try {
        contentType = String(response?.headers?.get?.('content-type') || '').trim();
    } catch {
        contentType = '';
    }
    return {
        status: Number.isFinite(status) && status > 0 ? status : 0,
        statusText,
        contentType,
    };
}

function formatHttpStatus(context = {}) {
    if (!context.status) return '';
    return `HTTP ${context.status}${context.statusText ? ` ${context.statusText}` : ''}`;
}

function extractStructuredFailureMessage(rawText = '') {
    const source = String(rawText || '').trim();
    if (!source || (source[0] !== '{' && source[0] !== '[')) return '';
    try {
        const data = JSON.parse(source);
        const nestedMessage = data?.error?.message;
        if (typeof nestedMessage === 'string' && nestedMessage.trim()) {
            return nestedMessage.trim();
        }
        if (typeof data?.message === 'string' && data.message.trim()) {
            return data.message.trim();
        }
    } catch {
        return '';
    }
    return '';
}

function normalizeHostFailureMessage(rawText = '', fallbackMessage = '', response = null) {
    if (isCsrfFailureText(rawText)) {
        return buildCsrfRefreshMessage();
    }
    const context = responseFailureContext(response);
    const isHtml = looksLikeHtmlDocument(rawText) || /\btext\/html\b/i.test(context.contentType);
    if (isHtml) {
        const status = formatHttpStatus(context);
        const summary = summarizeHtmlDocument(rawText);
        return [
            '酒馆后端返回了非 JSON 的 HTML 页面',
            status ? `（${status}）` : '',
            summary ? `：${summary}` : '',
        ].join('');
    }
    return extractStructuredFailureMessage(rawText)
        || String(rawText || fallbackMessage || '').trim();
}

function buildHostChatCompletionsFields(config = {}, source = HOST_CHAT_COMPLETIONS_SOURCE_OPENAI) {
    const baseUrl = normalizeReverseProxyForSource(config.baseUrl, source);
    const apiKey = String(config.apiKey || '').trim();
    const defaultReverseProxy = HOST_CHAT_COMPLETIONS_DEFAULT_REVERSE_PROXY[source] || '';
    const reverseProxy = baseUrl || (apiKey ? defaultReverseProxy : '');
    const fields = {
        chat_completion_source: source || HOST_CHAT_COMPLETIONS_SOURCE_OPENAI,
    };

    if (reverseProxy) {
        fields.reverse_proxy = reverseProxy;
    }
    if (apiKey) {
        fields.proxy_password = apiKey;
    }

    return fields;
}

function cleanPayload(body = {}) {
    Object.keys(body).forEach((key) => {
        if (body[key] === undefined || body[key] === '') {
            delete body[key];
        }
    });
    return body;
}

export function buildHostChatCompletionsStatusPayload(config = {}, source = HOST_CHAT_COMPLETIONS_SOURCE_OPENAI) {
    return buildHostChatCompletionsFields(config, source);
}

export function buildHostOpenAICompatibleStatusPayload(config = {}) {
    return buildHostChatCompletionsStatusPayload(config, HOST_CHAT_COMPLETIONS_SOURCE_OPENAI);
}

export function buildHostChatCompletionsGeneratePayload(
    config = {},
    task = {},
    messages = [],
    stream = false,
    source = HOST_CHAT_COMPLETIONS_SOURCE_OPENAI,
) {
    const maxTokens = task.maxTokens;
    const useCompletionLimit = source === HOST_CHAT_COMPLETIONS_SOURCE_OPENAI
        && usesMaxCompletionTokens(config.model);
    return cleanPayload({
        ...buildHostChatCompletionsFields(config, source),
        stream: !!stream,
        messages,
        model: config.model,
        max_tokens: useCompletionLimit ? undefined : maxTokens,
        max_completion_tokens: useCompletionLimit ? maxTokens : undefined,
        temperature: task.temperature,
        tools: Array.isArray(task.tools) && task.tools.length ? task.tools : undefined,
        tool_choice: Array.isArray(task.tools) && task.tools.length ? (task.toolChoice || 'auto') : undefined,
        use_sysprompt: source === HOST_CHAT_COMPLETIONS_SOURCE_OPENAI ? undefined : true,
    });
}

export function buildHostOpenAICompatibleGeneratePayload(config = {}, task = {}, messages = [], stream = false) {
    return buildHostChatCompletionsGeneratePayload(
        config,
        task,
        messages,
        stream,
        HOST_CHAT_COMPLETIONS_SOURCE_OPENAI,
    );
}

export function buildHostClaudeGeneratePayload(config = {}, task = {}, messages = [], stream = false) {
    return buildHostChatCompletionsGeneratePayload(
        config,
        task,
        messages,
        stream,
        HOST_CHAT_COMPLETIONS_SOURCE_CLAUDE,
    );
}

export function buildHostGoogleGeneratePayload(config = {}, task = {}, messages = [], stream = false) {
    return buildHostChatCompletionsGeneratePayload(
        config,
        task,
        messages,
        stream,
        HOST_CHAT_COMPLETIONS_SOURCE_MAKERSUITE,
    );
}

function resolveFetch(fetchImplementation) {
    const effectiveFetch = fetchImplementation || globalThis.fetch;
    if (typeof effectiveFetch !== 'function') {
        throw new Error('当前运行环境没有可用的 fetch，无法调用酒馆后端。');
    }
    return effectiveFetch;
}

async function fetchModels(
    config = {},
    source = HOST_CHAT_COMPLETIONS_SOURCE_OPENAI,
    options = {},
    dependencies = {},
) {
    const fetchImplementation = resolveFetch(dependencies.fetch);
    const response = await fetchImplementation(HOST_CHAT_COMPLETIONS_STATUS_ENDPOINT, {
        method: 'POST',
        headers: await buildHeaders(dependencies.requestHeadersProvider),
        body: JSON.stringify(buildHostChatCompletionsStatusPayload(config, source)),
        signal: options.signal,
    });
    const rawText = await response.text();
    let data = null;
    try {
        data = rawText ? JSON.parse(rawText) : {};
    } catch (error) {
        throw new Error(`酒馆后端模型列表拉取失败：${normalizeHostFailureMessage(rawText, String(error?.message || error), response)}`);
    }

    if (!response.ok || data?.error) {
        const message = normalizeHostFailureMessage(
            data?.message || data?.error?.message || rawText,
            `HTTP ${response.status}`,
            response,
        );
        throw new Error(`酒馆后端模型列表拉取失败：${message}`);
    }

    return [...new Set(extractModelListIds(data))];
}

export async function fetchHostChatCompletionsModels(
    config = {},
    source = HOST_CHAT_COMPLETIONS_SOURCE_OPENAI,
    options = {},
) {
    return await fetchModels(config, source, options, {
        requestHeadersProvider,
    });
}

export async function fetchHostOpenAICompatibleModels(config = {}, options = {}) {
    return await fetchHostChatCompletionsModels(config, HOST_CHAT_COMPLETIONS_SOURCE_OPENAI, options);
}

async function createCompletion(payload = {}, options = {}, dependencies = {}) {
    const request = await buildGenerateRequest(applyCustomHeadersToPayload(payload, dependencies.extraHeaders), false, dependencies.requestHeadersProvider);
    if (typeof options.onRequest === 'function') {
        options.onRequest(request);
    }
    const fetchImplementation = resolveFetch(dependencies.fetch);
    const response = await fetchImplementation(request.url, {
        method: request.method,
        headers: request.rawHeaders || request.headers,
        body: JSON.stringify(request.body),
        signal: options.signal,
    });

    const rawText = await response.text();
    let data = null;
    try {
        data = rawText ? JSON.parse(rawText) : {};
    } catch (error) {
        const parseError = new Error(`酒馆后端生成失败：${normalizeHostFailureMessage(rawText, String(error?.message || error), response)}`);
        parseError.status = response.status;
        parseError.body = rawText;
        throw parseError;
    }

    if (!response.ok || data?.error) {
        const message = normalizeHostFailureMessage(
            data?.error?.message || data?.message || rawText,
            `HTTP ${response.status}`,
            response,
        );
        const error = new Error(`酒馆后端生成失败：${message}`);
        error.status = response.status;
        error.error = data?.error;
        throw error;
    }

    return data;
}

export async function createHostChatCompletion(payload = {}, options = {}) {
    return await createCompletion(payload, options, {
        requestHeadersProvider,
        extraHeaders: options.extraHeaders,
    });
}

async function streamCompletion(payload = {}, onEvent, options = {}, dependencies = {}) {
    const request = await buildGenerateRequest(applyCustomHeadersToPayload(payload, dependencies.extraHeaders), true, dependencies.requestHeadersProvider);
    if (typeof options.onRequest === 'function') {
        options.onRequest(request);
    }
    const fetchImplementation = resolveFetch(dependencies.fetch);
    const response = await fetchImplementation(request.url, {
        method: request.method,
        headers: request.rawHeaders || request.headers,
        body: JSON.stringify(request.body),
        signal: options.signal,
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        const error = new Error(normalizeHostFailureMessage(
            text,
            `酒馆后端流式生成失败：HTTP ${response.status}`,
            response,
        ));
        error.status = response.status;
        error.body = text;
        throw error;
    }
    if (typeof options.onResponseAccepted === 'function') {
        options.onResponseAccepted();
    }

    await readSseEventsFromResponse(response, (event) => {
        if (event?.error) {
            const message = normalizeHostFailureMessage(
                event.error?.message || event.message || JSON.stringify(event.error),
                '酒馆后端流式生成失败',
            );
            throw new Error(message);
        }
        onEvent(event);
    });
}

export async function streamHostChatCompletion(payload = {}, onEvent, options = {}) {
    return await streamCompletion(payload, onEvent, options, {
        requestHeadersProvider,
        extraHeaders: options.extraHeaders,
    });
}

const HOST_CHAT_COMPLETION_CLIENT_METHODS = Object.freeze([
    'buildHostChatCompletionGenerateRequest',
    'createHostChatCompletion',
    'streamHostChatCompletion',
]);

export function assertHostChatCompletionsClient(client) {
    if (!client || !HOST_CHAT_COMPLETION_CLIENT_METHODS.every((method) => typeof client[method] === 'function')) {
        throw new TypeError('酒馆渠道必须注入有效的 Host Client。');
    }
    return client;
}

export function createHostChatCompletionsClient(options = {}) {
    const headersProvider = options.requestHeadersProvider;
    if (typeof headersProvider !== 'function') {
        throw new TypeError('创建 Host Client 时必须提供 requestHeadersProvider。');
    }
    if (options.fetch !== undefined && typeof options.fetch !== 'function') {
        throw new TypeError('创建 Host Client 时 fetch 必须是函数。');
    }
    const dependencies = Object.freeze({
        requestHeadersProvider: headersProvider,
        fetch: options.fetch,
    });
    return Object.freeze({
        buildHostChatCompletionGenerateRequest: async (payload = {}, stream = false, extraHeaders = {}) => (
            await buildGenerateRequest(payload, stream, dependencies.requestHeadersProvider, extraHeaders)
        ),
        fetchHostChatCompletionsModels: async (
            config = {},
            source = HOST_CHAT_COMPLETIONS_SOURCE_OPENAI,
            requestOptions = {},
        ) => await fetchModels(config, source, requestOptions, dependencies),
        fetchHostOpenAICompatibleModels: async (config = {}, requestOptions = {}) => (
            await fetchModels(
                config,
                HOST_CHAT_COMPLETIONS_SOURCE_OPENAI,
                requestOptions,
                dependencies,
            )
        ),
        createHostChatCompletion: async (payload = {}, requestOptions = {}) => (
            await createCompletion(payload, requestOptions, dependencies)
        ),
        streamHostChatCompletion: async (payload = {}, onEvent, requestOptions = {}) => (
            await streamCompletion(payload, onEvent, requestOptions, dependencies)
        ),
    });
}

export const browserHostChatCompletionsClient = Object.freeze({
    buildHostChatCompletionGenerateRequest,
    fetchHostChatCompletionsModels,
    fetchHostOpenAICompatibleModels,
    createHostChatCompletion,
    streamHostChatCompletion,
});
