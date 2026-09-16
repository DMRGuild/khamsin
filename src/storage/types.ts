export type ListName = 'allowlist' | 'admins' | 'tags';
export const CUSTOM_SLOTS = ['index', 'about', 'main-header', 'main-footer', 'sidebar-header', 'sidebar-footer'] as const;
export interface PinRecord {
  uploader: string; npub?: string; id: string | null;
  fileName?: string; size?: number; at: number;
}
export interface Store {
  readonly editable: boolean;
  list(name: ListName): Promise<string[]>;
  add(name: ListName, entry: string): Promise<void>;
  remove(name: ListName, entry: string): Promise<void>;
  custom(slot: string): Promise<string>;
  setCustom(slot: string, html: string): Promise<void>;
  pin(cid: string): Promise<PinRecord | null>;
  claimPin(cid: string, record: PinRecord): Promise<void>;
  deletePin(cid: string, owner: string): Promise<void>;
}
export interface Statement { sql: string; params?: (string | number | null)[] }
export interface SqlDriver {
  all<T>(statement: Statement): Promise<T[]>;
  run(statement: Statement): Promise<void>;
}
