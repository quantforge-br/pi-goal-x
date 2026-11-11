import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error Shared JavaScript experiment entry point.
import { summarize, compareReports, investigateCache } from "../experiments/context/cache-compare.mjs";

const report = () => ({version: 1, rows: [{id: "fixture", ...summarize({messages: [{role: "system", content: "policy"}, {role: "user", content: "history"}], tools: [{name: "read", parameters: {type: "object"}}], prompt_cache_key: "fixed"})}]});

test("cache comparison rejects missing scenarios, early text, schemas, options, markers and duplicate blocks", () => {
 const baseline = report();
 assert.equal(compareReports(baseline, structuredClone(baseline)).scenarios, 1);
 const variants = [
  (r: any) => { r.rows = []; },
  (r: any) => { r.rows[0].blocks[0].hash = "edited"; },
  (r: any) => { r.rows[0].immutable = "reordered or changed tools"; },
  (r: any) => { r.rows[0].options = "rotating identity"; },
  (r: any) => { r.rows[0].markers = [{path: ["messages", "0"], value: {type: "ephemeral"}}]; },
  (r: any) => { r.rows[0].blocks.push(r.rows[0].blocks[1]); },
 ];
 for (const mutate of variants) {
  const candidate = structuredClone(baseline);
  mutate(candidate);
  assert.throws(() => compareReports(baseline, candidate));
 }
 assert.throws(() => summarize({messages: [{role: "user", content: [{type: "text", text: "live", cache_control: {type: "ephemeral"}}]}]}, ["live"]), /marker on a transient/);
});

test("state-change measurement fixes #108 and rejects extra or unexplained resets", () => {
 const investigation = investigateCache();
 // #108: only the policy change (task setup enables the completion gate)
 // resets; the three task completions append snapshots instead.
 assert.deepEqual(investigation.stateChanges.filter((step: any) => step.prefixBreak).map((step: any) => step.kind), ["set-tasks"]);
 const release = structuredClone(investigation);
 for (const step of release.stateChanges) if (step.kind.startsWith("complete-")) step.prefixBreak = true;
 assert.equal(compareReports({...report(), investigation: release}, {...report(), investigation}).scenarios, 1);
 assert.equal(investigation.occupancy[1].appendedCounters, 0);
 assert.equal(investigation.occupancy[1].breaks, 0);
 assert.ok(investigation.occupancy[1].totalRequestBytes < investigation.occupancy[0].totalRequestBytes);
 const baseline = {...report(), investigation, corpus: {transitions: 1000, breaks: 32}};
 for (const mutate of [
  (r: any) => {r.investigation.stateChanges[0].kind = "unknown-reset";},
  (r: any) => {r.investigation.stateChanges[0].prefixBreak = true;},
  (r: any) => {r.investigation.stateChanges[1].prefixBreak = false;},
  (r: any) => {r.investigation.stateChanges[3].prefixBreak = true;},
  (r: any) => {r.investigation.occupancy[1].breaks = 1;},
  (r: any) => {r.investigation.occupancy[1].appendedCounters = 1;},
  (r: any) => {r.corpus.breaks++;},
 ]) {
  const candidate = structuredClone(baseline); mutate(candidate);
  assert.throws(() => compareReports(baseline, candidate));
 }
});

test("approved display removal must be exact and confined to a goal counter block", () => {
 const baseline = {version: 1, rows: [{id: "counter", ...summarize({messages: [{role: "user", content: "Goal snapshot: 12 tokens\nContext snapshot: unavailable\nAutonomous runs: 1/3"}]})}]};
 const candidate = {version: 1, rows: [{id: "counter", ...summarize({messages: [{role: "user", content: "Goal snapshot: 12 tokens\nAutonomous runs: 1/3"}]})}]};
 assert.equal(compareReports(baseline, candidate).approvedDifferences.length, 1);
 candidate.rows[0] = {id: "counter", ...summarize({messages: [{role: "user", content: "Goal snapshot: 12 tokens\nAutonomous runs: 1/3 extra instruction"}]})};
 assert.throws(() => compareReports(baseline, candidate), /unexpected counter edit/);
});

test("cache gate rejects serialized early-content changes and removed or relocated markers", () => {
 const payload = {system: "host policy", messages: [{role: "user", content: [{type: "text", text: "stable history", cache_control: {type: "ephemeral"}}, {type: "text", text: "more history"}]}], tools: [{name: "read", parameters: {type: "object", properties: {}}}]};
 const wrap = (value: typeof payload) => ({version: 1, rows: [{id: "wire", ...summarize(value)}]});
 const baseline = wrap(payload);
 for (const mutate of [
  (p: any) => {p.system = "changed host policy";},
  (p: any) => {p.messages[0].content[0].text = "changed early history";},
  (p: any) => {p.tools[0].parameters.properties.path = {type: "string"};},
  (p: any) => {delete p.messages[0].content[0].cache_control;},
  (p: any) => {p.messages[0].content[1].cache_control = p.messages[0].content[0].cache_control; delete p.messages[0].content[0].cache_control;},
 ]) {
  const candidate = structuredClone(payload); mutate(candidate);
  assert.throws(() => compareReports(baseline, wrap(candidate)));
 }
});

test("fixed goal profile is approved only inside tools and rules sections", () => {
 const hostSystem = "base\n\n<tools>\n- read: Read files\n</tools>\n\n<rules>\n- Host rule\n</rules>\n";
 const shape = (extra: string[]) => {
  const profile = extra.length ? `\n${extra.map((name) => `- ${name}: extra`).join("\n")}` : "";
  const rules = extra.length ? `\n${extra.map((name) => `- extra rule for ${name}`).join("\n")}` : "";
  const system = `base\n\n<tools>\n- read: Read files${profile}\n</tools>\n\n<rules>\n- Host rule${rules}\n</rules>\n`;
  return {version: 1, rows: [{id: "fixed", ...summarize({system, messages: [{role: "system", content: system}, {role: "user", content: "history"}], tools: [{name: "read", parameters: {type: "object"}}]}, [], {hostSystem})}]};
 };
 const baseline = shape(["goal_question"]);
 const candidate = shape(["goal_question", "propose_goal_draft"]);
 const approved = compareReports(baseline, candidate, {hostSystem});
 assert.equal(approved.approvedDifferences.filter((item: {reason?: string}) => item.reason === "fixed-goal-tool-profile").length, 1);
 const changed = structuredClone(baseline);
 changed.rows[0].blocks[0].raw.content = "changed outside the profile sections";
 changed.rows[0].blocks[0].hash = "different";
 assert.throws(() => compareReports(baseline, changed, {hostSystem}));
});

test("task-enabled scenarios must share one immutable prefix", () => {
 const row = (id: string, system: string) => ({id, ...summarize({system, messages: [{role: "user", content: "history"}], tools: [{name: "read", parameters: {type: "object"}}]})});
 const active = row("openai/none/active", "policy");
 const drafting = row("openai/none/guided-proposal", "policy");
 const baseline = {version: 1, rows: [active, drafting]};
 assert.equal(compareReports(baseline, structuredClone(baseline)).scenarios, 2);
 const drifted = structuredClone(baseline);
 drifted.rows[1].immutable = "state-dependent prefix";
 assert.throws(() => compareReports(baseline, drifted), /immutable prefix varies across lifecycle states/);
});
