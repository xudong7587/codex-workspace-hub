using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;

namespace VWatchCollector {
    public sealed class HubClient {
        private readonly CollectorConfig config;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 };

        public HubClient(CollectorConfig config) { this.config = config; }

        public Dictionary<string, object> Post(string path, object body) {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            string root = config.HubUrl.Trim().TrimEnd('/');
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(root + path);
            request.Method = "POST";
            request.ContentType = "application/json; charset=utf-8";
            request.Accept = "application/json";
            request.Timeout = 30000;
            request.ReadWriteTimeout = 30000;
            request.Headers[HttpRequestHeader.Authorization] = "Bearer " + config.Key;
            byte[] bytes = Encoding.UTF8.GetBytes(json.Serialize(body));
            request.ContentLength = bytes.Length;
            using (Stream stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
            try {
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) {
                    return json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                }
            } catch (WebException error) {
                HttpWebResponse response = error.Response as HttpWebResponse;
                string detail = "";
                if (response != null) using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8)) detail = reader.ReadToEnd();
                throw new InvalidOperationException("Hub 请求失败" + (response == null ? "" : " HTTP " + (int)response.StatusCode) + (detail.Length == 0 ? "" : ": " + detail));
            }
        }
    }
}
