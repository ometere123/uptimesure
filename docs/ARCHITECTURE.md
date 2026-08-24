# Architecture

UptimeSure is a long-running Rialo Venus workflow, not a Web2 uptime bot with an on-chain badge.

```text
Vercel frontend
      |
      | wallet / read RPC
      v
Rialo DevNet program state
      |
      +-- AFTER timer ------------------------+
      |                                       |
      v                                       v
REX / TEE HTTP probe                    workflow callback
      |                                       |
      | HTTPS response                        | repeated-failure policy
      +-------------------------------------->|
                                              |
                                      confirmed breach?
                                         /          \
                                       no            yes
                                       |              |
                                  schedule next   native RLO transfer
                                                      |
                                                      v
                                                beneficiary
```

## State machine

`ACTIVE -> UNHEALTHY -> BREACH_CONFIRMED -> BREACH_PAID` is the failure path. A later healthy observation closes the incident as `RECOVERED` and monitoring continues. Provider controls can pause, resume, run an immediate check, change the interval, retry an unpaid current incident, or shut the workflow down.

A breach requires consecutive failed observations. REX reports are reduced fail-closed: a strict majority of successful `HEALTHY` observations is required; ties, empty reports, request errors and undecodable outputs count unhealthy.

## Settlement model

The current DevNet implementation settles in native RLO from the workflow payer. This is provider-funded automatic compensation, not a stablecoin escrow and not an insurance policy. The program caps payout count and amount per incident, prevents a second successful payout for the same open incident, and records failed transfer attempts without killing monitoring.

A production version can replace this settlement adapter with a separately audited escrow or stablecoin rail. That future component is intentionally not faked in this repository.

## No backend

There is no database, cron server, keeper, custom oracle, Fly.io service, Railway instance, or Render worker. Rialo workflow state is authoritative; REX performs external HTTPS work; the static frontend can be hosted on Vercel.
