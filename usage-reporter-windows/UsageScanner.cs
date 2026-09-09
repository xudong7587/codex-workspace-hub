using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace CWUsageReporter {
    public sealed class UsageCounters {
        public long TotalTokens, InputTokens, CacheReadTokens, OutputTokens, ReasoningTokens, MessageCount, UnpricedTokens;
        public double CostUsd;
        public void Add(UsageCounters other) {
            if (other == null) return;
            TotalTokens += other.TotalTokens; InputTokens += other.InputTokens; CacheReadTokens += other.CacheReadTokens;
            OutputTokens += other.OutputTokens; ReasoningTokens += other.ReasoningTokens; MessageCount += other.MessageCount;
            UnpricedTokens += other.UnpricedTokens; CostUsd += other.CostUsd;
        }
        public Dictionary<string, object> Json() {
            return new Dictionary<string, object> {
                { "totalTokens", TotalTokens }, { "inputTokens", InputTokens }, { "cacheReadTokens", CacheReadTokens },
                { "cacheWriteTokens", 0L }, { "outputTokens", OutputTokens }, { "reasoningTokens", ReasoningTokens },
                { "messageCount", MessageCount }, { "unpricedTokens", UnpricedTokens },
                { "costUsd", Math.Round(CostUsd + UnpricedTokens * 4d / 1000000d, 8) }, { "estimated", UnpricedTokens > 0 }
            };
        }
    }

    public sealed class UsageSnapshot {
        public Dictionary<string, object> Payload { get; set; }
        public UsageCounters Today { get; set; }
        public UsageCounters Week { get; set; }
        public UsageCounters Month { get; set; }
        public UsageCounters Total { get; set; }
        public int FilesScanned { get; set; }
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
        private sealed class Price { public double Input, Cached, Output; public Price(double input, double cached, double output) { Input = input; Cached = cached; Output = output; } }
        private static readonly object CacheLock = new object();
        private static readonly Dictionary<string, FileSummary> Cache = new Dictionary<string, FileSummary>(StringComparer.OrdinalIgnoreCase);
        private static readonly Dictionary<string, Price> Prices = new Dictionary<string, Price>(StringComparer.OrdinalIgnoreCase) {
            { "gpt-6-astra", new Price(10, 1, 50) },
            { "gpt-5.6-sol", new Price(4, .4, 20) }, { "gpt-5.6", new Price(4, .4, 20) },
            { "gpt-5.6-terra", new Price(2, .2, 12) }, { "gpt-5.6-luna", new Price(.2, .02, 1.2) },
            { "gpt-5.5", new Price(5, .5, 30) }, { "gpt-5.4", new Price(2.5, .25, 15) },
            { "gpt-5.4-mini", new Price(.75, .075, 4.5) }, { "gpt-5.4-nano", new Price(.2, .02, 1.25) },
            { "gpt-5.2", new Price(1.75, .175, 14) }, { "codex-mini-latest", new Price(1.5, .375, 6) }
        };

        public static UsageSnapshot Scan(double usdCnyRate) { lock (CacheLock) return ScanLocked(usdCnyRate); }

        private static UsageSnapshot ScanLocked(double rate) {
            DateTime now = DateTime.Now;
            UsageCounters day = new UsageCounters(), week = new UsageCounters(), month = new UsageCounters(), total = new UsageCounters();
            Dictionary<string, UsageCounters> models = new Dictionary<string, UsageCounters>(StringComparer.OrdinalIgnoreCase);
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            string codex = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
            foreach (string folder in new[] { Path.Combine(codex, "sessions"), Path.Combine(codex, "archived_sessions") }) {
                if (!Directory.Exists(folder)) continue;
                foreach (string file in Directory.EnumerateFiles(folder, "*.jsonl", SearchOption.AllDirectories)) {
                    seen.Add(file);
                    FileInfo info = new FileInfo(file);
                    FileSummary summary;
                    if (!Cache.TryGetValue(file, out summary) || summary.Length != info.Length || summary.Stamp != info.LastWriteTimeUtc.Ticks) {
                        summary = ScanFile(file); summary.Length = info.Length; summary.Stamp = info.LastWriteTimeUtc.Ticks; Cache[file] = summary;
                    }
                    AddKey(day, summary.Days, now.ToString("yyyy-MM-dd"));
                    AddKey(week, summary.Weeks, IsoWeekKey(now));
                    AddKey(month, summary.Months, now.ToString("yyyy-MM"));
                    total.Add(summary.Total);
                    foreach (KeyValuePair<string, UsageCounters> pair in summary.Models) AddMap(models, pair.Key, pair.Value);
                }
            }
            foreach (string stale in new List<string>(Cache.Keys)) if (!seen.Contains(stale)) Cache.Remove(stale);
            Dictionary<string, object> modelJson = new Dictionary<string, object>();
            foreach (KeyValuePair<string, UsageCounters> pair in models) modelJson[pair.Key] = pair.Value.Json();
            var payload = new Dictionary<string, object> {
                { "source", "cw-usage-reporter" }, { "capturedAt", DateTime.UtcNow.ToString("o") },
                { "dayKey", now.ToString("yyyy-MM-dd") }, { "weekKey", IsoWeekKey(now) }, { "monthKey", now.ToString("yyyy-MM") },
                { "usdCnyRate", rate }, { "models", modelJson },
                { "periods", new Dictionary<string, object> { { "day", day.Json() }, { "week", week.Json() }, { "month", month.Json() }, { "total", total.Json() } } }
            };
            return new UsageSnapshot { Payload = payload, Today = day, Week = week, Month = month, Total = total, FilesScanned = seen.Count };
        }

        private static FileSummary ScanFile(string file) {
            FileSummary summary = new FileSummary();
            JavaScriptSerializer json = new JavaScriptSerializer();
            string model = "unknown";
            try {
                foreach (string line in ReadLinesShared(file)) {
                    if (!line.Contains("\"token_count\"") && !line.Contains("\"turn_context\"")) continue;
                    Dictionary<string, object> root;
                    try { root = json.Deserialize<Dictionary<string, object>>(line); } catch { continue; }
                    Dictionary<string, object> payload = Dict(root, "payload");
                    if (payload == null) continue;
                    if (Text(root, "type") == "turn_context") { string next = Text(payload, "model"); if (!String.IsNullOrWhiteSpace(next)) model = NormalizeModel(next); continue; }
                    if (Text(root, "type") != "event_msg" || Text(payload, "type") != "token_count") continue;
                    Dictionary<string, object> usage = Dict(Dict(payload, "info"), "last_token_usage");
                    if (usage == null) continue;
                    UsageCounters item = Counters(usage, model);
                    DateTime timestamp;
                    if (!DateTime.TryParse(Text(root, "timestamp"), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out timestamp)) timestamp = File.GetLastWriteTimeUtc(file);
                    DateTime local = timestamp.ToLocalTime();
                    summary.Total.Add(item); AddMap(summary.Days, local.ToString("yyyy-MM-dd"), item); AddMap(summary.Weeks, IsoWeekKey(local), item);
                    AddMap(summary.Months, local.ToString("yyyy-MM"), item); AddMap(summary.Models, model, item);
                }
            } catch (IOException) { }
            return summary;
        }

        private static IEnumerable<string> ReadLinesShared(string file) {
            using (FileStream stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (StreamReader reader = new StreamReader(stream, Encoding.UTF8, true, 64 * 1024)) {
                string line;
                while ((line = reader.ReadLine()) != null) yield return line;
            }
        }

        private static UsageCounters Counters(Dictionary<string, object> value, string model) {
            long input = Long(value, "input_tokens"), cached = Math.Min(input, Long(value, "cached_input_tokens"));
            long output = Long(value, "output_tokens"), reasoning = Long(value, "reasoning_output_tokens"), total = Long(value, "total_tokens");
            if (total == 0) total = input + output;
            UsageCounters item = new UsageCounters { TotalTokens = total, InputTokens = input, CacheReadTokens = cached, OutputTokens = output, ReasoningTokens = reasoning, MessageCount = 1 };
            Price price; string normalized = NormalizeModel(model);
            if (Prices.TryGetValue(normalized, out price)) {
                bool longContext = input > 272000 && (normalized.StartsWith("gpt-6") || normalized.StartsWith("gpt-5.4") || normalized.StartsWith("gpt-5.5") || normalized.StartsWith("gpt-5.6"));
                double inputMultiplier = longContext ? 2 : 1, outputMultiplier = longContext ? 1.5 : 1;
                item.CostUsd = ((input - cached) * price.Input * inputMultiplier + cached * price.Cached * inputMultiplier + output * price.Output * outputMultiplier) / 1000000.0;
            } else item.UnpricedTokens = total;
            return item;
        }

        private static void AddKey(UsageCounters target, Dictionary<string, UsageCounters> map, string key) { UsageCounters value; if (map.TryGetValue(key, out value)) target.Add(value); }
        private static void AddMap(Dictionary<string, UsageCounters> map, string key, UsageCounters value) { UsageCounters target; if (!map.TryGetValue(key, out target)) { target = new UsageCounters(); map[key] = target; } target.Add(value); }
        private static Dictionary<string, object> Dict(Dictionary<string, object> value, string key) { object raw; return value != null && value.TryGetValue(key, out raw) ? raw as Dictionary<string, object> : null; }
        private static string Text(Dictionary<string, object> value, string key) { object raw; return value != null && value.TryGetValue(key, out raw) && raw != null ? Convert.ToString(raw, CultureInfo.InvariantCulture) : ""; }
        private static long Long(Dictionary<string, object> value, string key) { long parsed; return Int64.TryParse(Text(value, key), NumberStyles.Any, CultureInfo.InvariantCulture, out parsed) ? Math.Max(0, parsed) : 0; }
        private static string NormalizeModel(string value) { string model = (value ?? "unknown").Trim().ToLowerInvariant(); int date = model.IndexOf("-202"); return date > 0 ? model.Substring(0, date) : model; }
        private static string IsoWeekKey(DateTime date) { int day = (int)CultureInfo.InvariantCulture.Calendar.GetDayOfWeek(date); if (day >= 1 && day <= 3) date = date.AddDays(3 - day); int week = CultureInfo.InvariantCulture.Calendar.GetWeekOfYear(date, CalendarWeekRule.FirstFourDayWeek, DayOfWeek.Monday); return date.Year.ToString("0000") + "-W" + week.ToString("00"); }
    }
}
