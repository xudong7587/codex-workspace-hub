using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;

namespace CWUsageReporter {
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
