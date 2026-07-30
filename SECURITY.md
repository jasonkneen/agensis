# Security policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.** A public issue is visible
to everyone the moment it is filed, including before a fix exists.

Use one of these private routes instead:

1. **GitHub private vulnerability reporting** (preferred). On this repository, go
   to the **Security** tab → **Report a vulnerability**. This opens a private
   advisory visible only to you and the maintainers, with a thread for follow-up
   and a path to a coordinated CVE if one is warranted.
2. **Email** — `<SECURITY_CONTACT_EMAIL>`.
   *Maintainers: replace this placeholder with a real, monitored address before
   publication. Until it is filled in, route 1 is the only working route.*

If you are unsure whether something is a security problem, report it privately
first. An over-cautious private report costs a maintainer five minutes; a
premature public one cannot be taken back.

### What to include

- What the issue is, and what an attacker gets out of it.
- The steps to reproduce it, or a proof of concept.
- Affected version, commit SHA, or deployment (self-hosted vs. hosted).
- Whether you have disclosed it anywhere else, and any deadline you are working
  to.

### What to expect

- **Acknowledgement within 5 working days.** This is a small project; if you
  hear nothing after that, send a reminder rather than assuming the report was
  received.
- An assessment of severity and an indication of the intended fix timeline.
- Credit in the advisory and release notes, unless you ask us not to.

We ask that you give us a reasonable window to ship a fix before publishing. We
will not ask you to stay quiet indefinitely, and we will not threaten anyone
acting in good faith under this policy.

## Scope

**In scope** — anything in this repository, and any deployment built from it:

- Authentication, session tokens and the MCP token verifiers.
- Workspace role enforcement, the generic `/backend/db/*` table allowlists, and
  row scoping.
- Private-session (DM) read authorization, over both REST and realtime.
- The credential vault and the credential proxy.
- SSRF guards on outbound URLs.
- Sandbox and agent-daemon isolation.
- Anything that leaks a secret into a response, a log, a broadcast frame or the
  audit log.

**Out of scope:**

- Vulnerabilities in third-party dependencies that have already been publicly
  disclosed upstream — report those upstream; open a normal issue here if this
  project needs to bump a version.
- Findings from automated scanners with no demonstrated impact.
- Reports that require an attacker to already hold `manage` on the workspace
  they are attacking, unless the point of the report is that `manage` should not
  have been sufficient.
- Social engineering, physical access, and denial of service through sheer
  volume.
- Missing hardening headers with no demonstrated exploit path.

## Known limitations

Stated plainly, because a security policy that omits them wastes a researcher's
time and misleads an operator:

- **Realtime fanout scopes private sessions for `chat_sessions` only.** The
  private-session split in `notifyDbSubscribers` (`server/realtime.cjs`) applies
  when the table is `chat_sessions`. `messages` is covered by a different,
  structural argument (an unfiltered `messages` subscription cannot be
  established, so a message only reaches a socket that named its session). Other
  allowlisted tables that can carry DM-derived rows are covered by neither and
  fall back to workspace-role scoping. This is documented in AGENTS.md and is a
  known gap, not a novel finding — reporting it is welcome, but expect it to be
  already tracked.
- **The audit log is tamper-evident, not tamper-proof.** It has no hash chain and
  no external anchor. Anyone holding `DATABASE_URL` can rewrite it. It is
  designed to detect application-level tampering, and it does not defend against
  the database operator.
- **`activity_events` is a feed, not an audit record.** It is client-authored and
  writable by anyone with the `write` capability. Do not treat a row in it as
  evidence of anything.

If you find that one of these limitations is *worse* than described here — wider
reach, a lower privilege requirement, a bypass of the mitigation that is claimed
— that is very much in scope. Please report it.

## Self-hosting

If you run your own deployment, the security-relevant environment variables and
what happens when they are unset are documented in
[AGENTS.md](./AGENTS.md#deploy-environment-variables-split-netlify--fly). Two
worth calling out:

- `AUTH_SECRET` must be identical across every host that verifies tokens.
- `SECRETS_ENCRYPTION_KEY`, if set on one host, must be set to the same value on
  all of them.
