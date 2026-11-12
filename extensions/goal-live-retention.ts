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
 *
 * Explicit-marker providers (Anthropic cache_control, Bedrock cachePoint) need
 * no retained counters: marker relocation already keeps the breakpoint on real
 * history, ahead of the live tail. Retaining a counter that changes on every
 * request would only fill the retention window and force a full reset — a
 * mid-history prefix break — every MAX_RETAINED_LIVE_TAILS requests. Once a
 * payload proves the session uses explicit markers, counters ride request-only
 * at the tail and are never replayed.
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
	/** A provider payload carried an explicit cache marker on our live tail. */
	explicitMarkers: boolean;
	/** Counters sent with the latest request only; never replayed mid-history. */
	requestOnlyCounters: string | undefined;
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
			session = { tails: [], lastFresh: undefined, baseFingerprints: [], explicitMarkers: false, requestOnlyCounters: undefined };
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
		// Request-only counters leave no retained copy, so dropping them is free.
		if (session.lastFresh !== undefined && (session.lastFresh.state !== fresh.state
			|| (session.lastFresh.tasks !== undefined && !fresh.tasks)
			|| (session.lastFresh.counters !== undefined && fresh.counters === undefined
				&& session.tails.some(tail => tail.kind === "goal-counters")))) reset();
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
		// Explicit-marker sessions keep counters out of retention entirely: the
		// relocated breakpoint sits ahead of the live tail, so a request-only
		// counter never enters a cached prefix and never needs a replay.
		const retainable = session.explicitMarkers ? blocks.filter(block => block.kind !== "goal-counters") : blocks;
		// Append only blocks that differ from the last emitted block of the same
		// kind, so unchanged content across repeats, tool loops, and history
		// advances adds zero blocks while keeping the prefix literal. The state
		// block never differs here: a changed state already reset above.
		const previous = session.lastFresh === undefined ? [] : freshBlocks(session.lastFresh);
		let appended = retainable.filter(block => !previous.some(prior => prior.kind === block.kind && prior.content === block.content));
		// Overflow is measured against what this request actually appends: an
		// unchanged request adds nothing and must never trigger a reset.
		if (session.tails.length + appended.length > MAX_RETAINED_LIVE_TAILS
			|| kindBytes(session.tails, "goal-counters") + kindBytes(appended, "goal-counters") > MAX_RETAINED_COUNTER_BYTES
			|| kindBytes(session.tails, "goal-tasks") + kindBytes(appended, "goal-tasks") > MAX_RETAINED_TASK_BYTES) {
			reset();
			appended = retainable;
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
		// Request-only counters are sent on every request, changed or not: no
		// earlier copy survives in history to stand in for them.
		session.requestOnlyCounters = session.explicitMarkers ? fresh.counters : undefined;
		if (session.requestOnlyCounters !== undefined) messages.push(makeLiveMessage(session.requestOnlyCounters));
		session.baseFingerprints = fingerprints;
		session.lastFresh = { state: fresh.state, tasks: fresh.tasks || undefined, counters: fresh.counters };
		return { messages, transientContents: [...new Set([...session.tails.map(tail => tail.content), ...blocks.map(block => block.content)])] };
	}

	/**
	 * Record that the request just built for this session carried an explicit
	 * cache marker on its live tail (the marker relocation moved it). From here
	 * on the session's counters are request-only.
	 *
	 * The counters appended by that same request still sit in `tails`. They are
	 * the last block of a payload whose breakpoint was just moved ahead of every
	 * live block, so no cached prefix contains them and dropping them from the
	 * replay set is free. Counters retained at earlier anchors (a session that
	 * only later starts sending markers) stay in place until the next reset:
	 * removing them would itself break the prefix.
	 */
	noteExplicitMarker(sessionKey: string): void {
		const session = this.sessions.get(sessionKey);
		if (!session || session.explicitMarkers) return;
		session.explicitMarkers = true;
		const newest = session.tails.at(-1);
		if (newest?.kind !== "goal-counters" || newest.anchorIndex !== session.baseFingerprints.length) return;
		session.tails.pop();
		session.requestOnlyCounters = newest.content;
	}

	/** Every live text of the latest request: retained tails plus request-only counters. */
	contents(sessionKey: string): string[] | undefined {
		const session = this.sessions.get(sessionKey);
		if (!session) return undefined;
		const contents = session.tails.map(tail => tail.content);
		if (session.requestOnlyCounters !== undefined) contents.push(session.requestOnlyCounters);
		return contents;
	}

	clear(sessionKey?: string): void {
		if (sessionKey === undefined) this.sessions.clear();
		else this.sessions.delete(sessionKey);
	}
}
