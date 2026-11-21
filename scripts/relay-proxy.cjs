// LittleWhiteBox 本地转发代理
//
// 用途：浏览器不允许设置 User-Agent 等请求头，且部分上游（如 opencode.ai）
// 拒绝浏览器跨域请求。这个脚本在本机监听一个端口，把请求原样转发给上游，
// 因此可以带上任意请求头。
//
// 用法：
//   1. node lwb-relay-proxy.cjs
//   2. 模型连接里 Base URL 填 http://127.0.0.1:18787
//   3. 路径前缀选「自定义」并留空
//   4. 渠道可以保持「OpenAI 兼容」，自定义请求头照常填
//
// 只监听 127.0.0.1，不对外网开放。

const http = require('node:http');
const https = require('node:https');

const PORT = Number(process.env.LWB_PROXY_PORT || 18787);
const UPSTREAM = (process.env.LWB_PROXY_UPSTREAM || 'https://opencode.ai/zen/go/v1').replace(/\/+$/, '');

// 会转发给上游的请求头，其余（浏览器/连接相关）丢弃。
const FORWARD = new Set([
    'authorization', 'content-type', 'accept', 'user-agent',
    'x-opencode-session', 'x-opencode-request', 'x-opencode-client',
    'http-referer', 'x-title', 'anthropic-version', 'anthropic-beta',
]);

function forwardHeaders(source) {
    const out = {};
    for (const [name, value] of Object.entries(source)) {
        if (FORWARD.has(name.toLowerCase()) && value != null) out[name] = value;
    }
    return out;
}

const server = http.createServer((req, res) => {
    const started = Date.now();

    // 浏览器从 http://127.0.0.1:8000 请求本代理，属于跨域，必须显式放行，
    // 否则 fetch 直接报 "Failed to fetch"（连 preflight 都过不去）。
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // 直通上游路径，并合并重复斜杠。
    const path = req.url.replace(/\/{2,}/g, '/');
    const target = new URL(UPSTREAM + path);
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers = forwardHeaders(req.headers);
        // 浏览器把本地请求的 Host 指到此处；上游需要自己的 Host。
        headers.host = target.host;

        const request = https.request({
            hostname: target.hostname,
            port: target.port || 443,
            path: target.pathname + target.search,
            method: req.method,
            headers,
        }, upstream => {
            res.writeHead(upstream.statusCode, {
                'content-type': upstream.headers['content-type'] || 'application/json',
                // 流式响应不缓冲
                'cache-control': 'no-store',
            });
            upstream.pipe(res);
            console.log(`${req.method} ${path} -> ${upstream.statusCode} (${Date.now() - started}ms)`);
        });

        request.on('error', error => {
            console.error(`${req.method} ${path} -> 代理失败: ${error.message}`);
            if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `relay failed: ${error.message}` } }));
        });

        if (body.length) request.write(body);
        request.end();
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`LittleWhiteBox 转发代理已启动`);
    console.log(`  本地地址: http://127.0.0.1:${PORT}`);
    console.log(`  上游地址: ${UPSTREAM}`);
    console.log('');
    console.log('在「模型连接」里把 Base URL 填成 http://127.0.0.1:' + PORT);
    console.log('路径前缀选「自定义」并留空，自定义请求头照常填。');
    console.log('Ctrl+C 停止。');
});
