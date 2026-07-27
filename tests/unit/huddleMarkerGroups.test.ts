import { describe, expect, it } from 'vitest';
import { groupHuddleMarkers, huddleGroupLabel, HUDDLE_MARKER_KIND, type HuddleMarkerGroup } from '../../src/lib/huddleTranscript';

// Ten stacked "You were in a huddle" lines was ten rows of chrome for one fact,
// and it buried the conversation those huddles happened inside. Runs collapse.
const marker = (id: string) => ({ id, message_kind: HUDDLE_MARKER_KIND, huddle_id: `h-${id}` });
const said = (id: string) => ({ id, message_kind: '', content: 'hello' });

describe('groupHuddleMarkers', () => {
  it('folds a run of markers into one group, oldest first', () => {
    const out = groupHuddleMarkers([marker('a'), marker('b'), marker('c')]);
    expect(out).toHaveLength(1);
    const group = out[0] as HuddleMarkerGroup;
    expect(group.kind).toBe('huddle-group');
    expect(group.messages.map(m => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('leaves a LONE marker alone — one huddle reads better as its sentence', () => {
    const out = groupHuddleMarkers([said('x'), marker('a'), said('y')]);
    expect(out.map(entry => (entry as { id?: string }).id)).toEqual(['x', 'a', 'y']);
  });

  it('a real message between huddles breaks the run', () => {
    // The huddles then belong to different moments; merging would misstate order.
    const out = groupHuddleMarkers([marker('a'), marker('b'), said('x'), marker('c'), marker('d')]);
    expect(out).toHaveLength(3);
    expect((out[0] as HuddleMarkerGroup).messages.map(m => m.id)).toEqual(['a', 'b']);
    expect((out[1] as { id: string }).id).toBe('x');
    expect((out[2] as HuddleMarkerGroup).messages.map(m => m.id)).toEqual(['c', 'd']);
  });

  it('preserves non-marker order exactly and passes an empty list through', () => {
    const out = groupHuddleMarkers([said('a'), said('b'), said('c')]);
    expect(out.map(entry => (entry as { id: string }).id)).toEqual(['a', 'b', 'c']);
    expect(groupHuddleMarkers([])).toEqual([]);
  });

  it('labels the count, singular and plural', () => {
    expect(huddleGroupLabel({ kind: 'huddle-group', key: 'k', messages: [marker('a')] })).toBe('1 huddle');
    expect(huddleGroupLabel({ kind: 'huddle-group', key: 'k', messages: [marker('a'), marker('b')] })).toBe('2 huddles');
  });
});
