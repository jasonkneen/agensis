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

describe('bridges are visible but not creatable', () => {
  const bridges = CHANNEL_TEMPLATES.filter(t => t.kind === 'bridge');

  it('ships the four asked for', () => {
    expect(bridges.map(b => b.id).sort()).toEqual(['openclaw', 'signal', 'telegram', 'whatsapp']);
  });

  it('NONE of them can create a channel — the transport does not exist', () => {
    // The whole point: a card that created a channel which then never receives
    // a message is worse than a card that says it is not built yet.
    for (const bridge of bridges) {
      expect(canCreateFromTemplate(bridge), bridge.id).toBe(false);
      expect(bridge.unavailableNote, bridge.id).toBeTruthy();
    }
  });

  it('every NATIVE template can create a channel', () => {
    for (const tpl of CHANNEL_TEMPLATES.filter(t => t.kind === 'native')) {
      expect(canCreateFromTemplate(tpl), tpl.id).toBe(true);
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
    expect(filterChannelTemplates(CHANNEL_TEMPLATES, 'All', 'bring your own').length).toBe(4);
  });

  it('a search matching nothing returns empty rather than everything', () => {
    // The inverted version of this shows the whole gallery for any typo.
    expect(filterChannelTemplates(CHANNEL_TEMPLATES, 'All', 'zzzznope')).toEqual([]);
  });

  it('category and query compose', () => {
    expect(filterChannelTemplates(CHANNEL_TEMPLATES, 'Social', 'telegram')).toEqual([]);
  });
});
