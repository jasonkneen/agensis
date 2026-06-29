export type RealtimeChannel = {
  on: {
    <T>(type: 'broadcast', config: { event: string }, callback: (message: BroadcastPayload<T>) => void): RealtimeChannel;
    <T>(type: 'db_changes', config: { event: string; schema: string; table: string; filter?: string }, callback: (payload: DbChangePayload<T>) => void): RealtimeChannel;
  };
  subscribe: (callback?: (status: string) => void) => RealtimeChannel;
  unsubscribe: () => Promise<unknown>;
  send: (message: BroadcastSendMessage) => Promise<unknown>;
};

export type BroadcastPayload<T> = { payload: T };
export type DbChangePayload<T> = {
  eventType?: string;
  new?: T;
  old?: Partial<T>;
};
export type BroadcastSendMessage = { type: 'broadcast'; event: string; payload: unknown };
