import { expect, it } from 'vitest';
import { DocumentBodyCache } from '../../src/lib/documentBodyCache';

it('evicts the least recently read body when the entry bound is reached', () => {
  const cache = new DocumentBodyCache(2, 100);
  cache.set('a', 'a').set('b', 'b');
  expect(cache.get('a')).toBe('a');
  cache.set('c', 'c');
  expect([...cache.keys()]).toEqual(['a', 'c']);
});
it('bounds retained UTF-16 bytes and skips individually oversized bodies', () => {
  const cache = new DocumentBodyCache(64, 12);
  cache.set('a', '1234').set('b', '5678');
  expect(cache.has('a')).toBe(false);
  cache.set('huge', '1234567');
  expect(cache.has('huge')).toBe(false);
  expect(cache.get('b')).toBe('5678');
});
it('accounts for replacement, deletion, clear and empty bodies', () => {
  const cache = new DocumentBodyCache(3, 8);
  cache.set('a', '1234').set('a', '').set('b', '1234');
  expect(cache.get('a')).toBe('');
  cache.delete('b'); cache.set('c', '1234');
  expect(cache.has('a')).toBe(true);
  cache.clear(); cache.set('d', '1234');
  expect([...cache.keys()]).toEqual(['d']);
});
