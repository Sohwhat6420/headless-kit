// Composio as the mail transport for a Gmail account connected there. Two key shapes:
//   ck_...  Composio Connect (consumer) key: the hosted MCP endpoint, a minimal Streamable-HTTP JSON-RPC client
//           (initialize, notifications/initialized, tools/call COMPOSIO_MULTI_EXECUTE_TOOL), header x-consumer-api-key.
//   other   a project API key: POST {restBase}/{TOOL_SLUG} with header x-api-key and {connected_account_id, arguments}.
// No SDK, no child processes. The key is read at call time, sent only in a header, and redacted from every error.
export const CONNECT_URL = 'https://connect.composio.dev/mcp';
export const REST_BASE = 'https://backend.composio.dev/api/v3.1/tools/execute';

function parseBody(text, contentType) {
  if (!/event-stream/.test(contentType || '')) return text ? JSON.parse(text) : null;
  let last = null;   // SSE: the last JSON-RPC message carried in a data: line
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    try { const j = JSON.parse(line.slice(5).trim()); if (j && (j.result !== undefined || j.error)) last = j; } catch { /* partial */ }
  }
  return last;
}

const scrub = (s, key) => (key ? String(s).split(key).join('[key]') : String(s));

export function composioClient({ readKey, account = null, connectUrl = CONNECT_URL, restBase = REST_BASE, fetchImpl = fetch, timeoutMs = 90_000 }) {
  let session = null;
  let nextId = 1;
  async function rpc(key, method, params, notify = false) {
    const headers = { 'x-consumer-api-key': key, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (session) headers['mcp-session-id'] = session;
    const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: nextId++, method, params };
    const res = await fetchImpl(connectUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) session = sid;
    const text = await res.text();
    if (!res.ok && !(notify && res.status === 202)) throw new Error(`composio ${method}: HTTP ${res.status} ${scrub(text.slice(0, 120), key)}`);
    if (notify) return null;
    const j = parseBody(text, res.headers.get('content-type'));
    if (!j) throw new Error(`composio ${method}: empty response`);
    if (j.error) throw new Error(`composio ${method}: ${scrub(String(j.error.message || j.error.code).slice(0, 160), key)}`);
    return j.result;
  }
  async function viaConnect(key, slug, args) {
    if (!session) {
      await rpc(key, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'headless-kit-mail-reply', version: '0.1.0' } });
      await rpc(key, 'notifications/initialized', {}, true);
    }
    let r;
    try {
      r = await rpc(key, 'tools/call', { name: 'COMPOSIO_MULTI_EXECUTE_TOOL', arguments: { tools: [{ tool_slug: slug, arguments: args, ...(account ? { account } : {}) }], sync_response_to_workbench: false, thought: 'mail-reply tracker', current_step: slug } });
    } catch (e) { session = null; throw e; }   // a dead session gets a fresh initialize next time
    const txt = (r.content || []).map((c) => c.text || '').join('');
    let j;
    try { j = JSON.parse(txt); } catch { throw new Error(`composio ${slug}: non-JSON result`); }
    const one = j?.data?.results?.[0];
    if (!j.successful || !one || one.response?.successful === false) throw new Error(`composio ${slug}: ${scrub(String(one?.response?.error || one?.error || j.error || 'unsuccessful').slice(0, 160), key)}`);
    return one.response.data;
  }
  async function viaRest(key, slug, args) {
    const res = await fetchImpl(`${restBase}/${slug}`, {
      method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ ...(account ? { connected_account_id: account } : {}), arguments: args }), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`composio ${slug}: HTTP ${res.status}`);
    const j = await res.json();
    if (j.successful === false || j.error) throw new Error(`composio ${slug}: ${scrub(String(j.error || 'unsuccessful').slice(0, 120), key)}`);
    return j.data?.response_data ?? j.data ?? j;
  }
  return {
    async execute(slug, args) {
      const key = readKey();
      if (!key) throw new Error('composio: no key (set composio.keyFile or MAIL_REPLY_COMPOSIO_KEY_FILE)');
      return key.startsWith('ck_') ? viaConnect(key, slug, args) : viaRest(key, slug, args);
    },
  };
}

/** Gmail search for mail from the allowed senders in the last `windowDays` days. */
export function gmailQuery(allow, windowDays = 2) {
  const terms = allow.map((a) => (a.startsWith('@') ? a.slice(1) : a));
  return `from:(${terms.join(' OR ')}) newer_than:${windowDays}d`;
}

/** The transport the tracker uses: list() -> messages, reply(msg, body), mark(msg). */
export function composioTransport({ client, allow, windowDays = 2, maxResults = 25, labelId = null, markRead = false }) {
  return {
    name: 'composio',
    authKnown: false,   // GMAIL_FETCH_EMAILS without the payload carries no Authentication-Results
    async list() {
      const data = await client.execute('GMAIL_FETCH_EMAILS', { query: gmailQuery(allow, windowDays), max_results: maxResults, verbose: false, include_payload: false });
      return (data.messages || []).map((m) => ({
        id: String(m.messageId || ''), threadId: m.threadId ? String(m.threadId) : null,
        receivedAt: m.messageTimestamp ? new Date(m.messageTimestamp).toISOString() : null,
        from: String(m.sender || ''), subject: String(m.subject ?? m.preview?.subject ?? ''),
        labels: Array.isArray(m.labelIds) ? m.labelIds : [], headers: {},
      })).filter((m) => m.id);
    },
    async reply(msg, { to, body, html = null }) {   // the tool takes one body: the HTML when there is one
      return client.execute('GMAIL_REPLY_TO_THREAD', { thread_id: msg.threadId, recipient_email: to, message_body: html || body, is_html: Boolean(html), include_signature: false });
    },
    async mark(msg) {
      if (!labelId && !markRead) return null;
      if (!/^[0-9a-f]+$/i.test(msg.id)) return null;
      return client.execute('GMAIL_ADD_LABEL_TO_EMAIL', { message_id: msg.id, add_label_ids: labelId ? [labelId] : [], remove_label_ids: markRead ? ['UNREAD'] : [] });
    },
  };
}
