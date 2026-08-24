# Rialo Migration Path

UptimeSure was first prototyped directly with Rialo Venus + REX. The repository retains that work because it maps cleanly to the market-ready V1 architecture.

| V1 today | Rialo-native later |
| --- | --- |
| Supabase Cron | Rialo Workflow scheduling |
| Supabase Edge Function HTTPS probe | REX / Rialo external-data execution |
| Edge Function evidence evaluation | REX deterministic execution |
| Base Sepolia contract state | Venus state or retained EVM settlement through interoperability |
| monitor transaction | protocol-native reactive continuation |
| Supabase read model | optional indexing/read layer |
| Vercel product UI | same product UI |

## What the existing Rialo prototype proved

The previous implementation compiled the Venus program, built PolkaVM/REX artifacts and successfully deployed a Venus program plus REX components to Rialo DevNet. Root transactions for guarantee creation and manual check submission were accepted. The unresolved point was reliable child workflow/REX callback execution: lineage remained at one node during the validation window.

That limitation is why V1 does not depend on Rialo availability. The product is built now; Rialo can later collapse the scheduler and external-data infrastructure when that execution path is dependable.

The original Rialo source remains under `program/` and its original prototype UI under `web/` until the product branch is fully verified. They are not used by the V1 Vercel build.
