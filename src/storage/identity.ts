import { nip19 } from 'nostr-tools';
import { ATPROTO_DID_RE, ATPROTO_HANDLE_RE } from '../config.ts';
export function normalizeIdentity(input: string, nostrOnly = false): string {
  const value = input.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase();
  if (value.startsWith('npub1')) {
    try { const decoded = nip19.decode(value); if (decoded.type === 'npub') return decoded.data; } catch { /* invalid */ }
  }
  if (!nostrOnly && ATPROTO_DID_RE.test(value)) return value;
  if (!nostrOnly && ATPROTO_HANDLE_RE.test(value)) return value.toLowerCase();
  throw new Error(nostrOnly ? 'Enter a Nostr PUBLIC key (npub or 64-character hex), never nsec.' : 'Invalid public key, DID, or handle.');
}
