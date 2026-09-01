using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace CodexWorkspaceCollector {
    [Serializable]
    public sealed class LocalFileState { public string Hash { get; set; } public long Revision { get; set; } public bool Deleted { get; set; } }
    [Serializable]
    public sealed class WorkspaceState {
        public long Revision { get; set; }
        public bool Initialized { get; set; }
        public Dictionary<string, LocalFileState> Files { get; set; }
        public WorkspaceState() { Files = new Dictionary<string, LocalFileState>(StringComparer.OrdinalIgnoreCase); }
    }
    public sealed class SyncProgressInfo {
        public string Status { get; set; }
        public string Phase { get; set; }
        public string WorkspaceId { get; set; }
        public string WorkspaceName { get; set; }
        public string CurrentFile { get; set; }
        public string Message { get; set; }
        public int Percent { get; set; }
        public int WorkspacePercent { get; set; }
        public int CompletedFiles { get; set; }
        public int TotalFiles { get; set; }
        public long TransferredBytes { get; set; }
        public long TotalBytes { get; set; }
    }
    internal sealed class SyncTarget {
        public string WorkspaceId, Name, Root, Direction;
        public bool BackupOnly;
    }
    internal sealed class UploadResult { public int Conflicts; public long Revision; }

    public static class SyncEngine {
        private const int FallbackMaxPlainFileBytes = 7 * 1024 * 1024;
        private static readonly HashSet<string> Skipped = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            ".git", ".svn", ".hg", ".codex", ".ssh", ".vs", ".idea", ".gradle", ".cache", ".next", ".nuxt", ".turbo",
            "node_modules", ".venv", "venv", "__pycache__", "bin", "obj", "dist", "build", "target", "out", "coverage", ".codex-sync-recovery"
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

        public static void SyncConfigured(CollectorConfig config, HubClient hub, Action<string> log, Action<SyncProgressInfo> progress) {
            List<SyncTarget> targets = new List<SyncTarget>();
            List<string> failures = new List<string>();
            if (config.SyncProjectDocuments) foreach (SyncFolder folder in config.Folders ?? new List<SyncFolder>()) {
                if (folder == null || !folder.Enabled || String.IsNullOrWhiteSpace(folder.Path)) continue;
                string direction = NormalizeDirection(folder.Direction);
                if (!Directory.Exists(folder.Path)) {
                    if (direction == "download") Directory.CreateDirectory(folder.Path);
                    else { log("跳过不存在的项目目录：" + folder.Path); continue; }
                }
                targets.Add(new SyncTarget { WorkspaceId = CollectorConfig.Slug(folder.WorkspaceId), Name = String.IsNullOrWhiteSpace(folder.Name) ? folder.WorkspaceId : folder.Name, Root = folder.Path, Direction = direction, BackupOnly = false });
            }
            if (config.BackupConversations) AddConversationTargets(targets);
            if (targets.Count == 0) {
                Emit(config, hub, progress, new SyncProgressInfo { Status = "complete", Phase = "无需同步", WorkspaceId = "all", WorkspaceName = "未选择项目", Percent = 100, WorkspacePercent = 100, Message = "请在项目清单中勾选要同步的项目" }, true);
                return;
            }
            for (int index = 0; index < targets.Count; index++) {
                SyncTarget target = targets[index];
                int current = index;
                Action<SyncProgressInfo> targetProgress = delegate(SyncProgressInfo info) {
                    info.Percent = Math.Max(0, Math.Min(100, (int)Math.Round((current * 100.0 + info.WorkspacePercent) / targets.Count)));
                    Emit(config, hub, progress, info, info.Status != "running" || info.WorkspacePercent == 0);
                };
                try { SyncWorkspace(config, hub, target, log, targetProgress); }
                catch (Exception error) {
                    failures.Add(target.Name + "：" + error.Message);
                    log("项目同步失败 " + target.Name + "：" + error.Message);
                    Report(targetProgress, target, "error", "项目同步失败", 100, "", 0, 0, 0, 0, error.Message);
                }
            }
            if (failures.Count > 0) throw new InvalidOperationException(String.Join("；", failures.ToArray()));
        }

        private static void AddConversationTargets(List<SyncTarget> targets) {
            string codex = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
            string backup = Path.Combine(CollectorConfig.DataDirectory, "ConversationBackups");
            Directory.CreateDirectory(backup);
            foreach (string name in new [] { "sessions", "archived_sessions" }) {
                string source = Path.Combine(codex, name);
                if (Directory.Exists(source)) targets.Add(new SyncTarget { WorkspaceId = "codex-chats-" + name, Name = "Codex 对话 " + name, Root = source, Direction = "upload", BackupOnly = true });
            }
        }

        private static void SyncWorkspace(CollectorConfig config, HubClient hub, SyncTarget target, Action<string> log, Action<SyncProgressInfo> progress) {
            string workspaceId = CollectorConfig.Slug(target.WorkspaceId);
            WorkspaceState state = LoadState(workspaceId);
            bool fullPull = !state.Initialized || (target.Direction == "download" && NeedsLocalRepair(target.Root, state));
            Report(progress, target, "running", fullPull ? "核对完整云端清单" : "读取云端增量清单", 1, "", 0, 0, 0, 0, fullPull ? "首次同步或本机文件缺失，正在执行完整校验" : "正在比较远端版本");
            Dictionary<string, object> pulled = hub.Post("/api/collector/v1/sync/pull", new Dictionary<string, object> {
                { "protocolVersion", 3 }, { "workspaceId", workspaceId }, { "workspaceName", target.Name }, { "deviceId", config.DeviceId },
                { "sinceRevision", state.Revision }, { "metadataOnly", true }, { "full", fullPull }
            });
            long remoteRevision = Number(pulled, "revision");
            long advertisedMax = Number(pulled, "maxBlobBytes");
            int maxPlainFileBytes = advertisedMax > 1024 ? (int)Math.Min(Int32.MaxValue, advertisedMax - 64) : FallbackMaxPlainFileBytes;
            List<Dictionary<string, object>> remoteFiles = Dictionaries(pulled, "files");
            if (target.Direction != "upload") {
                DownloadRemote(config, hub, target, state, remoteFiles, remoteRevision, log, progress);
                SaveState(workspaceId, state);
            }
            else Report(progress, target, "running", "仅上传模式", 34, "", 0, 0, 0, 0, "已跳过云端文件下载");

            UploadResult upload;
            if (target.Direction != "download") upload = UploadLocal(config, hub, target, state, maxPlainFileBytes, log, progress);
            else {
                upload = new UploadResult { Revision = state.Revision };
                Report(progress, target, "running", "仅下载模式", 96, "", remoteFiles.Count, remoteFiles.Count, 0, 0, "已跳过本机文件上传");
            }
            if (upload.Conflicts > 0) {
                if (target.Direction == "upload") throw new InvalidOperationException("远端已有 " + upload.Conflicts + " 个较新文件；仅上传模式未覆盖远端，请改为双向同步处理冲突");
                Dictionary<string, object> retryPull = hub.Post("/api/collector/v1/sync/pull", new Dictionary<string, object> {
                    { "protocolVersion", 3 }, { "workspaceId", workspaceId }, { "workspaceName", target.Name }, { "deviceId", config.DeviceId },
                    { "sinceRevision", state.Revision }, { "metadataOnly", true }
                });
                List<Dictionary<string, object>> retryFiles = Dictionaries(retryPull, "files");
                DownloadRemote(config, hub, target, state, retryFiles, Number(retryPull, "revision"), log, progress);
                SaveState(workspaceId, state);
            } else state.Revision = Math.Max(state.Revision, upload.Revision);
            state.Initialized = true;
            SaveState(workspaceId, state);
            Report(progress, target, "complete", "同步完成", 100, "", 0, 0, 0, 0, DirectionLabel(target.Direction) + "完成");
        }

        private static void DownloadRemote(CollectorConfig config, HubClient hub, SyncTarget target, WorkspaceState state,
            List<Dictionary<string, object>> remoteFiles, long remoteRevision, Action<string> log, Action<SyncProgressInfo> progress) {
            long totalBytes = 0, transferred = 0; int completed = 0; bool appliedAll = true;
            foreach (Dictionary<string, object> entry in remoteFiles) if (!Boolean(entry, "deleted")) totalBytes += Math.Max(0, Number(entry, "encryptedSize"));
            foreach (Dictionary<string, object> entry in remoteFiles) {
                string relative = Text(entry, "path");
                string objectId = Text(entry, "object");
                try {
                    if (Boolean(entry, "deleted")) {
                        if (!ApplyRemoteTombstone(target.Root, relative, entry, state, log)) appliedAll = false;
                        completed++;
                        Report(progress, target, "running", "归档云端删除", 3 + (int)Math.Min(29, completed * 29 / Math.Max(1, remoteFiles.Count)), relative, completed, remoteFiles.Count, transferred, totalBytes, "文件已移入可恢复目录");
                        continue;
                    }
                    LocalFileState known; state.Files.TryGetValue(relative, out known);
                    string currentPath = SafeLocalPath(target.Root, relative); bool alreadyCurrent = false;
                    try { alreadyCurrent = known != null && !known.Deleted && String.Equals(known.Hash, Text(entry, "hash"), StringComparison.OrdinalIgnoreCase) && currentPath != null && File.Exists(currentPath) && String.Equals(HashFile(currentPath), known.Hash, StringComparison.OrdinalIgnoreCase); } catch { }
                    if (alreadyCurrent) {
                        known.Revision = Number(entry, "revision"); completed++;
                        Report(progress, target, "running", "确认已上传文件", 3 + (int)Math.Min(29, completed * 29 / Math.Max(1, remoteFiles.Count)), relative, completed, remoteFiles.Count, transferred, totalBytes, "本机内容一致，跳过重复下载");
                        continue;
                    }
                    byte[] encrypted = DownloadBlob(hub, target.WorkspaceId, objectId, delegate(long done, long total) {
                        long currentTotal = totalBytes > 0 ? totalBytes : Math.Max(total, 1);
                        int percent = 3 + (int)Math.Min(29, (transferred + done) * 29 / currentTotal);
                        Report(progress, target, "running", "下载云端更新", percent, relative, completed, remoteFiles.Count, transferred + done, currentTotal, "正在接收加密文件");
                    });
                    transferred += encrypted.Length;
                    if (!ApplyRemote(config, target.Root, target.WorkspaceId, target.BackupOnly, entry, encrypted, state, log)) appliedAll = false;
                    completed++;
                } catch (Exception error) { appliedAll = false; log("下载远端文件失败 " + relative + "：" + error.Message); throw; }
            }
            if (appliedAll) state.Revision = Math.Max(state.Revision, remoteRevision);
            Report(progress, target, "running", "云端更新已应用", 34, "", completed, remoteFiles.Count, transferred, totalBytes, remoteFiles.Count == 0 ? "云端没有新文件" : "云端文件已写入本机");
        }

        private static byte[] DownloadBlob(HubClient hub, string workspaceId, string objectId, Action<long, long> progress) {
            string downloads = Path.Combine(CollectorConfig.DataDirectory, ".downloads"); Directory.CreateDirectory(downloads);
            string partial = Path.Combine(downloads, CollectorConfig.Slug(workspaceId) + "-" + objectId + ".part");
            long offset = File.Exists(partial) ? new FileInfo(partial).Length : 0, total = -1;
            using (FileStream output = new FileStream(partial, FileMode.Append, FileAccess.Write, FileShare.None)) {
                while (total < 0 || offset < total) {
                    long reportedTotal;
                    byte[] chunk = hub.GetBlobChunk(workspaceId, objectId, offset, HubClient.BlobChunkBytes, out reportedTotal);
                    if (reportedTotal >= 0) total = reportedTotal;
                    if (offset > total && total >= 0) throw new InvalidDataException("本机续传文件长度超过云端文件");
                    if (chunk.Length == 0 && offset < total) throw new InvalidDataException("云端文件分块提前结束");
                    output.Write(chunk, 0, chunk.Length); output.Flush(true); offset += chunk.Length;
                    progress(offset, total);
                    if (chunk.Length == 0) break;
                }
            }
            byte[] value = File.ReadAllBytes(partial);
            if (!String.Equals(Hex(SHA256.Create().ComputeHash(value)), objectId, StringComparison.OrdinalIgnoreCase)) { File.Delete(partial); throw new InvalidDataException("下载密文校验失败，已清除损坏断点"); }
            File.Delete(partial); return value;
        }

        private static UploadResult UploadLocal(CollectorConfig config, HubClient hub, SyncTarget target, WorkspaceState state, int maxPlainFileBytes, Action<string> log, Action<SyncProgressInfo> progress) {
            List<string> files = new List<string>(EnumerateFiles(target.Root, target.BackupOnly, target.BackupOnly ? 120 : 5));
            List<Dictionary<string, object>> pending = new List<Dictionary<string, object>>();
            UploadResult result = new UploadResult { Revision = state.Revision };
            int completed = 0; long transferred = 0, totalBytes = 0;
            foreach (string file in files) { try { totalBytes += Math.Min(new FileInfo(file).Length, maxPlainFileBytes); } catch { } }
            Report(progress, target, "running", "扫描本机差异", 38, "", 0, files.Count, 0, totalBytes, "已找到 " + files.Count + " 个候选文件");
            foreach (string file in files) {
                string relative = Relative(target.Root, file);
                byte[] plain;
                try { plain = File.ReadAllBytes(file); } catch (IOException) { completed++; continue; }
                if (plain.Length > maxPlainFileBytes) { log("跳过超过 " + Math.Max(1, maxPlainFileBytes / 1024 / 1024) + " MiB 的文件：" + file); completed++; continue; }
                string hash = Hex(SHA256.Create().ComputeHash(plain));
                LocalFileState previous;
                if (state.Files.TryGetValue(relative, out previous) && previous.Hash == hash) {
                    completed++; ReportUploadScan(progress, target, relative, completed, files.Count, transferred, totalBytes); continue;
                }
                byte[] encrypted = Encrypt(plain, config.Key);
                string objectId = Hex(SHA256.Create().ComputeHash(encrypted));
                int offset = 0;
                while (offset < encrypted.Length) {
                    int count = Math.Min(HubClient.BlobChunkBytes, encrypted.Length - offset);
                    byte[] chunk = new byte[count]; Buffer.BlockCopy(encrypted, offset, chunk, 0, count);
                    long received = hub.PutBlobChunk(target.WorkspaceId, objectId, offset, encrypted.Length, chunk, count);
                    offset = (int)Math.Max(offset + count, received);
                    int percent = 45 + (int)Math.Min(47, (transferred + Math.Min(offset, plain.Length)) * 47 / Math.Max(1, totalBytes));
                    Report(progress, target, "running", "上传本机更新", percent, relative, completed, files.Count, transferred + Math.Min(offset, plain.Length), totalBytes, "分块加密上传中");
                }
                pending.Add(new Dictionary<string, object> {
                    { "path", relative }, { "hash", hash }, { "baseRevision", previous == null ? 0 : previous.Revision },
                    { "size", plain.Length }, { "encryptedSize", encrypted.Length }, { "modifiedAt", File.GetLastWriteTimeUtc(file).ToString("o") },
                    { "object", objectId }
                });
                transferred += plain.Length; completed++;
                if (pending.Count == 32) MergeUploadResult(result, PushBatch(hub, target, config.DeviceId, pending, state, log));
            }
            if (config.PropagateDeletes && state.Initialized && !target.BackupOnly) foreach (KeyValuePair<string, LocalFileState> tracked in new List<KeyValuePair<string, LocalFileState>>(state.Files)) {
                if (tracked.Value == null || tracked.Value.Deleted) continue;
                string localPath = SafeLocalPath(target.Root, tracked.Key);
                if (localPath == null || File.Exists(localPath)) continue;
                pending.Add(new Dictionary<string, object> { { "path", tracked.Key }, { "baseRevision", tracked.Value.Revision }, { "deleted", true }, { "modifiedAt", DateTime.UtcNow.ToString("o") } });
                if (pending.Count == 32) MergeUploadResult(result, PushBatch(hub, target, config.DeviceId, pending, state, log));
            }
            if (pending.Count > 0) MergeUploadResult(result, PushBatch(hub, target, config.DeviceId, pending, state, log));
            Report(progress, target, "running", "提交文件清单", 96, "", completed, files.Count, transferred, totalBytes, "服务器已确认本机更新");
            return result;
        }

        private static void ReportUploadScan(Action<SyncProgressInfo> progress, SyncTarget target, string relative, int completed, int totalFiles, long transferred, long totalBytes) {
            int percent = 38 + (int)Math.Min(7, completed * 7 / Math.Max(1, totalFiles));
            Report(progress, target, "running", "扫描本机差异", percent, relative, completed, totalFiles, transferred, totalBytes, "正在比较文件指纹");
        }

        private static bool ApplyRemote(CollectorConfig config, string root, string workspaceId, bool backupOnly,
            Dictionary<string, object> entry, byte[] encrypted, WorkspaceState state, Action<string> log) {
            string relative = Text(entry, "path"); string remoteHash = Text(entry, "hash"); long revision = Number(entry, "revision");
            byte[] plain;
            try { plain = Decrypt(encrypted, config.Key); } catch { log("无法解密远端文件：" + relative); return false; }
            if (!String.Equals(Hex(SHA256.Create().ComputeHash(plain)), remoteHash, StringComparison.OrdinalIgnoreCase)) { log("远端文件明文校验失败：" + relative); return false; }
            string destination = backupOnly
                ? Path.Combine(CollectorConfig.DataDirectory, "ConversationBackups", workspaceId, relative.Replace('/', Path.DirectorySeparatorChar))
                : Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar));
            string fullRoot = Path.GetFullPath(backupOnly ? Path.Combine(CollectorConfig.DataDirectory, "ConversationBackups", workspaceId) : root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            destination = Path.GetFullPath(destination);
            if (!destination.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase)) return false;
            LocalFileState previous; state.Files.TryGetValue(relative, out previous);
            if (!backupOnly && File.Exists(destination)) {
                string localHash = HashFile(destination);
                bool localChanged = previous == null || previous.Deleted ? localHash != remoteHash : localHash != previous.Hash;
                if (localChanged && localHash != remoteHash) {
                    string conflict = destination + ".codex-sync-conflict-" + DateTime.Now.ToString("yyyyMMdd-HHmmssfff");
                    Directory.CreateDirectory(Path.GetDirectoryName(conflict)); File.Copy(destination, conflict, false);
                    log("检测到双端修改，已保留冲突副本：" + conflict);
                }
            }
            WriteFileAtomically(destination, plain);
            state.Files[relative] = new LocalFileState { Hash = remoteHash, Revision = revision, Deleted = false }; return true;
        }

        private static bool ApplyRemoteTombstone(string root, string relative, Dictionary<string, object> entry, WorkspaceState state, Action<string> log) {
            string destination = SafeLocalPath(root, relative); if (destination == null) return false;
            long revision = Number(entry, "revision"); LocalFileState previous; state.Files.TryGetValue(relative, out previous);
            if (File.Exists(destination)) {
                string recoveryRoot = Path.Combine(root, ".codex-sync-recovery", DateTime.Now.ToString("yyyyMMdd-HHmmssfff"));
                string recovery = SafeLocalPath(recoveryRoot, relative); if (recovery == null) return false;
                Directory.CreateDirectory(Path.GetDirectoryName(recovery));
                if (File.Exists(recovery)) recovery += "." + Guid.NewGuid().ToString("N").Substring(0, 8);
                File.Move(destination, recovery);
                log("云端删除已移入可恢复目录：" + recovery);
            }
            state.Files[relative] = new LocalFileState { Hash = previous == null ? "" : previous.Hash, Revision = revision, Deleted = true }; return true;
        }

        private static UploadResult PushBatch(HubClient hub, SyncTarget target, string deviceId, List<Dictionary<string, object>> files,
            WorkspaceState state, Action<string> log) {
            Dictionary<string, object> response = hub.Post("/api/collector/v1/sync/push", new Dictionary<string, object> {
                { "protocolVersion", 3 }, { "workspaceId", target.WorkspaceId }, { "workspaceName", target.Name }, { "deviceId", deviceId }, { "files", files.ToArray() }
            });
            object raw; IEnumerable accepted = response.TryGetValue("accepted", out raw) ? raw as IEnumerable : null;
            if (accepted != null) foreach (object item in accepted) {
                Dictionary<string, object> entry = item as Dictionary<string, object>; if (entry == null) continue;
                state.Files[Text(entry, "path")] = new LocalFileState { Hash = Text(entry, "hash"), Revision = Number(entry, "revision"), Deleted = Boolean(entry, "deleted") };
            }
            IEnumerable conflicts = response.TryGetValue("conflicts", out raw) ? raw as IEnumerable : null; int conflictCount = 0;
            if (conflicts != null) foreach (object ignored in conflicts) conflictCount++;
            if (conflictCount > 0) log("有 " + conflictCount + " 个文件在其他电脑被修改，正在拉取远端版本并保留本机冲突副本。");
            SaveState(target.WorkspaceId, state);
            files.Clear();
            return new UploadResult { Conflicts = conflictCount, Revision = Number(response, "revision") };
        }

        private static void MergeUploadResult(UploadResult aggregate, UploadResult batch) { aggregate.Conflicts += batch.Conflicts; aggregate.Revision = Math.Max(aggregate.Revision, batch.Revision); }

        private static void Emit(CollectorConfig config, HubClient hub, Action<SyncProgressInfo> callback, SyncProgressInfo info, bool force) {
            if (callback != null) callback(info);
            Dictionary<string, object> payload = new Dictionary<string, object> {
                { "deviceId", config.DeviceId }, { "workspaceId", info.WorkspaceId }, { "status", info.Status }, { "phase", info.Phase },
                { "percent", info.WorkspacePercent }, { "currentFile", info.CurrentFile ?? "" }, { "completedFiles", info.CompletedFiles },
                { "totalFiles", info.TotalFiles }, { "transferredBytes", info.TransferredBytes }, { "totalBytes", info.TotalBytes }, { "message", info.Message ?? "" }
            };
            hub.ReportProgress(payload, force);
        }

        private static void Report(Action<SyncProgressInfo> progress, SyncTarget target, string status, string phase, int workspacePercent,
            string currentFile, int completedFiles, int totalFiles, long transferredBytes, long totalBytes, string message) {
            progress(new SyncProgressInfo { Status = status, Phase = phase, WorkspaceId = target.WorkspaceId, WorkspaceName = target.Name,
                WorkspacePercent = workspacePercent, CurrentFile = currentFile, CompletedFiles = completedFiles, TotalFiles = totalFiles,
                TransferredBytes = transferredBytes, TotalBytes = totalBytes, Message = message });
        }

        private static List<Dictionary<string, object>> Dictionaries(Dictionary<string, object> value, string key) {
            List<Dictionary<string, object>> result = new List<Dictionary<string, object>>(); object raw;
            IEnumerable items = value.TryGetValue(key, out raw) ? raw as IEnumerable : null;
            if (items != null) foreach (object item in items) { Dictionary<string, object> entry = item as Dictionary<string, object>; if (entry != null) result.Add(entry); }
            return result;
        }
        private static string NormalizeDirection(string value) { return value == "upload" || value == "download" ? value : "both"; }
        private static string DirectionLabel(string value) { return value == "upload" ? "仅上传" : value == "download" ? "仅下载" : "双向同步"; }

        private static IEnumerable<string> EnumerateFiles(string root, bool jsonlOnly, int stableSeconds) {
            DateTime stableBefore = DateTime.UtcNow.AddSeconds(-Math.Max(1, stableSeconds)); Stack<string> pending = new Stack<string>(); pending.Push(root);
            while (pending.Count > 0) {
                string folder = pending.Pop(); string[] children; try { children = Directory.GetDirectories(folder); } catch { continue; }
                foreach (string child in children) if (!Skipped.Contains(Path.GetFileName(child))) pending.Push(child);
                string[] files; try { files = Directory.GetFiles(folder); } catch { continue; }
                foreach (string file in files) {
                    string ext = Path.GetExtension(file); DateTime modified; try { modified = File.GetLastWriteTimeUtc(file); } catch { continue; }
                    if (modified > stableBefore) continue;
                    if (jsonlOnly) { if (ext.Equals(".jsonl", StringComparison.OrdinalIgnoreCase)) yield return file; continue; }
                    string name = Path.GetFileName(file);
                    if (SecretNames.Contains(name) || name.StartsWith(".env.", StringComparison.OrdinalIgnoreCase)) continue;
                    if (SecretExtensions.Contains(ext) || TemporaryExtensions.Contains(ext)) continue;
                    yield return file;
                }
            }
        }

        private static bool NeedsLocalRepair(string root, WorkspaceState state) {
            if (!state.Initialized) return true;
            foreach (KeyValuePair<string, LocalFileState> item in state.Files) {
                if (item.Value == null || item.Value.Deleted) continue;
                string path = SafeLocalPath(root, item.Key);
                if (path != null && !File.Exists(path)) return true;
            }
            return false;
        }

        private static string SafeLocalPath(string root, string relative) {
            try {
                string fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                string value = Path.GetFullPath(Path.Combine(root, (relative ?? "").Replace('/', Path.DirectorySeparatorChar)));
                return value.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase) ? value : null;
            } catch { return null; }
        }

        private static void WriteFileAtomically(string destination, byte[] value) {
            string directory = Path.GetDirectoryName(destination); Directory.CreateDirectory(directory);
            string temporary = destination + ".cw-tmp-" + Guid.NewGuid().ToString("N");
            try {
                using (FileStream stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { stream.Write(value, 0, value.Length); stream.Flush(true); }
                if (File.Exists(destination)) File.Replace(temporary, destination, null); else File.Move(temporary, destination);
            } finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }

        private static byte[] Encrypt(byte[] plain, string secret) {
            byte[] encKey = SHA256.Create().ComputeHash(Encoding.UTF8.GetBytes("enc\0" + secret)); byte[] macKey = SHA256.Create().ComputeHash(Encoding.UTF8.GetBytes("mac\0" + secret));
            using (Aes aes = Aes.Create()) {
                aes.Key = encKey; aes.GenerateIV(); aes.Mode = CipherMode.CBC; aes.Padding = PaddingMode.PKCS7;
                byte[] cipher; using (ICryptoTransform transform = aes.CreateEncryptor()) cipher = transform.TransformFinalBlock(plain, 0, plain.Length);
                byte[] body = new byte[1 + aes.IV.Length + cipher.Length]; body[0] = 1; Buffer.BlockCopy(aes.IV, 0, body, 1, aes.IV.Length); Buffer.BlockCopy(cipher, 0, body, 17, cipher.Length);
                byte[] mac = new HMACSHA256(macKey).ComputeHash(body); byte[] output = new byte[body.Length + mac.Length]; Buffer.BlockCopy(body, 0, output, 0, body.Length); Buffer.BlockCopy(mac, 0, output, body.Length, mac.Length); return output;
            }
        }
        private static byte[] Decrypt(byte[] value, string secret) {
            if (value.Length < 50 || value[0] != 1) throw new InvalidDataException("encrypted blob is invalid");
            byte[] encKey = SHA256.Create().ComputeHash(Encoding.UTF8.GetBytes("enc\0" + secret)); byte[] macKey = SHA256.Create().ComputeHash(Encoding.UTF8.GetBytes("mac\0" + secret));
            int bodyLength = value.Length - 32; byte[] body = new byte[bodyLength]; Buffer.BlockCopy(value, 0, body, 0, bodyLength);
            byte[] expected = new HMACSHA256(macKey).ComputeHash(body); int diff = 0; for (int i = 0; i < 32; i++) diff |= expected[i] ^ value[bodyLength + i];
            if (diff != 0) throw new CryptographicException("encrypted blob authentication failed"); byte[] iv = new byte[16]; Buffer.BlockCopy(value, 1, iv, 0, 16);
            using (Aes aes = Aes.Create()) { aes.Key = encKey; aes.IV = iv; aes.Mode = CipherMode.CBC; aes.Padding = PaddingMode.PKCS7; using (ICryptoTransform transform = aes.CreateDecryptor()) return transform.TransformFinalBlock(value, 17, bodyLength - 17); }
        }

        private static string Relative(string root, string path) { Uri rootUri = new Uri(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar); return Uri.UnescapeDataString(rootUri.MakeRelativeUri(new Uri(Path.GetFullPath(path))).ToString()).Replace('\\', '/'); }
        private static string HashFile(string path) { using (FileStream stream = File.OpenRead(path)) return Hex(SHA256.Create().ComputeHash(stream)); }
        private static string Hex(byte[] bytes) { StringBuilder text = new StringBuilder(bytes.Length * 2); foreach (byte b in bytes) text.Append(b.ToString("x2")); return text.ToString(); }
        private static string Text(Dictionary<string, object> value, string key) { object raw; return value != null && value.TryGetValue(key, out raw) && raw != null ? Convert.ToString(raw) : ""; }
        private static long Number(Dictionary<string, object> value, string key) { long result; return Int64.TryParse(Text(value, key), out result) ? result : 0; }
        private static bool Boolean(Dictionary<string, object> value, string key) { bool result; return System.Boolean.TryParse(Text(value, key), out result) && result; }
        private static string StatePath(string workspaceId) { return Path.Combine(CollectorConfig.DataDirectory, "state-" + CollectorConfig.Slug(workspaceId) + ".json"); }
        private static WorkspaceState LoadState(string id) { try { WorkspaceState state = new JavaScriptSerializer().Deserialize<WorkspaceState>(File.ReadAllText(StatePath(id), Encoding.UTF8)) ?? new WorkspaceState(); if (!state.Initialized && (state.Revision > 0 || state.Files.Count > 0)) state.Initialized = true; return state; } catch { return new WorkspaceState(); } }
        private static void SaveState(string id, WorkspaceState state) {
            Directory.CreateDirectory(CollectorConfig.DataDirectory); string path = StatePath(id), temporary = path + ".tmp-" + Guid.NewGuid().ToString("N");
            try {
                byte[] body = new UTF8Encoding(false).GetBytes(new JavaScriptSerializer().Serialize(state));
                using (FileStream stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { stream.Write(body, 0, body.Length); stream.Flush(true); }
                if (File.Exists(path)) File.Replace(temporary, path, null); else File.Move(temporary, path);
            } finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
    }
}
