# Implementation

Move goal prompt rendering from before_agent_start into a request-only context tail shared by normal and custom-message runs. Keep before_agent_start preflight/accounting/scheduler behavior and stale-dispatch aborts. Render current lifecycle state on every context event; consume one-shot reminders there. Never modify the host system prompt.

Normalize every checkpoint independently to its bounded v2 trigger at its existing index; do not delete earlier markers or derive historical metadata from live state. Pi's real compaction can retire old history. Display-only audit filtering remains deterministic. Existing fixed execution tool profiles stay idempotent; explicit drafting/settings changes are legitimate schema boundaries.

Test prefix equality across consecutive serialized requests, current state freshness, lifecycle safety, and real SDK provider conversion/cache controls. Audit child session prompt ordering and provider defaults. Run typecheck, lint, all tests and context checks, updating obsolete checkpoint/context expectations.

Explicit caches need a reusable write point, not just a stable prefix. Add a narrow before_provider_request transform that relocates Pi's existing final live-state breakpoint onto the preceding history block for Anthropic cache_control and Bedrock cachePoint payloads. Preserve TTL, do not increase the breakpoint count, and leave implicit caches / caching disabled untouched. This avoids writing only a unique ephemeral suffix on each call.

## 2026-09-21 addendum: implicit advancing-history retention

The "leave implicit caches untouched" line above covered explicit markers only, and it stays true: implicit payloads gain no marker. What it missed is the message sequence itself: the request-only tail disappeared exactly where the next completed assistant turn appeared, so request N was never a prefix of request N+1 and implicit caches froze at the first injection point (live evidence: cache reads pinned at 28,160 tokens while uncached input grew past 62,000).

The fix retains previously sent tails verbatim at their anchors (extensions/goal-live-retention.ts) and splits the live state into a stable policy tail and a volatile counters tail, so each request literally extends the previous one with bounded growth. The marker-relocation design above is unchanged in scope but now skips every transient tail, current and retained. The advancing-history SDK regression (tests/prompt-cache-sdk-worker.ts) fails on the pre-fix sequence and passes with retention.

## 2026-11-04: issue #126 fixed tool surface

Replace status-dependent applicableGoalTools with a tasksEnabled-only profile: three core tools plus three drafting tools, or all five execution tools plus three drafting tools. Reuse the idempotent installer for draft start/clear/rehydration. Remove the separate drafting installer and focus-driven profile synchronization. Preserve host selection and avoid setActiveTools when membership is unchanged.

Add a tool_call guard for the five execution tools while hasActiveDraft is true, before work tracking. Existing drafting executors still reject calls without an active draft; lifecycle/task executors remain authoritative for invalid states. Keep per-turn settings reconciliation independent of draft state.

Update profile expectations and add regressions for stable ordered declarations, pause/resume, focus changes, task-list changes, draft confirm/cancel/rehydration, disabled tasks, and runtime guards. Run targeted tests, typecheck, then the full unit/integration suites. Live provider cache-hit rates remain unverified without a patched runtime trial.

## 2026-11-11: request-only live tail under explicit markers

The context hook runs before the payload exists, so it cannot see whether the provider uses explicit markers. The before_provider_request hook can: cacheGoalHistory returns the payload only when it moved a marker off the live tail. That return value is the detection signal, so it covers every adapter that emits cache_control or cachePoint without a provider list.

On the first relocation LiveTailRetention.noteExplicitMarker flags the session/model identity. The blocks appended by that same request are anchored at the end of its history, behind the breakpoint that was just moved ahead of every live block, so no cached prefix contains them; they are dropped from the replay set and remembered as the request-only tail. Later applies retain nothing: every fresh block is pushed at the tail on every request, changed or not, because no earlier copy survives to stand in for it. With nothing retained there is nothing to remove, so no bound, policy change or dropped block can break the prefix. contents() includes the request-only tail so relocation keeps skipping it; a breakpoint left on a live block would miss on every request.

Retaining only the policy was rejected. Without the periodic counter resets the policy keeps its first anchor, so one pause removes a block near the start of the session and the provider re-writes everything after it, twice per pause/resume. Wire-level context compression can also fold an early retained policy into a summary, leaving the model without it until the next reset.

Tails retained before the flag is set stay at their anchors until the next reset: removing them is itself a prefix break. A block still current at such an anchor is not repeated at the tail. The flag survives resets and is forgotten when the session entry is cleared or evicted; the next request relearns it.
