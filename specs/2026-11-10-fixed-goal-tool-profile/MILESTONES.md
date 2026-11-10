# Implementation log

## 2026-11-10 — fixed goal tool profile (upstream #127)

- Cherry-picked tmonk/pi-goal-x#127 onto `b0fc15e` (0.34.1) as `4499e77`. `applicableGoalTools(tasksEnabled)`
  now returns the five execution tools plus the three drafting tools (or the
  three core tools plus drafting when `disableTasks`), independent of goal
  status, focus and draft state. Registration order on the real SDK is
  `get_goal`, `create_goal`, `update_goal`, `set_goal_tasks`,
  `update_goal_task`, `goal_question`, `goal_questionnaire`,
  `propose_goal_draft`; the profile is only reordered when `disableTasks`
  removes the task tools.
- Added the same-turn guard: after `propose_goal_draft` confirms or cancels a
  draft, the five execution goal tools are blocked for the rest of that turn
  ("The goal draft was resolved earlier in this turn..."). Tests:
  `tests/goal-drafting.test.ts` ("a proposal that cancels the draft blocks goal
  tools for the rest of the turn", "a proposal that confirms the draft blocks
  further goal tools for the rest of the turn"). Because the fixed profile now
  always advertises the task tools, `tests/goal-tool-visibility.test.ts` also
  requires their executors to reject inapplicable lifecycle states without
  mutating the goal. Tool declarations and prompts are unchanged by this guard.
- Harnesses previously inferred the drafting phase from
  `tools.includes("propose_goal_draft")`, which is now always true. They now
  look for the latest `[GOAL CONFIRMATION focus=...]` / `[GOAL TWEAK DRAFT]`
  user prompt and check whether a later assistant `propose_goal_draft` call
  exists, with the refinement/cancel tool result keeping drafting active:
  - `scripts/live-session-check.mjs`
  - `experiments/continuation/terminal.mjs` (drives the controls walkthroughs)
  - `experiments/continuation/efficiency.mjs`
  - `experiments/context/capture-context.mjs` now starts its mock with host
    tools plus extension tools, mirroring the real SDK's activation at
    registration so the captured system prompt and tool order match the live
    session.
- `experiments/context/run-gate.mjs` replaced the "drafting requests advertise
  exactly three tools" assertion with the fixed-profile invariant: one ordered
  declaration list for all task-enabled fixtures (drafting and execution
  alike), the core+drafting list when tasks are disabled, drafting tools
  present in drafting requests, and no task tools under `disableTasks`.

## Context baseline refresh

Regenerated with `CONTEXT_BASELINE_LABEL=4499e77-fixed-goal-tool-profile npm run
context:measure`. Why every row changes: tool declarations moved from the
lifecycle profile into a fixed profile and the SDK system prompt now carries
the snippets and prompt guidelines of every declared goal tool.

| Class | Serialized chars | Estimated tokens | Tool schema chars | Base system chars |
| --- | --- | --- | --- | --- |
| Active goal, tasks + task list (7 fixtures) | 14,221–15,864 → 17,538–19,181 (+3,317 each) | +829 each | 4,654 → 7,200 | 3,671 → 4,442 |
| Active goal, no task list (9 fixtures) | 10,133–13,912 → 14,902–18,681 (+4,769 each) | +1,192 each | 3,653 → 7,200 | 3,220 → 4,442 |
| No/paused/blocked/complete/budget goal (5 fixtures) | 6,923–9,595 → 14,598–15,665 (+6,070–7,675 each) | +1,518–1,919 each | 1,144–2,668 → 7,200 | 2,823–2,904 → 4,442 |
| Guided drafting (2 fixtures) | 8,608/8,610 → 14,404/14,406 (+5,796 each) | +1,449 each | 2,545 → 7,200 | 3,301 → 4,442 |
| Tasks disabled | 11,006 → 14,323 (+3,317) | +829 | 2,668 → 5,214 | 2,904 → 3,675 |

Totals: serialized chars 277,596 → 395,415 (+117,819, +42.4%); estimated
tokens 69,408 → 98,863 (+29,455); extension-attributable chars 162,355 →
280,174; child-request chars unchanged at 15,228. The extra declarations ride
in every request, inside the cached prefix: drafting, execution, pause, resume,
block and completion requests now share that prefix, so no goal-state change
can invalidate it.

`context:gate` passes after the refresh (24 fixtures). `context:provider-check`
passes 6 real SDK payloads; it now also proves the captured ordered tool list
and full system prompt equal the real session's (registration-order fix).

## Cache gate

The pinned release (`fe0e38f8`) still has state-dependent goal declarations, so
`experiments/context/cache-compare.mjs` now compares a canonical host-only
projection (host tools plus the `<tools>`/`<rules>` sections of the host-only
system prompt) byte for byte and separately enforces the new invariant:

- every task-enabled scenario in a provider/tier group has exactly one
  immutable prefix, drafting and execution included;
- the `tasks-disabled` scenario differs, proving the setting still changes the
  declared profile;
- explicit cache markers remain on the same placement class (last tool, same
  system block, same history block) and values;
- only two approved delta classes exist: the existing default-off context
  display line and the fixed-profile system blocks. A fixed-profile system
  block may differ only inside the `<tools>`/`<rules>` sections; the candidate
  system block is 778–1,631 bytes larger depending on the release profile it
  replaces.

Evidence: `Cache gate PASS: 408 adapter scenarios; 276 exact approved display
deltas; 306 approved fixed-profile system blocks; 1,000 bounded transitions.`
The 306 blocks are the three message-based adapters (102 scenarios each); the
Anthropic message adapter keeps the system prompt outside message blocks and
covers the same change through `hostImmutable`.

## CLI evidence

- `node scripts/live-session-check.mjs` (Pi 1.4.0): 3 provider requests —
  drafting=`propose_goal_draft`, execution=`update_goal`, audit approved —
  goal created, completed and archived.
- `node experiments/controls/cli-walkthrough.mjs`: all 11 cases pass,
  including the `/goal` draft dialogs, refinement/cancel path and
  `/goal-direct` paused/resumed audited completion. Requests are classified by
  the conversation; `/goal-direct` no longer loops on a phantom draft.
