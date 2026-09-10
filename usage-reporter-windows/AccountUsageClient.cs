using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace CWUsageReporter {
    // Only numeric usage and a hashed account identity leave this process.
    public static class AccountUsageClient {
        public static Dictionary<string, object> Read() {
            var result = new Dictionary<string, object> { { "status", "unavailable" } };
            Process process = null;
            try {
                string executable = FindCodex();
                if (executable == null) { result["reason"] = "codex_not_found"; return result; }
                process = new Process { StartInfo = new ProcessStartInfo(executable, "app-server") {
                    UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true,
                    RedirectStandardOutput = true, RedirectStandardError = true,
                    StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
                } };
                process.ErrorDataReceived += delegate { }; // Drain diagnostics, never upload or log auth data.
                process.Start(); process.BeginErrorReadLine();
                var json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
                Request(process, json, 1, "initialize", new { clientInfo = new { name = "cw-usage-reporter", version = ReporterConfig.AppVersion }, capabilities = new { experimentalApi = false } });
                process.StandardInput.WriteLine("{\"method\":\"initialized\"}"); process.StandardInput.Flush();
                var account = Dict(Request(process, json, 2, "account/read", new { refreshToken = false }), "account");
                string email = Text(account, "email").Trim().ToLowerInvariant();
                if (Text(account, "type") != "chatgpt" || email.Length == 0) {
                    result["reason"] = "chatgpt_identity_unavailable"; return result;
                }
                using (SHA256 sha = SHA256.Create()) {
                    result["accountKey"] = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes("cw-chatgpt-usage-v1:" + email))).Replace("-", "").ToLowerInvariant();
                }
                var usage = Request(process, json, 3, "account/usage/read", null);
                // Confirm the user did not switch accounts during the request.
                var after = Dict(Request(process, json, 4, "account/read", new { refreshToken = false }), "account");
                if (!String.Equals(email, Text(after, "email").Trim(), StringComparison.OrdinalIgnoreCase)) {
                    result.Remove("accountKey"); result["reason"] = "account_changed"; return result;
                }
                var summary = Dict(usage, "summary");
                object tokens;
                result["lifetimeTokens"] = summary != null && summary.TryGetValue("lifetimeTokens", out tokens) ? tokens : null;
                var buckets = new List<object>();
                object raw;
                var rows = usage.TryGetValue("dailyUsageBuckets", out raw) ? raw as System.Collections.IEnumerable : null;
                if (rows != null) foreach (object row in rows) {
                    var bucket = row as Dictionary<string, object>;
                    if (bucket != null && bucket.TryGetValue("tokens", out tokens)) buckets.Add(new Dictionary<string, object> { { "startDate", Text(bucket, "startDate") }, { "tokens", tokens } });
                }
                result["dailyUsageBuckets"] = rows == null ? null : buckets;
                result["capturedAt"] = DateTime.UtcNow.ToString("o");
                result["status"] = "available";
            } catch {
                // Stable diagnostic only; upstream errors may contain credentials or account details.
                result["reason"] = "account_usage_request_failed";
            } finally {
                if (process != null) {
                    try { process.StandardInput.Close(); if (!process.WaitForExit(1500)) { process.Kill(); process.WaitForExit(1500); } } catch { }
                    process.Dispose();
                }
            }
            return result;
        }

        private static Dictionary<string, object> Request(Process process, JavaScriptSerializer json, int id, string method, object parameters) {
            var message = new Dictionary<string, object> { { "id", id }, { "method", method } };
            if (parameters != null) message["params"] = parameters;
            process.StandardInput.WriteLine(json.Serialize(message)); process.StandardInput.Flush();
            Stopwatch deadline = Stopwatch.StartNew();
            while (deadline.ElapsedMilliseconds < 15000) {
                Task<string> read = process.StandardOutput.ReadLineAsync();
                if (!read.Wait((int)Math.Max(1, 15000 - deadline.ElapsedMilliseconds))) throw new TimeoutException();
                string line = read.Result;
                if (line == null) throw new IOException();
                var response = json.Deserialize<Dictionary<string, object>>(line);
                object responseId;
                if (!response.TryGetValue("id", out responseId) || Convert.ToString(responseId) != id.ToString()) continue;
                if (response.ContainsKey("error")) throw new InvalidOperationException();
                return Dict(response, "result") ?? new Dictionary<string, object>();
            }
            throw new TimeoutException();
        }

        private static string FindCodex() {
            string installed = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OpenAI", "Codex", "bin");
            if (Directory.Exists(installed)) {
                var files = new List<string>(Directory.GetFiles(installed, "codex.exe", SearchOption.AllDirectories));
                files.Sort((a, b) => File.GetLastWriteTimeUtc(b).CompareTo(File.GetLastWriteTimeUtc(a)));
                if (files.Count > 0) return files[0];
            }
            foreach (string directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator)) {
                if (String.IsNullOrWhiteSpace(directory)) continue;
                string candidate = Path.Combine(directory.Trim('"'), "codex.exe");
                if (File.Exists(candidate)) return candidate;
            }
            return null;
        }
        private static Dictionary<string, object> Dict(Dictionary<string, object> value, string key) {
            object raw; return value != null && value.TryGetValue(key, out raw) ? raw as Dictionary<string, object> : null;
        }
        private static string Text(Dictionary<string, object> value, string key) {
            object raw; return value != null && value.TryGetValue(key, out raw) && raw != null ? Convert.ToString(raw) : "";
        }
    }
}
