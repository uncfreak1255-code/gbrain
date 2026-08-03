# Search mode configuration (`search.mode`)

GBrain ships three named search modes that bundle the search-lite knobs from
PR #897 into a single config key. Pick one at install time; the rest of the
project resolves through `src/core/search/mode.ts`.

Not to be confused with `docs/guides/search-modes.md`, which covers a different
axis: which search *command* to reach for (keyword vs hybrid vs direct get).

## Knob bundles

| Knob                          | `conservative` | `balanced` | `tokenmax`     |
|-------------------------------|----------------|------------|----------------|
| `cache.enabled`               | true           | true       | true           |
| `cache.similarity_threshold`  | 0.92           | 0.92       | 0.92           |
| `cache.ttl_seconds`           | 3600           | 3600       | 3600           |
| `intentWeighting`             | true           | true       | true           |
| `tokenBudget`                 | **4000**       | **12000**  | **off**        |
| `expansion` (LLM multi-query) | false          | false      | **true**       |
| `relationalRetrieval`         | false          | **true**   | **true**       |
| `searchLimit` default         | 10             | 25         | 50             |

## Cost anchors

Downstream agent input cost — gbrain itself is rounding error. The
corner-to-corner spread is 25x once you pair mode with downstream model.
Chunks ~400 tokens avg. Per-query cost @ 10K queries/month (typical
single-user volume), full search payload, no cache savings:

| Mode \ Downstream | Haiku 4.5 (\$1/M) | Sonnet 4.6 (\$3/M) | Opus 4.7 (\$5/M) |
|---|---|---|---|
| conservative (~4K) | **\$40/mo** | \$120/mo | \$200/mo |
| balanced (~10K) | \$100/mo | \$300/mo | \$500/mo |
| tokenmax (~20K) | \$200/mo | \$600/mo | **\$1,000/mo** |

Scales linearly: multiply by 10 for 100K/mo (heavy power user / multi-user
fleet); divide by 10 for 1K/mo (light usage). Natural pairings span ~4x.
Mismatches (tokenmax+Haiku, conservative+Opus) waste capacity differently
— too-big payload overwhelms a cheap model; too-small payload starves an
expensive one.

tokenmax adds ~\$1.50 per 1K queries in Haiku expansion calls on top of
the matrix (\$15/mo @ 10K). Cache hits cut all numbers ~50%. **The cost
picker copy in `gbrain init` carries the same matrix verbatim** — update
both when refreshing.

**Per-query math vs real-world spend.** The matrix above is what an
isolated benchmark would measure. Real agent loops with disciplined
Anthropic prompt caching see 50-80% discount on top (cache hits skip
downstream entirely). The realistic-scale anchor in
`docs/eval/SEARCH_MODE_METHODOLOGY.md` walks the natural pairings at
single-power-user volume (~860 turns/mo): tokenmax+Opus ~\$700/mo,
balanced+Sonnet ~\$430/mo, conservative+Haiku ~\$170/mo. Setups WITHOUT
cache-aware prompt layout (frequent prefix churn) see the per-query
matrix dominate — mode + model choice matters more there.

## Cache-key contamination (`knobs_hash`)

Migration v56 added a `knobs_hash` column to `query_cache`. The lookup filter is
`WHERE source_id = $ AND knobs_hash = $ AND embedding similarity < $` so a
tokenmax write (expansion=on, limit=50) can't be served to a conservative read.

The hash also folds the active embedding column name + provider into the cache
key, so a query routed through `embedding_voyage` (1024d Voyage) can't be served
a cache row written against `embedding` (1536d OpenAI); and it folds the
`relationalRetrieval` knob + depth, so a relational-on result set can't be served
to a relational-off lookup (same contamination class as graph_signals).

`mode.ts:KNOBS_HASH_VERSION` is the single source of truth. Bumping it makes
existing rows unreachable on first re-query — a one-time miss spike on upgrade.

## Relational retrieval

`relationalRetrieval` (on for balanced/tokenmax) adds a fourth recall arm: a
relational query ("who invested in X", "what connects A and B") resolves its seed
entity and walks the typed-edge graph (`src/core/search/relational-recall.ts` +
`relational-intent.ts`, `engine.relationalFanout`), injecting edge-derived answers
into RRF. Within-source, deterministic, mentions-excluded by default, pure no-op
for non-relational queries. The `query` op's `relational` flag forces it on/off
per call.

## CLI surfaces

    gbrain search modes              # what is running, with per-knob attribution
    gbrain search modes --reset      # clear search.* overrides (mode bundle wins)
    gbrain search stats [--days N]   # cache hit rate, intent mix, budget drops
    gbrain search tune [--apply]     # data-driven recommendations

The install picker fires inside `gbrain init` AFTER `engine.initSchema()`
(non-TTY auto-selects). The upgrade banner fires once via `runPostUpgrade`
in `src/commands/upgrade.ts`, gated by `search.mode_upgrade_notice_shown`.
