const PERIODS = ["day", "week", "month", "total"];
const nullableTokens = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid account token counter");
  return value;
};
const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function normalizeAccountUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const accountKey = /^[a-f0-9]{64}$/.test(value.accountKey) ? value.accountKey : null;
  const capturedAt = Date.parse(value.capturedAt);
  const status = accountKey && Number.isFinite(capturedAt) && ["available", "stale"].includes(value.status) ? value.status : "unavailable";
  const buckets = new Map();
  if (Array.isArray(value.dailyUsageBuckets)) {
    if (value.dailyUsageBuckets.length > 10000) throw new Error("Too many account usage buckets");
    for (const row of value.dailyUsageBuckets) {
      if (!validDate(row?.startDate)) throw new Error("Invalid account usage date");
      if (buckets.has(row.startDate)) throw new Error("Duplicate account usage date");
      buckets.set(row.startDate, nullableTokens(row.tokens));
    }
  }
  return {
    accountKey, status,
    capturedAt: status === "unavailable" ? null : new Date(capturedAt).toISOString(),
    lifetimeTokens: status === "unavailable" ? null : nullableTokens(value.lifetimeTokens),
    dailyUsageBuckets: status === "unavailable" || !Array.isArray(value.dailyUsageBuckets) ? null
      : [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([startDate, tokens]) => ({ startDate, tokens })),
  };
}

export function aggregateAccountUsage(devices, now = Date.now()) {
  const byAccount = new Map();
  for (const device of devices) {
    const item = device.accountUsage;
    if (!item?.accountKey) continue;
    const previous = byAccount.get(item.accountKey);
    // Account totals are snapshots, never device contributions.
    if (!previous || (Date.parse(item.capturedAt) || 0) > (Date.parse(previous.capturedAt) || 0)) byAccount.set(item.accountKey, item);
  }
  const accounts = [...byAccount.values()];
  const unidentifiedDeviceCount = devices.filter((d) => !d.accountUsage?.accountKey).length;
  const date = new Date(now).toISOString().slice(0, 10);
  const monday = new Date(`${date}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const starts = { day: date, week: monday.toISOString().slice(0, 10), month: date.slice(0, 7) + "-01" };
  const periods = {};
  const successes = accounts.filter((a) => a.status !== "unavailable");
  for (const name of PERIODS) {
    let total = 0, known = accounts.length > 0, partial = false;
    for (const account of accounts) {
      if (name === "total") {
        if (account.lifetimeTokens === null) known = false;
        else total += account.lifetimeTokens;
        continue;
      }
      const rows = account.dailyUsageBuckets?.filter((b) => b.startDate >= starts[name] && b.startDate <= date && b.tokens !== null);
      if (!rows?.length) { known = false; continue; }
      total += rows.reduce((sum, b) => sum + b.tokens, 0);
      const expectedDays = Math.round((Date.parse(date) - Date.parse(starts[name])) / 86400000) + 1;
      partial ||= rows.length < expectedDays;
    }
    if (!Number.isSafeInteger(total)) throw new Error("Account token sum exceeds safe integer range");
    periods[name] = { totalTokens: known ? total : null, partial: partial || !known || unidentifiedDeviceCount > 0 };
  }
  const reads = successes.map((a) => a.capturedAt).sort();
  const bucketDates = successes.flatMap((a) => a.dailyUsageBuckets || []).map((b) => b.startDate).sort();
  return {
    source: "account/usage/read", accountCount: accounts.length, availableAccountCount: successes.length,
    unidentifiedDeviceCount,
    capturedAt: reads[0] || null,
    latestBucketDate: bucketDates.at(-1) || null,
    dateBasis: "official bucket dates; UTC current period",
    stale: successes.length !== accounts.length || !successes.length || successes.some((a) => a.status === "stale" || now - Date.parse(a.capturedAt) > 15 * 60000),
    periods,
  };
}
