using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace VWatchCollector {
    internal static class Program {
        [STAThread]
        private static void Main() {
            bool created;
            using (Mutex mutex = new Mutex(true, "Local\\VWatchCollector.SingleInstance", out created)) {
                if (!created) { MessageBox.Show("VWatch 采集器已经在运行。", "VWatch 采集器"); return; }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new CollectorContext());
            }
        }
    }

    internal sealed class CollectorContext : ApplicationContext {
        private CollectorConfig config;
        private readonly NotifyIcon tray;
        private System.Threading.Timer timer;
        private int running;
        private static readonly string LogPath = Path.Combine(CollectorConfig.DataDirectory, "collector.log");

        public CollectorContext() {
            config = CollectorConfig.Load();
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("立即采集与同步", null, delegate { QueueRun(true); });
            menu.Items.Add("设置", null, delegate { ShowSettings(); });
            menu.Items.Add("打开备份目录", null, delegate { OpenPath(Path.Combine(CollectorConfig.DataDirectory, "ConversationBackups")); });
            menu.Items.Add("查看日志", null, delegate { OpenPath(LogPath); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出", null, delegate { ExitThread(); });
            tray = new NotifyIcon { Icon = SystemIcons.Information, Text = "VWatch 采集器", Visible = true, ContextMenuStrip = menu };
            tray.DoubleClick += delegate { ShowSettings(); };
            if (!config.IsReady()) ShowSettings();
            ResetTimer();
            if (config.IsReady()) QueueRun(false);
        }

        private void ShowSettings() {
            using (SettingsForm form = new SettingsForm(config)) {
                if (form.ShowDialog() == DialogResult.OK) {
                    config = form.Value; config.Save(); ResetTimer(); QueueRun(true);
                }
            }
        }

        private void ResetTimer() {
            if (timer != null) timer.Dispose();
            int minutes = Math.Max(1, config.IntervalMinutes);
            timer = new System.Threading.Timer(delegate { QueueRun(false); }, null, TimeSpan.FromMinutes(minutes), TimeSpan.FromMinutes(minutes));
        }

        private void QueueRun(bool notify) {
            if (!config.IsReady() || Interlocked.Exchange(ref running, 1) != 0) return;
            ThreadPool.QueueUserWorkItem(delegate {
                try {
                    CollectorConfig snapshot = CollectorConfig.Load();
                    HubClient hub = new HubClient(snapshot);
                    Dictionary<string, object> usage = UsageScanner.Scan(snapshot.UsdCnyRate);
                    hub.Post("/api/collector/v1/usage", new Dictionary<string, object> { { "deviceId", snapshot.DeviceId }, { "snapshot", usage } });
                    SyncEngine.SyncConfigured(snapshot, hub, Log);
                    Log("采集与同步完成");
                    if (notify) Balloon("采集与同步完成", ToolTipIcon.Info);
                } catch (Exception error) {
                    Log("失败：" + error.Message);
                    Balloon("采集失败：" + Short(error.Message, 180), ToolTipIcon.Error);
                } finally { Interlocked.Exchange(ref running, 0); }
            });
        }

        private void Balloon(string text, ToolTipIcon icon) {
            try { tray.ShowBalloonTip(4000, "VWatch 采集器", text, icon); } catch { }
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
            if (timer != null) timer.Dispose(); tray.Visible = false; tray.Dispose(); base.ExitThreadCore();
        }
    }

    internal sealed class SettingsForm : Form {
        private readonly TextBox hub = new TextBox(), key = new TextBox(), device = new TextBox(), interval = new TextBox(), rate = new TextBox(), folders = new TextBox();
        private readonly CheckBox sync = new CheckBox(), chats = new CheckBox(), startup = new CheckBox();
        public CollectorConfig Value { get; private set; }

        public SettingsForm(CollectorConfig current) {
            Text = "VWatch 采集器设置"; Width = 680; Height = 650; MinimumSize = new Size(620, 580); StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Microsoft YaHei UI", 9F); BackColor = Color.FromArgb(245, 249, 247);
            TableLayoutPanel grid = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(22), ColumnCount = 2, RowCount = 11, AutoScroll = true };
            grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 150)); grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            Controls.Add(grid);
            Label title = new Label { Text = "额度采集与多电脑同步", Font = new Font(Font.FontFamily, 18F, FontStyle.Bold), AutoSize = true, ForeColor = Color.FromArgb(20, 54, 42) };
            grid.Controls.Add(title, 0, 0); grid.SetColumnSpan(title, 2);
            Label note = new Label { Text = "填写与手机相同的 Docker HTTPS 地址和 Key。Key 使用 Windows 当前账户加密保存，项目文件上传前也会加密。", AutoSize = true, MaximumSize = new Size(590, 0), ForeColor = Color.FromArgb(86, 108, 98) };
            grid.Controls.Add(note, 0, 1); grid.SetColumnSpan(note, 2);
            AddRow(grid, 2, "Hub 地址", hub, current.HubUrl, "https://quota.example.com");
            AddRow(grid, 3, "连接 Key", key, current.Key, "管理面板里的手机桥接 Secret"); key.UseSystemPasswordChar = true;
            AddRow(grid, 4, "设备名称", device, current.DeviceId, "office-pc");
            FlowLayoutPanel timing = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true };
            interval.Width = 70; interval.Text = current.IntervalMinutes.ToString(); rate.Width = 70; rate.Text = current.UsdCnyRate.ToString("0.00");
            timing.Controls.Add(interval); timing.Controls.Add(new Label { Text = "分钟    美元兑人民币", AutoSize = true, Padding = new Padding(0, 6, 0, 0) }); timing.Controls.Add(rate);
            grid.Controls.Add(new Label { Text = "采集间隔", AutoSize = true, Padding = new Padding(0, 7, 0, 0) }, 0, 5); grid.Controls.Add(timing, 1, 5);
            folders.Multiline = true; folders.ScrollBars = ScrollBars.Vertical; folders.Height = 150; folders.Dock = DockStyle.Fill;
            folders.Text = FormatFolders(current.Folders);
            grid.Controls.Add(new Label { Text = "项目文档目录", AutoSize = true, Padding = new Padding(0, 7, 0, 0) }, 0, 6); grid.Controls.Add(folders, 1, 6);
            Label hint = new Label { Text = "每行：同步名称 | 文件夹路径。同一项目在各电脑使用相同名称。只同步 Markdown、Office、PDF、JSON、YAML 等文档；不会同步 .git、node_modules 和构建目录。", AutoSize = true, MaximumSize = new Size(430, 0), ForeColor = Color.Gray };
            grid.Controls.Add(hint, 1, 7);
            FlowLayoutPanel choices = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true };
            sync.Text = "双向同步项目文档"; sync.Checked = current.SyncProjectDocuments; sync.AutoSize = true;
            chats.Text = "加密备份 Codex 对话"; chats.Checked = current.BackupConversations; chats.AutoSize = true;
            startup.Text = "登录 Windows 后启动"; startup.Checked = current.StartWithWindows; startup.AutoSize = true;
            choices.Controls.Add(sync); choices.Controls.Add(chats); choices.Controls.Add(startup); grid.Controls.Add(choices, 1, 8);
            FlowLayoutPanel actions = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, FlowDirection = FlowDirection.RightToLeft };
            Button save = Button("保存并开始", true), cancel = Button("取消", false), discover = Button("自动发现 Codex 项目", false), test = Button("测试连接", false);
            save.Click += SaveClicked; cancel.Click += delegate { DialogResult = DialogResult.Cancel; Close(); };
            discover.Click += DiscoverClicked; test.Click += TestClicked;
            actions.Controls.Add(save); actions.Controls.Add(cancel); actions.Controls.Add(test); actions.Controls.Add(discover);
            grid.Controls.Add(actions, 0, 10); grid.SetColumnSpan(actions, 2);
        }

        private static void AddRow(TableLayoutPanel grid, int row, string label, TextBox box, string value, string placeholder) {
            grid.Controls.Add(new Label { Text = label, AutoSize = true, Padding = new Padding(0, 7, 0, 0) }, 0, row);
            box.Dock = DockStyle.Fill; box.Text = value ?? ""; box.Tag = placeholder; grid.Controls.Add(box, 1, row);
        }
        private static Button Button(string text, bool primary) { return new Button { Text = text, AutoSize = true, Height = 36, FlatStyle = FlatStyle.Flat, BackColor = primary ? Color.FromArgb(15, 132, 91) : Color.White, ForeColor = primary ? Color.White : Color.FromArgb(25, 53, 43) }; }
        private static string FormatFolders(List<SyncFolder> values) { StringBuilder b = new StringBuilder(); foreach (SyncFolder f in values ?? new List<SyncFolder>()) if (f != null && !String.IsNullOrWhiteSpace(f.Path)) b.AppendLine(f.WorkspaceId + " | " + f.Path); return b.ToString(); }

        private CollectorConfig ReadValue() {
            int minutes; double usd;
            if (!Int32.TryParse(interval.Text.Trim(), out minutes) || minutes < 1 || minutes > 1440) throw new InvalidOperationException("采集间隔应为 1 到 1440 分钟。");
            if (!Double.TryParse(rate.Text.Trim(), out usd) || usd < 1 || usd > 20) throw new InvalidOperationException("美元兑人民币应为 1 到 20。");
            CollectorConfig value = new CollectorConfig { HubUrl = hub.Text.Trim().TrimEnd('/'), DeviceId = CollectorConfig.Slug(device.Text), IntervalMinutes = minutes,
                UsdCnyRate = usd, SyncProjectDocuments = sync.Checked, BackupConversations = chats.Checked, StartWithWindows = startup.Checked, Folders = ParseFolders(folders.Text) };
            value.Key = key.Text;
            if (!value.IsReady()) throw new InvalidOperationException("请填写正确的 HTTPS Hub 地址和连接 Key。");
            return value;
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
