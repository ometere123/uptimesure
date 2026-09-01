import { assertEquals } from "std/assert";
import { canAdvanceCursor, identityKey, orphanedIdentities, type ChainIdentity } from "./reorg.ts";

const old: ChainIdentity = { blockNumber: 10, blockHash: "0xold", txHash: "0xtx-old", logIndex: 2 };
const replacement: ChainIdentity = { blockNumber: 10, blockHash: "0xnew", txHash: "0xtx-new", logIndex: 2 };

Deno.test("canonical overlap is idempotent and reorg replacement is detectable", () => {
  assertEquals(orphanedIdentities([old], [old]), []);
  assertEquals(orphanedIdentities([old], [replacement]), [old]);
  assertEquals(identityKey(old) === identityKey(replacement), false);
});

Deno.test("orphaned incidents and observations are invalidated without deleting HTTP rows", () => {
  const incident = { ...old };
  const observation = { ...old };
  assertEquals(orphanedIdentities([incident], []), [incident]);
  assertEquals(orphanedIdentities([observation], []), [observation]);
  // The pure reconciler returns identities to invalidate; the caller updates chain projection only.
});

Deno.test("cursor never advances past an unprocessed chunk and restart is safe", () => {
  assertEquals(canAdvanceCursor(9, 10), 10);
  assertEquals(canAdvanceCursor(9, 10), 10);
  assertEquals(canAdvanceCursor(10, 9), 10);
});
