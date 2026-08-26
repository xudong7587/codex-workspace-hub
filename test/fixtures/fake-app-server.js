import { createInterface } from "node:readline";

if (process.env.CLAWD_TEST_FAKE_APP_SERVER !== "1") {
  process.exit(0);
}

if (process.env.CLAWD_TEST_FAKE_APP_SERVER_EXIT_EARLY === "1") {
  process.exit(17);
}

const order = [];
let initialized = false;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ id, result: value });
}

function error(id, code, message) {
  send({ id, error: { code, message } });
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.exitCode = 2;
    input.close();
    return;
  }

  if (message.method === "initialize" && Object.hasOwn(message, "id")) {
    order.push("initialize");
    result(message.id, {
      platformFamily: "test",
      platformOs: process.platform,
      protocolVersion: 1,
    });
    return;
  }

  if (message.method === "initialized" && !Object.hasOwn(message, "id")) {
    order.push("initialized");
    initialized = true;
    return;
  }

  if (!Object.hasOwn(message, "id")) return;
  if (!initialized) {
    error(message.id, -32_000, "initialized notification was not received");
    return;
  }

  order.push(message.method);
  if (message.method === "account/read") {
    result(message.id, {
      account: { type: "chatgpt", planType: "plus" },
    });
    return;
  }
  if (message.method === "account/rateLimits/read") {
    result(message.id, {
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          primary: {
            usedPercent: 12,
            windowDurationMins: 300,
            resetsAt: 1_788_000_000,
          },
          secondary: {
            usedPercent: 34,
            windowDurationMins: 10_080,
            resetsAt: 1_788_600_000,
          },
        },
      },
    });
    return;
  }
  if (message.method === "fixture/order") {
    result(message.id, [...order]);
    return;
  }
  if (message.method === "fixture/emit") {
    result(message.id, { accepted: true });
    setImmediate(() => {
      send({
        method: "account/rateLimits/updated",
        params: { source: "fake-app-server", sequence: 1 },
      });
    });
    return;
  }

  error(message.id, -32_601, `Unsupported method: ${message.method}`);
});

input.on("close", () => {
  process.exit(process.exitCode || 0);
});
