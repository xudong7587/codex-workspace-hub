using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace VWatchCollector {
    public sealed class UsageCounters {
        public long totalTokens, inputTokens, cacheReadTokens, outputTokens, reasoningTokens, messageCount;
        public double costUsd;
        public void Add(UsageCounters other) {
            totalTokens += other.totalTokens; inputTokens += other.inputTokens; cacheReadTokens += other.cacheReadTokens;
            outputTokens += other.outputTokens; reasoningTokens += other.reasoningTokens; messageCount += other.messageCount; costUsd += other.costUsd;
        }
        public Dictionary<string, object> Json() {
            return new Dictionary<string, object> {
                { "totalTokens", totalTokens }, { "inputTokens", inputTokens }, { "cacheReadTokens", cacheReadTokens },
                { "cacheWriteTokens", 0L }, { "outputTokens", outputTokens }, { "reasoningTokens", reasoningTokens },
                { "messageCount", messageCount }, { "costUsd", Math.Round(costUsd, 8) }
            };
        }
    }

    public static class UsageScanner {
        private sealed class FileSummary {
            public long Length, Stamp;
            public UsageCounters Total = new UsageCounters();
            public Dictionary<string, UsageCounters> Days = new Dictionary<string, UsageCounters>();
            public Dictionary<string, UsageCounters> Weeks = new Dictionary<string, UsageCounters>();
            public Dictionary<string, UsageCounters> Months = new Dictionary<string, UsageCounters>();
            public Dictionary<string, UsageCounters> Models = new Dictionary<string, UsageCounters>(StringComparer.OrdinalIgnoreCase);
        }
        private static readonly object CacheLock = new object();
        private static readonly Dictionary<string, FileSummary> Cache = new Dictionary<string, FileSummary>(StringComparer.OrdinalIgnoreCase);
        private sealed class Price { public double Input, Cached, Output; public Price(double input, double cached, double output) { Input=input; Cached=cached; Output=output; } }
        private static readonly Dictionary<string, Price> Prices = new Dictionary<string, Price>(StringComparer.OrdinalIgnoreCase) {
            { "gpt-5.6-sol", new Price(4.0, .4, 20.0) }, { "gpt-5.6", new Price(4.0, .4, 20.0) },
            { "gpt-5.6-terra", new Price(2.0, .2, 12.0) }, { "gpt-5.6-luna", new Price(.2, .02, 1.2) },
            { "gpt-5.5", new Price(5.0, .5, 30.0) }, { "gpt-5.4", new Price(2.5, .25, 15.0) },
            { "gpt-5.4-mini", new Price(.75, .075, 4.5) }, { "gpt-5.4-nano", new Price(.2, .02, 1.25) },
            { "gpt-5.2", new Price(1.75, .175, 14.0) }, { "codex-mini-latest", new Price(1.5, .375, 6.0) }
        };

        public static Dictionary<string, object> Scan(double usdCnyRate) {
            lock (CacheLock) { return ScanLocked(usdCnyRate); }
        }

        private static Dictionary<string, object> ScanLocked(double usdCnyRate) {
            DateTime now = DateTime.Now;
            UsageCounters day = new UsageCounters(), week = new UsageCounters(), month = new UsageCounters(), total = new UsageCounters();
            Dictionary<string, UsageCounters> models = new Dictionary<string, UsageCounters>(StringComparer.OrdinalIgnoreCase);
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            string codex = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
            foreach (string folder in new [] { Path.Combine(codex, "sessions"), Path.Combine(codex, "archived_sessions") }) {
                if (!Directory.Exists(folder)) continue;
                foreach (string file in Directory.EnumerateFiles(folder, "*.jsonl", SearchOption.AllDirectories)) {
                    seen.Add(file);
                    FileInfo info = new FileInfo(file);
                    FileSummary summary;
                    if (!Cache.TryGetValue(file, out summary) || summary.Length != info.Length || summary.Stamp != info.LastWriteTimeUtc.Ticks) {
                        summary = ScanFile(file);
                        summary.Length = info.Length; summary.Stamp = info.LastWriteTimeUtc.Ticks; Cache[file] = summary;
                    }
                    AddKey(day, summary.Days, now.ToString("yyyy-MM-dd"));
                    AddKey(week, summary.Weeks, IsoWeekKey(now));
                    AddKey(month, summary.Months, now.ToString("yyyy-MM"));
                    total.Add(summary.Total);
                    foreach (KeyValuePair<string, UsageCounters> pair in summary.Models) {
                        UsageCounters target;
                        if (!models.TryGetValue(pair.Key, out target)) { target = new UsageCounters(); models[pair.Key] = target; }
                        target.Add(pair.Value);
                    }
                }
            }
            foreach (string stale in new List<string>(Cache.Keys)) if (!seen.Contains(stale)) Cache.Remove(stale);
            Dictionary<string, object> modelJson = new Dictionary<string, object>();
            foreach (KeyValuePair<string, UsageCounters> pair in models) modelJson[pair.Key] = pair.Value.Json();
            return new Dictionary<string, object> {
                { "source", "vwatch-collector" }, { "capturedAt", DateTime.UtcNow.ToString("o") },
                { "dayKey", now.ToString("yyyy-MM-dd") }, { "weekKey", IsoWeekKey(now) }, { "monthKey", now.ToString("yyyy-MM") },
                { "usdCnyRate", usdCnyRate }, { "models", modelJson },
                { "periods", new Dictionary<string, object> { { "day", day.Json() }, { "week", week.Json() }, { "month", month.Json() }, { "total", total.Json() } } }
            };
        }

        private static FileSummary ScanFile(string file) {
            FileSummary summary = new FileSummary();
            JavaScriptSerializer json = new JavaScriptSerializer();
            string model = "unknown";
            try {
                foreach (string line in File.ReadLines(file, Encoding.UTF8)) {
                    if (line.IndexOf("\"token_count\"", StringComparison.Ordinal) < 0 && line.IndexOf("\"turn_context\"", StringComparison.Ordinal) < 0) continue;
                    Dictionary<string, object> root;
                    try { root = json.Deserialize<Dictionary<string, object>>(line); } catch { continue; }
                    Dictionary<string, object> payload = Dict(root, "payload");
                    if (payload == null) continue;
                    if (Text(root, "type") == "turn_context") {
                        string next = Text(payload, "model"); if (!String.IsNullOrWhiteSpace(next)) model = NormalizeModel(next);
                        continue;
                    }
                    if (Text(root, "type") != "event_msg" || Text(payload, "type") != "token_count") continue;
                    Dictionary<string, object> info = Dict(payload, "info");
                    Dictionary<string, object> usage = Dict(info, "last_token_usage");
                    if (usage == null) continue;
                    UsageCounters item = Counters(usage, model);
                    DateTime timestamp;
                    if (!DateTime.TryParse(Text(root, "timestamp"), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out timestamp)) timestamp = File.GetLastWriteTimeUtc(file);
                    DateTime local = timestamp.ToLocalTime();
                    summary.Total.Add(item);
                    AddMap(summary.Days, local.ToString("yyyy-MM-dd"), item);
                    AddMap(summary.Weeks, IsoWeekKey(local), item);
                    AddMap(summary.Months, local.ToString("yyyy-MM"), item);
                    AddMap(summary.Models, model, item);
                }
            } catch (IOException) { }
            return summary;
        }

        private static void AddKey(UsageCounters target, Dictionary<string, UsageCounters> values, string key) {
            UsageCounters value; if (values.TryGetValue(key, out value)) target.Add(value);
        }
        private static void AddMap(Dictionary<string, UsageCounters> values, string key, UsageCounters value) {
            UsageCounters target;
            if (!values.TryGetValue(key, out target)) { target = new UsageCounters(); values[key] = target; }
            target.Add(value);
        }

        private static UsageCounters Counters(Dictionary<string, object> value, string model) {
            long input = Long(value, "input_tokens"), cached = Math.Min(input, Long(value, "cached_input_tokens"));
            long output = Long(value, "output_tokens"), reasoning = Long(value, "reasoning_output_tokens");
            long totalTokens = Long(value, "total_tokens");
            if (totalTokens == 0) totalTokens = input + output;
            UsageCounters item = new UsageCounters { totalTokens = totalTokens, inputTokens = input, cacheReadTokens = cached,
                outputTokens = output, reasoningTokens = reasoning, messageCount = 1 };
            Price price;
            if (Prices.TryGetValue(NormalizeModel(model), out price)) {
                double inputMultiplier = input > 272000 && (model.StartsWith("gpt-5.4") || model.StartsWith("gpt-5.5") || model.StartsWith("gpt-5.6")) ? 2.0 : 1.0;
                double outputMultiplier = inputMultiplier > 1 ? 1.5 : 1.0;
                item.costUsd = ((input - cached) * price.Input * inputMultiplier + cached * price.Cached * inputMultiplier + output * price.Output * outputMultiplier) / 1000000.0;
            }
            return item;
        }

        private static Dictionary<string, object> Dict(Dictionary<string, object> value, string key) {
            object raw; return value != null && value.TryGetValue(key, out raw) ? raw as Dictionary<string, object> : null;
        }
        private static string Text(Dictionary<string, object> value, string key) { object raw; return value != null && value.TryGetValue(key, out raw) && raw != null ? Convert.ToString(raw, CultureInfo.InvariantCulture) : ""; }
        private static long Long(Dictionary<string, object> value, string key) { long parsed; return Int64.TryParse(Text(value, key), NumberStyles.Any, CultureInfo.InvariantCulture, out parsed) ? Math.Max(0, parsed) : 0; }
        private static string NormalizeModel(string value) {
            string model = (value ?? "unknown").Trim().ToLowerInvariant();
            int date = model.IndexOf("-202"); if (date > 0) model = model.Substring(0, date);
            return model;
        }
        private static string IsoWeekKey(DateTime date) {
            int day = (int)CultureInfo.InvariantCulture.Calendar.GetDayOfWeek(date);
            if (day >= 1 && day <= 3) date = date.AddDays(3 - day);
            int week = CultureInfo.InvariantCulture.Calendar.GetWeekOfYear(date, CalendarWeekRule.FirstFourDayWeek, DayOfWeek.Monday);
            return date.Year.ToString("0000") + "-W" + week.ToString("00");
        }
    }
}
