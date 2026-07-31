// What each bridge provider needs from the person setting it up.
//
// Single-sourced here so the setup form, the validation and the "what do I do
// next" copy cannot drift apart. The server has the matching list in
// server/bridge-admin-routes.cjs (PROVIDER_FIELDS) and rejects anything missing
// — this is the UI half, not the enforcement.
//
// agensis never creates a Slack app or a Telegram bot for anybody. The user
// makes those where they already live, pastes what they get, and we complete
// whatever handshake the provider supports. So every field here is something a
// human copies out of somebody else's dashboard.

export type BridgeProvider = 'telegram' | 'slack' | 'whatsapp' | 'signal' | 'openclaw' | 'nostr';

export interface BridgeField {
  key: string;
  label: string;
  placeholder: string;
  /** Rendered as a password field and never echoed back by the API. */
  secret?: boolean;
  help?: string;
}

export interface BridgeProviderSpec {
  provider: BridgeProvider;
  /** 'hub' runs on the server; 'daemon' needs the user's own machine. */
  lane: 'hub' | 'daemon';
  fields: BridgeField[];
  /** Whether the remote chat/channel id is typed in rather than discovered. */
  externalIdLabel?: string;
  externalIdPlaceholder?: string;
  externalIdHelp?: string;
  /** One line under the title, explaining what the user is about to do. */
  summary: string;
  /** Shown once the bridge row exists, as the remaining manual step. */
  steps: string[];
  /** Set when the provider links by scanning a code on a phone. */
  pairing?: 'qr';
  warning?: string;
  /** This provider uses its own invite wizard instead of the generic credential form. */
  setup?: 'invite';
}

export const BRIDGE_PROVIDERS: Record<BridgeProvider, BridgeProviderSpec> = {
  nostr: {
    provider: 'nostr',
    lane: 'hub',
    summary: 'Join a Nostr community with an invite and choose which channels to mirror.',
    fields: [],
    steps: [],
    setup: 'invite',
  },
  telegram: {
    provider: 'telegram',
    lane: 'hub',
    summary: 'Mirror a Telegram group into this channel using your own bot.',
    fields: [
      {
        key: 'botToken',
        label: 'Bot token',
        placeholder: '123456:ABC-DEF…',
        secret: true,
        help: 'From @BotFather — /newbot, then copy the token it gives you.',
      },
    ],
    externalIdLabel: 'Chat ID',
    externalIdPlaceholder: '-1001234567890',
    externalIdHelp: 'Optional. Leave blank and the first message the bot sees will fill it in.',
    steps: [
      'Add the bot to your Telegram group.',
      'In @BotFather, turn OFF the bot’s privacy mode — otherwise it cannot read group messages.',
      'Send a message in the group to confirm it comes through.',
    ],
  },
  slack: {
    provider: 'slack',
    lane: 'hub',
    summary: 'Mirror a Slack channel using a Slack app you own.',
    fields: [
      {
        key: 'botToken',
        label: 'Bot user OAuth token',
        placeholder: 'xoxb-…',
        secret: true,
        help: 'OAuth & Permissions in your Slack app. Needs chat:write and channels:history.',
      },
      {
        key: 'signingSecret',
        label: 'Signing secret',
        placeholder: '…',
        secret: true,
        help: 'Basic Information in your Slack app. Used to verify every delivery is really from Slack.',
      },
    ],
    externalIdLabel: 'Channel ID',
    externalIdPlaceholder: 'C0123456789',
    externalIdHelp: 'The channel ID, not the name — bottom of the channel’s About tab.',
    steps: [
      'Paste the event URL below into your Slack app’s Event Subscriptions.',
      'Subscribe to the message.channels bot event.',
      'Invite the bot into the channel.',
    ],
  },
  whatsapp: {
    provider: 'whatsapp',
    lane: 'daemon',
    pairing: 'qr',
    summary: 'Link WhatsApp on your own machine and mirror one conversation here.',
    fields: [],
    steps: [
      'Scan the code below with WhatsApp on your phone: Settings, then Linked devices.',
      'Send a message in the conversation you want mirrored.',
    ],
    warning:
      'This links WhatsApp as a companion device from the machine running your agensis daemon, the same way WhatsApp Web does. It uses an unofficial client library, which is against WhatsApp’s terms — accounts have been banned for it. Your credentials stay on your machine.',
  },
  signal: {
    provider: 'signal',
    lane: 'daemon',
    pairing: 'qr',
    summary: 'Link Signal on your own machine and mirror one group here.',
    fields: [],
    steps: [
      'Scan the code below with Signal on your phone: Settings, then Linked devices.',
      'Send a message in the group you want mirrored.',
    ],
    warning:
      'Signal has no server API, so this runs on the machine hosting your agensis daemon and links as a second device. Nothing is stored on agensis servers.',
  },
  openclaw: {
    provider: 'openclaw',
    lane: 'daemon',
    summary: 'Attach an OpenClaw gateway so its chats land in agensis channels.',
    fields: [
      {
        key: 'gatewayUrl',
        label: 'Gateway URL',
        placeholder: 'ws://127.0.0.1:18789',
        help: 'Your OpenClaw gateway. It must be reachable from the machine running your agensis daemon.',
      },
      {
        key: 'authToken',
        label: 'Auth token',
        placeholder: '…',
        secret: true,
        help: 'The gateway’s shared-secret token.',
      },
    ],
    externalIdLabel: 'Chat ID',
    externalIdPlaceholder: 'telegram:-100123…',
    externalIdHelp: 'Which OpenClaw chat to mirror. Leave blank to pick one after connecting.',
    steps: [
      'Make sure the gateway is running and your agensis daemon is connected.',
      'Pick the chat to mirror once the gateway reports in.',
    ],
  },
};

export function bridgeSpec(id: string): BridgeProviderSpec | null {
  return (BRIDGE_PROVIDERS as Record<string, BridgeProviderSpec>)[id] ?? null;
}
