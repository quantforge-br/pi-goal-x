# Fixed goal tool profile

Status: implemented

Source: [tmonk/pi-goal-x#127](https://github.com/tmonk/pi-goal-x/pull/127), cherry-picked onto `b0fc15e` (0.34.1) as `4499e77`, plus follow-up fixes

## Problem

The goal extension used to advertise a different tool set for every lifecycle
state: create/get/update plus conditional task tools while a goal was active,
the three drafting tools only while a `/goal`, `/sisyphus` or `/goal-tweak`
draft was open, and a reduced surface for paused, blocked, complete or
budget-limited goals. Tool declarations are part of the provider's cached
prompt prefix, so every draft start, confirmation, pause, resume, block and
completion changed the immutable prefix and invalidated the cache for the
whole conversation.

The drafting tools must also never be advertised only during a draft: a tool
declaration that appears or disappears with UI state is both a cache reset and
an agent-visible mode switch.

## Required behavior

- The registered goal tool profile is fixed for the whole session and changes
  only when the persistent `disableTasks` setting changes:
  - tasks enabled: `create_goal`, `get_goal`, `update_goal`, `set_goal_tasks`,
    `update_goal_task`, `goal_question`, `goal_questionnaire`,
    `propose_goal_draft`;
  - tasks disabled: the three core tools plus the three drafting tools.
- Goal status, focus changes, draft start/confirm/cancel, compaction, audit
  activity and session recovery never add, remove, reorder or otherwise
  reinstall goal tools.
- The drafting tools are always declared but reject calls without an active
  user-started draft. A `tool_call` guard blocks the five execution tools while
  a draft is active, and after a proposal confirms or cancels the draft the
  same turn cannot execute goal work.
- The extension never mutates the host's ordinary work-tool selection.
- Ordered declarations and the extension-attributable system prompt are
  identical for drafting and execution requests. This is the cache invariant
  the context and cache gates enforce.

## Measurement consequences

The committed `experiments/context/baseline-main.json` intentionally grows.
Fixtures that used to advertise a reduced goal surface (no goal, paused,
blocked, complete, budget-limited, drafting) now carry all eight goal tools
(six with `disableTasks`), and execution fixtures gain the three drafting
schemas plus their system-prompt snippets and guidelines. These declarations are
sent with every request, but they stay inside the cached prefix; a lifecycle
transition no longer forces an uncached rebuild of the whole conversation.

Legacy draft-only profiles are not preserved. Contract schemas, prompts within
an unchanged profile, checkpoint bounds and cache-marker placement classes are
unchanged. The cache gate compares the release and candidate host-only prefix
byte for byte and requires every task-enabled scenario to share one immutable
prefix.

## Acceptance

- Real Pi 1.4 lifecycle: `/goal` draft, proposal, confirmation, execution and
  isolated auditor all pass with three provider requests.
- Controls walkthroughs infer the drafting phase from the conversation and
  reach audited completion through `/goal` and `/goal-direct`.
- `context:gate`, `context:provider-check` and `context:cache-gate` pass with
  the rebuilt baselines; only the fixed-profile system blocks and the existing
  default-off context display delta differ from the pinned release.
- `npm run check` and `npm run lint` are clean.
