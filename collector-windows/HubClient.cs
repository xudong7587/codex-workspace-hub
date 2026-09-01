using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace CodexWorkspaceCollector {
    public sealed class HubClient {
        public const int BlobChunkBytes = 512 * 1024;
        private readonly CollectorConfig config;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 };
        private DateTime lastProgressAt = DateTime.MinValue;
        private string lastProgressKey = "";

        public HubClient(CollectorConfig config) { this.config = config; }

        public Dictionary<string, object> Post(string path, object body) {
            return Retry(delegate { return PostOnce(path, body); });
        }

        private Dictionary<string, object> PostOnce(string path, object body) {
            byte[] bytes = Encoding.UTF8.GetBytes(json.Serialize(body));
            HttpWebRequest request = CreateRequest(path, "POST", "application/json; charset=utf-8", "application/json");
            request.ContentLength = bytes.Length;
            using (Stream stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
            return ReadJson(request);
        }

        public long PutBlobChunk(string workspaceId, string objectId, long offset, long totalBytes, byte[] value, int count) {
            Dictionary<string, object> response = Retry(delegate { return PutBlobChunkOnce(workspaceId, objectId, offset, totalBytes, value, count); });
            object raw; long received;
            if (!response.TryGetValue("receivedBytes", out raw) || !Int64.TryParse(Convert.ToString(raw), out received)) received = offset + count;
            if (received < offset || received > totalBytes) throw new InvalidDataException("CW 返回了无效的续传偏移");
            return received;
        }

        private Dictionary<string, object> PutBlobChunkOnce(string workspaceId, string objectId, long offset, long totalBytes, byte[] value, int count) {
            string path = "/api/collector/v1/sync/blob?workspaceId=" + Escape(workspaceId)
                + "&object=" + Escape(objectId) + "&offset=" + offset + "&total=" + totalBytes;
            HttpWebRequest request = CreateRequest(path, "PUT", "application/octet-stream", "application/json");
            request.ContentLength = count;
            using (Stream stream = request.GetRequestStream()) stream.Write(value, 0, count);
            return ReadJson(request);
        }

        public byte[] GetBlobChunk(string workspaceId, string objectId, long offset, int limit, out long totalBytes) {
            long receivedTotal = -1;
            byte[] value = Retry(delegate { return GetBlobChunkOnce(workspaceId, objectId, offset, limit, out receivedTotal); });
            totalBytes = receivedTotal;
            return value;
        }

        private byte[] GetBlobChunkOnce(string workspaceId, string objectId, long offset, int limit, out long totalBytes) {
            string path = "/api/collector/v1/sync/blob?workspaceId=" + Escape(workspaceId)
                + "&object=" + Escape(objectId) + "&offset=" + offset + "&limit=" + limit;
            HttpWebRequest request = CreateRequest(path, "GET", null, "application/octet-stream");
            try {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (MemoryStream output = new MemoryStream()) {
                    string total = response.Headers["X-CW-Total-Bytes"];
                    if (!Int64.TryParse(total, out totalBytes)) totalBytes = response.ContentLength;
                    using (Stream input = response.GetResponseStream()) input.CopyTo(output);
                    return output.ToArray();
                }
            } catch (WebException error) { throw RequestError(error); }
        }

        private static T Retry<T>(Func<T> operation) {
            Exception last = null;
            for (int attempt = 1; attempt <= 3; attempt++) {
                try { return operation(); }
                catch (HubRequestException error) {
                    last = error;
                    if (!error.Transient || attempt == 3) throw;
                    Thread.Sleep(attempt == 1 ? 500 : 1500);
                }
            }
            throw last ?? new InvalidOperationException("CW 请求失败");
        }

        public void ReportProgress(Dictionary<string, object> progress, bool force) {
            string key = Convert.ToString(progress.ContainsKey("status") ? progress["status"] : "") + ":"
                + Convert.ToString(progress.ContainsKey("phase") ? progress["phase"] : "") + ":"
                + Convert.ToString(progress.ContainsKey("percent") ? progress["percent"] : "");
            if (!force && key == lastProgressKey && DateTime.UtcNow - lastProgressAt < TimeSpan.FromSeconds(2)) return;
            if (!force && DateTime.UtcNow - lastProgressAt < TimeSpan.FromMilliseconds(800)) return;
            lastProgressAt = DateTime.UtcNow; lastProgressKey = key;
            try { Post("/api/collector/v1/sync/progress", progress); } catch { }
        }

        private HttpWebRequest CreateRequest(string path, string method, string contentType, string accept) {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            string root = config.HubUrl.Trim().TrimEnd('/');
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(root + path);
            request.Method = method;
            if (!String.IsNullOrEmpty(contentType)) request.ContentType = contentType;
            request.Accept = accept;
            request.Timeout = 45000;
            request.ReadWriteTimeout = 45000;
            request.KeepAlive = true;
            request.Headers[HttpRequestHeader.Authorization] = "Bearer " + config.Key;
            return request;
        }

        private Dictionary<string, object> ReadJson(HttpWebRequest request) {
            try {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
                    return json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                }
            } catch (WebException error) { throw RequestError(error); }
        }

        private static Exception RequestError(WebException error) {
            HttpWebResponse response = error.Response as HttpWebResponse;
            if (response == null) return new HubRequestException("无法连接 CW，请检查网络、HTTPS 地址与证书。", true, error);
            string detail = "";
            try { using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) detail = reader.ReadToEnd(); } catch { }
            int status = (int)response.StatusCode;
            string contentType = response.ContentType ?? "";
            bool transient = status == 408 || status == 429 || status == 500 || status == 502 || status == 503 || status == 504;
            if (status == 502 || status == 504) return new HubRequestException("CW 反向代理返回 HTTP " + status + "。已自动重试；若仍出现，请检查代理超时和上传限制。", true, error);
            string message = ExtractMessage(detail);
            if (String.IsNullOrWhiteSpace(message) && contentType.IndexOf("html", StringComparison.OrdinalIgnoreCase) >= 0) message = "反向代理返回了网页错误";
            return new HubRequestException("CW 请求失败 HTTP " + status + (String.IsNullOrWhiteSpace(message) ? "" : "：" + message), transient, error);
        }

        private static string ExtractMessage(string body) {
            if (String.IsNullOrWhiteSpace(body)) return "";
            string trimmed = body.Trim();
            if (trimmed.StartsWith("<", StringComparison.Ordinal)) return "";
            try {
                Dictionary<string, object> value = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(trimmed);
                object raw;
                if (value != null && value.TryGetValue("message", out raw)) return Convert.ToString(raw);
                if (value != null && value.TryGetValue("error", out raw)) return Convert.ToString(raw);
            } catch { }
            return trimmed.Length > 240 ? trimmed.Substring(0, 240) : trimmed;
        }

        private static string Escape(string value) { return Uri.EscapeDataString(value ?? ""); }
    }

    internal sealed class HubRequestException : InvalidOperationException {
        public bool Transient { get; private set; }
        public HubRequestException(string message, bool transient, Exception inner) : base(message, inner) { Transient = transient; }
    }
}
