// scripts/run-with-soft-deadline.mjs — runs one reviewer with a warning-only deadline.
//
// The workflow owns the 25-minute hard timeout. This wrapper only emits an
// Actions warning after ten minutes; silence is not evidence that a remote
// reasoning request has stalled, so it never kills or replaces the child.
import { closeSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_SOFT_MS = 10 * 60 * 1000;

export function parseArgs(args) {
  const separator = args.indexOf('--');
  if (separator === -1 || separator === args.length - 1) {
    throw new Error('Usage: run-with-soft-deadline.mjs [--label text] [--soft-ms n] [--stdout file] -- command [args...]');
  }

  let label = 'Review';
  let softMs = DEFAULT_SOFT_MS;
  let stdoutFile;
  for (let i = 0; i < separator; i++) {
    const option = args[i];
    const value = args[++i];
    if (value === undefined) throw new Error(`Missing value for ${option}`);
    if (option === '--label') label = value;
    else if (option === '--soft-ms') softMs = Number(value);
    else if (option === '--stdout') stdoutFile = value;
    else throw new Error(`Unknown option ${option}`);
  }
  if (!Number.isFinite(softMs) || softMs < 0) throw new Error('--soft-ms must be a non-negative number');
  return { label, softMs, stdoutFile, command: args[separator + 1], commandArgs: args.slice(separator + 2) };
}

/** Runs the command to completion; the timer is informational and never terminates it. */
export async function runWithSoftDeadline({ label, softMs, stdoutFile, command, commandArgs }) {
  const stdoutFd = stdoutFile ? openSync(stdoutFile, 'w') : undefined;
  const stdout = stdoutFd ?? 'inherit';
  const child = spawn(command, commandArgs, { stdio: ['inherit', stdout, 'inherit'] });
  const warning = setTimeout(() => {
    console.error(`::warning::${label} is still running after ${Math.round(softMs / 60_000)} minutes; allowing it to continue to the workflow's hard limit.`);
  }, softMs);

  const forwardInterrupt = () => child.kill('SIGINT');
  const forwardTerminate = () => child.kill('SIGTERM');
  process.once('SIGINT', forwardInterrupt);
  process.once('SIGTERM', forwardTerminate);

  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    if (result.signal) throw new Error(`${command} exited after signal ${result.signal}`);
    return result.code ?? 1;
  } finally {
    clearTimeout(warning);
    process.removeListener('SIGINT', forwardInterrupt);
    process.removeListener('SIGTERM', forwardTerminate);
    if (stdoutFd !== undefined) closeSync(stdoutFd);
  }
}

async function main() {
  const exitCode = await runWithSoftDeadline(parseArgs(process.argv.slice(2)));
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
