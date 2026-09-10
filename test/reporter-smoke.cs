using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;
using CWUsageReporter;

internal static class ReporterSmoke {
    private static void Assert(bool value, string message) { if (!value) throw new Exception(message); }
    public static void Main(string[] args) {
        var json = new JavaScriptSerializer();
        var stats = json.Deserialize<Dictionary<string, object>>("{\"usage\":{\"periods\":{\"total\":{\"totalTokens\":7123456789}},\"accountUsage\":{\"periods\":{\"day\":{\"totalTokens\":null},\"total\":{\"totalTokens\":7123456789}}},\"localDetails\":{\"deviceId\":\"test-pc\",\"usdCnyRate\":7.2,\"periods\":{\"total\":{\"costUsd\":3,\"pricedCostUsd\":2,\"estimatedCostUsd\":1}}}}}");
        var view = UsageOverview.FromStats(stats, 7.2);
        Assert(view.Total.TotalTokens == 7123456789L && view.Total.TokensAvailable, "Official 64-bit counter lost");
        Assert(!view.Day.TokensAvailable, "Missing today became zero");
        Assert(view.Total.PricedCostUsd == 2 && view.Total.EstimatedCostUsd == 1, "Cost breakdown lost");
        var direct = new Dictionary<string, object> { { "status", "available" }, { "lifetimeTokens", 7123456789L },
            { "dailyUsageBuckets", new object[] { new Dictionary<string, object> { { "startDate", DateTime.UtcNow.ToString("yyyy-MM-dd") }, { "tokens", 0 } } } } };
        var fallback = UsageOverview.FromSnapshot(new UsageSnapshot { Payload = new Dictionary<string, object> { { "accountUsage", direct } }, Total = new UsageCounters { CostUsd = 2 } }, 7.2);
        Assert(fallback.OfficialMode && fallback.Total.TotalTokens == 7123456789L, "Direct official fallback lost");
        Assert(fallback.Day.TokensAvailable && fallback.Day.TotalTokens == 0, "Explicit official zero missing");
        Assert(fallback.Total.PricedCostUsd == 2, "Fallback local pricing lost");
        var counters = new UsageCounters { CostUsd = 2, UnpricedTokens = 250000 };
        var payload = counters.Json();
        Assert(Convert.ToDouble(payload["costUsd"]) == 3 && Convert.ToDouble(payload["pricedCostUsd"]) == 2, "Pricing serialization failed");
        string fixture = Path.Combine(Path.GetTempPath(), "cw-reporter-test-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path.Combine(fixture, "sessions"));
        try {
            string first = Event(json, 10, 10), next = Event(json, 20, 10), reset = Event(json, 5, 5);
            File.WriteAllLines(Path.Combine(fixture, "sessions", "fixture.jsonl"), new[] { first, first, next, reset });
            var scanned = UsageScanner.ScanAt(fixture, DateTime.Now, 7.2);
            Assert(scanned.Total.TotalTokens == 25, "Duplicate notification counted or reset discarded");
            Assert(scanned.Total.MessageCount == 3, "Usage event deduplication failed");
        } finally { Directory.Delete(fixture, true); }
        Console.WriteLine("Reporter contract tests passed");
        if (args.Length > 0 && args[0] == "--live") {
            var usage = AccountUsageClient.Read();
            Assert(Convert.ToString(usage["status"]) == "available", "Official account usage unavailable");
            Console.WriteLine("Official lifetimeTokens=" + Convert.ToString(usage["lifetimeTokens"]));
            if (args.Length > 1) {
                var snapshot = UsageScanner.Scan(7.2);
                snapshot.Payload["accountUsage"] = usage;
                File.WriteAllText(args[1], json.Serialize(snapshot.Payload));
            }
        }
    }
    private static string Event(JavaScriptSerializer json, long total, long last) {
        return json.Serialize(new { type = "event_msg", timestamp = DateTime.UtcNow.ToString("o"), payload = new { type = "token_count", info = new {
            total_token_usage = new { total_tokens = total, input_tokens = total },
            last_token_usage = new { total_tokens = last, input_tokens = last }
        } } });
    }
}
