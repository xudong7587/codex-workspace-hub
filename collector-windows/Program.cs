using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Net.NetworkInformation;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace CodexWorkspaceCollector {
    internal static class Program {
        [STAThread]
        private static void Main() {
            bool created;
            using (Mutex mutex = new Mutex(true, "Local\\CodexWorkspaceCollector.SingleInstance", out created)) {
                if (!created) { MessageBox.Show("Codex Workspace Collector 已经在运行。", "Codex Workspace Collector"); return; }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new CollectorContext());
            }
        }
    }

    internal sealed class CollectorContext : ApplicationContext {
        private CollectorConfig config;
        private readonly NotifyIcon tray;
        private System.Threading.Timer quotaTimer, scheduleTimer, debounceTimer;
        private readonly List<FileSystemWatcher> watchers = new List<FileSystemWatcher>();
        private static readonly HashSet<string> IgnoredWatchFolders = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
            ".git", ".svn", ".hg", ".codex", ".ssh", ".vs", ".idea", ".gradle", ".cache", ".next", ".nuxt", ".turbo",
            "node_modules", ".venv", "venv", "__pycache__", "bin", "obj", "dist", "build", "target", "out", "coverage"
        };
        private int usageRunning, syncRunning, syncPending;
        private string lastScheduledSlot = "";
        private static readonly string LogPath = Path.Combine(CollectorConfig.DataDirectory, "collector.log");

        public CollectorContext() {
            config = CollectorConfig.Load();
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("立即采集额度", null, delegate { QueueUsage(true); });
            menu.Items.Add("立即同步项目", null, delegate { QueueSync(true, "手动"); });
            menu.Items.Add("设置", null, delegate { ShowSettings(); });
            menu.Items.Add("打开备份目录", null, delegate { OpenPath(Path.Combine(CollectorConfig.DataDirectory, "ConversationBackups")); });
            menu.Items.Add("查看日志", null, delegate { OpenPath(LogPath); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出", null, delegate { ExitThread(); });
            tray = new NotifyIcon { Icon = SystemIcons.Information, Text = "Codex Workspace Collector", Visible = true, ContextMenuStrip = menu };
            tray.DoubleClick += delegate { ShowSettings(); };
            NetworkChange.NetworkAvailabilityChanged += NetworkAvailabilityChanged;
            if (!config.IsReady()) ShowSettings();
            ResetAutomation();
            if (config.IsReady()) {
                QueueUsage(false);
                if (config.SyncMode != "manual") QueueSync(false, "启动检查");
            }
        }

        private void ShowSettings() {
            using (SettingsForm form = new SettingsForm(config)) {
                if (form.ShowDialog() == DialogResult.OK) {
                    config = form.Value; config.Save(); ResetAutomation(); QueueUsage(true); QueueSync(true, "设置更新");
                }
            }
        }

        private void ResetAutomation() {
            if (quotaTimer != null) quotaTimer.Dispose();
            if (scheduleTimer != null) scheduleTimer.Dispose();
            if (debounceTimer != null) debounceTimer.Dispose();
            foreach (FileSystemWatcher watcher in watchers) watcher.Dispose();
            watchers.Clear();
            int minutes = Math.Max(1, config.IntervalMinutes);
            quotaTimer = new System.Threading.Timer(delegate { QueueUsage(false); }, null, TimeSpan.FromMinutes(minutes), TimeSpan.FromMinutes(minutes));
            if (config.SyncMode == "smart") SetupWatchers();
            if (config.SyncMode != "manual") scheduleTimer = new System.Threading.Timer(delegate { CheckSchedule(); }, null, TimeSpan.FromSeconds(15), TimeSpan.FromSeconds(30));
        }

        private void SetupWatchers() {
            foreach (SyncFolder folder in config.Folders ?? new List<SyncFolder>()) if (folder != null && Directory.Exists(folder.Path)) AddWatcher(folder.Path, "项目变化", true);
            if (config.BackupConversations) {
                string codex = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
                foreach (string name in new [] { "sessions", "archived_sessions" }) {
                    string path = Path.Combine(codex, name);
                    if (Directory.Exists(path)) AddWatcher(path, "对话完成", false);
                }
            }
        }

        private void AddWatcher(string path, string reason, bool filterProjectNoise) {
            try {
                FileSystemWatcher watcher = new FileSystemWatcher(path) {
                    IncludeSubdirectories = true,
                    NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size
                };
                FileSystemEventHandler changed = delegate(object sender, FileSystemEventArgs e) { if (!filterProjectNoise || !IgnoredWatchPath(e.FullPath)) ScheduleSmartSync(reason); };
                RenamedEventHandler renamed = delegate(object sender, RenamedEventArgs e) { if (!filterProjectNoise || !IgnoredWatchPath(e.FullPath)) ScheduleSmartSync(reason); };
                watcher.Changed += changed; watcher.Created += changed; watcher.Deleted += changed; watcher.Renamed += renamed;
                watcher.EnableRaisingEvents = true; watchers.Add(watcher);
            } catch (Exception error) { Log("无法监控目录 " + path + "：" + error.Message); }
        }

        private static bool IgnoredWatchPath(string path) {
            foreach (string part in (path ?? "").Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)) if (IgnoredWatchFolders.Contains(part)) return true;
            string name = Path.GetFileName(path ?? "");
            string ext = Path.GetExtension(name);
            return name.Equals(".env", StringComparison.OrdinalIgnoreCase)
                || name.StartsWith(".env.", StringComparison.OrdinalIgnoreCase)
                || ext.Equals(".tmp", StringComparison.OrdinalIgnoreCase)
                || ext.Equals(".log", StringComparison.OrdinalIgnoreCase)
                || ext.Equals(".lock", StringComparison.OrdinalIgnoreCase);
        }

        private void ScheduleSmartSync(string reason) {
            if (config.SyncMode != "smart") return;
            int seconds = Math.Max(30, config.QuietSeconds);
            if (debounceTimer != null) debounceTimer.Dispose();
            debounceTimer = new System.Threading.Timer(delegate { QueueSync(false, reason + "，已静默 " + seconds + " 秒"); }, null, TimeSpan.FromSeconds(seconds), Timeout.InfiniteTimeSpan);
        }

        private void CheckSchedule() {
            DateTime now = DateTime.Now;
            string minute = now.ToString("HH:mm");
            string slot = now.ToString("yyyy-MM-dd HH:mm");
            if (slot == lastScheduledSlot) return;
            foreach (string value in (config.SyncTimes ?? "").Split(new [] { ',', '，', ';', '；', ' ' }, StringSplitOptions.RemoveEmptyEntries)) {
                if (value.Trim() != minute) continue;
                lastScheduledSlot = slot;
                QueueSync(false, "定时兜底 " + minute);
                return;
            }
        }

        private void NetworkAvailabilityChanged(object sender, NetworkAvailabilityEventArgs e) {
            if (e.IsAvailable && config.SyncMode == "smart") ScheduleSmartSync("网络恢复");
        }

        private void QueueUsage(bool notify) {
            if (!config.IsReady() || Interlocked.Exchange(ref usageRunning, 1) != 0) return;
            ThreadPool.QueueUserWorkItem(delegate {
                try {
                    CollectorConfig snapshot = CollectorConfig.Load();
                    HubClient hub = new HubClient(snapshot);
                    Dictionary<string, object> usage = UsageScanner.Scan(snapshot.UsdCnyRate);
                    hub.Post("/api/collector/v1/usage", new Dictionary<string, object> { { "deviceId", snapshot.DeviceId }, { "snapshot", usage } });
                    Log("额度采集完成");
                    if (notify) Balloon("额度采集完成", ToolTipIcon.Info);
                } catch (Exception error) {
                    Log("额度采集失败：" + error.Message);
                    if (notify) Balloon("采集失败：" + Short(error.Message, 180), ToolTipIcon.Error);
                } finally { Interlocked.Exchange(ref usageRunning, 0); }
            });
        }

        private void QueueSync(bool notify, string reason) {
            if (!config.IsReady()) return;
            if (Interlocked.Exchange(ref syncRunning, 1) != 0) { Interlocked.Exchange(ref syncPending, 1); return; }
            ThreadPool.QueueUserWorkItem(delegate {
                try {
                    CollectorConfig snapshot = CollectorConfig.Load();
                    SyncEngine.SyncConfigured(snapshot, new HubClient(snapshot), Log);
                    Log("同步完成（" + reason + "）");
                    if (notify) Balloon("项目与对话同步完成", ToolTipIcon.Info);
                } catch (Exception error) {
                    Log("同步失败（" + reason + "）：" + error.Message);
                    if (notify) Balloon("同步失败：" + Short(error.Message, 180), ToolTipIcon.Error);
                } finally {
                    Interlocked.Exchange(ref syncRunning, 0);
                    if (Interlocked.Exchange(ref syncPending, 0) != 0) QueueSync(false, "合并的待处理变化");
                }
            });
        }

        private void Balloon(string text, ToolTipIcon icon) {
            try { tray.ShowBalloonTip(4000, "Codex Workspace Collector", text, icon); } catch { }
        }

        private static void Log(string text) {
            try {
                Directory.CreateDirectory(CollectorConfig.DataDirectory);
                File.AppendAllText(LogPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + text + Environment.NewLine, Encoding.UTF8);
            } catch { }
        }

        private static void OpenPath(string path) {
            try {
                if (Path.HasExtension(path) && !File.Exists(path)) { Directory.CreateDirectory(Path.GetDirectoryName(path)); File.WriteAllText(path, "", Encoding.UTF8); }
                else if (!Path.HasExtension(path)) Directory.CreateDirectory(path);
                System.Diagnostics.Process.Start(path);
            } catch { }
        }
        private static string Short(string value, int length) { return String.IsNullOrEmpty(value) || value.Length <= length ? value : value.Substring(0, length); }

        protected override void ExitThreadCore() {
            NetworkChange.NetworkAvailabilityChanged -= NetworkAvailabilityChanged;
            if (quotaTimer != null) quotaTimer.Dispose();
            if (scheduleTimer != null) scheduleTimer.Dispose();
            if (debounceTimer != null) debounceTimer.Dispose();
            foreach (FileSystemWatcher watcher in watchers) watcher.Dispose();
            tray.Visible = false; tray.Dispose(); base.ExitThreadCore();
        }
    }

    internal sealed class SettingsForm : Form {
        private readonly TextBox hub = new TextBox(), key = new TextBox(), device = new TextBox(), interval = new TextBox(), rate = new TextBox(), folders = new TextBox(), quiet = new TextBox(), syncTimes = new TextBox();
        private readonly ComboBox syncMode = new ComboBox();
        private readonly CheckBox sync = new CheckBox(), chats = new CheckBox(), startup = new CheckBox();
        public CollectorConfig Value { get; private set; }

        public SettingsForm(CollectorConfig current) {
            Text = "Codex Workspace Collector 设置"; Width = 720; Height = 780; MinimumSize = new Size(660, 700); StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Dpi; AutoScaleDimensions = new SizeF(96F, 96F); DoubleBuffered = true;
            Font = new Font("Microsoft YaHei UI", 10F); BackColor = Color.FromArgb(242, 247, 244);
            TableLayoutPanel grid = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(32, 26, 32, 30), ColumnCount = 2, RowCount = 15, AutoScroll = true, BackColor = Color.FromArgb(242, 247, 244) };
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 156)); grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            Controls.Add(grid);
            Label title = new Label { Text = "Codex 多设备工作同步", Font = new Font(Font.FontFamily, 22F, FontStyle.Bold), AutoSize = true, ForeColor = Color.FromArgb(14, 56, 42), Margin = new Padding(0, 0, 0, 8) };
            grid.Controls.Add(title, 0, 0); grid.SetColumnSpan(title, 2);
            Label note = new Label { Text = "这台电脑独立决定同步策略。Hub 只负责安全中转与密文存储；连接 Key 和项目内容都会在本机保护。", AutoSize = true, MaximumSize = new Size(620, 0), ForeColor = Color.FromArgb(82, 105, 95), Font = new Font(Font.FontFamily, 10.5F), Margin = new Padding(0, 0, 0, 18) };
            grid.Controls.Add(note, 0, 1); grid.SetColumnSpan(note, 2);
            AddRow(grid, 2, "Hub 地址", hub, current.HubUrl, "https://quota.example.com");
            AddRow(grid, 3, "连接 Key", key, current.Key, "管理面板里的手机桥接 Secret"); key.UseSystemPasswordChar = true;
            AddRow(grid, 4, "设备名称", device, current.DeviceId, "office-pc");
            FlowLayoutPanel timing = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true };
            interval.Width = 70; interval.Text = current.IntervalMinutes.ToString(); rate.Width = 70; rate.Text = current.UsdCnyRate.ToString("0.00");
            timing.Controls.Add(interval); timing.Controls.Add(new Label { Text = "分钟    美元兑人民币", AutoSize = true, Padding = new Padding(0, 6, 0, 0) }); timing.Controls.Add(rate);
            grid.Controls.Add(new Label { Text = "采集间隔", AutoSize = true, Padding = new Padding(0, 7, 0, 0) }, 0, 5); grid.Controls.Add(timing, 1, 5);
            syncMode.DropDownStyle = ComboBoxStyle.DropDownList; syncMode.Width = 320; syncMode.FlatStyle = FlatStyle.Flat; syncMode.BackColor = Color.White;
            syncMode.Items.AddRange(new object[] { "智能同步（变化后 + 定时兜底）", "仅按设定时间同步", "仅手动同步" });
            syncMode.SelectedIndex = current.SyncMode == "scheduled" ? 1 : current.SyncMode == "manual" ? 2 : 0;
            grid.Controls.Add(new Label { Text = "项目同步模式", AutoSize = true, Padding = new Padding(0, 7, 0, 0) }, 0, 6); grid.Controls.Add(syncMode, 1, 6);
            FlowLayoutPanel syncTiming = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true };
            quiet.Width = 60; quiet.Text = current.QuietSeconds.ToString(); syncTimes.Width = 285; syncTimes.Text = current.SyncTimes;
            syncTiming.Controls.Add(quiet); syncTiming.Controls.Add(new Label { Text = "秒无变化后同步    兜底时间", AutoSize = true, Padding = new Padding(0, 6, 0, 0) }); syncTiming.Controls.Add(syncTimes);
            grid.Controls.Add(new Label { Text = "同步触发", AutoSize = true, Padding = new Padding(0, 7, 0, 0) }, 0, 7); grid.Controls.Add(syncTiming, 1, 7);
            Label timingHint = new Label { Text = "多个时间用逗号分隔，例如 08:00,12:00,18:00,23:00。智能模式只把文件变化当作触发信号，静默期结束后才检查差异。", AutoSize = true, MaximumSize = new Size(470, 0), ForeColor = Color.Gray };
            grid.Controls.Add(timingHint, 1, 8);
            folders.Multiline = true; folders.ScrollBars = ScrollBars.Vertical; folders.Height = 170; folders.Dock = DockStyle.Fill; folders.BackColor = Color.White; folders.BorderStyle = BorderStyle.FixedSingle;
            folders.Text = FormatFolders(current.Folders);
            grid.Controls.Add(new Label { Text = "项目目录", AutoSize = true, Padding = new Padding(0, 7, 0, 0) }, 0, 9); grid.Controls.Add(folders, 1, 9);
            Label hint = new Label { Text = "每行：同步名称 | 文件夹路径。同一项目在各电脑使用相同名称。同步源码、配置和文档；排除 .git、依赖、构建缓存、.env 与密钥文件。", AutoSize = true, MaximumSize = new Size(470, 0), ForeColor = Color.Gray };
            grid.Controls.Add(hint, 1, 10);
            FlowLayoutPanel choices = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true };
            sync.Text = "双向同步完整项目"; sync.Checked = current.SyncProjectDocuments; sync.AutoSize = true; sync.ForeColor = Color.FromArgb(28, 61, 49);
            chats.Text = "静默后加密备份 Codex 对话"; chats.Checked = current.BackupConversations; chats.AutoSize = true; chats.ForeColor = Color.FromArgb(28, 61, 49);
            startup.Text = "登录 Windows 后启动"; startup.Checked = current.StartWithWindows; startup.AutoSize = true; startup.ForeColor = Color.FromArgb(28, 61, 49);
            choices.Controls.Add(sync); choices.Controls.Add(chats); choices.Controls.Add(startup); grid.Controls.Add(choices, 1, 11);
            FlowLayoutPanel actions = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, FlowDirection = FlowDirection.RightToLeft };
            Button save = Button("保存并开始", true), cancel = Button("取消", false), discover = Button("自动发现 Codex 项目", false), test = Button("测试连接", false);
            save.Click += SaveClicked; cancel.Click += delegate { DialogResult = DialogResult.Cancel; Close(); };
            discover.Click += DiscoverClicked; test.Click += TestClicked;
            actions.Controls.Add(save); actions.Controls.Add(cancel); actions.Controls.Add(test); actions.Controls.Add(discover);
            grid.Controls.Add(actions, 0, 14); grid.SetColumnSpan(actions, 2);
        }

        private static void AddRow(TableLayoutPanel grid, int row, string label, TextBox box, string value, string placeholder) {
            grid.Controls.Add(new Label { Text = label, AutoSize = true, Padding = new Padding(0, 9, 0, 0), ForeColor = Color.FromArgb(42, 70, 59), Font = new Font("Microsoft YaHei UI", 9.5F, FontStyle.Bold) }, 0, row);
            box.Dock = DockStyle.Fill; box.Text = value ?? ""; box.Tag = placeholder; box.BackColor = Color.White; box.BorderStyle = BorderStyle.FixedSingle; box.Margin = new Padding(0, 4, 0, 8); grid.Controls.Add(box, 1, row);
        }
        private static Button Button(string text, bool primary) {
            Button value = new Button { Text = text, AutoSize = true, Height = 42, Padding = new Padding(12, 4, 12, 4), FlatStyle = FlatStyle.Flat, BackColor = primary ? Color.FromArgb(13, 132, 89) : Color.White, ForeColor = primary ? Color.White : Color.FromArgb(25, 53, 43), Cursor = Cursors.Hand };
            value.FlatAppearance.BorderColor = primary ? Color.FromArgb(13, 132, 89) : Color.FromArgb(202, 216, 209); return value;
        }
        private static string FormatFolders(List<SyncFolder> values) { StringBuilder b = new StringBuilder(); foreach (SyncFolder f in values ?? new List<SyncFolder>()) if (f != null && !String.IsNullOrWhiteSpace(f.Path)) b.AppendLine(f.WorkspaceId + " | " + f.Path); return b.ToString(); }

        private CollectorConfig ReadValue() {
            int minutes, quietSeconds; double usd;
            if (!Int32.TryParse(interval.Text.Trim(), out minutes) || minutes < 1 || minutes > 1440) throw new InvalidOperationException("采集间隔应为 1 到 1440 分钟。");
            if (!Int32.TryParse(quiet.Text.Trim(), out quietSeconds) || quietSeconds < 30 || quietSeconds > 900) throw new InvalidOperationException("静默时间应为 30 到 900 秒。");
            if (!Double.TryParse(rate.Text.Trim(), out usd) || usd < 1 || usd > 20) throw new InvalidOperationException("美元兑人民币应为 1 到 20。");
            string normalizedTimes = NormalizeTimes(syncTimes.Text);
            string mode = syncMode.SelectedIndex == 1 ? "scheduled" : syncMode.SelectedIndex == 2 ? "manual" : "smart";
            CollectorConfig value = new CollectorConfig { HubUrl = hub.Text.Trim().TrimEnd('/'), DeviceId = CollectorConfig.Slug(device.Text), IntervalMinutes = minutes,
                UsdCnyRate = usd, SyncProjectDocuments = sync.Checked, BackupConversations = chats.Checked, SyncMode = mode, QuietSeconds = quietSeconds,
                SyncTimes = normalizedTimes, StartWithWindows = startup.Checked, Folders = ParseFolders(folders.Text) };
            value.Key = key.Text;
            if (!value.IsReady()) throw new InvalidOperationException("请填写正确的 HTTPS Hub 地址和连接 Key。");
            return value;
        }
        private static string NormalizeTimes(string text) {
            List<string> values = new List<string>();
            foreach (string raw in (text ?? "").Split(new [] { ',', '，', ';', '；', ' ' }, StringSplitOptions.RemoveEmptyEntries)) {
                DateTime parsed;
                if (!DateTime.TryParseExact(raw.Trim(), "HH:mm", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out parsed))
                    throw new InvalidOperationException("同步时间格式应为 HH:mm，例如 08:00,12:00,18:00。");
                string value = parsed.ToString("HH:mm");
                if (!values.Contains(value)) values.Add(value);
            }
            if (values.Count == 0) throw new InvalidOperationException("请至少填写一个同步时间。");
            values.Sort(StringComparer.Ordinal); return String.Join(",", values.ToArray());
        }
        private static List<SyncFolder> ParseFolders(string text) {
            List<SyncFolder> values = new List<SyncFolder>();
            foreach (string line in (text ?? "").Split(new [] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)) {
                int split = line.IndexOf('|'); string path = split < 0 ? line.Trim() : line.Substring(split + 1).Trim();
                string id = split < 0 ? Path.GetFileName(path.TrimEnd('\\', '/')) : line.Substring(0, split).Trim();
                if (!String.IsNullOrWhiteSpace(path)) values.Add(new SyncFolder { WorkspaceId = CollectorConfig.Slug(id), Path = path });
            }
            return values;
        }
        private void SaveClicked(object sender, EventArgs e) { try { Value = ReadValue(); DialogResult = DialogResult.OK; Close(); } catch (Exception error) { MessageBox.Show(error.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning); } }
        private void TestClicked(object sender, EventArgs e) { try { CollectorConfig value = ReadValue(); new HubClient(value).Post("/api/collector/v1/sync/pull", new Dictionary<string, object> { { "workspaceId", "connection-test" }, { "sinceRevision", 0 } }); MessageBox.Show("连接成功。", Text, MessageBoxButtons.OK, MessageBoxIcon.Information); } catch (Exception error) { MessageBox.Show(error.Message, "连接失败", MessageBoxButtons.OK, MessageBoxIcon.Error); } }
        private void DiscoverClicked(object sender, EventArgs e) {
            string config = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex", "config.toml");
            if (!File.Exists(config)) { MessageBox.Show("没有找到 Codex config.toml。", Text); return; }
            List<SyncFolder> values = ParseFolders(folders.Text); HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (SyncFolder f in values) seen.Add(Path.GetFullPath(f.Path));
            Regex pattern = new Regex("^\\[projects\\.(?:'([^']+)'|\"([^\"]+)\")\\]$");
            foreach (string line in File.ReadLines(config, Encoding.UTF8)) {
                Match match = pattern.Match(line.Trim()); if (!match.Success) continue;
                string path = (match.Groups[1].Success ? match.Groups[1].Value : match.Groups[2].Value).Replace("\\\\", "\\");
                if (Directory.Exists(path) && seen.Add(Path.GetFullPath(path))) values.Add(new SyncFolder { WorkspaceId = CollectorConfig.Slug(Path.GetFileName(path)), Path = path });
            }
            folders.Text = FormatFolders(values);
        }
    }
}
