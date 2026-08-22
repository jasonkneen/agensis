'use strict';

// ---------------------------------------------------------------------------
// THE AGENT SHARE POLICY — what the MACHINE will contribute, decided on the
// machine.
//
// `workspace_agents.sharing` (shared/agentSharing.cjs) is the WORKSPACE's half:
// a person in agensis saying "we want this agent's documents". This is the other
// half, and it belongs to whoever owns the computer the agent runs on: a file in
// the agent's root folder, read by the daemon, declaring what that machine is
// willing to send. Consciously modelled on robots.txt — a plain-text file, at a
// known location, that the party holding the content writes for the party
// fetching it.
//
// THE TWO HALVES INTERSECT. Neither can widen the other:
//
//     effective = workspace switch AND machine policy
//
// A workspace cannot switch on something the machine withholds, and a machine
// cannot force in something the workspace turned off. Stated as an AND rather
// than a precedence order because precedence invites the question "which one
// wins?", and the answer must always be "the more restrictive one".
//
// WHERE robots.txt IS ONLY ADVISORY, THIS IS NOT. A crawler chooses whether to
// honour robots.txt; here the daemon that reads the file is the same process
// that decides what to send, so a withheld path is simply never enumerated.
// The server then applies the SAME policy again at ingest
// (server/agent-connections.cjs) against the declaration the daemon reported.
// That second check is what makes this a control rather than a convention: a
// buggy or modified daemon that sends a disallowed path gets it dropped.
//
// FAIL OPEN ON ABSENCE, FAIL CLOSED ON GARBAGE. No file at all means "no
// machine-side restrictions" — the workspace switches decide alone, which is
// exactly the behaviour of every agent connected before this existed. But a file
// that PARSES to nothing usable is different: somebody wrote it intending to
// restrict something, and reading their broken file as "share everything" is the
// worst possible interpretation. Those produce `errors` and the caller decides;
// `parseSharePolicy` never silently discards a line it did not understand.
//
// PURE. No fs, no network, no clock. The daemon reads the bytes and calls this;
// so does the server. Unit-tested in tests/agent-share-policy.test.cjs.
// ---------------------------------------------------------------------------

const { SHARING_CHANNELS } = require('./agentSharing.cjs');

/** The conventional filename, in the agent's root folder. */
const SHARE_POLICY_FILENAME = '.agensis-share';

/** Biggest policy file we will parse. A policy is a page, not a database. */
const MAX_POLICY_BYTES = 64 * 1024;

/** Most path rules honoured. Beyond this the file is doing something else. */
const MAX_PATH_RULES = 500;

/**
 * One parsed policy.
 *
 * `channels` holds only the channels the file MENTIONED — absent means "no
 * opinion", which is different from "share". A policy that says nothing about
 * memory must not be read as granting memory; it must be read as deferring to
 * the workspace switch.
 */
function emptyPolicy() {
 return { declared: false, channels: {}, rules: [], errors: [] };
}

function isChannel(value) {
 return SHARING_CHANNELS.includes(value);
}

/**
 * Parse a `.agensis-share` file.
 *
 * Grammar, one directive per line, `#` to end of line is a comment:
 *
 *     share: documents           # this machine will contribute documents
 *     withhold: memory           # ...but never its memory files
 *     allow: docs/**             # path rules, applied to documents and
 *     disallow: docs/internal/** # memory files. FIRST MATCH WINS.
 *
 * Directive names are case-insensitive; paths are not (they are paths).
 * `deny:` is accepted as a synonym for `disallow:` because it is what people
 * type, and refusing it would produce a file that silently shares what its
 * author believed they had blocked — the one failure this format must not have.
 */
function parseSharePolicy(text) {
 const policy = emptyPolicy();
 const raw = typeof text === 'string' ? text : '';
 if (!raw.trim()) return policy;
 if (Buffer.byteLength(raw, 'utf8') > MAX_POLICY_BYTES) {
  policy.errors.push('Policy file is too large to parse; it was ignored.');
  return policy;
 }

 const lines = raw.replace(/\r\n?/g, '\n').split('\n');
 for (let index = 0; index < lines.length; index += 1) {
  // A `#` anywhere starts a comment. Paths containing `#` are not supported,
  // and that is a deliberate trade: comments are worth far more in a file
  // people hand-write than a filename nobody should have.
  const line = lines[index].split('#')[0].trim();
  if (!line) continue;

  const split = line.indexOf(':');
  if (split < 1) {
   policy.errors.push(`Line ${index + 1}: expected "directive: value".`);
   continue;
  }
  const directive = line.slice(0, split).trim().toLowerCase();
  const value = line.slice(split + 1).trim();
  if (!value) {
   policy.errors.push(`Line ${index + 1}: "${directive}" has no value.`);
   continue;
  }

  if (directive === 'share' || directive === 'withhold') {
   const channel = value.toLowerCase();
   if (!isChannel(channel)) {
    policy.errors.push(`Line ${index + 1}: unknown channel "${value}". Known channels: ${SHARING_CHANNELS.join(', ')}.`);
    continue;
   }
   // LAST mention of a channel wins, so an operator appending a `withhold:` to
   // the end of the file gets what they obviously intend.
   policy.channels[channel] = directive === 'share';
   policy.declared = true;
   continue;
  }

  if (directive === 'allow' || directive === 'disallow' || directive === 'deny') {
   if (policy.rules.length >= MAX_PATH_RULES) {
    policy.errors.push(`Line ${index + 1}: more than ${MAX_PATH_RULES} path rules; the rest were ignored.`);
    continue;
   }
   policy.rules.push({ allow: directive === 'allow', pattern: value });
   policy.declared = true;
   continue;
  }

  policy.errors.push(`Line ${index + 1}: unknown directive "${directive}".`);
 }

 return policy;
}

/**
 * Compile one glob to a RegExp.
 *
 * Supports the three forms people actually write: `**` (any depth, including
 * none), `*` (one segment), `?` (one character). Everything else is escaped, so
 * a pattern containing regex metacharacters matches them literally rather than
 * becoming an accidental wildcard — a `.` in `*.private.md` must mean a dot.
 *
 * A trailing `/` means "this directory and everything under it", which is what
 * `scratch/` reads as to anyone who has written a .gitignore.
 */
function globToRegExp(pattern) {
 let glob = String(pattern || '').trim();
 if (!glob) return null;
 glob = glob.replace(/^\.\//, '').replace(/^\/+/, '');
 if (glob.endsWith('/')) glob = `${glob}**`;

 let out = '';
 for (let index = 0; index < glob.length; index += 1) {
  const char = glob[index];
  if (char === '*') {
   if (glob[index + 1] === '*') {
    // `a/**/b` must also match `a/b`, so the separator after `**` is optional.
    if (glob[index + 2] === '/') {
     out += '(?:.*/)?';
     index += 2;
    } else {
     out += '.*';
     index += 1;
    }
   } else {
    out += '[^/]*';
   }
   continue;
  }
  if (char === '?') { out += '[^/]'; continue; }
  out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 }
 try {
  return new RegExp(`^${out}$`);
 } catch {
  return null;
 }
}

/**
 * Does the policy permit this path?
 *
 * FIRST MATCH WINS, in file order — the robots.txt rule, and the one people
 * expect from a file that looks like this. A path matching no rule is ALLOWED:
 * the rules are exceptions carved out of "share what the channel allows", not
 * an allowlist. A file whose author wants an allowlist writes `disallow: **`
 * first and then carves back with `allow:`.
 *
 * No rules at all means every path passes, which is what an empty policy means.
 */
function pathAllowed(policy, filePath) {
 const rules = policy?.rules || [];
 if (rules.length === 0) return true;
 const candidate = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
 if (!candidate) return true;
 for (const rule of rules) {
  const matcher = globToRegExp(rule.pattern);
  if (matcher && matcher.test(candidate)) return rule.allow;
 }
 return true;
}

/**
 * Does the policy permit this channel?
 *
 * A channel the file never mentions returns true — "no opinion", deferring to
 * the workspace switch. Only an explicit `withhold:` returns false, which is the
 * same fail-open shape the workspace switches use, for the same reason.
 */
function channelAllowed(policy, channel) {
 const declared = policy?.channels?.[channel];
 return declared !== false;
}

/**
 * The EFFECTIVE answer for one channel: the workspace switch AND the machine
 * policy. This is the function every caller should use; reading either half on
 * its own is how the two drift apart.
 */
function effectiveChannel(agentRow, policy, channel) {
 const { agentSharesChannel } = require('./agentSharing.cjs');
 return agentSharesChannel(agentRow, channel) && channelAllowed(policy, channel);
}

/**
 * Why a channel is off, in the words a UI should use.
 *
 * The distinction matters to whoever is looking at an empty list: "we turned it
 * off here" is a thing they can undo in the app, and "that machine declines" is
 * not — it needs a file change on someone else's computer. A surface that
 * showed one blank list for both would send people to the wrong place.
 */
function describeChannelState(agentRow, policy, channel) {
 const { agentSharesChannel } = require('./agentSharing.cjs');
 const workspaceOn = agentSharesChannel(agentRow, channel);
 const machineOn = channelAllowed(policy, channel);
 if (workspaceOn && machineOn) return { shared: true, reason: 'shared' };
 if (!workspaceOn && !machineOn) return { shared: false, reason: 'both' };
 return { shared: false, reason: workspaceOn ? 'machine' : 'workspace' };
}

/**
 * Normalize a policy that arrived over the wire.
 *
 * The daemon sends the PARSED shape, not the file, so this is the server's gate
 * on it: unknown channels dropped, rules capped, patterns forced to strings.
 * Never trust a peer's parse — the daemon is a program on somebody else's
 * machine and this object decides what the server will store.
 */
function normalizeSharePolicyMessage(input) {
 const policy = emptyPolicy();
 if (!input || typeof input !== 'object' || Array.isArray(input)) return policy;

 const channels = input.channels;
 if (channels && typeof channels === 'object' && !Array.isArray(channels)) {
  for (const channel of SHARING_CHANNELS) {
   if (!Object.prototype.hasOwnProperty.call(channels, channel)) continue;
   policy.channels[channel] = channels[channel] !== false;
   policy.declared = true;
  }
 }

 const rules = Array.isArray(input.rules) ? input.rules.slice(0, MAX_PATH_RULES) : [];
 for (const rule of rules) {
  if (!rule || typeof rule !== 'object') continue;
  const pattern = String(rule.pattern || '').trim().slice(0, 512);
  if (!pattern) continue;
  policy.rules.push({ allow: rule.allow === true, pattern });
  policy.declared = true;
 }
 return policy;
}

/** A one-line summary for a UI that has no room for the whole file. */
function describeSharePolicy(policy) {
 if (!policy?.declared) return 'No policy file on this machine';
 const withheld = SHARING_CHANNELS.filter(channel => policy.channels[channel] === false);
 const parts = [];
 if (withheld.length > 0) parts.push(`withholds ${withheld.join(', ')}`);
 if (policy.rules.length > 0) parts.push(`${policy.rules.length} path rule${policy.rules.length === 1 ? '' : 's'}`);
 return parts.length > 0 ? `Machine policy: ${parts.join(' · ')}` : 'Machine policy: no restrictions';
}

module.exports = {
 SHARE_POLICY_FILENAME,
 MAX_POLICY_BYTES,
 MAX_PATH_RULES,
 parseSharePolicy,
 globToRegExp,
 pathAllowed,
 channelAllowed,
 effectiveChannel,
 describeChannelState,
 normalizeSharePolicyMessage,
 describeSharePolicy,
};
