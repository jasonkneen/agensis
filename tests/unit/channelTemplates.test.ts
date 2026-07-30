import { describe, expect, it } from 'vitest';
import {
  CHANNEL_TEMPLATES,
  CHANNEL_TEMPLATE_CATEGORIES,
  canCreateFromTemplate,
  channelDraftFromTemplate,
  filterChannelTemplates,
} from '../../src/lib/channelTemplates';
import { CHANNEL_ICONS, MAX_INTENT_CHARS, MAX_DESCRIPTION_CHARS } from '../../src/lib/channelProfile';
import { CONVERSATION_MODES } from '../../src/lib/channelMentions';
import { bridgeSpec } from '../../src/lib/bridgeProviders';

describe('channel templates', () => {
  it('every template stores a REAL channel icon key', () => {
    // A template that shipped an icon key the database does not accept would
    // normalize to '' and silently lose its icon on the very first save.
    for (const tpl of CHANNEL_TEMPLATES) {
      expect(CHANNEL_ICONS as readonly string[], tpl.id).toContain(tpl.channelIcon);
    }
  });

  it('every template uses a real conversation mode', () => {
    for (const tpl of CHANNEL_TEMPLATES) {
      expect(CONVERSATION_MODES as readonly string[], tpl.id).toContain(tpl.conversationMode);
    }
  });

  it('prefilled text fits the limits the channel editor enforces', () => {
    // Otherwise picking a template produces a channel whose own edit form
    // refuses to save it back unchanged.
    for (const tpl of CHANNEL_TEMPLATES) {
      expect(tpl.intent.length, `${tpl.id} intent`).toBeLessThanOrEqual(MAX_INTENT_CHARS);
      expect(tpl.channelDescription.length, `${tpl.id} description`).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
    }
  });

  it('template ids are unique', () => {
    const ids = CHANNEL_TEMPLATES.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('categories are derived, so no template can have an unlisted category', () => {
    expect(CHANNEL_TEMPLATE_CATEGORIES[0]).toBe('All');
    for (const tpl of CHANNEL_TEMPLATES) {
      expect(CHANNEL_TEMPLATE_CATEGORIES).toContain(tpl.category);
    }
  });
});

describe('bridges are real, and each one has somewhere to send you', () => {
  const bridges = CHANNEL_TEMPLATES.filter(t => t.kind === 'bridge');

  it('ships the five that have a transport', () => {
    // These are exactly the providers server/channel-bridges.cjs carries
    // (DAEMON_PROVIDERS + HUB_PROVIDERS). A template for a sixth would be a
    // card that opens a setup step the backend cannot honour.
    expect(bridges.map(b => b.id).sort()).toEqual(['openclaw', 'signal', 'slack', 'telegram', 'whatsapp']);
  });

  it('every bridge has a provider spec to ask for credentials with', () => {
    // NewChannelDialog sends a bridge to `bridgeSpec(tpl.id)` for the fields to
    // collect. A template with no spec renders a setup step with nothing in it —
    // a dead end that looks like a bug in the dialog rather than a missing spec.
    for (const bridge of bridges) {
      const spec = bridgeSpec(bridge.id);
      expect(spec, bridge.id).toBeTruthy();
      expect(spec!.provider, bridge.id).toBe(bridge.id);
      expect(spec!.fields.length + (spec!.pairing ? 1 : 0), bridge.id).toBeGreaterThan(0);
    }
  });

  it('bridges all sit in the one category the gallery groups them under', () => {
    for (const bridge of bridges) {
      expect(bridge.category, bridge.id).toBe('Bring your own');
    }
  });

  it('every template can create a channel — nothing ships as a placeholder card', () => {
    // `available: false` still exists for the next template whose UI lands ahead
    // of its backend, but nothing sets it today. A bridge is gated by needing
    // credentials (NewChannelDialog routes kind==='bridge' to setup FIRST), not
    // by being unbuilt — so it is `available` and has no unavailableNote.
    for (const tpl of CHANNEL_TEMPLATES) {
      expect(canCreateFromTemplate(tpl), tpl.id).toBe(true);
      expect(tpl.unavailableNote, tpl.id).toBeUndefined();
    }
  });
});

describe('channelDraftFromTemplate', () => {
  it('carries only fields a human could set in Edit channel', () => {
    const tpl = CHANNEL_TEMPLATES.find(t => t.id === 'watercooler')!;
    const draft = channelDraftFromTemplate(tpl);
    expect(Object.keys(draft).sort()).toEqual(
      ['conversation_mode', 'description', 'icon', 'intent', 'title'],
    );
  });

  it('does NOT record the template id in any field', () => {
    // A channel made from a template is an ordinary channel. Storing the id
    // would mean deleting a template could strand channels that referenced it.
    // Asserted as "no key carries the id", not "the JSON never contains the
    // string" — 'project' legitimately appears inside the title "New project",
    // and the looser check fails on that without anything being wrong.
    for (const tpl of CHANNEL_TEMPLATES) {
      const draft = channelDraftFromTemplate(tpl) as Record<string, unknown>;
      expect(Object.keys(draft), tpl.id).not.toContain('id');
      expect(Object.keys(draft), tpl.id).not.toContain('template');
      expect(Object.keys(draft), tpl.id).not.toContain('template_id');
    }
  });

  it('the custom template prefills nothing but a usable mode', () => {
    const draft = channelDraftFromTemplate(CHANNEL_TEMPLATES.find(t => t.id === 'custom')!);
    expect(draft.title).toBe('');
    expect(draft.intent).toBe('');
    expect(draft.conversation_mode).toBe('auto');
  });

  it('watercooler starts in social cadence, standup in mention', () => {
    // These are the two templates whose whole value is the mode they pick.
    expect(channelDraftFromTemplate(CHANNEL_TEMPLATES.find(t => t.id === 'watercooler')!).conversation_mode).toBe('social');
    expect(channelDraftFromTemplate(CHANNEL_TEMPLATES.find(t => t.id === 'standup')!).conversation_mode).toBe('mention');
  });
});

describe('filterChannelTemplates', () => {
  it('All plus empty query returns everything', () => {
    expect(filterChannelTemplates(CHANNEL_TEMPLATES, 'All', '')).toHaveLength(CHANNEL_TEMPLATES.length);
  });

  it('filters by category', () => {
    const social = filterChannelTemplates(CHANNEL_TEMPLATES, 'Social', '');
    expect(social.length).toBeGreaterThan(0);
    expect(social.every(t => t.category === 'Social')).toBe(true);
  });

  it('searches name, description and category, case-insensitively', () => {
    expect(filterChannelTemplates(CHANNEL_TEMPLATES, 'All', 'TELEGRAM').map(t => t.id)).toEqual(['telegram']);
    // Matched on CATEGORY text alone — no bridge repeats "bring your own" in its
    // name or description. Counted off the templates rather than hardcoded, so
    // adding a sixth bridge does not fail a test about case-insensitivity.
    const bringYourOwn = CHANNEL_TEMPLATES.filter(t => t.category === 'Bring your own');
    expect(bringYourOwn.length).toBeGreaterThan(0);
    expect(filterChannelTemplates(CHANNEL_TEMPLATES, 'All', 'bring your own').map(t => t.id))
      .toEqual(bringYourOwn.map(t => t.id));
  });

  it('a search matching nothing returns empty rather than everything', () => {
    // The inverted version of this shows the whole gallery for any typo.
    expect(filterChannelTemplates(CHANNEL_TEMPLATES, 'All', 'zzzznope')).toEqual([]);
  });

  it('category and query compose', () => {
    expect(filterChannelTemplates(CHANNEL_TEMPLATES, 'Social', 'telegram')).toEqual([]);
  });
});
