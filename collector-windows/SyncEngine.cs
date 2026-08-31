using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace CodexWorkspaceCollector {
    [Serializable]
    public sealed class LocalFileState { public string Hash { get; set; } public long Revision { get; set; } }
    [Serializable]
    public sealed class WorkspaceState {
        public long Revision { get; set; }
        public Dictionary<string, LocalFileState> Files { get; set; }
        public WorkspaceState() { Files = new Dictionary<string, LocalFileState>(StringComparer.OrdinalIgnoreCase); }
    }

    public static class SyncEngine {
        private static readonly HashSet<string> Skipped = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            ".git", ".svn", ".hg", ".codex", ".ssh", ".vs", ".idea", ".gradle", ".cache", ".next", ".nuxt", ".turbo",
            "node_modules", ".venv", "venv", "__pycache__", "bin", "obj", "dist", "build", "target", "out", "coverage"
        };
        private static readonly HashSet<string> SecretNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            ".env", "auth.json", "credentials.json", "secrets.json", "id_rsa", "id_ed25519"
        };
        private static readonly HashSet<string> SecretExtensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            ".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"
        };
        private static readonly HashSet<string> TemporaryExtensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            ".tmp", ".temp", ".swp", ".swo", ".lock", ".log"
        };

        public static void SyncConfigured(CollectorConfig config, HubClient hub, Action<string> log) {
            if (config.SyncProjectDocuments) foreach (SyncFolder folder in config.Folders) {
                if (folder != null && Directory.Exists(folder.Path)) SyncWorkspace(config, hub, folder.WorkspaceId, folder.Path, false, log);
            }
            if (config.BackupConversations) BackupConversations(config, hub, log);
        }

        private static void BackupConversations(CollectorConfig config, HubClient hub, Action<string> log) {
            string codex = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
            string backup = Path.Combine(CollectorConfig.DataDirectory, "ConversationBackups");
            Directory.CreateDirectory(backup);
            foreach (string name in new [] { "sessions", "archived_sessions" }) {
                string source = Path.Combine(codex, name);
                if (!Directory.Exists(source)) continue;
                SyncWorkspace(config, hub, "codex-chats-" + name, source, true, log);
            }
        }

        public static void SyncWorkspace(CollectorConfig config, HubClient hub, string workspaceId, string root, bool backupOnly, Action<string> log) {
            workspaceId = CollectorConfig.Slug(workspaceId);
            WorkspaceState state = LoadState(workspaceId);
            Dictionary<string, object> pulled = hub.Post("/api/collector/v1/sync/pull", new Dictionary<string, object> {
                { "workspaceId", workspaceId }, { "sinceRevision", state.Revision }
            });
            long remoteRevision = Number(pulled, "revision");
            object rawFiles;
            IEnumerable remoteFiles = pulled.TryGetValue("files", out rawFiles) ? rawFiles as IEnumerable : null;
            bool appliedAll = true;
            if (remoteFiles != null) foreach (object raw in remoteFiles) {
                Dictionary<string, object> entry = raw as Dictionary<string, object>;
                if (entry == null) continue;
                if (!ApplyRemote(config, root, workspaceId, backupOnly, entry, state, log)) appliedAll = false;
            }
            if (appliedAll) state.Revision = Math.Max(state.Revision, remoteRevision);

            List<Dictionary<string, object>> pending = new List<Dictionary<string, object>>();
            int pendingEncodedBytes = 0;
            foreach (string file in EnumerateFiles(root, backupOnly, backupOnly ? 120 : 5)) {
                string relative = Relative(root, file);
                byte[] plain;
                try { plain = File.ReadAllBytes(file); } catch (IOException) { continue; }
                if (plain.Length > 7 * 1024 * 1024) continue;
                string hash = Hex(SHA256.Create().ComputeHash(plain));
                LocalFileState previous;
                if (state.Files.TryGetValue(relative, out previous) && previous.Hash == hash) continue;
                string encrypted = Convert.ToBase64String(Encrypt(plain, config.Key));
                if (pending.Count > 0 && pendingEncodedBytes + encrypted.Length > 8 * 1024 * 1024) {
                    PushBatch(hub, workspaceId, config.DeviceId, pending, state, log);
                    pendingEncodedBytes = 0;
                }
                pending.Add(new Dictionary<string, object> {
                    { "path", relative }, { "hash", hash }, { "baseRevision", previous == null ? 0 : previous.Revision },
                    { "size", plain.Length }, { "modifiedAt", File.GetLastWriteTimeUtc(file).ToString("o") },
                    { "blob", encrypted }
                });
                pendingEncodedBytes += encrypted.Length;
                if (pending.Count == 32) { PushBatch(hub, workspaceId, config.DeviceId, pending, state, log); pendingEncodedBytes = 0; }
            }
            if (pending.Count > 0) PushBatch(hub, workspaceId, config.DeviceId, pending, state, log);
            SaveState(workspaceId, state);
        }

        private static bool ApplyRemote(CollectorConfig config, string root, string workspaceId, bool backupOnly,
            Dictionary<string, object> entry, WorkspaceState state, Action<string> log) {
            string relative = Text(entry, "path");
            string remoteHash = Text(entry, "hash");
            long revision = Number(entry, "revision");
            byte[] plain;
            try { plain = Decrypt(Convert.FromBase64String(Text(entry, "blob")), config.Key); }
            catch { log("无法解密远端文件：" + relative); return false; }
            string destination;
            if (backupOnly) destination = Path.Combine(CollectorConfig.DataDirectory, "ConversationBackups", workspaceId, relative.Replace('/', Path.DirectorySeparatorChar));
            else destination = Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar));
            string fullRoot = Path.GetFullPath(backupOnly ? Path.Combine(CollectorConfig.DataDirectory, "ConversationBackups", workspaceId) : root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            destination = Path.GetFullPath(destination);
            if (!destination.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase)) return false;
            LocalFileState previous;
            state.Files.TryGetValue(relative, out previous);
            if (!backupOnly && File.Exists(destination)) {
                string localHash = HashFile(destination);
                bool localChanged = previous == null ? localHash != remoteHash : localHash != previous.Hash;
                if (localChanged && localHash != remoteHash) {
                    string conflict = destination + ".codex-sync-conflict-" + DateTime.Now.ToString("yyyyMMdd-HHmmssfff");
                    Directory.CreateDirectory(Path.GetDirectoryName(conflict));
                    File.Copy(destination, conflict, false);
                    log("检测到双端修改，已保留冲突副本：" + conflict);
                }
            }
            Directory.CreateDirectory(Path.GetDirectoryName(destination));
            File.WriteAllBytes(destination, plain);
            state.Files[relative] = new LocalFileState { Hash = remoteHash, Revision = revision };
            return true;
        }

        private static void PushBatch(HubClient hub, string workspaceId, string deviceId, List<Dictionary<string, object>> files,
            WorkspaceState state, Action<string> log) {
            Dictionary<string, object> response = hub.Post("/api/collector/v1/sync/push", new Dictionary<string, object> {
                { "workspaceId", workspaceId }, { "deviceId", deviceId }, { "files", files.ToArray() }
            });
            object raw;
            IEnumerable accepted = response.TryGetValue("accepted", out raw) ? raw as IEnumerable : null;
            if (accepted != null) foreach (object item in accepted) {
                Dictionary<string, object> entry = item as Dictionary<string, object>; if (entry == null) continue;
                state.Files[Text(entry, "path")] = new LocalFileState { Hash = Text(entry, "hash"), Revision = Number(entry, "revision") };
            }
            IEnumerable conflicts = response.TryGetValue("conflicts", out raw) ? raw as IEnumerable : null;
            int conflictCount = 0;
            if (conflicts != null) foreach (object ignored in conflicts) conflictCount++;
            if (conflictCount > 0) log("有 " + conflictCount + " 个文件在其他电脑被修改，将在下次同步生成冲突副本。");
            else state.Revision = Math.Max(state.Revision, Number(response, "revision"));
            files.Clear();
        }

        private static IEnumerable<string> EnumerateFiles(string root, bool jsonlOnly, int stableSeconds) {
            DateTime stableBefore = DateTime.UtcNow.AddSeconds(-Math.Max(1, stableSeconds));
            Stack<string> pending = new Stack<string>(); pending.Push(root);
            while (pending.Count > 0) {
                string folder = pending.Pop();
                string[] children;
                try { children = Directory.GetDirectories(folder); } catch { continue; }
                foreach (string child in children) if (!Skipped.Contains(Path.GetFileName(child))) pending.Push(child);
                string[] files;
                try { files = Directory.GetFiles(folder); } catch { continue; }
                foreach (string file in files) {
                    string ext = Path.GetExtension(file);
                    DateTime modified;
                    try { modified = File.GetLastWriteTimeUtc(file); } catch { continue; }
                    if (modified > stableBefore) continue;
                    if (jsonlOnly) {
                        if (ext.Equals(".jsonl", StringComparison.OrdinalIgnoreCase)) yield return file;
                        continue;
                    }
                    string name = Path.GetFileName(file);
                    if (SecretNames.Contains(name) || name.StartsWith(".env.", StringComparison.OrdinalIgnoreCase)) continue;
                    if (SecretExtensions.Contains(ext) || TemporaryExtensions.Contains(ext)) continue;
                    yield return file;
                }
            }
        }

        private static byte[] Encrypt(byte[] plain, string secret) {
            byte[] encKey = SHA256.Create().ComputeHash(Encoding.UTF8.GetBytes("enc\0" + secret));
            byte[] macKey = SHA256.Create().ComputeHash(Encoding.UTF8.GetBytes("mac\0" + secret));
            using (Aes aes = Aes.Create()) {
                aes.Key = encKey; aes.GenerateIV(); aes.Mode = CipherMode.CBC; aes.Padding = PaddingMode.PKCS7;
                byte[] cipher; using (ICryptoTransform transform = aes.CreateEncryptor()) cipher = transform.TransformFinalBlock(plain, 0, plain.Length);
                byte[] body = new byte[1 + aes.IV.Length + cipher.Length]; body[0] = 1;
                Buffer.BlockCopy(aes.IV, 0, body, 1, aes.IV.Length); Buffer.BlockCopy(cipher, 0, body, 17, cipher.Length);
                byte[] mac = new HMACSHA256(macKey).ComputeHash(body);
                byte[] output = new byte[body.Length + mac.Length]; Buffer.BlockCopy(body, 0, output, 0, body.Length); Buffer.BlockCopy(mac, 0, output, body.Length, mac.Length);
                return output;
            }
        }

        private static byte[] Decrypt(byte[] value, string secret) {
            if (value.Length < 50 || value[0] != 1) throw new InvalidDataException("encrypted blob is invalid");
            byte[] encKey = SHA256.Create().ComputeHash(Encoding.UTF8.GetBytes("enc\0" + secret));
            byte[] macKey = SHA256.Create().ComputeHash(Encoding.UTF8.GetBytes("mac\0" + secret));
            int bodyLength = value.Length - 32; byte[] body = new byte[bodyLength]; Buffer.BlockCopy(value, 0, body, 0, bodyLength);
            byte[] expected = new HMACSHA256(macKey).ComputeHash(body); int diff = 0;
            for (int i = 0; i < 32; i++) diff |= expected[i] ^ value[bodyLength + i];
            if (diff != 0) throw new CryptographicException("encrypted blob authentication failed");
            byte[] iv = new byte[16]; Buffer.BlockCopy(value, 1, iv, 0, 16);
            using (Aes aes = Aes.Create()) {
                aes.Key = encKey; aes.IV = iv; aes.Mode = CipherMode.CBC; aes.Padding = PaddingMode.PKCS7;
                using (ICryptoTransform transform = aes.CreateDecryptor()) return transform.TransformFinalBlock(value, 17, bodyLength - 17);
            }
        }

        private static string Relative(string root, string path) {
            Uri rootUri = new Uri(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar);
            return Uri.UnescapeDataString(rootUri.MakeRelativeUri(new Uri(Path.GetFullPath(path))).ToString()).Replace('\\', '/');
        }
        private static string HashFile(string path) { using (FileStream stream = File.OpenRead(path)) return Hex(SHA256.Create().ComputeHash(stream)); }
        private static string Hex(byte[] bytes) { StringBuilder text = new StringBuilder(bytes.Length * 2); foreach (byte b in bytes) text.Append(b.ToString("x2")); return text.ToString(); }
        private static string Text(Dictionary<string, object> value, string key) { object raw; return value != null && value.TryGetValue(key, out raw) && raw != null ? Convert.ToString(raw) : ""; }
        private static long Number(Dictionary<string, object> value, string key) { long result; return Int64.TryParse(Text(value, key), out result) ? result : 0; }
        private static string StatePath(string workspaceId) { return Path.Combine(CollectorConfig.DataDirectory, "state-" + CollectorConfig.Slug(workspaceId) + ".json"); }
        private static WorkspaceState LoadState(string id) { try { return new JavaScriptSerializer().Deserialize<WorkspaceState>(File.ReadAllText(StatePath(id), Encoding.UTF8)) ?? new WorkspaceState(); } catch { return new WorkspaceState(); } }
        private static void SaveState(string id, WorkspaceState state) { Directory.CreateDirectory(CollectorConfig.DataDirectory); File.WriteAllText(StatePath(id), new JavaScriptSerializer().Serialize(state), new UTF8Encoding(false)); }
    }
}
