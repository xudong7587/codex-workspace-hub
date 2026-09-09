using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace CWUsageReporter {
    [Serializable]
    public sealed class ReporterConfig {
        public const string AppVersion = "1.0.4";
        public string HubUrl { get; set; }
        public string ProtectedKey { get; set; }
        public string DeviceId { get; set; }
        public int IntervalMinutes { get; set; }
        public double UsdCnyRate { get; set; }
        public bool StartWithWindows { get; set; }

        public ReporterConfig() {
            HubUrl = "";
            ProtectedKey = "";
            DeviceId = Slug(Environment.MachineName);
            IntervalMinutes = 5;
            UsdCnyRate = 7.2;
            StartWithWindows = true;
        }

        [ScriptIgnore]
        public string Key {
            get { return Unprotect(ProtectedKey, Entropy); }
            set { ProtectedKey = Protect(value == null ? "" : value.Trim(), Entropy); }
        }

        public static readonly string DataDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CWUsageReporter");
        public static readonly string ConfigPath = Path.Combine(DataDirectory, "config.json");
        public static readonly string BackupConfigPath = Path.Combine(DataDirectory, "config.json.bak");
        public static readonly string StartupShortcutPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Startup), "CW Token 详情采集器.lnk");
        private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("CWUsageReporter.Config.v1");
        private static readonly byte[] PluginEntropy = Encoding.UTF8.GetBytes("CWDevelopmentSync.Config.v1");

        public static ReporterConfig Load() {
            ReporterConfig current = TryLoad(ConfigPath);
            if (HasReadableSecret(current)) {
                EnsureBackup();
                return current;
            }
            ReporterConfig backup = TryLoad(BackupConfigPath);
            if (HasReadableSecret(backup)) {
                try { File.Copy(BackupConfigPath, ConfigPath, true); } catch { }
                return backup;
            }
            if (current != null) return current;
            try {
                ReporterConfig migrated = TryPluginConfig();
                if (migrated != null) { migrated.Save(); return migrated; }
            } catch { }
            return new ReporterConfig();
        }

        private static ReporterConfig TryLoad(string path) {
            try {
                if (!File.Exists(path)) return null;
                ReporterConfig value = new JavaScriptSerializer().Deserialize<ReporterConfig>(File.ReadAllText(path, Encoding.UTF8));
                if (value != null) value.Normalize();
                return value;
            } catch { return null; }
        }

        private static bool HasReadableSecret(ReporterConfig value) {
            return value != null && !String.IsNullOrWhiteSpace(value.ProtectedKey) && !String.IsNullOrWhiteSpace(value.Key);
        }

        private static void EnsureBackup() {
            try { if (!File.Exists(BackupConfigPath)) File.Copy(ConfigPath, BackupConfigPath, false); } catch { }
        }

        private static ReporterConfig TryPluginConfig() {
            string path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CWDevelopmentSync", "config.json");
            if (!File.Exists(path)) return null;
            try {
                var raw = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(path, Encoding.UTF8)) as System.Collections.Generic.Dictionary<string, object>;
                if (raw == null || !raw.ContainsKey("hubUrl") || !raw.ContainsKey("protectedSecret")) return null;
                ReporterConfig value = new ReporterConfig();
                value.HubUrl = Convert.ToString(raw["hubUrl"]).Trim().TrimEnd('/');
                if (raw.ContainsKey("deviceId")) value.DeviceId = Slug(Convert.ToString(raw["deviceId"]));
                string secret = Unprotect(Convert.ToString(raw["protectedSecret"]), PluginEntropy);
                if (String.IsNullOrWhiteSpace(secret)) return null;
                value.Key = secret;
                return value;
            } catch { return null; }
        }

        private void Normalize() {
            HubUrl = (HubUrl ?? "").Trim().TrimEnd('/');
            DeviceId = Slug(DeviceId);
            if (IntervalMinutes < 1 || IntervalMinutes > 1440) IntervalMinutes = 5;
            if (UsdCnyRate < 1 || UsdCnyRate > 20) UsdCnyRate = 7.2;
        }

        public bool IsReady() {
            Uri uri;
            return Uri.TryCreate(HubUrl, UriKind.Absolute, out uri) && uri.Scheme == Uri.UriSchemeHttps && !String.IsNullOrWhiteSpace(Key);
        }

        public void Save() {
            Normalize();
            Directory.CreateDirectory(DataDirectory);
            string temporary = ConfigPath + ".tmp";
            File.WriteAllText(temporary, new JavaScriptSerializer().Serialize(this), new UTF8Encoding(false));
            if (File.Exists(ConfigPath)) {
                File.Replace(temporary, ConfigPath, BackupConfigPath);
            } else {
                File.Move(temporary, ConfigPath);
                File.Copy(ConfigPath, BackupConfigPath, true);
            }
            ApplyStartupSetting();
        }

        public void ApplyStartupSetting() {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Run", true)) {
                if (key != null) {
                    key.DeleteValue("CodexWorkspaceCollector", false);
                    key.DeleteValue("CWUsageReporter", false);
                }
            }
            if (StartWithWindows) WriteStartupShortcut(StartupShortcutPath, System.Windows.Forms.Application.ExecutablePath);
            else if (File.Exists(StartupShortcutPath)) File.Delete(StartupShortcutPath);
        }

        private static void WriteStartupShortcut(string shortcutPath, string targetPath) {
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null) throw new InvalidOperationException("Windows 快捷方式服务不可用");
            object shell = null;
            object shortcut = null;
            try {
                shell = Activator.CreateInstance(shellType);
                shortcut = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { shortcutPath });
                Type shortcutType = shortcut.GetType();
                shortcutType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { targetPath });
                shortcutType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { Path.GetDirectoryName(targetPath) });
                shortcutType.InvokeMember("Arguments", BindingFlags.SetProperty, null, shortcut, new object[] { "--background" });
                shortcutType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { "CW Token 详情采集器" });
                shortcutType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            } finally {
                if (shortcut != null && Marshal.IsComObject(shortcut)) Marshal.FinalReleaseComObject(shortcut);
                if (shell != null && Marshal.IsComObject(shell)) Marshal.FinalReleaseComObject(shell);
            }
        }

        public static string Slug(string value) {
            StringBuilder output = new StringBuilder();
            foreach (char c in (value ?? "").Trim().ToLowerInvariant()) {
                if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.') output.Append(c);
                else if (output.Length > 0 && output[output.Length - 1] != '-') output.Append('-');
            }
            string text = output.ToString().Trim('-');
            if (text.Length >= 3) return text.Substring(0, Math.Min(63, text.Length));
            byte[] hash = SHA256.Create().ComputeHash(Encoding.UTF8.GetBytes(value ?? Environment.MachineName));
            return "pc-" + BitConverter.ToString(hash, 0, 4).Replace("-", "").ToLowerInvariant();
        }

        private static string Protect(string value, byte[] entropy) {
            if (String.IsNullOrEmpty(value)) return "";
            byte[] bytes = Encoding.UTF8.GetBytes(value);
            try { return Convert.ToBase64String(ProtectedData.Protect(bytes, entropy, DataProtectionScope.CurrentUser)); }
            finally { Array.Clear(bytes, 0, bytes.Length); }
        }

        private static string Unprotect(string value, byte[] entropy) {
            try {
                if (String.IsNullOrEmpty(value)) return "";
                byte[] plain = ProtectedData.Unprotect(Convert.FromBase64String(value), entropy, DataProtectionScope.CurrentUser);
                try { return Encoding.UTF8.GetString(plain); } finally { Array.Clear(plain, 0, plain.Length); }
            } catch { return ""; }
        }
    }
}
