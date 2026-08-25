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

## Current compile status

`program/` compiles. This is CI-verified, not asserted: the `rialo-experimental-verify` workflow runs a real `cargo check --all-targets` on Rust 1.90.0, and [run 32797065763](https://github.com/ometere123/uptimesure/actions/runs/32797065763) finished the dev profile in 24.97s with no warnings attributable to this crate. The `rialo-*` requirements pinned at `0.10.1` resolve from crates.io to `0.10.2`.

Establishing that took fixing two real defects, both found only because the workflow started actually compiling rather than checking that files exist:

- Every `///` doc comment inside the `rialo!` macro aborted parsing. `///` desugars to a `#[doc = "..."]` attribute and the DSL grammar in `rialo-venus-dsl` 0.10.2 rejects attributes inside its blocks. All 24 were converted to `//`, which the lexer strips before the macro sees a token stream.
- The `program` block accepts `use` items but rejects `const` items, so the seven policy bounds aborted parsing the same way. They now sit at module level, with identical values.

**A compiling prototype is not a working async runtime integration.** This run proves the program type-checks against the current `rialo-*` crates. It executes nothing, reaches no network, and says nothing about whether a scheduled child callback would ever arrive. Asynchronous child workflow/REX callback lineage remains unproven, exactly as it was.

The pinned versions are also two minor releases behind — `rialo-s-program` and `rialo-venus` are at `0.18.1`. Upgrading a retained prototype is deliberately out of scope for shipping V1, so the compile evidence above is evidence about `0.10.x` only.

The original Rialo source remains under `program/` and its original prototype UI under `web/`. Neither is used by the V1 Vercel build, and neither gates it: the Rialo workflows are `workflow_dispatch`-only and the `product-verify` gate does not run them. They are kept deliberately as the migration path, not as work in progress awaiting deletion.

`docs/DEMO.md` records what a meaningful Rialo demo would have to show — lineage extending past the root node — alongside the V1 proof procedure.
