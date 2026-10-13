import { describe, expect, it } from 'vitest';
import { favouritesCodec, toggleFavourite } from '../../src/lib/pm/favourites';

const A = '11111111-2222-4333-8444-555555555555';
const B = '22222222-2222-4333-8444-555555555555';

describe('favourites', () => {
  it('round-trips ids', () => {
    expect(favouritesCodec.parse(favouritesCodec.serialize([A, B]))).toEqual([A, B]);
  });
  it('drops anything that is not an id, and rejects non-lists and bad JSON', () => {
    expect(favouritesCodec.parse(JSON.stringify([A, 'nope', 3]))).toEqual([A]);
    expect(favouritesCodec.parse('{"a":1}')).toBeNull();
    expect(favouritesCodec.parse('not json')).toBeNull();
  });
  it('toggles', () => {
    expect(toggleFavourite([A], B)).toEqual([A, B]);
    expect(toggleFavourite([A, B], A)).toEqual([B]);
  });
});
