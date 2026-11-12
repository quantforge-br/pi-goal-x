# Prompt caching across goal execution

Issue #67 exposes mutable state ahead of conversation history. Preserve a stable provider prefix across ordinary turns, autonomous checkpoints, and tool loops. Current objective, tasks, usage, budget, lifecycle, scheduling, auditor feedback, and compaction steering must remain available at the request tail without persisting full state on every request. Keep historical checkpoints bounded and stable in position. Preserve stale-dispatch guards, tool-result pairing, and delegation isolation.

Caching remains controlled by Pi and the provider; do not override user cache settings or promise cache hits. Audit drafting, tool profiles, auditor and Oracle sessions as well as the reported hook. Validate serialized provider requests without paid API calls and document unavoidable invalidation boundaries.

## 2026-11-04: issue #126 tool-profile stability

Advertise the same goal and drafting tools with no focused goal, across lifecycle and focus changes, and while entering or leaving drafting. Only the explicit disableTasks setting may change this extension's tool selection. Preserve host tools and reject invalid operations at execution time. During an active draft, block the five ordinary goal tools so unconfirmed proposals cannot mutate goals. Keep existing draft confirmation, cancellation, rehydration, and stale-dispatch guards intact.

Scope: fix tool/rules prefix churn and validate it offline. Do not change live-tail retention without request-payload evidence. Do not modify the installed npm package as part of this repository patch.

## 2026-11-11: request-only live tail under explicit markers

Payload evidence from a 139-request Anthropic session: usage counters change on almost every request, each change retained one more tail, and the 32-tail bound forced a full retention reset about every 30 requests. Every reset removed the retained tails from mid-history and the provider re-wrote the cached conversation (four resets, 31k–89k tokens each). A pause and a resume changed the policy block and reset retention twice more (45k tokens each).

In sessions whose payloads carry an explicit cache marker, goal state must never rewrite cached history: not counter changes, not task progress, not policy changes such as pause, resume or an objective edit. Policy, task snapshot and counters are sent on every request after the relocated breakpoint and are not replayed in later requests. The accepted cost is that this tail is billed on every request (uncached input, or a cache write when the upstream adds its own trailing breakpoint) instead of being read from cache. Sessions without explicit markers keep the retained layout, because implicit caches still need each request to extend the previous one.
