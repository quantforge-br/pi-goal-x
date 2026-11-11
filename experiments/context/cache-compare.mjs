/** Pure payload comparisons and deterministic retention measurements. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {LiveTailRetention} from '../../extensions/goal-live-retention.ts';
import {createGoal} from '../../extensions/goal-record.ts';
import {goalPromptParts} from '../../extensions/prompts/goal-prompts.ts';
import {userMessage, assistantMessage} from './fixtures.mjs';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const textBlock = block => typeof block.content === 'string' ? block.content : undefined;

// The committed gate compares against a release whose advertised goal tools
// still changed with lifecycle state. The fixed profile intentionally changes
// those declarations, so callers pass the host-only system prompt: both sides
// are reduced to the host-only system prefix and host tools before comparing.
// Everything else must stay byte-identical.
const FIXED_GOAL_TOOL_NAMES = new Set([
 'create_goal','get_goal','update_goal','set_goal_tasks','update_goal_task',
 'goal_question','goal_questionnaire','propose_goal_draft',
]);
const TOOLS_SECTION = /<tools>\n[\s\S]*?\n<\/tools>/;
const RULES_SECTION = /<rules>\n[\s\S]*?\n<\/rules>/;
const toolName = tool => tool?.name ?? tool?.function?.name;
function profileProjection(hostSystem) {
 const tools=hostSystem?.match(TOOLS_SECTION)?.[0], rules=hostSystem?.match(RULES_SECTION)?.[0];
 if(!tools||!rules) return value=>value;
 const project=value=>{
  if(typeof value==='string') return value.replace(TOOLS_SECTION,tools).replace(RULES_SECTION,rules);
  if(Array.isArray(value)) return value.map(project);
  if(value&&typeof value==='object') return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,project(child)]));
  return value;
 };
 return project;
}
const isSystemBlock = block => block?.role === 'system' || block?.role === 'developer';

export function summarize(payload, transients=[], {hostSystem}={}) {
 const blocks=payload.input??payload.messages;
 assert.ok(Array.isArray(blocks) && blocks.length, 'adapter omitted model-visible input');
 const markers=[];
 function visit(value, trail=[]) {
  if(!value || typeof value!=='object') return;
  if(value.cache_control || value.cachePoint) {
   assert.ok(!transients.includes(value.text), 'cache marker on a transient block');
   const tool=trail[0]==='tools'?toolName(payload.tools?.[Number(trail[1])]):undefined;
   const lastTool=!!tool&&Number(trail[1])===(payload.tools?.length??0)-1;
   markers.push({path:trail, ...(tool?{tool,lastTool}:{}), value:value.cache_control??value.cachePoint});
  }
  for(const [key, child] of Object.entries(value)) visit(child,[...trail,key]);
 }
 visit(payload);
 const hostTools=(payload.tools??[]).filter(tool=>!FIXED_GOAL_TOOL_NAMES.has(toolName(tool)));
 const project=profileProjection(hostSystem);
 return {
  immutable:digest({system:payload.system,instructions:payload.instructions,systemMessages:blocks.filter(b=>b.role==='system'||b.role==='developer'),tools:payload.tools}),
  ...(hostSystem?{hostImmutable:digest({system:project(payload.system),instructions:project(payload.instructions),systemMessages:blocks.filter(b=>b.role==='system'||b.role==='developer').map(project),tools:hostTools})}:{}),
  options:digest(Object.fromEntries(Object.entries(payload).filter(([k])=>!['system','instructions','tools','messages','input'].includes(k)))),
  blocks:blocks.map(block=>({hash:digest(block),bytes:Buffer.byteLength(JSON.stringify(block)),raw:block,...(textBlock(block)===undefined?{}:{text:textBlock(block)})})),
  bytes:Buffer.byteLength(JSON.stringify(payload)), markers,
 };
}

/** No payload normalization: a permitted display delta must match an exact block. */
export function compareReports(baseline, candidate, {hostSystem}={}) {
 assert.equal(candidate.version,baseline.version);
 assert.ok(baseline.rows.length>0,'empty baseline');
 assert.deepEqual(candidate.rows.map(r=>r.id),baseline.rows.map(r=>r.id),'missing/reordered scenario');
 if(baseline.corpus) assert.deepEqual(candidate.corpus,baseline.corpus,'retention bounds/reset frequency changed');
 if(baseline.dependencies) assert.equal(candidate.dependencies,baseline.dependencies,'comparison dependencies differ');
 if(baseline.investigation) {
  const steps=candidate.investigation.stateChanges, prior=baseline.investigation.stateChanges;
  assert.deepEqual(steps.map(step=>step.kind),prior.map(step=>step.kind),'state change sequence changed');
  // Task progress rides in its own append-only snapshot, so dropping a
  // release-era task-progress break is the only approved reclassification.
  for(const [n,step] of steps.entries()) if(step.prefixBreak!==prior[n].prefixBreak) assert.ok(prior[n].prefixBreak&&step.kind.startsWith('complete-'),`state reset classification changed at ${step.kind}`);
  assert.equal(candidate.investigation.occupancy[1].breaks,0,'hidden occupancy invalidated retention');
  assert.equal(candidate.investigation.occupancy[1].appendedCounters,0,'hidden occupancy added redundant counters');
  for(const [n,step] of candidate.investigation.stateChanges.entries()) assert.ok(step.reusableBlocks>=baseline.investigation.stateChanges[n].reusableBlocks,'unchanged workflow lost reusable history');
 }
 const project=profileProjection(hostSystem);
 const differences=[];
 // The fixed profile is state-independent: every task-enabled scenario must
 // advertise the same ordered declarations, drafting and execution included.
 const profileGroups=new Map();
 for(const row of candidate.rows) {
  if(row.id.endsWith('/tasks-disabled')) continue;
  const group=row.id.split('/').slice(0,2).join('/');
  if(!profileGroups.has(group)) profileGroups.set(group,[]);
  profileGroups.get(group).push(row);
 }
 for(const [group,rows] of profileGroups) {
  assert.equal(new Set(rows.map(row=>row.immutable)).size,1,`${group}: immutable prefix varies across lifecycle states`);
  const disabled=candidate.rows.find(row=>row.id===`${group}/tasks-disabled`);
  if(disabled) assert.ok(!rows.some(row=>row.immutable===disabled.immutable),`${group}: disableTasks did not change the declared profile`);
 }
 const markerPlacement=marker=>marker.tool?(marker.lastTool?'tool:last':`tool:${marker.tool}`):marker.path.join('.');
 for(let i=0;i<baseline.rows.length;i++) {
  const a=baseline.rows[i], b=candidate.rows[i];
  if(a.hostImmutable!==undefined||b.hostImmutable!==undefined) assert.equal(b.hostImmutable,a.hostImmutable,`${b.id}: non-goal system/tool prefix changed`);
  else assert.equal(b.immutable,a.immutable,`${b.id}: immutable prefix changed`);
  assert.equal(b.options,a.options,`${b.id}: cache/provider options changed`);
  assert.deepEqual(b.markers.map(marker=>({at:markerPlacement(marker),value:marker.value})),a.markers.map(marker=>({at:markerPlacement(marker),value:marker.value})),`${b.id}: cache markers moved or changed`);
  assert.equal(b.blocks.length,a.blocks.length,`${b.id}: unexpected block count`);
  for(let j=0;j<a.blocks.length;j++) {
   if(a.blocks[j].hash===b.blocks[j].hash) continue;
   let edits=0;
   const expected=value=>{
    if(typeof value==='string' && value.startsWith('Goal snapshot:') && value.includes('\nContext snapshot: unavailable\n')) {edits++;return value.replace('\nContext snapshot: unavailable\n','\n');}
    if(Array.isArray(value))return value.map(expected);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,expected(v)]));
    return value;
   };
   const approved=expected(a.blocks[j].raw);
   if(edits>0) {
    assert.ok(!b.id.endsWith('/context-explicit-true'),`${b.id}: explicit opt-in differs from release`);
    assert.deepEqual(b.blocks[j].raw,approved,`${b.id}: unexpected counter edit`);
    differences.push({scenario:b.id,block:j,reason:'default-context-display-off',removedBytes:a.blocks[j].bytes-b.blocks[j].bytes});
    continue;
   }
   // The fixed goal profile intentionally changes the declared goal tools and
   // their system-prompt snippets/guidelines. Only those sections may differ.
   if(isSystemBlock(a.blocks[j].raw) && isSystemBlock(b.blocks[j].raw)) {
    assert.notDeepEqual(b.blocks[j].raw,a.blocks[j].raw,`${b.id}: block hash changed without content (block ${j})`);
    assert.deepEqual(project(b.blocks[j].raw),project(a.blocks[j].raw),`${b.id}: non-profile system change in block ${j}`);
    differences.push({scenario:b.id,block:j,reason:'fixed-goal-tool-profile',beforeBytes:a.blocks[j].bytes,afterBytes:b.blocks[j].bytes});
    continue;
   }
   assert.fail(`${b.id}: unexplained block ${j}`);
  }
  if(a.reuse) {
   assert.equal(b.reuse?.blocks,a.reuse.blocks,`${b.id}: warm-prefix blocks lost`);
   const removed=a.blocks.slice(0,a.reuse.blocks).reduce((sum,block,j)=>sum+block.bytes-b.blocks[j].bytes,0);
   assert.equal(b.reuse.bytes,a.reuse.bytes-removed,`${b.id}: reusable history lost`);
  }
 }
 return {scenarios:candidate.rows.length,approvedDifferences:differences};
}

/**
 * Measure prefix breaks across ten state/task transitions (#108). Plain work
 * never breaks; the gate compares the remaining classification with the
 * pinned release, whose layout broke on every task transition.
 */
export function investigateCache() {
 let goal=createGoal({objective:'Complete three verified tasks',autoContinue:true,sisyphus:false},0);
 goal.id='cache-investigation';
 const history=[userMessage('Begin')], retention=new LiveTailRetention();
 let previous=retention.apply('state-workflow',history,goalPromptParts(goal)).messages;
 const kinds=['work','set-tasks','work','complete-1','work','complete-2','work','complete-3','work','work'];
 const stateChanges=[];
 for(const [n,kind] of kinds.entries()) {
  if(kind==='set-tasks') goal={...goal,taskList:{tasks:[1,2,3].map(i=>({id:`t${i}`,title:`Required task ${i}`,status:'pending'})),blockCompletion:true,proposedAt:'1970-01-01T00:00:00Z'}};
  else if(kind.startsWith('complete')) goal={...goal,taskList:{...goal.taskList,tasks:goal.taskList.tasks.map(task=>task.id===`t${kind.at(-1)}`?{...task,status:'complete',evidence:'verified'}:task)}};
  history.push(assistantMessage(`Work ${n}`),userMessage('Continue'));
  const next=retention.apply('state-workflow',history,goalPromptParts(goal)).messages;
  let shared=0;while(shared<previous.length && JSON.stringify(previous[shared])===JSON.stringify(next[shared]))shared++;
  const prefixBreak=shared!==previous.length;
  if(kind==='work') assert.equal(prefixBreak,false,'work: unexplained reset');
  stateChanges.push({kind,prefixBreak,reusableBlocks:shared,reusableBytes:Buffer.byteLength(JSON.stringify(previous.slice(0,shared))),requestBytes:Buffer.byteLength(JSON.stringify(next))});
  previous=next;
 }
 const occupancy=[];
 for(const showContextUsage of [true,false]) {
  const retained=new LiveTailRetention();
  const base=[userMessage('Unchanged history')];
  let prior,breaks=0,appendedCounters=0,totalRequestBytes=0;
  for(let n=0;n<80;n++) {
   const result=retained.apply('occupancy',base,goalPromptParts(goal,{showContextUsage},{tokens:n+1,contextWindow:1000}));
   if(prior && JSON.stringify(result.messages.slice(0,prior.length))!==JSON.stringify(prior))breaks++;
   if(prior && JSON.stringify(result.messages)!==JSON.stringify(prior))appendedCounters++;
   totalRequestBytes+=Buffer.byteLength(JSON.stringify(result.messages));
   prior=result.messages;
  }
  occupancy.push({showContextUsage,requests:80,breaks,appendedCounters,totalRequestBytes});
 }
 return {stateChanges,occupancy,decision:'policy changes reset; task progress appends a task snapshot without resetting'};
}

