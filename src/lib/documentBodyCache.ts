/** Bounded LRU for fetched document bodies; size uses UTF-16 string bytes. */
export class DocumentBodyCache extends Map<string, string> {
  private bytes = 0;
  constructor(private readonly maxEntries = 64, private readonly maxBytes = 8 * 1024 * 1024) {
    super();
  }
  override get(id: string): string | undefined {
    const body = super.get(id);
    if (body !== undefined) {
      super.delete(id);
      super.set(id, body);
    }
    return body;
  }
  override set(id: string, body: string): this {
    this.delete(id);
    const bytes = body.length * 2;
    if (bytes > this.maxBytes) return this;
    super.set(id, body);
    this.bytes += bytes;
    while (this.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.keys().next().value;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    return this;
  }
  override delete(id: string): boolean {
    const body = super.get(id);
    if (body !== undefined) this.bytes -= body.length * 2;
    return super.delete(id);
  }
  override clear(): void {
    super.clear();
    this.bytes = 0;
  }
}
