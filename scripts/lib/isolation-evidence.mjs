import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * writeProgressIsolationEvidence
 * Pure-ish evidence formatter + writer.
 * - Computes structured before/after facts from snapshots (candByteEqual, hasSig, equals).
 * - Emits CMD/OUT for wc/ls + uniqueSig-probe grep -F on the *provided* real paths (read-only).
 * - Uses writeFileSync (overwrite, never append) when scratchDir given.
 * - Returns the full content string (for unit testing without fs side effects on the log).
 *
 * Call ONLY from test when process.env.GROK_GOAL_SCRATCH is set.
 * Never call from production paths.
 */
export function writeProgressIsolationEvidence(scratchDir, ctx = {}) {
  const {
    uniqueSig = '',
    beforeOrch = { files: [], candidateStr: '' },
    afterOrch = { files: [], candidateStr: '' },
    beforeJournal = '',
    afterJournal = '',
    realJournalPath = 'docs/todo/run-journal.md',
    realCandPath = '.va-auto-pilot/orchestration/candidate-backlog.json',
    realOrchDir = '.va-auto-pilot/orchestration',
    tmpCandPath = '',
    realCwd = process.cwd ? process.cwd() : '',
    tmpRoot = '',
  } = ctx;

  const journalEqual = afterJournal === beforeJournal;
  const candByteEqual = afterOrch.candidateStr === beforeOrch.candidateStr;
  const beforeHasSig = (beforeOrch.candidateStr || '').includes(uniqueSig);
  const afterHasSig = (afterOrch.candidateStr || '').includes(uniqueSig);

  // probe uses a distinctive chunk of *this run's* uniqueSig (full objective) — prefer "Highest-value" part so grep is specific even when prefix is historically common
  let probeSrc = String(uniqueSig);
  const hvIdx = probeSrc.indexOf("Highest-value");
  if (hvIdx >= 0) probeSrc = probeSrc.slice(hvIdx, hvIdx + 160);
  const probe = probeSrc.slice(0, 120).replace(/'/g, '');

  let content = '';
  const line = (s = '') => { content += s + '\n'; };

  line('=== isolation-evidence (canonical; sole producer = targeted test run under GROK_GOAL_SCRATCH) ===');
  line('timestamp: ' + new Date().toISOString());
  line('realCwd: ' + realCwd);
  line('tmpRoot: ' + tmpRoot);
  line('uniqueSigLen: ' + uniqueSig.length);
  line('uniqueSigHead: ' + uniqueSig.slice(0, 120));
  line('');
  line('beforeJournalLen: ' + beforeJournal.length);
  line('afterJournalLen: ' + afterJournal.length);
  line('journalEqual: ' + journalEqual);
  line('');
  line('beforeHasSig: ' + beforeHasSig);
  line('afterHasSig: ' + afterHasSig);
  line('candByteEqual: ' + candByteEqual);
  line('orchFilesBefore: ' + JSON.stringify(beforeOrch.files));
  line('orchFilesAfter: ' + JSON.stringify(afterOrch.files));
  line('');
  // Structured before/after facts for skeptic proof
  line('=== BEFORE (unmodified real state snapshot taken inside test before any goal/plan spawns) ===');
  line('journal[0:200]: ' + beforeJournal.slice(0, 200).replace(/\n/g, '\\n'));
  line('cand[0:200]: ' + (beforeOrch.candidateStr || '').slice(0, 200).replace(/\n/g, '\\n'));
  line('=== AFTER (real state snapshot after iter+goal+plan-from-goal) ===');
  line('journal[0:200]: ' + afterJournal.slice(0, 200).replace(/\n/g, '\\n'));
  line('cand[0:200]: ' + (afterOrch.candidateStr || '').slice(0, 200).replace(/\n/g, '\\n'));
  line('');
  // RAW commands using the uniqueSig probe against the unmodified real paths
  line('=== RAW: wc -l realJournal ===');
  line('CMD: wc -l ' + realJournalPath);
  const wcJ = spawnSync('wc', ['-l', realJournalPath], { encoding: 'utf8' });
  line('OUT: ' + (wcJ.stdout || '').trim() + ' code=' + wcJ.status);

  line('=== RAW: ls -la realOrchDir ===');
  line('CMD: ls -la ' + realOrchDir);
  const lsR = spawnSync('ls', ['-la', realOrchDir], { encoding: 'utf8' });
  line('OUT: ' + (lsR.stdout || '').trim() + ' code=' + lsR.status);

  line('=== RAW: grep -c -F <uniqueSig-probe> realCand (historical may >0; this run must not increase) ===');
  const bashCmdC = `grep -c -F '${probe}' '${realCandPath}' 2>/dev/null || echo 0`;
  line('CMD: bash -c ' + bashCmdC);
  const grC = spawnSync('bash', ['-c', bashCmdC], { encoding: 'utf8' });
  line('OUT: ' + (grC.stdout || '').trim() + ' code=' + grC.status);

  line('=== RAW: grep -F <uniqueSig-probe> realJournal | wc -l || echo 0 ===');
  const bashCmdJ = `grep -F '${probe}' '${realJournalPath}' 2>/dev/null | wc -l || echo 0`;
  line('CMD: bash -c ' + bashCmdJ);
  const grJ = spawnSync('bash', ['-c', bashCmdJ], { encoding: 'utf8' });
  line('OUT: ' + (grJ.stdout || '').trim() + ' code=' + grJ.status);

  if (tmpCandPath) {
    line('=== RAW: test -f tmpCand && wc -c tmpCand ===');
    const bashCmdT = `test -f '${tmpCandPath}' && wc -c '${tmpCandPath}' || echo 'no-tmp-cand'`;
    line('CMD: bash -c ' + bashCmdT);
    const wcT = spawnSync('bash', ['-c', bashCmdT], { encoding: 'utf8' });
    line('OUT: ' + (wcT.stdout || '').trim());
  }

  line('');
  line('=== CONCLUSION from this run ===');
  line('deltas=0: ' + (journalEqual && candByteEqual));
  line('sig-presence-unchanged: ' + (afterHasSig === beforeHasSig));
  line('tmp-got-this-run-objective: ' + String(!!(tmpCandPath && fs.existsSync(tmpCandPath) && fs.readFileSync(tmpCandPath, 'utf8').includes(uniqueSig))));
  line('=== end ===');

  if (scratchDir) {
    const p = path.join(scratchDir, 'isolation-evidence.log');
    fs.writeFileSync(p, content, 'utf8'); // overwrite (not append)
  }
  return content;
}
