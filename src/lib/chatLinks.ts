/**
 * Drop sentence punctuation from a matched URL while preserving balanced
 * brackets that genuinely belong to the address.
 */
export function trimUrlTail(url: string): string {
  let end = url.length;
  while (end > 0) {
    const char = url[end - 1];
    if ('.,;:!?"\''.includes(char)) {
      end -= 1;
      continue;
    }
    const opener = char === ')' ? '(' : char === ']' ? '[' : char === '}' ? '{' : '';
    if (opener && !url.slice(0, end - 1).includes(opener)) {
      end -= 1;
      continue;
    }
    break;
  }
  return end > 'https://'.length ? url.slice(0, end) : url;
}
