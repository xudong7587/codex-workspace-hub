using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace CodexWorkspaceCollector {
    [Serializable]
    public sealed class SyncFolder {
        public string WorkspaceId { get; set; }
        public string Path { get; set; }
        public bool Enabled { get; set; }
        public string Direction { get; set; }
        public SyncFolder() { WorkspaceId = "project"; Path = ""; Enabled = true; Direction = "both"; }
    }

    [Serializable]
    public sealed class CollectorConfig {
        public string HubUrl { get; set; }
        public string ProtectedKey { get; set; }
        public string DeviceId { get; set; }
        public int IntervalMinutes { get; set; }
        public double UsdCnyRate { get; set; }
        public bool SyncProjectDocuments { get; set; }
        public bool BackupConversations { get; set; }
        public string SyncMode { get; set; }
        public int QuietSeconds { get; set; }
        public string SyncTimes { get; set; }
        public bool StartWithWindows { get; set; }
        public List<SyncFolder> Folders { get; set; }

        public CollectorConfig() {
            HubUrl = "";
            ProtectedKey = "";
            DeviceId = Slug(Environment.MachineName);
            IntervalMinutes = 5;
            UsdCnyRate = 7.2;
            SyncProjectDocuments = true;
            BackupConversations = true;
            SyncMode = "smart";
            QuietSeconds = 90;
            SyncTimes = "08:00,12:00,18:00,23:00";
            Folders = new List<SyncFolder>();
        }

        public string Key {
            get { return Unprotect(ProtectedKey); }
            set { ProtectedKey = Protect(value == null ? "" : value.Trim()); }
        }

        public static readonly string DataDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexWorkspaceCollector");
        public static readonly string ConfigPath = Path.Combine(DataDirectory, "config.json");
        private static readonly string LegacyDataDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VWatchCollector");
        private static readonly string LegacyConfigPath = Path.Combine(LegacyDataDirectory, "config.json");
        private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("CodexWorkspaceCollector.Config.v1");
        private static readonly byte[] LegacyEntropy = Encoding.UTF8.GetBytes("VWatchCollector.Config.v1");

        public static CollectorConfig Load() {
            try {
                bool migratedDirectory = false;
                if (!Directory.Exists(DataDirectory) && Directory.Exists(LegacyDataDirectory)) {
                    try { Directory.Move(LegacyDataDirectory, DataDirectory); migratedDirectory = true; } catch { }
                }
                string sourcePath = File.Exists(ConfigPath) ? ConfigPath : LegacyConfigPath;
                if (!File.Exists(sourcePath)) return new CollectorConfig();
                CollectorConfig value = new JavaScriptSerializer().Deserialize<CollectorConfig>(File.ReadAllText(sourcePath, Encoding.UTF8));
                if (value == null) return new CollectorConfig();
                bool migratedConfiguration = migratedDirectory || sourcePath.Equals(LegacyConfigPath, StringComparison.OrdinalIgnoreCase);
                if (migratedConfiguration) {
                    string legacyKey = Unprotect(value.ProtectedKey, LegacyEntropy);
                    value.ProtectedKey = Protect(legacyKey, Entropy);
                }
                if (value.Folders == null) value.Folders = new List<SyncFolder>();
                string rawConfiguration = File.ReadAllText(sourcePath, Encoding.UTF8);
                bool legacyFolders = rawConfiguration.IndexOf("\"Enabled\"", StringComparison.OrdinalIgnoreCase) < 0;
                foreach (SyncFolder folder in value.Folders) {
                    if (folder == null) continue;
                    if (legacyFolders) folder.Enabled = true;
                    if (String.IsNullOrWhiteSpace(folder.Direction)) folder.Direction = "both";
                    if (folder.Direction != "both" && folder.Direction != "upload" && folder.Direction != "download") folder.Direction = "both";
                }
                if (value.IntervalMinutes < 1) value.IntervalMinutes = 5;
                if (String.IsNullOrWhiteSpace(value.SyncMode)) value.SyncMode = "smart";
                if (value.SyncMode != "smart" && value.SyncMode != "scheduled" && value.SyncMode != "manual") value.SyncMode = "smart";
                if (value.QuietSeconds < 30 || value.QuietSeconds > 900) value.QuietSeconds = 90;
                if (String.IsNullOrWhiteSpace(value.SyncTimes)) value.SyncTimes = "08:00,12:00,18:00,23:00";
                if (String.IsNullOrWhiteSpace(value.DeviceId)) value.DeviceId = Slug(Environment.MachineName);
                if (migratedConfiguration) value.Save();
                return value;
            } catch { return new CollectorConfig(); }
        }

        public void Save() {
            Directory.CreateDirectory(DataDirectory);
            string temporary = ConfigPath + ".tmp";
            File.WriteAllText(temporary, new JavaScriptSerializer().Serialize(this), new UTF8Encoding(false));
            if (File.Exists(ConfigPath)) File.Replace(temporary, ConfigPath, null);
            else File.Move(temporary, ConfigPath);
            ApplyStartup();
        }

        public bool IsReady() {
            return Uri.IsWellFormedUriString(HubUrl, UriKind.Absolute) && !String.IsNullOrWhiteSpace(Key);
        }

        public static string Slug(string value) {
            StringBuilder output = new StringBuilder();
            foreach (char c in (value ?? "").ToLowerInvariant()) {
                if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.') output.Append(c);
                else if (output.Length > 0 && output[output.Length - 1] != '-') output.Append('-');
            }
            string text = output.ToString().Trim('-');
            return text.Length >= 3 ? text.Substring(0, Math.Min(63, text.Length)) : "windows-pc";
        }

        private static string Protect(string value) {
            return Protect(value, Entropy);
        }

        private static string Protect(string value, byte[] entropy) {
            if (String.IsNullOrEmpty(value)) return "";
            return Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(value), entropy, DataProtectionScope.CurrentUser));
        }

        private static string Unprotect(string value) {
            return Unprotect(value, Entropy);
        }

        private static string Unprotect(string value, byte[] entropy) {
            try {
                if (String.IsNullOrEmpty(value)) return "";
                return Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(value), entropy, DataProtectionScope.CurrentUser));
            } catch { return ""; }
        }

        private void ApplyStartup() {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run", true)) {
                if (key == null) return;
                key.DeleteValue("VWatchCollector", false);
                if (StartWithWindows) key.SetValue("CodexWorkspaceCollector", "\"" + System.Windows.Forms.Application.ExecutablePath + "\"");
                else key.DeleteValue("CodexWorkspaceCollector", false);
            }
        }
    }
}
