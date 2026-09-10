using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;

namespace CWUsageReporter {
    internal sealed class UsagePeriodView {
        public long TotalTokens { get; set; }
        public double CostUsd { get; set; }
        public bool Estimated { get; set; }
        public bool TokensAvailable { get; set; }
        public bool Partial { get; set; }
        public double PricedCostUsd { get; set; }
        public double EstimatedCostUsd { get; set; }
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
                result.SourceNote = "官方账号 Token · 日数据至 " + Text(official, "latestBucketDate") + (Bool(official, "stale") ? "（缓存）" : "") + " · 金额仅设备 " + Text(local, "deviceId");
            } else result.SourceNote = "本地日志统计（非账号总量）";
            return result.Total == null ? null : result;
        }

        public static UsageOverview FromSnapshot(UsageSnapshot snapshot, double rate) {
            var result = new UsageOverview {
                UsdCnyRate = rate, DeviceCount = 1,
                Day = Period(snapshot.Today), Week = Period(snapshot.Week),
                Month = Period(snapshot.Month), Total = Period(snapshot.Total), SourceNote = "本机日志（CW 官方统计暂不可用）"
            };
            var official = Dict(snapshot.Payload, "accountUsage");
            if (official != null) {
                result.OfficialMode = true;
                ApplyRawTokens(result.Day, official, "day"); ApplyRawTokens(result.Week, official, "week");
                ApplyRawTokens(result.Month, official, "month"); ApplyRawTokens(result.Total, official, "total");
                result.SourceNote = Text(official, "status") == "available" ? "官方账号 Token（本机读取）· 金额为本机日志"
                    : "官方暂不可用 · 请检查本机 Codex 登录及版本";
            }
            return result;
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
            return new UsagePeriodView { TotalTokens = value.TotalTokens, TokensAvailable = true, CostUsd = value.CostUsd + value.UnpricedTokens * 4d / 1000000d, PricedCostUsd = value.CostUsd, EstimatedCostUsd = value.UnpricedTokens * 4d / 1000000d, Estimated = estimated };
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
                throw new InvalidOperationException("CW 请求失败" + (response == null ? "" : " HTTP " + (int)response.StatusCode) + (String.IsNullOrWhiteSpace(detail) ? "" : "：" + Short(detail, 180)), error);
            }
        }

        private static string Short(string value, int limit) { return value.Length <= limit ? value : value.Substring(0, limit) + "…"; }
    }
}
