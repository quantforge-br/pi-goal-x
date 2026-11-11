import test from "node:test";
import assert from "node:assert/strict";
import { LiveTailRetention } from "../extensions/goal-live-retention.ts";
import { createGoal, type GoalRecord, type GoalTask } from "../extensions/goal-record.ts";
import { goalPromptParts } from "../extensions/prompts/goal-prompts.ts";

// #108 follow-up: task progress used to live in the policy block, so every
// task start/complete/skip reset retention and broke the prompt-cache prefix.

const msg = (role: string, content: string, timestamp: number): any => ({ role, content, timestamp });
const contents = (messages: any[]): string[] => messages.map(message => message.content);

function taskGoal(blockCompletion: boolean): GoalRecord {
	const goal = createGoal({ objective: "Ship three verified tasks", autoContinue: true, sisyphus: false }, 0);
	goal.id = "task-snapshot-retention";
	const tasks: GoalTask[] = [1, 2, 3].map(i => ({ id: `t${i}`, title: `Task ${i}`, status: "pending", verificationContract: `check ${i}` }));
	return { ...goal, taskList: { tasks, blockCompletion, proposedAt: "1970-01-01T00:00:00Z" } };
}

function setTask(goal: GoalRecord, id: string, change: Partial<GoalTask>): GoalRecord {
	return { ...goal, taskList: { ...goal.taskList!, tasks: goal.taskList!.tasks.map(task => task.id === id ? { ...task, ...change } : task) } };
}

const transitions: Array<[string, (goal: GoalRecord) => GoalRecord, RegExp]> = [
	["start t1", goal => ({ ...goal, currentTaskId: "t1" }), /Current: t1/],
	["switch current task", goal => ({ ...goal, currentTaskId: "t2" }), /Current: t2/],
	["complete t2", goal => ({ ...setTask(goal, "t2", { status: "complete", evidence: "verified" }), currentTaskId: undefined }), /1\/3 tasks complete/],
	["start t1 again", goal => ({ ...goal, currentTaskId: "t1" }), /Current: t1/],
	["skip t3", goal => setTask(goal, "t3", { status: "skipped", skipReason: "user excluded" }), /\(1 skipped\)/],
	["complete t1", goal => ({ ...setTask(goal, "t1", { status: "complete", evidence: "verified" }), currentTaskId: undefined }), /2\/3 tasks complete/],
];

for (const blockCompletion of [true, false]) test(`task transitions keep request N a prefix of N+1 (blockCompletion=${blockCompletion})`, () => {
	const retention = new LiveTailRetention();
	let goal = taskGoal(blockCompletion);
	const history = [msg("user", "Begin", 1)];
	const initial = goalPromptParts(goal);
	let previous = retention.apply("s", history, initial).messages;
	for (const [n, [name, change, expected]] of transitions.entries()) {
		goal = change(goal);
		history.push(msg("assistant", `Work ${n}`, n + 2), msg("user", "Continue", n + 2));
		const parts = goalPromptParts(goal);
		assert.equal(parts.state, initial.state, `${name}: task progress changed the policy block`);
		assert.match(parts.tasks!, expected);
		const next = retention.apply("s", history, parts).messages;
		assert.deepEqual(next.slice(0, previous.length), previous, `${name}: request N is not a prefix of N+1`);
		assert.equal(contents(next).at(-1), parts.tasks, `${name}: the latest task snapshot must be the newest tail`);
		previous = next;
	}
	assert.equal(contents(previous).filter(content => content === initial.state).length, 1, "policy sent once");
});

test("a task policy change still resets retention", () => {
	const retention = new LiveTailRetention();
	const history = [msg("user", "Begin", 1)];
	const before = retention.apply("s", history, goalPromptParts(taskGoal(false))).messages;
	history.push(msg("assistant", "Work", 2));
	const parts = goalPromptParts(taskGoal(true));
	assert.match(parts.state, /TASK GATE: do not request completion while the latest \[TASK LIST\] snapshot/);
	const after = retention.apply("s", history, parts).messages;
	assert.notDeepEqual(after.slice(0, before.length), before);
	assert.deepEqual(contents(after).slice(-3), [parts.state, parts.tasks, parts.counters]);
});

const policyChanges: Array<[string, (goal: GoalRecord) => GoalRecord, Parameters<typeof goalPromptParts>[1]?]> = [
	["status", goal => ({ ...goal, status: "paused" })],
	["objective", goal => ({ ...goal, objective: "Ship four verified tasks" })],
	["goal contract", goal => ({ ...goal, verificationContract: "npm test passes" })],
	["mode", goal => ({ ...goal, sisyphus: true })],
	["settings", goal => goal, { strictExecutionContract: true }],
];

for (const [name, change, settings] of policyChanges) test(`policy change (${name}) resets retention while tasks are in progress`, () => {
	const retention = new LiveTailRetention();
	const goal = { ...taskGoal(true), currentTaskId: "t1" };
	const history = [msg("user", "Begin", 1)];
	const before = goalPromptParts(goal);
	const first = retention.apply("s", history, before).messages;
	history.push(msg("assistant", "Work", 2));
	const parts = goalPromptParts(change(goal), settings);
	assert.notEqual(parts.state, before.state, `${name}: policy unchanged`);
	const next = retention.apply("s", history, parts).messages;
	assert.notDeepEqual(next.slice(0, first.length), first, `${name}: stale policy retained`);
	assert.equal(contents(next).includes(before.state), false, `${name}: old policy replayed`);
	assert.deepEqual(contents(next).slice(-3), [parts.state, parts.tasks, parts.counters]);
});
