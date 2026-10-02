using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;

namespace CWUsageReporter {
    internal sealed class QuotaOverview {
        public int? SessionRemaining { get; private set; }
        public int? WeeklyRemaining { get; private set; }

        public static QuotaOverview FromStats(Dictionary<string, object> stats) {
            var result = new QuotaOverview();
            Dictionary<string, object> limits = Dict(stats, "limits");
            object providersRaw;
            var providers = limits != null && limits.TryGetValue("providers", out providersRaw)
                ? providersRaw as System.Collections.IEnumerable : null;
            if (providers == null) return result;
            foreach (object providerRaw in providers) {
                var provider = providerRaw as Dictionary<string, object>;
                if (provider == null || !String.Equals(Text(provider, "provider"), "codex", StringComparison.OrdinalIgnoreCase)) continue;
                object windowsRaw;
                var windows = provider.TryGetValue("windows", out windowsRaw) ? windowsRaw as System.Collections.IEnumerable : null;
                if (windows == null) break;
                foreach (object windowRaw in windows) {
                    var window = windowRaw as Dictionary<string, object>;
                    double used;
                    if (window == null || !TryPercent(window, "usedPercent", out used)) continue;
                    int remaining = (int)Math.Round(100d - used, MidpointRounding.AwayFromZero);
                    string kind = Text(window, "kind");
                    if (String.Equals(kind, "session", StringComparison.OrdinalIgnoreCase)) result.SessionRemaining = remaining;
                    else if (String.Equals(kind, "weekly", StringComparison.OrdinalIgnoreCase)) result.WeeklyRemaining = remaining;
                }
                break;
            }
            return result;
        }

        private static bool TryPercent(Dictionary<string, object> value, string key, out double result) {
            object raw; double parsed;
            if (value != null && value.TryGetValue(key, out raw)
                && Double.TryParse(Convert.ToString(raw, CultureInfo.InvariantCulture), NumberStyles.Any, CultureInfo.InvariantCulture, out parsed)
                && !Double.IsNaN(parsed) && !Double.IsInfinity(parsed)) {
                result = Math.Max(0, Math.Min(100, parsed)); return true;
            }
            result = 0; return false;
        }
        private static Dictionary<string, object> Dict(Dictionary<string, object> value, string key) {
            object raw; return value != null && value.TryGetValue(key, out raw) ? raw as Dictionary<string, object> : null;
        }
        private static string Text(Dictionary<string, object> value, string key) {
            object raw; return value != null && value.TryGetValue(key, out raw) && raw != null ? Convert.ToString(raw, CultureInfo.InvariantCulture) : "";
        }
    }

    internal static class UsageFormatting {
        public static double SolHighCachedEstimate(long tokens) {
            return Math.Max(0, tokens) / 1000000d * (8d * 0.1d + 0.8d * 0.9d);
        }

        public static string Tokens(long value) {
            return value < 100000000
                ? (value / 10000d).ToString("0.0") + "万"
                : (value / 100000000d).ToString("0.0") + "亿";
        }
    }

    internal sealed class UsagePeriodView {
        public long TotalTokens { get; set; }
        public double CostUsd { get; set; }
        public bool Estimated { get; set; }
        public bool TokensAvailable { get; set; }
        public bool Partial { get; set; }
        public double PricedCostUsd { get; set; }
        public double EstimatedCostUsd { get; set; }
        public double? ValueCny(double exchange) {
            if (!TokensAvailable) return null;
            return (PricedCostUsd + EstimatedCostUsd) * exchange;
        }
    }

    internal sealed class UsageOverview {
        public UsagePeriodView Day { get; set; }
        public UsagePeriodView Week { get; set; }
        public UsagePeriodView Month { get; set; }
        public UsagePeriodView Total { get; set; }
        public double UsdCnyRate { get; set; }
        public int DeviceCount { get; set; }
        public string SourceNote { get; set; }
        public bool OfficialMode { get; set; }

        public static UsageOverview FromStats(Dictionary<string, object> stats, double fallbackRate) {
            Dictionary<string, object> usage = Dict(stats, "usage");
            Dictionary<string, object> periods = Dict(usage, "periods");
            if (periods == null) return null;
            UsageOverview result = new UsageOverview {
                UsdCnyRate = PositiveDouble(usage, "usdCnyRate", fallbackRate),
                DeviceCount = (int)Math.Max(0, Long(usage, "deviceCount")),
                Day = Period(periods, "day"), Week = Period(periods, "week"),
                Month = Period(periods, "month"), Total = Period(periods, "total")
            };
            var official = Dict(usage, "accountUsage");
            var local = Dict(usage, "localDetails");
            if (official != null) {
                result.OfficialMode = true;
                ApplyOfficial(result, Dict(official, "periods"));
                var details = Dict(local, "periods");
                ApplyCost(result.Day, details, "day"); ApplyCost(result.Week, details, "week");
                ApplyCost(result.Month, details, "month"); ApplyCost(result.Total, details, "total");
                result.UsdCnyRate = PositiveDouble(local, "usdCnyRate", fallbackRate);
                result.SourceNote = "官方账号 Token · 日数据至 " + Text(official, "latestBucketDate") + (Bool(official, "stale") ? "（缓存）" : "");
            } else result.SourceNote = "本地日志统计（非账号总量）";
            return result.Total == null ? null : result;
        }

        public static UsageOverview FromSnapshot(UsageSnapshot snapshot, double rate) {
            var result = new UsageOverview {
                UsdCnyRate = rate, DeviceCount = 1,
                Day = Period(snapshot.Today), Week = Period(snapshot.Week),
                Month = Period(snapshot.Month), Total = Period(snapshot.Total), SourceNote = "今日 / 本周 / 本月：本机实时日志 · 累计：本机日志"
            };
            var official = Dict(snapshot.Payload, "accountUsage");
            if (official != null && Text(official, "status") == "available" && official.ContainsKey("lifetimeTokens") && official["lifetimeTokens"] != null) {
                result.ApplyOfficialTotal(Long(official, "lifetimeTokens"));
            }
            return result;
        }

        public void ApplyOfficialTotal(long officialTokens) {
            if (Total == null || officialTokens < 0) return;
            long localTotalTokens = Total.TotalTokens;
            Total.TotalTokens = officialTokens;
            Total.TokensAvailable = true;
            long missingTokens = Math.Max(0, officialTokens - localTotalTokens);
            if (missingTokens > 0) {
                Total.EstimatedCostUsd += UsageFormatting.SolHighCachedEstimate(missingTokens);
                Total.CostUsd = Total.PricedCostUsd + Total.EstimatedCostUsd;
                Total.Estimated = true;
            }
            OfficialMode = true;
            SourceNote = "近期：本机实时日志 · 累计：Codex 软件总量";
        }

        public static bool TryOfficialTotalFromStats(Dictionary<string, object> stats, out long totalTokens) {
            Dictionary<string, object> usage = Dict(stats, "usage");
            Dictionary<string, object> accountUsage = Dict(usage, "accountUsage");
            Dictionary<string, object> periods = Dict(accountUsage, "periods");
            Dictionary<string, object> total = Dict(periods, "total");
            object raw; long parsed;
            if (total != null && total.TryGetValue("totalTokens", out raw) && raw != null
                && Int64.TryParse(Convert.ToString(raw, CultureInfo.InvariantCulture), NumberStyles.Any, CultureInfo.InvariantCulture, out parsed)
                && parsed >= 0) { totalTokens = parsed; return true; }
            totalTokens = 0; return false;
        }

        private static void ApplyRawTokens(UsagePeriodView target, Dictionary<string, object> official, string name) {
            target.TokensAvailable = false; target.TotalTokens = 0;
            if (Text(official, "status") != "available") return;
            if (name == "total") {
                target.TokensAvailable = official.ContainsKey("lifetimeTokens") && official["lifetimeTokens"] != null;
                target.TotalTokens = Long(official, "lifetimeTokens"); return;
            }
            DateTime today = DateTime.UtcNow.Date;
            DateTime start = name == "week" ? today.AddDays(-(((int)today.DayOfWeek + 6) % 7))
                : name == "month" ? new DateTime(today.Year, today.Month, 1) : today;
            object raw;
            var rows = official.TryGetValue("dailyUsageBuckets", out raw) ? raw as System.Collections.IEnumerable : null;
            if (rows == null) return;
            int days = 0;
            foreach (object row in rows) {
                var bucket = row as Dictionary<string, object>;
                DateTime date;
                if (bucket == null || !DateTime.TryParseExact(Text(bucket, "startDate"), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out date)
                    || date < start || date > today || !bucket.ContainsKey("tokens") || bucket["tokens"] == null) continue;
                target.TotalTokens += Long(bucket, "tokens"); days++;
            }
            target.TokensAvailable = days > 0;
            target.Partial = days < (today - start).Days + 1;
        }

        private static void ApplyOfficial(UsageOverview result, Dictionary<string, object> periods) {
            result.Day = Period(periods, "day"); result.Week = Period(periods, "week");
            result.Month = Period(periods, "month"); result.Total = Period(periods, "total");
        }
        private static void ApplyCost(UsagePeriodView target, Dictionary<string, object> details, string key) {
            var local = Period(details, key);
            target.CostUsd = local.CostUsd; target.PricedCostUsd = local.PricedCostUsd;
            target.EstimatedCostUsd = local.EstimatedCostUsd; target.Estimated = local.Estimated;
        }

        private static UsagePeriodView Period(UsageCounters value) {
            if (value == null) return new UsagePeriodView();
            bool estimated = value.UnpricedTokens > 0;
            return new UsagePeriodView { TotalTokens = value.TotalTokens, TokensAvailable = true, CostUsd = value.CostUsd + value.EstimatedCostUsd, PricedCostUsd = value.CostUsd, EstimatedCostUsd = value.EstimatedCostUsd, Estimated = estimated };
        }
        private static UsagePeriodView Period(Dictionary<string, object> periods, string key) {
            Dictionary<string, object> value = Dict(periods, key);
            return value == null ? new UsagePeriodView() : new UsagePeriodView {
                TotalTokens = Long(value, "totalTokens"), TokensAvailable = value.ContainsKey("totalTokens") && value["totalTokens"] != null,
                Partial = Bool(value, "partial"), CostUsd = PositiveDouble(value, "costUsd", 0), Estimated = Bool(value, "estimated"),
                PricedCostUsd = PositiveDouble(value, "pricedCostUsd", Bool(value, "estimated") ? 0 : PositiveDouble(value, "costUsd", 0)),
                EstimatedCostUsd = PositiveDouble(value, "estimatedCostUsd", Bool(value, "estimated") ? PositiveDouble(value, "costUsd", 0) : 0)
            };
        }
        private static string Text(Dictionary<string, object> value, string key) { object raw; return value != null && value.TryGetValue(key, out raw) && raw != null ? Convert.ToString(raw) : "—"; }
        private static Dictionary<string, object> Dict(Dictionary<string, object> value, string key) {
            object raw; return value != null && value.TryGetValue(key, out raw) ? raw as Dictionary<string, object> : null;
        }
        private static long Long(Dictionary<string, object> value, string key) {
            object raw; long parsed; return value != null && value.TryGetValue(key, out raw) && Int64.TryParse(Convert.ToString(raw, CultureInfo.InvariantCulture), NumberStyles.Any, CultureInfo.InvariantCulture, out parsed) ? parsed : 0;
        }
        private static double PositiveDouble(Dictionary<string, object> value, string key, double fallback) {
            object raw; double parsed; return value != null && value.TryGetValue(key, out raw) && Double.TryParse(Convert.ToString(raw, CultureInfo.InvariantCulture), NumberStyles.Any, CultureInfo.InvariantCulture, out parsed) && parsed >= 0 ? parsed : fallback;
        }
        private static bool Bool(Dictionary<string, object> value, string key) {
            object raw; bool parsed; return value != null && value.TryGetValue(key, out raw) && Boolean.TryParse(Convert.ToString(raw, CultureInfo.InvariantCulture), out parsed) && parsed;
        }
    }

    internal sealed class HubClient {
        private readonly ReporterConfig config;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };

        public HubClient(ReporterConfig config) { this.config = config; }

        public Dictionary<string, object> Get(string path) { return Request("GET", path, null); }
        public Dictionary<string, object> Post(string path, object body) { return Request("POST", path, body); }

        private Dictionary<string, object> Request(string method, string path, object body) {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(config.HubUrl.TrimEnd('/') + path);
            request.Method = method;
            request.Accept = "application/json";
            request.Headers[HttpRequestHeader.Authorization] = "Bearer " + config.Key;
            request.Timeout = 30000;
            request.ReadWriteTimeout = 30000;
            if (body != null) {
                byte[] payload = Encoding.UTF8.GetBytes(json.Serialize(body));
                request.ContentType = "application/json; charset=utf-8";
                request.ContentLength = payload.Length;
                using (Stream stream = request.GetRequestStream()) stream.Write(payload, 0, payload.Length);
            }
            try {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
                    string text = reader.ReadToEnd();
                    return String.IsNullOrWhiteSpace(text) ? new Dictionary<string, object>() : json.Deserialize<Dictionary<string, object>>(text);
                }
            } catch (WebException error) {
                HttpWebResponse response = error.Response as HttpWebResponse;
                string detail = "";
                if (response != null) using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) detail = reader.ReadToEnd();
                throw new InvalidOperationException("Hub 请求失败" + (response == null ? "" : " HTTP " + (int)response.StatusCode) + (String.IsNullOrWhiteSpace(detail) ? "" : "：" + Short(detail, 180)), error);
            }
        }

        private static string Short(string value, int limit) { return value.Length <= limit ? value : value.Substring(0, limit) + "…"; }
    }
}
