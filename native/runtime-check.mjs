// The Windows prerequisites of the local speech runtime.
//
// The pinned runtime is a native library. On Windows it needs the Visual C++
// 2015-2022 redistributable (x64) in version 14.40 or newer; an older one
// crashes inside the library when it is loaded. The check runs in its own
// child process, so a crash there is a result and not the end of the
// installer. Nothing is installed here: a machine-wide redistributable is the
// user's decision, and the installer only says what is missing.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const MINIMUM_VCPP = '14.40';
export const VCPP_INSTRUCTION = 'Install the Microsoft Visual C++ 2015-2022 redistributable for x64 (version 14.40 or newer) and try again: https://aka.ms/vs/17/release/vc_redist.x64.exe';

const REGISTRY_KEY = 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64';

/** The version of the installed Visual C++ runtime, or null when there is none. */
export async function visualCppRuntimeVersion({ execFile: exec = run } = {}) {
  try {
    const { stdout } = await exec('reg.exe', ['query', REGISTRY_KEY, '/v', 'Version'], { windowsHide: true });
    const match = String(stdout).match(/Version\s+REG_SZ\s+(\d+(?:\.\d+)*)/i);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** True when the installed runtime is at least the version this build needs. */
export function versionIsEnough(version, minimum = MINIMUM_VCPP) {
  if (!version) return false;
  const left = String(version).split('.').map((part) => Number(part) || 0);
  const right = String(minimum).split('.').map((part) => Number(part) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

/** Loads the pinned binding. It throws when the native library cannot be loaded. */
export async function loadBinding() {
  return import('transcribe-cpp');
}

/**
 * The answer of the child process: whether the runtime can be used here, the
 * runtime version it found, and what is missing.
 */
export async function runtimeAnswer({ execFile: exec = run, script = fileURLToPath(import.meta.url) } = {}) {
  const version = await visualCppRuntimeVersion({ execFile: exec });
  const answer = { ok: true, version: version ?? null, reason: null };
  if (!versionIsEnough(version)) {
    answer.ok = false;
    answer.reason = version
      ? `The Visual C++ runtime on this computer is ${version}; ${MINIMUM_VCPP} or newer is needed.`
      : `No Visual C++ runtime was found; ${MINIMUM_VCPP} or newer is needed.`;
  }
  try {
    await loadBinding();
  } catch (error) {
    answer.ok = false;
    answer.reason = answer.reason || `The local speech runtime could not be loaded: ${error?.message || error}`;
  }
  return answer;
}

/**
 * Runs the check in a child process and reports what it found. A child that
 * crashes - an old runtime does exactly that - is a result, not a failure of
 * the caller.
 */
export async function checkRuntime({ execFile: exec = run, script = fileURLToPath(import.meta.url) } = {}) {
  let stdout = '';
  let stderr = '';
  try {
    const result = await exec(process.execPath, [script], { timeout: 120000, windowsHide: true, maxBuffer: 1024 * 1024 });
    stdout = result.stdout ?? '';
    stderr = result.stderr ?? '';
  } catch (error) {
    stdout = error.stdout ?? '';
    stderr = error.stderr ?? '';
  }
  let parsed = null;
  try { parsed = JSON.parse(String(stdout).trim()); } catch { /* the child did not answer */ }
  if (parsed && typeof parsed.ok === 'boolean') {
    return { ok: parsed.ok, version: parsed.version ?? null, reason: parsed.reason ?? null, instruction: parsed.ok ? null : VCPP_INSTRUCTION };
  }
  return {
    ok: false,
    version: null,
    reason: String(stderr).trim() || 'The local speech runtime check did not answer.',
    instruction: VCPP_INSTRUCTION,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const answer = await runtimeAnswer();
  process.stdout.write(JSON.stringify(answer));
  process.exit(answer.ok ? 0 : 1);
}
