// CoreForge entrypoint: the process lifecycle around the forge server.
//
// app.ts builds the HTTP server but binds nothing; this file is what the
// harness actually runs. It brings the server up on a port the kernel picks,
// tells the contest environment (MAKEFUN_ENV_URL) which port that was, and
// then waits until the environment says the suite has finished before
// shutting down with a success status.

import { createApp } from './app.ts';
import type { AddressInfo } from 'node:net';

// The environment's origin, with any trailing slashes removed so paths can
// be appended directly. An empty value means there is no environment to
// register with, which the startup path below treats as fatal.
const envBase = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

// Retry/poll timing: waits start short and double up to a cap, so a slow
// environment is retried patiently without ever being hammered.
const FIRST_WAIT_MS = 200;
const LONGEST_WAIT_MS = 2_000;
const DONE_POLL_MS = 250;
// No single call to the environment may hang indefinitely; an unanswered
// request is abandoned and retried like any other failure.
const CALL_TIMEOUT_MS = 10_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function envUrl(path: string): string {
  return `${envBase}${path}`;
}

async function postRegistration(port: number): Promise<Response> {
  return fetch(envUrl('/register'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
}

async function fetchDoneFlag(): Promise<Response> {
  return fetch(envUrl('/done'), { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
}

// Announce the bound port until the environment accepts it. Success is any
// 2xx; a 409 also counts, because it means an earlier attempt from this
// process was recorded and only its response was lost — the environment
// keeps the first registration it receives.
async function registerBoundPort(port: number): Promise<void> {
  let wait = FIRST_WAIT_MS;
  for (;;) {
    try {
      const reply = await postRegistration(port);
      if (reply.ok || reply.status === 409) return;
    } catch {
      // Unreachable or timed out: wait and try again below.
    }
    await delay(wait);
    wait = Math.min(wait * 2, LONGEST_WAIT_MS);
  }
}

// Ask the environment whether the suite is finished, over and over, until
// it says so. Healthy "not finished" answers are re-polled on a steady
// short cadence; failed calls back off exponentially instead. This never
// returns early: leaving before the flag flips would abandon the forge
// mid-suite.
async function awaitSuiteEnd(): Promise<void> {
  let wait = FIRST_WAIT_MS;
  for (;;) {
    let answered = false;
    try {
      const reply = await fetchDoneFlag();
      if (reply.ok) {
        answered = true;
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      answered = false;
    }
    if (answered) {
      wait = FIRST_WAIT_MS;
      await delay(DONE_POLL_MS);
    } else {
      await delay(wait);
      wait = Math.min(wait * 2, LONGEST_WAIT_MS);
    }
  }
}

async function startForge(): Promise<number> {
  if (envBase === '') {
    process.stderr.write('MAKEFUN_ENV_URL is unset: no environment to register with, exiting.\n');
    return 1;
  }

  const server = createApp();

  // Port 0 asks the kernel for a free ephemeral port; the suite's own port
  // (8080) is never requested. Binding every interface matters: the
  // environment dials back the address our registration arrives from.
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, () => {
      resolveListen();
    });
  });
  const boundPort = (server.address() as AddressInfo).port;

  // A direct stop signal from the harness ends the process promptly and
  // tidily rather than leaving the server half-open.
  const stopNow = (): void => {
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', stopNow);
  process.on('SIGTERM', stopNow);

  await registerBoundPort(boundPort);
  await awaitSuiteEnd();

  server.close();
  return 0;
}

process.exit(await startForge());
