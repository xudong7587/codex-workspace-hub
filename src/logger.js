const PRIORITY = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3 });
const SENSITIVE_KEY = /(authorization|cookie|secret|token|password|api[-_]?key)/i;
const DEFAULT_HISTORY_LIMIT = 500;

function redact(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(item, seen),
    ]),
  );
}

export function createLogger(level = "info", sink = process.stderr, options = {}) {
  const threshold = PRIORITY[level] ?? PRIORITY.info;
  const historyLimit = Math.max(0, Math.min(5_000, Number(options.historyLimit) || DEFAULT_HISTORY_LIMIT));
  const history = [];
  const write = (entryLevel, message, fields) => {
    if (PRIORITY[entryLevel] > threshold) return;
    const entry = {
      time: new Date().toISOString(),
      level: entryLevel,
      message: String(message),
      ...(fields && typeof fields === "object" ? redact(fields) : {}),
    };
    if (historyLimit > 0) {
      history.push(entry);
      if (history.length > historyLimit) history.splice(0, history.length - historyLimit);
    }
    const line = `${JSON.stringify(entry)}\n`;
    if (typeof sink?.write === "function") sink.write(line);
  };

  return Object.freeze({
    error: (message, fields) => write("error", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    info: (message, fields) => write("info", message, fields),
    debug: (message, fields) => write("debug", message, fields),
    recent: (limit = 200) => history.slice(-Math.max(1, Math.min(1_000, Number(limit) || 200))).map((entry) => ({ ...entry })),
  });
}
