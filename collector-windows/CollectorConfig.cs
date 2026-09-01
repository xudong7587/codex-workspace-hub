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
        public string Name { get; set; }
        public string Path { get; set; }
        public bool Enabled { get; set; }
        public string Direction { get; set; }
        public SyncFolder() { WorkspaceId = "project"; Name = ""; Path = ""; Enabled = true; Direction = "both"; }
    }

    [Serializable]
    public sealed class CollectorConfig {
        public const string AppVersion = "0.9.4";
        public string HubUrl { get; set; }
        public string ProtectedKey { get; set; }
        public string DeviceId { get; set; }
        public int IntervalMinutes { get; set; }
        public double UsdCnyRate { get; set; }
        public bool SyncProjectDocuments { get; set; }
        public bool BackupConversations { get; set; }
        public bool PropagateDeletes { get; set; }
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
            BackupConversations = false;
            PropagateDeletes = false;
            SyncMode = "smart";
            QuietSeconds = 90;
            SyncTimes = "08:00,12:00,18:00,23:00";
            Folders = new List<SyncFolder>();
        }

        [ScriptIgnore]
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
                bool foldersMigrated = rawConfiguration.IndexOf("\"Name\"", StringComparison.OrdinalIgnoreCase) < 0;
                Dictionary<string, int> originalIds = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                Dictionary<string, int> originalNames = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
                foreach (SyncFolder folder in value.Folders) if (folder != null) {
                    string originalId = String.IsNullOrWhiteSpace(folder.WorkspaceId) ? "windows-pc" : folder.WorkspaceId;
                    originalIds[originalId] = originalIds.ContainsKey(originalId) ? originalIds[originalId] + 1 : 1;
                    string originalName = (folder.Name ?? "").Trim();
                    if (!String.IsNullOrWhiteSpace(originalName)) originalNames[originalName] = originalNames.ContainsKey(originalName) ? originalNames[originalName] + 1 : 1;
                }
                HashSet<string> usedIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                HashSet<string> usedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (SyncFolder folder in value.Folders) {
                    if (folder == null) continue;
                    if (legacyFolders) folder.Enabled = false;
                    if (String.IsNullOrWhiteSpace(folder.Direction)) folder.Direction = "both";
                    if (folder.Direction != "both" && folder.Direction != "upload" && folder.Direction != "download") folder.Direction = "both";
                    string directoryName = Path.GetFileName((folder.Path ?? "").TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
                    string originalName = (folder.Name ?? "").Trim();
                    bool placeholderName = String.IsNullOrWhiteSpace(originalName)
                        || ((String.Equals(originalName, "项目", StringComparison.OrdinalIgnoreCase) || String.Equals(originalName, "windows-pc", StringComparison.OrdinalIgnoreCase))
                            && originalNames.ContainsKey(originalName) && originalNames[originalName] > 1);
                    string displayName = placeholderName ? (String.IsNullOrWhiteSpace(directoryName) ? folder.WorkspaceId : directoryName) : originalName;
                    if (String.IsNullOrWhiteSpace(displayName)) displayName = "项目";
                    string uniqueName = displayName;
                    int nameSuffix = 2;
                    while (!usedNames.Add(uniqueName)) uniqueName = displayName + " (" + nameSuffix++ + ")";
                    bool nameChanged = !String.Equals(folder.Name, uniqueName, StringComparison.Ordinal);
                    if (nameChanged) { folder.Name = uniqueName; foldersMigrated = true; }
                    string originalId = String.IsNullOrWhiteSpace(folder.WorkspaceId) ? "windows-pc" : folder.WorkspaceId;
                    string candidate = nameChanged || (originalIds.ContainsKey(originalId) && originalIds[originalId] > 1) ? Slug(folder.Name) : Slug(originalId);
                    if (!usedIds.Add(candidate)) {
                        candidate = candidate + "-" + StableHash((folder.Path ?? "") + "\0" + folder.Name, 4);
                        int idSuffix = 2;
                        string uniqueId = candidate;
                        while (!usedIds.Add(uniqueId)) uniqueId = candidate + "-" + idSuffix++;
                        candidate = uniqueId; foldersMigrated = true;
                    }
                    if (!String.Equals(folder.WorkspaceId, candidate, StringComparison.Ordinal)) { folder.WorkspaceId = candidate; foldersMigrated = true; }
                }
                if (value.IntervalMinutes < 1) value.IntervalMinutes = 5;
                if (String.IsNullOrWhiteSpace(value.SyncMode)) value.SyncMode = "smart";
                if (value.SyncMode != "smart" && value.SyncMode != "scheduled" && value.SyncMode != "manual") value.SyncMode = "smart";
                if (value.QuietSeconds < 30 || value.QuietSeconds > 900) value.QuietSeconds = 90;
                if (String.IsNullOrWhiteSpace(value.SyncTimes)) value.SyncTimes = "08:00,12:00,18:00,23:00";
                if (String.IsNullOrWhiteSpace(value.DeviceId)) value.DeviceId = Slug(Environment.MachineName);
                if (migratedConfiguration || foldersMigrated) value.Save();
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
            string source = (value ?? "").Trim().ToLowerInvariant();
            foreach (char c in source) {
                if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.') output.Append(c);
                else if (output.Length > 0 && output[output.Length - 1] != '-') output.Append('-');
            }
            string text = output.ToString().Trim('-');
            return text.Length >= 3 ? text.Substring(0, Math.Min(63, text.Length)) : (source.Length == 0 ? "windows-pc" : "id-" + StableHash(source, 8));
        }

        private static string StableHash(string value, int bytes) {
            byte[] hash = SHA256.Create().ComputeHash(Encoding.UTF8.GetBytes(value ?? ""));
            StringBuilder text = new StringBuilder(bytes * 2);
            for (int index = 0; index < Math.Min(bytes, hash.Length); index++) text.Append(hash[index].ToString("x2"));
            return text.ToString();
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
