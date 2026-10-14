# Extensions — Improvement List

Audit of `~/.pi/agent/extensions` (2025-08-26). Findings ranked biggest first. Nothing applied yet.

## Deletable / dead

1. **delete:** `qwenThinkingIsValid()` in `sync-models.ts` (plus its `readModelsConfig`/`ModelsConfig` scaffolding, ~60 lines) can never fail — `make_entry()` in the Python script *unconditionally* writes `thinkingLevelMap`, `compat.thinkingFormat`, and `preserve_thinking` for every qwen3.8-27b id on each sync, and the write is atomic. It's re-checking an invariant the script itself guarantees. [sync-models.ts:40-56]
2. **delete:** `/docs-rm` duplicates `/docs rm` — same picker, same filter logic copied into a non-interactive branch (~45 lines). Keep one; if you need print-mode support, keep only that branch. Header comment even lists both. [docs-rag.ts:760-810]
3. **delete:** named exports in `docs-rag.ts` ("for testing") — there are no tests anywhere in the repo. Either write the one small test or drop the export block. [docs-rag.ts:495-504]
4. **yagni:** `/model-prompt mode <append|replace>` subcommand — `set` and `replace` already set the mode; a third way to flip it is unused flexibility. [model-prompt.ts:137-148]

## Broken / misleading config

5. **bug:** `DOCS_RAG_MAX_CHUNKS_PER_DOC` is a dead knob — `searchIndex()` hardcodes "max 2 chunks per doc" *before* `buildInjection` applies the env limit, so setting it above 2 does nothing. Either pass the limit through or delete the env var and its header docs. [docs-rag.ts:318, 395]
6. **bug:** `/sync-models` exec timeout is 30s, but the script makes 1 request per GGUF repo for variants (15s timeout each) plus the models call — with several multi-quant models this routinely exceeds 30s and kills a sync that would have succeeded. Bump to ~120s. [sync-models.ts:124]
7. **security:** API key is passed as a CLI arg (`--api-key sk-...`), visible in `ps` output for the duration of the run. Pass via env instead — one line in the `pi.exec` options. [sync-models.ts:105, 124]
8. **bug (edge):** index cache freshness compares `INDEX_PATH.mtime` to the top-level `DOCS_DIR.mtime` — files added to a *subdirectory* don't bump the parent's mtime, so a new session can serve a stale index. `/learn` force-rebuilds so you only hit this via external edits; comparing against the newest file mtime (or just rebuilding when doc count mismatches) fixes it. [docs-rag.ts:520-531]

## Duplicated code

9. **shrink:** atomic JSON store (`loadStore`/`saveStore` with tmp+rename+unlink) is copy-pasted between `model-prompt.ts` and `effort.ts`, and a third time in Python (`write_json_atomically`). The two TS copies could share a ~20-line helper; the `AGENT_DIR` resolution block (3 lines + imports) is triplicated across docs-rag/effort/model-prompt. Borderline — three copies of 25 lines is where I'd finally extract.
10. **shrink:** port-range validation exists in both `sync-models.ts` and `configure_provider()` in the .py. The TS path always supplies a validated port, so the py check only serves standalone use — fine to keep one, just know it's double.

## Minor / style

11. `pi` param is passed but never used in `requestContext`, `fetchInferenceStatus`, and `applyReasoningBudget` — drop it from the signatures. [effort.ts:148-170]
12. `idle-guard.ts` uses 4-space indent; every other file uses tabs.
13. `idle-guard` retry path: `pi.sendUserMessage(originalPrompt)` after `ctx.abort()` — if the user typed a *new* prompt during the hang, you get their new prompt followed by a ghost resend of the old one. Worth a comment at minimum acknowledging the race. [idle-guard.ts:96-100]
14. `pi-bell.ts`: flag is `type: "string"` holding a number; and if `agent_end` ever fires without a prior `agent_start`, `agentStartedAt = 0` → elapsed is huge → bell rings on the first turn. Guard with `if (!agentStartedAt) return`.
15. `terminal-title-status.ts`: shutdown restores `basename(cwd)` but the running base title is `pi - <session|cwd>` — inconsistent restore, and it clobbers the session name.
16. `gpu-status.ts`: default dashboard URL hardcodes `192.168.1.10:8181` (env override exists, so fine for personal use — just noting it'll silently show nothing on any other machine).
17. Repo hygiene: no `.gitignore`, and `__pycache__/sync-models.cpython-313.pyc` is sitting in the tree (currently untracked, one `git add -A` away from being committed).

## Net

- ~150 lines deletable without behavior loss (#1, #2, #3, #4)
- 3 real bugs worth fixing: dead env knob (#5), sync timeout (#6), key in argv (#7)
- No deps to cut — everything is stdlib already. Lean overall; each extension does one thing.
