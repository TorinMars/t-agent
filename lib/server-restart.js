// A restart asked for from the page (POST /api/system/restart): answer first, then exit with code 75, the same exit as the end of an update,
// so PM2, launchd or systemd starts the process again. Without a process manager that exit would end the service for good, so it is refused.
// `exit` and `schedule` are injected so tests can check the exit without ending the test process.
const RESTART_EXIT_CODE = 75;
const RESTART_DELAY_MS = 750;

function refusal(code) {
  return Object.assign(new Error(code), { statusCode: 409 });
}

function createServerRestart({ supervisor, isApplying, bootId, log, exit, schedule, delayMs = RESTART_DELAY_MS }) {
  let requested = false;

  // The same rule as `supported` of the automatic update: only a proven supervisor counts.
  function support() {
    return supervisor() ? { supported: true, reason: null } : { supported: false, reason: 'NO_PROCESS_MANAGER' };
  }

  // Throws NO_PROCESS_MANAGER or UPDATE_IN_PROGRESS (statusCode 409). A second request before the exit schedules nothing more.
  function request() {
    if (!support().supported) throw refusal('NO_PROCESS_MANAGER');
    if (isApplying()) throw refusal('UPDATE_IN_PROGRESS');
    if (!requested) {
      requested = true;
      log('restart', `Restart requested; exiting with code ${RESTART_EXIT_CODE} so the process manager starts the service again`);
      schedule(() => exit(RESTART_EXIT_CODE), delayMs);
    }
    return { accepted: true, boot_id: bootId };
  }

  // True from an accepted request until the exit: no update may start then, since the exit would stop it partway (npm ci, a merge).
  const pending = () => requested;

  return { support, request, pending };
}

module.exports = { createServerRestart, RESTART_EXIT_CODE, RESTART_DELAY_MS };
