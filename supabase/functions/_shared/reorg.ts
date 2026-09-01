export interface ChainIdentity {
  blockNumber: number;
  blockHash: string | null;
  txHash: string | null;
  logIndex: number;
}

export function identityKey(identity: ChainIdentity): string {
  return `${identity.blockHash ?? `block:${identity.blockNumber}`}:${identity.txHash ?? "tx:unknown"}:${identity.logIndex}`;
}

/** Rows are invalidated, never deleted, so monitor-owned HTTP evidence remains auditable. */
export function orphanedIdentities<T extends ChainIdentity>(rows: T[], canonical: ChainIdentity[]): T[] {
  const live = new Set(canonical.map(identityKey));
  return rows.filter((row) => !live.has(identityKey(row)));
}

export function canAdvanceCursor(processedThrough: number, chunkEnd: number): number {
  return chunkEnd > processedThrough ? chunkEnd : processedThrough;
}
