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
    }

    internal sealed class UsageOverview {
        public UsagePeriodView Day { get; set; }
        public UsagePeriodView Week { get; set; }
        public UsagePeriodView Month { get; set; }
        public UsagePeriodView Total { get; set; }
        public double UsdCnyRate { get; set; }
        public int DeviceCount { get; set; }

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
            return result.Total == null ? null : result;
        }

        public static UsageOverview FromSnapshot(UsageSnapshot snapshot, double rate) {
            return new UsageOverview {
                UsdCnyRate = rate, DeviceCount = 1,
                Day = Period(snapshot.Today), Week = Period(snapshot.Week),
                Month = Period(snapshot.Month), Total = Period(snapshot.Total)
            };
        }

        private static UsagePeriodView Period(UsageCounters value) {
            if (value == null) return new UsagePeriodView();
            bool estimated = value.UnpricedTokens > 0;
            return new UsagePeriodView { TotalTokens = value.TotalTokens, CostUsd = value.CostUsd + value.UnpricedTokens * 4d / 1000000d, Estimated = estimated };
        }
        private static UsagePeriodView Period(Dictionary<string, object> periods, string key) {
            Dictionary<string, object> value = Dict(periods, key);
            return value == null ? new UsagePeriodView() : new UsagePeriodView {
                TotalTokens = Long(value, "totalTokens"), CostUsd = PositiveDouble(value, "costUsd", 0), Estimated = Bool(value, "estimated")
            };
        }
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
