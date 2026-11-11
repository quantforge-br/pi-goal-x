import { createHash } from "node:crypto";
import { asRecord } from "./goal-record.ts";

/**
 * Prefix-stable retention for request-only goal-state tails.
 *
 * The context hook appends live goal state to every provider request without
 * persisting it. When the next request arrives, the completed assistant turn
 * occupies the position where the previous tail sat, so request N is no
 * longer a prefix of request N+1 and implicit prompt caches (OpenAI Responses
 * / Chat Completions, which carry no explicit marker) freeze at the first
 * injection point.
 *
 * This module makes each request a true prefix of the next: previously sent
 * tails are re-inserted verbatim at their recorded anchor (the session length
 * when they were emitted), the whole preceding history is verified unchanged
 * by digest, and only genuinely new tail content is appended. Identical
 * content across repeated requests appends nothing, so tool loops and idle
 * re-requests cost zero growth. A stable-state change, any history rewrite
 * (compaction, resume, session-tree moves, filter changes, middle-message
 * edits), an unsafe insertion point, or overflow all perform one documented
 * full reset instead of silently shifting the prefix or corrupting message
 * structure.
 *
 * Task snapshots and usage counters are separate tail kinds. Each is appended
 * only when it differs from its previous emission, so task progress extends
 * the prefix instead of resetting it; only the policy block forces a reset.
 */

export const LIVE_CONTEXT_TYPE = "pi-goal-live-context";

export type LiveTailKind = "goal-state" | "goal-tasks" | "goal-counters";

/** A request-only tail message. Never persisted; the hook replays it per request. */
export interface LiveMessage {
	role: "custom";
	customType: typeof LIVE_CONTEXT_TYPE;
	content: string;
	display: false;
	timestamp: 0;
}

/**
 * Upper bound on retained tails per session. Retained tails are small (the
 * per-turn volatile counters), so the steady-state wire overhead stays near
 * a few kilobytes; exceeding the bound performs a single full reset, i.e. at
 * most one prefix break per MAX_RETAINED_LIVE_TAILS state changes.
 */
export const MAX_RETAINED_LIVE_TAILS = 32;

/** Upper bound on concurrently tracked sessions (parent plus isolated runs). */
export const MAX_TRACKED_SESSIONS = 16;
/** Extra historical observations, excluding the single current policy block. */
export const MAX_RETAINED_COUNTER_BYTES = 4096;
/**
 * Retained task snapshots. Each task transition appends one snapshot, so a
 * long task run stays prefix-stable until this bound forces a single reset.
 */
export const MAX_RETAINED_TASK_BYTES = 16_384;

export interface FreshLiveTails {
	state: string;
	tasks?: string | undefined;
	counters?: string | undefined;
}

interface LiveBlock {
	content: string;
	kind: LiveTailKind;
}

interface RetainedTail extends LiveBlock {
	anchorIndex: number;
	anchorFingerprint: string | null;
}

interface SessionRetention {
	tails: RetainedTail[];
	lastFresh: FreshLiveTails | undefined;
	/** Digest of every base message at the last apply; any earlier rewrite resets. */
	baseFingerprints: Array<string | null>;
}

function freshBlocks(fresh: FreshLiveTails): LiveBlock[] {
	const blocks: LiveBlock[] = [{ content: fresh.state, kind: "goal-state" }];
	if (fresh.tasks) blocks.push({ content: fresh.tasks, kind: "goal-tasks" });
	if (fresh.counters !== undefined) blocks.push({ content: fresh.counters, kind: "goal-counters" });
	return blocks;
}

function kindBytes(blocks: readonly LiveBlock[], kind: LiveTailKind): number {
	return blocks.reduce((n, block) => block.kind === kind ? n + Buffer.byteLength(block.content) : n, 0);
}

/** Full-message digest, or null (never a match) when serialization fails. */
function fingerprintMessage(message: unknown): string | null {
	try {
		const serialized = JSON.stringify(message) ?? "undefined";
		return createHash("sha256").update(serialized).digest("base64");
	} catch {
		return null;
	}
}

/**
 * Tool results must stay adjacent to the call they answer, so a retained tail
 * may never be inserted directly before one. Covers the Pi session role
 * (`toolResult`), the provider wire role (`tool`, as seen by marker
 * relocation), and result-bearing content blocks in either vocabulary — the
 * call side needs no guard since inserting before a call keeps the pair
 * adjacent.
 */
function splitsToolBatch(next: unknown): boolean {
	const record = asRecord(next);
	const role = record?.role;
	if (role === "toolResult" || role === "tool") return true;
	const content = record?.content;
	if (Array.isArray(content)) {
		for (const block of content) {
			const entry = asRecord(block);
			if (!entry) continue;
			const type = typeof entry.type === "string" ? entry.type : "";
			if (type === "tool_result" || type === "toolResult") return true;
			if ("toolCallId" in entry || "toolUseId" in entry) return true;
		}
	}
	return false;
}

function makeLiveMessage(content: string): LiveMessage {
	return {
		role: "custom",
		customType: LIVE_CONTEXT_TYPE,
		content,
		display: false,
		timestamp: 0,
	};
}

export class LiveTailRetention {
	private readonly sessions = new Map<string, SessionRetention>();

	apply<T>(sessionKey: string, base: readonly T[], fresh: FreshLiveTails | null): { messages: Array<T | LiveMessage>; transientContents: string[] } {
		if (fresh === null) {
			this.sessions.delete(sessionKey);
			return { messages: [...base], transientContents: [] };
		}
		// Hash each message once per request. Extensions may reuse and mutate
		// message objects, so object identity cannot cache a digest across requests.
		const fingerprints = base.map(fingerprintMessage);
		let session = this.sessions.get(sessionKey);
		if (!session) {
			session = { tails: [], lastFresh: undefined, baseFingerprints: [] };
			if (this.sessions.size >= MAX_TRACKED_SESSIONS) {
				const oldest = this.sessions.keys().next();
				if (!oldest.done) this.sessions.delete(oldest.value);
			}
			this.sessions.set(sessionKey, session);
		}
		const reset = () => {
			session!.tails = [];
			session!.lastFresh = undefined;
			session!.baseFingerprints = [];
		};
		// A changed state block supersedes every previously sent tail: start
		// fresh rather than leave a stale objective or a cancelled scheduling
		// instruction lingering mid-history. A dropped task snapshot or counter
		// block resets too, so its last copy never reads as the current one.
		if (session.lastFresh !== undefined && (session.lastFresh.state !== fresh.state
			|| (session.lastFresh.tasks !== undefined && !fresh.tasks)
			|| (session.lastFresh.counters !== undefined && fresh.counters === undefined))) reset();
		// Tails anchored while history was empty would linger at the head once
		// real history arrives. Reset once so fresh tails anchor at the tail.
		if (session.tails.length > 0 && session.baseFingerprints.length === 0 && base.length > 0) reset();
		// Any rewrite earlier than the anchors — middle-message edits, filter
		// changes, checkpoint normalization — breaks the prefix even when the
		// trailing message is identical, so verify the whole preceding history.
		if (session.baseFingerprints.length > base.length) reset();
		else {
			for (let i = 0; i < session.baseFingerprints.length; i++) {
				const current = fingerprints[i];
				if (current === null || current !== session.baseFingerprints[i]) {
					reset();
					break;
				}
			}
		}
		// An unsafe anchor invalidates the whole replay. Keeping an earlier
		// policy while re-appending fresh blocks would duplicate that policy.
		let valid = 0;
		while (valid < session.tails.length) {
			const tail = session.tails[valid]!;
			if (tail.anchorIndex > base.length) break;
			if (tail.anchorIndex > 0) {
				const current = fingerprints[tail.anchorIndex - 1];
				if (current === null || current !== tail.anchorFingerprint) break;
			}
			if (splitsToolBatch(base[tail.anchorIndex])) break;
			valid++;
		}
		if (valid < session.tails.length) reset();
		const blocks = freshBlocks(fresh);
		// Append only blocks that differ from the last emitted block of the same
		// kind, so unchanged content across repeats, tool loops, and history
		// advances adds zero blocks while keeping the prefix literal. The state
		// block never differs here: a changed state already reset above.
		const previous = session.lastFresh === undefined ? [] : freshBlocks(session.lastFresh);
		let appended = blocks.filter(block => !previous.some(prior => prior.kind === block.kind && prior.content === block.content));
		// Overflow is measured against what this request actually appends: an
		// unchanged request adds nothing and must never trigger a reset.
		if (session.tails.length + appended.length > MAX_RETAINED_LIVE_TAILS
			|| kindBytes(session.tails, "goal-counters") + kindBytes(appended, "goal-counters") > MAX_RETAINED_COUNTER_BYTES
			|| kindBytes(session.tails, "goal-tasks") + kindBytes(appended, "goal-tasks") > MAX_RETAINED_TASK_BYTES) {
			reset();
			appended = blocks;
		}
		const messages: Array<T | LiveMessage> = [...base];
		for (let i = session.tails.length - 1; i >= 0; i--) {
			const tail = session.tails[i]!;
			messages.splice(tail.anchorIndex, 0, makeLiveMessage(tail.content));
		}
		for (const block of appended) {
			messages.push(makeLiveMessage(block.content));
			session.tails.push({ anchorIndex: base.length, anchorFingerprint: fingerprints.at(-1) ?? null, content: block.content, kind: block.kind });
		}
		session.baseFingerprints = fingerprints;
		session.lastFresh = { state: fresh.state, tasks: fresh.tasks || undefined, counters: fresh.counters };
		return { messages, transientContents: [...new Set([...session.tails.map(tail => tail.content), ...blocks.map(block => block.content)])] };
	}

	contents(sessionKey: string): string[] | undefined {
		return this.sessions.get(sessionKey)?.tails.map(tail => tail.content);
	}

	clear(sessionKey?: string): void {
		if (sessionKey === undefined) this.sessions.clear();
		else this.sessions.delete(sessionKey);
	}
}
