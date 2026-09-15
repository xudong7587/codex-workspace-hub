using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;
using CWUsageReporter;

internal static class ReporterSmoke {
    private static void Assert(bool value, string message) { if (!value) throw new Exception(message); }
    public static void Main(string[] args) {
        var json = new JavaScriptSerializer();
        Assert(UsageFormatting.Tokens(99999999L) == "10000.0万", "Sub-100-million unit must be 万 with one decimal");
        Assert(UsageFormatting.Tokens(100000000L) == "1.0亿", "100 million threshold must use 亿 with one decimal");
        Assert(UsageFormatting.Tokens(98864107L) == "9886.4万", "Token value must round to one decimal");
        var counterMethod = typeof(UsageScanner).GetMethod("Counters", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
        var tokenParts = new Dictionary<string, object> { { "input_tokens", 100000 }, { "cached_input_tokens", 20000 }, { "output_tokens", 10000 }, { "total_tokens", 110000 } };
        var astraParts = (UsageCounters)counterMethod.Invoke(null, new object[] { tokenParts, "gpt-6-astra" });
        var solParts = (UsageCounters)counterMethod.Invoke(null, new object[] { tokenParts, "gpt-5.6-sol" });
        Assert(Math.Abs(astraParts.CostUsd - 1.32) < 0.000001 && Math.Abs(solParts.CostUsd - 0.528) < 0.000001, "Per-model input/cache/output pricing failed");
        Assert(new UsagePeriodView { TokensAvailable = true, TotalTokens = 1000000, PricedCostUsd = 4, EstimatedCostUsd = 9 }.ValueCny(7.2) == 13d * 7.2, "Value must combine model prices and explicit fallback");
        var unknownParts = (UsageCounters)counterMethod.Invoke(null, new object[] { tokenParts, "unknown-test" });
        Assert(Math.Abs(unknownParts.EstimatedCostUsd - 0.956) < 0.000001 && unknownParts.CostUsd == 0, "Sol high-tier fallback must remain separate");
        var unknownTotal = (UsageCounters)counterMethod.Invoke(null, new object[] { new Dictionary<string, object> { { "total_tokens", 1000000 } }, "unknown-test" });
        Assert(unknownTotal.EstimatedCostUsd == 30, "Unclassified tokens must use high output rate");
        Assert(new UsagePeriodView { TokensAvailable = true, TotalTokens = 0 }.ValueCny(7.2) == 0d, "Zero value missing");
        Assert(!new UsagePeriodView().ValueCny(7.2).HasValue, "Missing usage became zero value");
        var stats = json.Deserialize<Dictionary<string, object>>("{\"usage\":{\"periods\":{\"total\":{\"totalTokens\":7123456789}},\"accountUsage\":{\"periods\":{\"day\":{\"totalTokens\":null},\"total\":{\"totalTokens\":7123456789}}},\"localDetails\":{\"deviceId\":\"test-pc\",\"usdCnyRate\":7.2,\"periods\":{\"total\":{\"costUsd\":3,\"pricedCostUsd\":2,\"estimatedCostUsd\":1}}}}}");
        var view = UsageOverview.FromStats(stats, 7.2);
        Assert(view.Total.TotalTokens == 7123456789L && view.Total.TokensAvailable, "Official 64-bit counter lost");
        Assert(!view.Day.TokensAvailable, "Missing today became zero");
        Assert(view.Total.PricedCostUsd == 2 && view.Total.EstimatedCostUsd == 1, "Cost breakdown lost");
        var direct = new Dictionary<string, object> { { "status", "available" }, { "lifetimeTokens", 1000999L },
            { "dailyUsageBuckets", new object[] { new Dictionary<string, object> { { "startDate", DateTime.UtcNow.ToString("yyyy-MM-dd") }, { "tokens", 0 } } } } };
        var snapshotForView = new UsageSnapshot { Payload = new Dictionary<string, object> { { "accountUsage", direct } }, Today = new UsageCounters { TotalTokens = 123 }, Week = new UsageCounters { TotalTokens = 456 }, Month = new UsageCounters { TotalTokens = 789 }, Total = new UsageCounters { TotalTokens = 999, CostUsd = 2 } };
        var fallback = UsageOverview.FromSnapshot(snapshotForView, 7.2);
        Assert(fallback.OfficialMode && fallback.Total.TotalTokens == 1000999L, "Direct official fallback lost");
        Assert(fallback.Day.TokensAvailable && fallback.Day.TotalTokens == 123, "Official zero replaced local today");
        Assert(fallback.Week.TotalTokens == 456 && fallback.Month.TotalTokens == 789, "Official buckets replaced local periods");
        direct["dailyUsageBuckets"] = null;
        Assert(UsageOverview.FromSnapshot(snapshotForView, 7.2).Day.TotalTokens == 123, "Missing official days erased local usage");
        direct["status"] = "unavailable";
        var unavailable = UsageOverview.FromSnapshot(snapshotForView, 7.2);
        Assert(unavailable.Day.TotalTokens == 123 && unavailable.Total.TotalTokens == 999 && !unavailable.OfficialMode, "Official failure erased local fallback");
        Assert(fallback.Total.PricedCostUsd == 2, "Fallback local pricing lost");
        Assert(Math.Abs(fallback.Total.ValueCny(7.2).Value - 3.52d * 7.2) < 0.000001, "Official/local gap must use Sol high tier with 90% cache hits");
        Assert(Math.Abs(UsageFormatting.SolHighCachedEstimate(1000000) - 1.52d) < 0.000001, "Sol high cached estimate must weight 90% cached input");
        var counters = new UsageCounters { CostUsd = 2, UnpricedTokens = 250000, EstimatedCostUsd = 1 };
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
