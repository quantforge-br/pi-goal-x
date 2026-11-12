/** Compare the candidate with pinned release code using the same capture driver. */
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, cpSync, symlinkSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildReport} from './cache-report.mjs';
import {compareReports} from './cache-compare.mjs';
import {BASE_SYSTEM} from './capture-context.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
// Fork baseline: the first commit whose explicit-marker sessions send a
// request-only tail. Upstream 0.34.0 predates the fork's intentional payload
// changes (task snapshot tail, request-only tail), so it can no longer match.
const ref='6fae508d2078c1cb266872a56780aae7ffadfed6';
const output=process.env.PI_GOAL_CACHE_REPORT_DIR??mkdtempSync(path.join(tmpdir(),'goal-cache-evidence-'));
mkdirSync(output,{recursive:true});
const baselineRoot=mkdtempSync(path.join(tmpdir(),'goal-cache-baseline-'));
try {
 try {execFileSync('git',['cat-file','-e',`${ref}^{commit}`],{cwd:root,stdio:'ignore'});}
 catch {execFileSync('git',['fetch','--no-tags','--depth=1','origin',ref],{cwd:root,stdio:'inherit'});}
 const archive=execFileSync('git',['archive',ref,'extensions','experiments/context','package.json','package-lock.json'],{cwd:root,maxBuffer:16*1024*1024});
 execFileSync('tar',['-x','-C',baselineRoot],{input:archive});
 // Both trees use exactly the same fixtures, driver and installed SDK.
 for(const name of ['capture-context.mjs','fixtures.mjs','cache-report.mjs','cache-compare.mjs']) cpSync(path.join(root,'experiments/context',name),path.join(baselineRoot,'experiments/context',name));
 symlinkSync(path.join(root,'node_modules'),path.join(baselineRoot,'node_modules'),'dir');
 const baselineFile=path.join(output,'baseline.json');
 execFileSync(process.execPath,['--experimental-strip-types','experiments/context/cache-report.mjs',`--output=${baselineFile}`],{cwd:baselineRoot,maxBuffer:1024*1024});
 const baseline=JSON.parse(readFileSync(baselineFile,'utf8'));
 baseline.source=ref;
 writeFileSync(baselineFile,JSON.stringify(baseline,null,2)+'\n');
 const candidate=await buildReport();
 writeFileSync(path.join(output,'candidate.json'),JSON.stringify(candidate,null,2)+'\n');
 const comparison=compareReports(baseline,candidate,{hostSystem:BASE_SYSTEM});
 writeFileSync(path.join(output,'comparison.json'),JSON.stringify(comparison,null,2)+'\n');
 const display=comparison.approvedDifferences.filter(item=>item.reason==='default-context-display-off').length;
 const profile=comparison.approvedDifferences.filter(item=>item.reason==='fixed-goal-tool-profile').length;
 console.log(`Cache gate PASS: ${comparison.scenarios} adapter scenarios; ${display} exact approved display deltas; ${profile} approved fixed-profile system blocks; 1,000 bounded transitions. Evidence: ${output}`);
} finally {rmSync(baselineRoot,{recursive:true,force:true});}
