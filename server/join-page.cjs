'use strict';

// ============================================================================
// server/join-page.cjs — the ONE join URL, rendered for two audiences.
// ----------------------------------------------------------------------------
// Why this exists at all:
//
// The in-app "Configure MCP" surface used to hand out a LIVE, long-lived bearer
// token embedded inside a convenience string with a copy button. It leaked into
// a transcript. The narrow fix (use the placeholder) shipped, and the same
// mistake was then found in a second place — because the real defect is not
// where the token was rendered, it is that a long-lived credential HAD to be
// rendered somewhere. Whatever is guarded gets a masked field; whatever is
// convenient hands you the raw value; people use the convenient one.
//
// So this removes the premise. A join link is:
//   - short-lived (minutes, not weeks)
//   - single-use (the redeeming UPDATE is itself the guard)
//   - not a credential in its own right — it cannot be used as an MCP bearer,
//     unlike workspace_invites, which doubles as one for its full 14 days
//   - redeemed server-side; the long-lived credential is provisioned at that
//     moment and returned exactly once, in the redemption RESPONSE
//
// This module is PURE: no database, no crypto, no randomness, no I/O. It turns a
// descriptor into (a) the JSON an agent gets and (b) the HTML a human gets. That
// purity is what makes the preview route provably incapable of minting anything
// — the preview handler has nothing to call.
//
// The machine-readable contract, and why it is built the way it is:
//
//   The owner's requirement was that an agent must understand this page whether
//   or not its request is detected as a browser. So NOTHING here branches on
//   User-Agent. Instead the same instructions are carried FOUR ways, and any one
//   of them is sufficient:
//     1. `Accept: application/json` (or ?format=json) returns the structured form.
//     2. A JSON-LD <script type="application/ld+json"> block in the HTML.
//     3. A fenced, clearly-delimited machine block that is VISIBLE in the
//        rendered page — an agent that only gets rendered text still sees it.
//     4. Plain English prose stating the endpoint, method and body, in the body
//        copy, addressed to an AI agent by name.
//   An LLM that renders the HTML and reads the text can act on (3) or (4)
//   without parsing anything special.
// ============================================================================

const MACHINE_BEGIN = '--- BEGIN AGENSIS JOIN INSTRUCTIONS ---';
const MACHINE_END = '--- END AGENSIS JOIN INSTRUCTIONS ---';

// The literal that stands in for the credential everywhere it is DESCRIBED
// rather than delivered. Matches server/skills.cjs so the two never drift.
const TOKEN_PLACEHOLDER = 'aga_YOUR_AGENT_TOKEN';
const CONTROLLER_TOKEN_PLACEHOLDER = 'agc_YOUR_CONTROLLER_TOKEN';

// The preview's stand-in token. Deliberately not base64url-shaped and carrying
// the word PREVIEW, so a copy/paste of a preview URL cannot be mistaken for, or
// collide with, a real one — and so a token-charset check rejects it outright.
const PREVIEW_TOKEN = 'preview-not-a-real-token';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// JSON destined for a <script> element. A workspace name is user-controlled, so
// a literal `</script>` inside it would end the element and turn the rest of the
// payload into markup. Escaping `<` (and the `-->` opener) as \u sequences keeps
// the JSON valid and inert.
function escapeJsonForScript(json) {
  return String(json)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    // U+2028 / U+2029 are valid inside JSON but terminate a line inside a
    // script element, which would split the block in two.
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

// Build the canonical join URL for a token. Public origin, not the backend host:
// a human is expected to open this, and the backend host is proxied behind the
// app origin for exactly that reason.
function joinUrlFor(publicBaseUrl, token) {
  return `${trimTrailingSlash(publicBaseUrl)}/join/${encodeURIComponent(token)}`;
}

// Where an agent POSTs to redeem. Deliberately built from the BACKEND origin,
// not the page origin, even though the page origin also resolves:
// https://agensis.io/join/* is a Netlify PROXY onto the backend, and a proxy hop
// is one more thing that can mishandle a POST body. The credential-issuing call
// should not depend on it. This costs nothing — the agent reads this absolute
// URL out of the payload it was just served, so it never has to guess.
function redeemUrlFor(apiBaseUrl, token) {
  return `${trimTrailingSlash(apiBaseUrl)}/backend/join/${encodeURIComponent(token)}/redeem`;
}

// Where a human is sent to accept. The SPA reads ?join= and redeems with the
// signed-in user's own session token, then strips the parameter from the URL.
function acceptUrlFor(publicBaseUrl, token) {
  return `${trimTrailingSlash(publicBaseUrl)}/app?join=${encodeURIComponent(token)}`;
}

// ----------------------------------------------------------------------------
// Descriptors
// ----------------------------------------------------------------------------
// A descriptor is everything the two renderers need and NOTHING a renderer could
// leak: there is no field on it that holds, or could hold, a credential. The
// credential does not exist yet when this is built — it is provisioned on
// redemption, in the route, and returned in that response only.
// ----------------------------------------------------------------------------

function joinDescriptor({
  token = '',
  // The origin a person sees: https://agensis.io. Carries /join/* and /app.
  publicBaseUrl = '',
  // The origin the API lives on: https://agensis-backend.fly.dev. Carries
  // /backend/*. These are different hosts in production — /backend/* is NOT
  // routed on the app origin — so they cannot be collapsed into one value.
  apiBaseUrl = '',
  mcpEndpoint = '',
  workspaceName = '',
  role = 'editor',
  label = '',
  audience = 'both',
  grantKind = 'individual',
  controllerName = '',
  controllerScopes = [],
  controllerExpiresAt = null,
  expiresAt = null,
  status = 'open',
  preview = false,
} = {}) {
  const joinUrl = joinUrlFor(publicBaseUrl, token);
  const resolvedGrantKind = grantKind === 'workspace_control' ? 'workspace_control' : 'individual';
  const resolvedAudience = resolvedGrantKind === 'workspace_control'
    ? 'controller'
    : (audience === 'human' || audience === 'agent' ? audience : 'both');
  return {
    preview: Boolean(preview),
    status: status === 'open' ? 'open' : 'invalid',
    token,
    joinUrl,
    redeemUrl: redeemUrlFor(apiBaseUrl || publicBaseUrl, token),
    acceptUrl: acceptUrlFor(publicBaseUrl, token),
    mcpEndpoint,
    workspaceName: String(workspaceName || 'an agensis workspace'),
    role: String(role || 'editor'),
    label: String(label || ''),
    grantKind: resolvedGrantKind,
    audience: resolvedAudience,
    controllerName: resolvedGrantKind === 'workspace_control' ? String(controllerName || '') : '',
    controllerScopes: resolvedGrantKind === 'workspace_control' && Array.isArray(controllerScopes)
      ? controllerScopes.map(String)
      : [],
    controllerExpiresAt: resolvedGrantKind === 'workspace_control' && controllerExpiresAt
      ? new Date(controllerExpiresAt).toISOString()
      : null,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
  };
}

// The preview descriptor. Fixed, invented values; no argument of it comes from a
// database row, and the token is a constant that cannot address a real link.
function previewDescriptor({ publicBaseUrl = '', apiBaseUrl = '', mcpEndpoint = '' } = {}) {
  return joinDescriptor({
    token: PREVIEW_TOKEN,
    publicBaseUrl,
    apiBaseUrl,
    mcpEndpoint,
    workspaceName: 'Example Workspace',
    role: 'editor',
    label: 'Example invite',
    audience: 'both',
    grantKind: 'individual',
    controllerName: '',
    controllerScopes: [],
    controllerExpiresAt: null,
    // A fixed instant, not now()+ttl: a preview must render identically every
    // time so it can be diffed, and a moving expiry would imply a live clock is
    // counting down on something that does not exist.
    expiresAt: '2030-01-01T00:00:00.000Z',
    status: 'open',
    preview: true,
  });
}

// An invalid link: unknown, expired, revoked, or already redeemed. All four
// render THIS, identically. Distinguishing them would answer "did this token
// ever exist?" for anyone willing to ask twice.
function invalidDescriptor({ publicBaseUrl = '', preview = false } = {}) {
  return {
    preview: Boolean(preview),
    status: 'invalid',
    token: '',
    joinUrl: `${trimTrailingSlash(publicBaseUrl)}/join`,
    redeemUrl: '',
    acceptUrl: `${trimTrailingSlash(publicBaseUrl)}/app`,
    mcpEndpoint: '',
    workspaceName: '',
    role: '',
    label: '',
    audience: 'both',
    expiresAt: null,
  };
}

// ----------------------------------------------------------------------------
// The structured (machine) form
// ----------------------------------------------------------------------------

// What an agent does with the redemption response. Single-sourced so the
// instructions ON the page and the instructions IN the response cannot drift —
// the agent reads the first before redeeming and the second after.
function agentNextSteps() {
  return [
    `Substitute data.credential.token for ${TOKEN_PLACEHOLDER} in data.mcp.config.`,
    'Write that config to your MCP client configuration file (Connector path — you act as the agent over MCP).',
    'Store the token where you keep secrets. Do not print it, echo it into a chat, or commit it.',
    'Connect as Connector, then call whoami to confirm your identity, then list_channels.',
    'Optional Relay: if you need a local coding host instead of MCP-as-agent, a human can set this agent to Relay and run desktop ACP or `agensis connect` with a separate connect token.',
  ];
}

function controllerNextSteps() {
  return [
    `Substitute data.credential.token for ${CONTROLLER_TOKEN_PLACEHOLDER} in data.mcp.config.`,
    'Write that config to the controller MCP client configuration (Connector enrollment).',
    'Store the token as a secret. Do not print it, echo it into a chat, or commit it.',
    'Connect and call whoami. Only the scopes listed in this enrollment are available.',
    'Register child agents with register_agent; the server attributes every child to this controller.',
  ];
}

function machinePayload(descriptor) {
  if (descriptor.status !== 'open') {
    return {
      service: 'agensis',
      kind: 'workspace_join_invitation',
      status: 'invalid',
      message:
        'This join link is no longer valid. It has expired, been used, been revoked, '
        + 'or never existed — these are deliberately indistinguishable. Ask whoever '
        + 'sent it for a fresh one.',
      preview: Boolean(descriptor.preview),
    };
  }

  if (descriptor.grantKind === 'workspace_control') {
    return {
      service: 'agensis',
      kind: 'workspace_control_enrollment',
      status: 'open',
      preview: Boolean(descriptor.preview),
      workspace: descriptor.workspaceName,
      label: descriptor.label,
      audience: 'controller',
      expires_at: descriptor.expiresAt,
      credential_expires_at: descriptor.controllerExpiresAt,
      single_use: true,
      join_url: descriptor.joinUrl,
      summary:
        `A high-authority, scoped controller enrollment for "${descriptor.workspaceName}". `
        + 'This does not create a workspace member and does not grant owner, private-session, '
        + 'raw-vault, role-management, or generic message access.',
      human: null,
      agent: null,
      controller: {
        name: descriptor.controllerName,
        scopes: descriptor.controllerScopes,
        denied_by_design: [
          'private_sessions:read',
          'messages:post_anywhere',
          'vault:read_raw',
          'roles:grant',
          'credentials:escalate',
        ],
        action:
          'POST to redeem_url with the exact controller lane. Do not include an Authorization '
          + 'header. The response contains one named, expiring, revocable controller credential.',
        method: 'POST',
        redeem_url: descriptor.redeemUrl,
        headers: { 'Content-Type': 'application/json' },
        body: { as: 'controller' },
        returns: {
          'data.workspace': '{ id, name }',
          'data.controller': '{ id, name, scopes, expires_at }',
          'data.credential.token': 'your scoped controller bearer, shown once',
          'data.mcp.endpoint': descriptor.mcpEndpoint,
          'data.mcp.config': `an MCP client config with ${CONTROLLER_TOKEN_PLACEHOLDER} where your token goes`,
        },
        then: controllerNextSteps(),
        notes: [
          'Single-use: the second redemption fails, including your own retry.',
          'The controller expires automatically and can be revoked independently.',
          'Child agents and resources remain attributed after revocation.',
        ],
      },
    };
  }

  const wantsAgent = descriptor.audience === 'agent' || descriptor.audience === 'both';
  const wantsHuman = descriptor.audience === 'human' || descriptor.audience === 'both';

  return {
    service: 'agensis',
    kind: 'workspace_join_invitation',
    status: 'open',
    preview: Boolean(descriptor.preview),
    workspace: descriptor.workspaceName,
    label: descriptor.label,
    audience: descriptor.audience,
    expires_at: descriptor.expiresAt,
    single_use: true,
    join_url: descriptor.joinUrl,
    summary:
      `An invitation to join the agensis workspace "${descriptor.workspaceName}". `
      + 'This URL is short-lived and single-use. Redeeming it provisions access '
      + 'server-side; the credential is returned once, in the redemption response, '
      + 'and is never shown on this page.',
    human: wantsHuman
      ? {
        action: 'Open this URL in a browser and sign in to accept.',
        url: descriptor.acceptUrl,
        result: `You are added to "${descriptor.workspaceName}" with the ${descriptor.role} role.`,
      }
      : null,
    agent: wantsAgent
      ? {
        action:
          'POST to redeem_url with a JSON body naming yourself. No Authorization '
          + 'header: holding this URL IS the authorization. The response contains '
          + 'your long-lived credential, once.',
        method: 'POST',
        redeem_url: descriptor.redeemUrl,
        headers: { 'Content-Type': 'application/json' },
        body: {
          as: 'agent',
          name: '<the display name you want in the workspace>',
          handle: '<optional @handle; derived from name when omitted>',
          description: '<optional one line about what you do>',
        },
        returns: {
          'data.workspace': '{ id, name }',
          'data.agent': '{ id, name, handle }',
          'data.credential.token': 'your bearer token, shown ONCE and never recoverable',
          'data.mcp.endpoint': descriptor.mcpEndpoint,
          'data.mcp.config': `an MCP client config with ${TOKEN_PLACEHOLDER} where your token goes`,
        },
        then: agentNextSteps(),
        notes: [
          'Single-use: the second redemption of this URL fails, including your own retry.',
          'Do not send this URL anywhere. It is spent the moment it works.',
          'Redemption creates a Connector (external/MCP) agent with a bearer token. Relay (desktop ACP or agensis CLI) is a separate attach path that uses a different connect token.',
        ],
      }
      : null,
  };
}

// The JSON-LD graph. schema.org has no "join invitation" type, so the standard
// vocabulary carries the human-readable framing and a namespaced `agensis` key
// carries the actionable contract. A consumer that only understands schema.org
// still gets a name, a description and a URL.
function jsonLd(descriptor) {
  const payload = machinePayload(descriptor);
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: descriptor.status === 'open'
      ? `Join ${descriptor.workspaceName} on agensis`
      : 'This agensis join link is no longer valid',
    description: payload.summary || payload.message,
    url: descriptor.joinUrl,
    potentialAction: descriptor.status === 'open'
      && (descriptor.audience === 'agent' || descriptor.audience === 'both' || descriptor.audience === 'controller')
      ? {
        '@type': 'CreateAction',
        name: descriptor.audience === 'controller'
          ? 'Redeem this join link as a workspace controller'
          : 'Redeem this join link as an agent',
        target: {
          '@type': 'EntryPoint',
          urlTemplate: descriptor.redeemUrl,
          httpMethod: 'POST',
          contentType: 'application/json',
        },
      }
      : undefined,
    agensis: payload,
  };
}

// ----------------------------------------------------------------------------
// The HTML form
// ----------------------------------------------------------------------------
// No script, no external asset, no font, no image. That is not minimalism for
// its own sake: it lets the response carry `default-src 'none'`, and it means an
// agent that fetches the HTML and strips tags still ends up with every
// instruction, in order, as plain text.
// ----------------------------------------------------------------------------

const PAGE_STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 40px 20px;
  font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  background: #f6f7f9; color: #16181d;
}
main { max-width: 680px; margin: 0 auto; }
.card {
  background: #fff; border: 1px solid #e3e6ea; border-radius: 12px;
  padding: 28px 30px; margin-bottom: 18px;
}
h1 { font-size: 22px; line-height: 1.3; margin: 0 0 6px; letter-spacing: -0.01em; }
h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.06em;
     color: #6b7280; margin: 0 0 10px; }
p { margin: 0 0 12px; }
ul, ol { margin: 0 0 12px; padding-left: 20px; }
li { margin-bottom: 6px; }
dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; }
dt { color: #6b7280; }
dd { margin: 0; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
/* pre-wrap, not pre. An agent whose only view of this page is a rendering or a
   screenshot must be able to read the whole machine block and the whole redeem
   URL — a horizontal scrollbar hides both from it, and from anyone reading on a
   phone. Wrapping costs nothing here because every block is JSON or a URL. */
pre {
  background: #f2f4f7; border: 1px solid #e3e6ea; border-radius: 8px;
  padding: 14px 16px; margin: 0 0 12px;
  white-space: pre-wrap; overflow-wrap: anywhere;
}
.cta {
  display: inline-block; background: #16181d; color: #fff; text-decoration: none;
  padding: 11px 20px; border-radius: 8px; font-weight: 600;
}
.muted { color: #6b7280; font-size: 13px; }
.banner {
  background: #fff8e1; border: 1px solid #f0d68a; border-radius: 8px;
  padding: 12px 16px; margin-bottom: 18px; font-size: 14px;
}
.invalid h1 { color: #b4232a; }
@media (prefers-color-scheme: dark) {
  body { background: #101215; color: #e8eaed; }
  .card { background: #16181d; border-color: #2a2e35; }
  h2, dt, .muted { color: #9aa1ad; }
  pre { background: #1c1f25; border-color: #2a2e35; }
  .cta { background: #e8eaed; color: #16181d; }
  .banner { background: #241f0c; border-color: #5c4b17; }
  .invalid h1 { color: #ff8085; }
}
`.trim();

// Wrap a head + body into a real HTML document. The pieces are assembled by the
// two renderers below; this is the only place the skeleton is written, so the
// two pages cannot end up with different charsets or a missing <html lang>.
function htmlDocument({ title, head = [], body = [] }) {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // The URL in the address bar IS the secret. Never index it, never follow it.
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${PAGE_STYLE}</style>`,
    ...head,
    '</head>',
    '<body>',
    ...body,
    '</body>',
    '</html>',
  ].join('\n');
}

function renderInvalidHtml(descriptor) {
  const payload = machinePayload(descriptor);
  return htmlDocument({
    title: 'This agensis join link is no longer valid',
    head: [
      `<script type="application/ld+json">${escapeJsonForScript(JSON.stringify(jsonLd(descriptor), null, 2))}</script>`,
    ],
    body: [
      `<main class="invalid">`,
      `<div class="card">`,
      `<h1>This join link is no longer valid</h1>`,
      `<p>${escapeHtml(payload.message)}</p>`,
      `<p class="muted">Join links are deliberately short-lived and work exactly once, so a link that has been shared, logged or pasted somewhere cannot be replayed later.</p>`,
      `</div>`,
      `<div class="card">`,
      `<h2>If you are an AI agent reading this page</h2>`,
      `<p>There is nothing to redeem here and no endpoint to call. Report back that the link was refused, and ask whoever sent it for a new one. Do not retry: an unknown link and an expired one are answered identically on purpose, so a second attempt tells you nothing the first did not.</p>`,
      `<pre>${escapeHtml(`${MACHINE_BEGIN}\n${JSON.stringify(payload, null, 2)}\n${MACHINE_END}`)}</pre>`,
      `</div>`,
      `</main>`,
    ],
  });
}

function renderJoinHtml(descriptor) {
  if (descriptor.status !== 'open') return renderInvalidHtml(descriptor);

  const payload = machinePayload(descriptor);
  const workspace = escapeHtml(descriptor.workspaceName);
  const expires = descriptor.expiresAt
    ? new Date(descriptor.expiresAt).toUTCString()
    : 'shortly';
  const wantsHuman = descriptor.audience === 'human' || descriptor.audience === 'both';
  const wantsAgent = descriptor.audience === 'agent' || descriptor.audience === 'both';
  const wantsController = descriptor.audience === 'controller';

  const parts = [];
  parts.push('<main>');

  if (descriptor.preview) {
    parts.push(
      '<div class="banner"><strong>Preview.</strong> This is a rendering of the join page with '
      + 'invented data. No invite exists behind it, nothing here can be redeemed, and no '
      + 'credential was created to show it to you.</div>',
    );
  }

  // --- The human half -------------------------------------------------------
  parts.push('<div class="card">');
  parts.push(wantsController
    ? `<h1>Workspace control enrollment for ${escapeHtml(descriptor.controllerName)}</h1>`
    : `<h1>You have been invited to join ${workspace}</h1>`);
  parts.push(wantsController
    ? '<p>This is a high-authority but deliberately scoped controller enrollment. It does not add a human member and it does not make the controller a workspace owner.</p>'
    : '<p>agensis is a shared workspace where people and AI agents work together in channels and threads. Accepting adds you to this workspace as a member.</p>');
  parts.push('<dl>');
  parts.push(`<dt>Workspace</dt><dd>${workspace}</dd>`);
  if (descriptor.label) parts.push(`<dt>Invite</dt><dd>${escapeHtml(descriptor.label)}</dd>`);
  if (wantsHuman) parts.push(`<dt>Your role</dt><dd>${escapeHtml(descriptor.role)}</dd>`);
  if (wantsController) {
    parts.push(`<dt>Controller</dt><dd>${escapeHtml(descriptor.controllerName)}</dd>`);
    parts.push(`<dt>Scopes</dt><dd>${escapeHtml(descriptor.controllerScopes.join(', '))}</dd>`);
    if (descriptor.controllerExpiresAt) {
      parts.push(`<dt>Credential expires</dt><dd>${escapeHtml(new Date(descriptor.controllerExpiresAt).toUTCString())}</dd>`);
    }
  }
  parts.push(`<dt>Link expires</dt><dd>${escapeHtml(expires)}</dd>`);
  parts.push('<dt>Uses left</dt><dd>1 — this link works exactly once</dd>');
  parts.push('</dl>');
  if (wantsHuman) {
    parts.push(`<p style="margin-top:20px"><a class="cta" href="${escapeHtml(descriptor.acceptUrl)}">Sign in and join</a></p>`);
    parts.push(
      '<p class="muted">What happens next: you sign in (or create an account), you are added '
      + `to ${workspace}, and this link stops working. Nothing is charged and no credential is `
      + 'shown to you — your normal sign-in is your access.</p>',
    );
  } else if (!wantsController) {
    parts.push('<p class="muted">This particular link was issued for an AI agent rather than a person.</p>');
  } else {
    parts.push(
      '<p class="muted">This link can only enroll the named controller. It cannot be redeemed '
      + 'as a person or an ordinary agent, and its requested scopes are fixed before redemption.</p>',
    );
  }
  parts.push('</div>');

  // --- The agent half -------------------------------------------------------
  // Deliberately rendered as ordinary page copy, not hidden metadata: an agent
  // that can only see what a screenshot or a text extraction would show still
  // gets the endpoint, the method, the body and the follow-up steps.
  if (wantsAgent || wantsController) {
    parts.push('<div class="card">');
    parts.push(wantsController
      ? '<h2>If you are the controller reading this page</h2>'
      : '<h2>If you are an AI agent reading this page</h2>');
    parts.push(
      wantsController
        ? '<p>You can enroll the named controller using only this one-time URL. The response grants exactly the scopes shown above and nothing outside that closed set.</p>'
        : '<p>You can join this workspace yourself as a <strong>Connector</strong> agent (MCP). You do not need a human to do it for you, and you do not need any credential you do not already have: holding this URL is the authorization. Relay (desktop ACP or the agensis CLI) is a separate attach path after you exist in the workspace.</p>',
    );
    parts.push('<p>Send an HTTP POST to this URL, with no Authorization header:</p>');
    parts.push(`<pre>${escapeHtml(descriptor.redeemUrl)}</pre>`);
    parts.push('<p>with the header <code>Content-Type: application/json</code> and this JSON body:</p>');
    parts.push(`<pre>${escapeHtml(JSON.stringify(wantsController ? {
      as: 'controller',
    } : {
      as: 'agent',
      name: 'the display name you want in the workspace',
      handle: 'optional-handle',
      description: 'optional one line about what you do',
    }, null, 2))}</pre>`);
    parts.push(
      wantsController
        ? '<p>The response contains the named controller and, in <code>data.credential.token</code>, its scoped expiring bearer. It is returned once and is never recoverable afterwards.</p>'
        : '<p>The response contains your workspace, the agent record created for you, and — in <code>data.credential.token</code> — a long-lived bearer token. That token is returned once and is never recoverable afterwards, so save it before you do anything else.</p>',
    );
    parts.push('<p>Then:</p>');
    parts.push('<ol>');
    const nextSteps = wantsController ? payload.controller.then : payload.agent.then;
    for (const step of nextSteps) parts.push(`<li>${escapeHtml(step)}</li>`);
    parts.push('</ol>');
    parts.push(
      '<p>This link is single-use. If your POST succeeds, the URL is spent — a retry, '
      + 'including your own, will be refused. Do not forward this URL to anyone and do not '
      + 'include it, or the token you get back, in any message you send.</p>',
    );
    parts.push(
      `<p class="muted">The same instructions are available as JSON: request this URL with `
      + `<code>Accept: application/json</code>, or append <code>?format=json</code>.</p>`,
    );
    parts.push('</div>');

    // The fenced machine block. Visible on purpose — an agent handed a rendering
    // of this page, or its extracted text, finds the full contract here without
    // needing to parse HTML, read a meta tag, or make a second request.
    parts.push('<div class="card">');
    parts.push('<h2>Machine-readable instructions</h2>');
    parts.push(`<pre>${escapeHtml(`${MACHINE_BEGIN}\n${JSON.stringify(payload, null, 2)}\n${MACHINE_END}`)}</pre>`);
    parts.push('</div>');
  }

  parts.push('</main>');
  return htmlDocument({
    title: `Join ${descriptor.workspaceName} on agensis`,
    head: [
      `<script type="application/ld+json">${escapeJsonForScript(JSON.stringify(jsonLd(descriptor), null, 2))}</script>`,
    ],
    body: parts,
  });
}

module.exports = {
  MACHINE_BEGIN,
  MACHINE_END,
  TOKEN_PLACEHOLDER,
  CONTROLLER_TOKEN_PLACEHOLDER,
  PREVIEW_TOKEN,
  escapeHtml,
  escapeJsonForScript,
  joinUrlFor,
  redeemUrlFor,
  acceptUrlFor,
  agentNextSteps,
  controllerNextSteps,
  joinDescriptor,
  previewDescriptor,
  invalidDescriptor,
  machinePayload,
  jsonLd,
  renderJoinHtml,
};
