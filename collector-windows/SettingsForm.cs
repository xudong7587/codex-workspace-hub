using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace CodexWorkspaceCollector {
    internal sealed class SettingsForm : Form {
        private readonly Color Green = Color.FromArgb(13, 132, 89), Ink = Color.FromArgb(18, 45, 35), Muted = Color.FromArgb(89, 111, 102), Canvas = Color.FromArgb(242, 247, 244);
        private readonly TextBox hub = new TextBox(), key = new TextBox(), device = new TextBox(), interval = new TextBox(), rate = new TextBox(), quiet = new TextBox(), syncTimes = new TextBox();
        private readonly ComboBox syncMode = new ComboBox();
        private readonly CheckBox sync = new CheckBox(), chats = new CheckBox(), startup = new CheckBox();
        private readonly DataGridView projects = new DataGridView();
        private readonly Panel content = new Panel();
        private readonly List<Button> navigation = new List<Button>();
        private readonly List<Control> pages = new List<Control>();
        private readonly CollectorConfig current;
        public CollectorConfig Value { get; private set; }

        public SettingsForm(CollectorConfig value) {
            current = value; Text = "Codex Workspace Collector"; Width = 1080; Height = 760; MinimumSize = new Size(900, 650);
            StartPosition = FormStartPosition.CenterScreen; AutoScaleMode = AutoScaleMode.Dpi; AutoScaleDimensions = new SizeF(96F, 96F);
            Font = new Font("Microsoft YaHei UI", 9.5F); BackColor = Canvas; DoubleBuffered = true;

            TableLayoutPanel shell = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 2, BackColor = Canvas };
            shell.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 230)); shell.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            shell.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); shell.RowStyles.Add(new RowStyle(SizeType.Absolute, 76)); Controls.Add(shell);
            shell.Controls.Add(BuildSidebar(), 0, 0); shell.Controls.Add(content, 1, 0); shell.Controls.Add(BuildFooter(), 0, 1); shell.SetColumnSpan(shell.GetControlFromPosition(0, 1), 2);
            content.Dock = DockStyle.Fill; content.Padding = new Padding(34, 26, 34, 20); content.BackColor = Canvas;
            pages.Add(BuildConnectionPage()); pages.Add(BuildProjectsPage()); pages.Add(BuildAutomationPage());
            foreach (Control page in pages) { page.Dock = DockStyle.Fill; page.Visible = false; content.Controls.Add(page); }
            ShowPage(0);
        }

        private Control BuildSidebar() {
            Panel panel = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(235, 243, 239), Padding = new Padding(24, 28, 20, 20) };
            Label mark = new Label { Text = "CW", BackColor = Green, ForeColor = Color.White, TextAlign = ContentAlignment.MiddleCenter, Font = new Font(Font.FontFamily, 16F, FontStyle.Bold), Width = 54, Height = 54, Location = new Point(24, 28) };
            Label title = new Label { Text = "Collector", AutoSize = true, Font = new Font(Font.FontFamily, 17F, FontStyle.Bold), ForeColor = Ink, Location = new Point(88, 29) };
            Label sub = new Label { Text = "电脑端同步器", AutoSize = true, ForeColor = Muted, Location = new Point(90, 60) };
            panel.Controls.Add(mark); panel.Controls.Add(title); panel.Controls.Add(sub);
            string[] names = { "连接 CW", "同步项目", "自动化" };
            for (int index = 0; index < names.Length; index++) {
                Button button = new Button { Text = names[index], FlatStyle = FlatStyle.Flat, Width = 184, Height = 48, Location = new Point(24, 120 + index * 58), TextAlign = ContentAlignment.MiddleLeft, Padding = new Padding(16, 0, 0, 0), Cursor = Cursors.Hand, ForeColor = Ink, BackColor = Color.Transparent, Tag = index };
                button.FlatAppearance.BorderSize = 0; button.Click += delegate(object sender, EventArgs args) { ShowPage((int)((Button)sender).Tag); };
                navigation.Add(button); panel.Controls.Add(button);
            }
            Label help = new Label { Text = "① 连接中转服务\n② 勾选本机项目\n③ 决定何时同步", AutoSize = true, ForeColor = Muted, Location = new Point(40, 330), Font = new Font(Font.FontFamily, 9F), Padding = new Padding(0, 8, 0, 0) };
            panel.Controls.Add(help); return panel;
        }

        private Control BuildFooter() {
            Panel footer = new Panel { Dock = DockStyle.Fill, BackColor = Color.White, Padding = new Padding(24, 15, 30, 13) };
            Label note = new Label { Text = "设置只保存在这台电脑；项目文件在上传前使用连接 Key 加密。", AutoSize = true, ForeColor = Muted, Location = new Point(28, 28) };
            Button save = ActionButton("保存并开始", true), cancel = ActionButton("取消", false);
            save.Anchor = AnchorStyles.Top | AnchorStyles.Right; cancel.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            save.Location = new Point(footer.Width - 170, 15); cancel.Location = new Point(footer.Width - 270, 15);
            footer.Resize += delegate { save.Left = footer.ClientSize.Width - save.Width - 30; cancel.Left = save.Left - cancel.Width - 12; };
            save.Click += SaveClicked; cancel.Click += delegate { DialogResult = DialogResult.Cancel; Close(); };
            footer.Controls.Add(note); footer.Controls.Add(cancel); footer.Controls.Add(save); return footer;
        }

        private Control BuildConnectionPage() {
            TableLayoutPanel page = Page("连接 CW", "先连接 NAS 上的 Codex Workspace Hub。这里的地址和 Key 与手机桥接使用同一套。", 6);
            Panel state = Card(); Label stateTitle = new Label { Text = "连接信息", AutoSize = true, Font = new Font(Font.FontFamily, 13F, FontStyle.Bold), ForeColor = Ink, Location = new Point(22, 18) };
            Label stateText = new Label { Text = "CW 只负责中转、密文存储与同步状态；不会替电脑登录 Codex。", AutoSize = true, ForeColor = Muted, Location = new Point(22, 51) };
            Button test = ActionButton("测试连接", false); test.Anchor = AnchorStyles.Top | AnchorStyles.Right; test.Location = new Point(620, 20); test.Click += TestClicked;
            state.Resize += delegate { test.Left = state.ClientSize.Width - test.Width - 20; };
            state.Controls.Add(stateTitle); state.Controls.Add(stateText); state.Controls.Add(test); state.Height = 86; page.Controls.Add(state, 0, 2);
            AddField(page, 3, "Hub HTTPS 地址", hub, current.HubUrl, "例如 https://cw.example.com");
            AddField(page, 4, "连接 Key", key, current.Key, "在 CW 管理页的“接入设备”中复制"); key.UseSystemPasswordChar = true;
            AddField(page, 5, "这台设备名称", device, current.DeviceId, "用于区分办公室、家里和笔记本");
            return page;
        }

        private Control BuildProjectsPage() {
            TableLayoutPanel page = Page("同步项目", "只同步勾选的项目。每台电脑可以选择不同项目，也可以为同一项目设置不同方向。", 5);
            page.RowStyles[2] = new RowStyle(SizeType.Percent, 100);
            projects.Dock = DockStyle.Fill; projects.BackgroundColor = Color.White; projects.BorderStyle = BorderStyle.None; projects.RowHeadersVisible = false;
            projects.AllowUserToAddRows = false; projects.AllowUserToDeleteRows = false; projects.AllowUserToResizeRows = false; projects.AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill;
            projects.SelectionMode = DataGridViewSelectionMode.FullRowSelect; projects.MultiSelect = false; projects.EnableHeadersVisualStyles = false;
            projects.ColumnHeadersDefaultCellStyle = new DataGridViewCellStyle { BackColor = Color.FromArgb(232, 243, 237), ForeColor = Ink, Font = new Font(Font.FontFamily, 9F, FontStyle.Bold), Padding = new Padding(5), SelectionBackColor = Color.FromArgb(232, 243, 237) };
            projects.DefaultCellStyle = new DataGridViewCellStyle { ForeColor = Ink, SelectionBackColor = Color.FromArgb(220, 240, 231), SelectionForeColor = Ink, Padding = new Padding(5) };
            projects.RowTemplate.Height = 38;
            projects.Columns.Add(new DataGridViewCheckBoxColumn { Name = "Enabled", HeaderText = "同步", FillWeight = 12 });
            projects.Columns.Add(new DataGridViewTextBoxColumn { Name = "WorkspaceId", HeaderText = "项目名称", FillWeight = 24 });
            projects.Columns.Add(new DataGridViewTextBoxColumn { Name = "Path", HeaderText = "本机目录", FillWeight = 46 });
            DataGridViewComboBoxColumn direction = new DataGridViewComboBoxColumn { Name = "Direction", HeaderText = "方向", FillWeight = 18, FlatStyle = FlatStyle.Flat };
            direction.Items.AddRange("双向同步", "仅上传", "仅下载"); projects.Columns.Add(direction);
            foreach (SyncFolder folder in current.Folders ?? new List<SyncFolder>()) if (folder != null) projects.Rows.Add(folder.Enabled, folder.WorkspaceId, folder.Path, DirectionText(folder.Direction));
            Panel card = Card(); card.Padding = new Padding(1); card.Controls.Add(projects); page.Controls.Add(card, 0, 2);
            FlowLayoutPanel actions = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, Margin = new Padding(0, 12, 0, 0) };
            Button discover = ActionButton("扫描 Codex 项目", true), add = ActionButton("添加文件夹", false), remove = ActionButton("移除所选", false);
            discover.Click += DiscoverClicked; add.Click += AddClicked; remove.Click += RemoveClicked; actions.Controls.Add(discover); actions.Controls.Add(add); actions.Controls.Add(remove); page.Controls.Add(actions, 0, 3);
            Label hint = new Label { Text = "方向说明：双向用于主力电脑；仅上传适合贡献代码的电脑；仅下载适合只接收项目的电脑。依赖、构建缓存、.git、.env 与密钥文件不会同步。", AutoSize = true, MaximumSize = new Size(780, 0), ForeColor = Muted, Margin = new Padding(0, 12, 0, 0) };
            page.Controls.Add(hint, 0, 4); return page;
        }

        private Control BuildAutomationPage() {
            TableLayoutPanel page = Page("自动化", "决定这台电脑何时检查差异。文件变化只作为触发信号，真正传输仍按差异进行。", 8);
            sync.Text = "启用项目同步"; sync.Checked = current.SyncProjectDocuments; sync.AutoSize = true;
            chats.Text = "加密备份本机 Codex 对话"; chats.Checked = current.BackupConversations; chats.AutoSize = true;
            startup.Text = "登录 Windows 后自动启动"; startup.Checked = current.StartWithWindows; startup.AutoSize = true;
            FlowLayoutPanel toggles = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, Margin = new Padding(0, 5, 0, 14) }; toggles.Controls.Add(sync); toggles.Controls.Add(chats); toggles.Controls.Add(startup); page.Controls.Add(toggles, 0, 2);
            syncMode.DropDownStyle = ComboBoxStyle.DropDownList; syncMode.FlatStyle = FlatStyle.Flat; syncMode.Items.AddRange(new object[] { "智能同步（变化后 + 定时兜底）", "仅按设定时间同步", "仅手动同步" });
            syncMode.SelectedIndex = current.SyncMode == "scheduled" ? 1 : current.SyncMode == "manual" ? 2 : 0;
            AddControlField(page, 3, "项目同步模式", syncMode, "推荐智能同步：编辑停止后再同步，不会持续占用资源。");
            quiet.Text = current.QuietSeconds.ToString(); AddField(page, 4, "变化静默秒数", quiet, quiet.Text, "30–900 秒，默认 90 秒");
            syncTimes.Text = current.SyncTimes; AddField(page, 5, "每日兜底时间", syncTimes, syncTimes.Text, "逗号分隔，例如 08:00,12:00,18:00,23:00");
            interval.Text = current.IntervalMinutes.ToString(); AddField(page, 6, "额度采集间隔", interval, interval.Text, "分钟；与项目同步相互独立");
            rate.Text = current.UsdCnyRate.ToString("0.00"); AddField(page, 7, "美元兑人民币", rate, rate.Text, "用于 Token 价值换算"); return page;
        }

        private TableLayoutPanel Page(string titleText, string subtitleText, int rows) {
            TableLayoutPanel page = new TableLayoutPanel { RowCount = rows, ColumnCount = 1, Dock = DockStyle.Fill, AutoScroll = false, BackColor = Canvas };
            page.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            for (int index = 0; index < rows; index++) page.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Label title = new Label { Text = titleText, AutoSize = true, Font = new Font(Font.FontFamily, 24F, FontStyle.Bold), ForeColor = Ink, Margin = new Padding(0, 0, 0, 3) };
            Label subtitle = new Label { Text = subtitleText, AutoSize = true, MaximumSize = new Size(780, 0), ForeColor = Muted, Font = new Font(Font.FontFamily, 10.5F), Margin = new Padding(0, 0, 0, 22) };
            page.Controls.Add(title, 0, 0); page.Controls.Add(subtitle, 0, 1); return page;
        }

        private Panel Card() { return new Panel { Dock = DockStyle.Fill, BackColor = Color.White, Margin = new Padding(0, 0, 0, 8) }; }
        private void AddField(TableLayoutPanel page, int row, string label, TextBox box, string value, string hint) { box.Text = value ?? ""; AddControlField(page, row, label, box, hint); }
        private void AddControlField(TableLayoutPanel page, int row, string label, Control control, string hint) {
            TableLayoutPanel field = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 2, Margin = new Padding(0, 5, 0, 8), Padding = new Padding(20, 13, 20, 13), BackColor = Color.White };
            field.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 180)); field.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            Label name = new Label { Text = label, AutoSize = true, Font = new Font(Font.FontFamily, 9.5F, FontStyle.Bold), ForeColor = Ink, Padding = new Padding(0, 7, 0, 0) };
            control.Dock = DockStyle.Top; control.Height = 32; control.BackColor = Color.White;
            Label description = new Label { Text = hint, AutoSize = true, ForeColor = Muted, Margin = new Padding(0, 5, 0, 0) };
            field.Controls.Add(name, 0, 0); field.SetRowSpan(name, 2); field.Controls.Add(control, 1, 0); field.Controls.Add(description, 1, 1); page.Controls.Add(field, 0, row);
        }

        private Button ActionButton(string text, bool primary) {
            Button button = new Button { Text = text, AutoSize = true, Height = 42, Padding = new Padding(14, 4, 14, 4), FlatStyle = FlatStyle.Flat, BackColor = primary ? Green : Color.White, ForeColor = primary ? Color.White : Ink, Cursor = Cursors.Hand };
            button.FlatAppearance.BorderColor = primary ? Green : Color.FromArgb(196, 215, 205); return button;
        }
        private void ShowPage(int index) {
            for (int i = 0; i < pages.Count; i++) pages[i].Visible = i == index;
            for (int i = 0; i < navigation.Count; i++) { navigation[i].BackColor = i == index ? Color.White : Color.Transparent; navigation[i].ForeColor = i == index ? Green : Ink; navigation[i].Font = new Font(Font.FontFamily, 9.5F, i == index ? FontStyle.Bold : FontStyle.Regular); }
            if (index < pages.Count) pages[index].BringToFront();
        }

        private CollectorConfig ReadValue() {
            int minutes, quietSeconds; double usd;
            if (!Int32.TryParse(interval.Text.Trim(), out minutes) || minutes < 1 || minutes > 1440) throw new InvalidOperationException("额度采集间隔应为 1 到 1440 分钟。");
            if (!Int32.TryParse(quiet.Text.Trim(), out quietSeconds) || quietSeconds < 30 || quietSeconds > 900) throw new InvalidOperationException("静默时间应为 30 到 900 秒。");
            if (!Double.TryParse(rate.Text.Trim(), out usd) || usd < 1 || usd > 20) throw new InvalidOperationException("美元兑人民币应为 1 到 20。");
            CollectorConfig value = new CollectorConfig { HubUrl = hub.Text.Trim().TrimEnd('/'), DeviceId = CollectorConfig.Slug(device.Text), IntervalMinutes = minutes, UsdCnyRate = usd,
                SyncProjectDocuments = sync.Checked, BackupConversations = chats.Checked, SyncMode = syncMode.SelectedIndex == 1 ? "scheduled" : syncMode.SelectedIndex == 2 ? "manual" : "smart",
                QuietSeconds = quietSeconds, SyncTimes = NormalizeTimes(syncTimes.Text), StartWithWindows = startup.Checked, Folders = ReadProjects() };
            value.Key = key.Text; if (!value.IsReady()) throw new InvalidOperationException("请填写正确的 HTTPS Hub 地址和连接 Key。"); return value;
        }

        private List<SyncFolder> ReadProjects() {
            List<SyncFolder> values = new List<SyncFolder>(); HashSet<string> ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (DataGridViewRow row in projects.Rows) {
                string name = Convert.ToString(row.Cells["WorkspaceId"].Value).Trim(), path = Convert.ToString(row.Cells["Path"].Value).Trim();
                if (String.IsNullOrWhiteSpace(name) || String.IsNullOrWhiteSpace(path)) continue;
                string id = CollectorConfig.Slug(name); if (!ids.Add(id)) throw new InvalidOperationException("项目名称不能重复：" + name);
                values.Add(new SyncFolder { Enabled = Convert.ToBoolean(row.Cells["Enabled"].Value ?? false), WorkspaceId = id, Path = path, Direction = DirectionValue(Convert.ToString(row.Cells["Direction"].Value)) });
            }
            return values;
        }
        private static string NormalizeTimes(string text) {
            List<string> values = new List<string>();
            foreach (string raw in (text ?? "").Split(new [] { ',', '，', ';', '；', ' ' }, StringSplitOptions.RemoveEmptyEntries)) {
                DateTime parsed; if (!DateTime.TryParseExact(raw.Trim(), "HH:mm", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out parsed)) throw new InvalidOperationException("同步时间格式应为 HH:mm。");
                string value = parsed.ToString("HH:mm"); if (!values.Contains(value)) values.Add(value);
            }
            if (values.Count == 0) throw new InvalidOperationException("请至少填写一个同步时间。"); values.Sort(StringComparer.Ordinal); return String.Join(",", values.ToArray());
        }
        private void SaveClicked(object sender, EventArgs e) { try { Value = ReadValue(); DialogResult = DialogResult.OK; Close(); } catch (Exception error) { MessageBox.Show(error.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Warning); } }
        private void TestClicked(object sender, EventArgs e) {
            try { CollectorConfig value = ReadValue(); Dictionary<string, object> status = new HubClient(value).Post("/api/collector/v1/sync/pull", new Dictionary<string, object> { { "workspaceId", "connection-test" }, { "sinceRevision", 0 }, { "metadataOnly", true } }); MessageBox.Show("连接成功，CW 已接受同步协议。", Text, MessageBoxButtons.OK, MessageBoxIcon.Information); }
            catch (Exception error) { MessageBox.Show(error.Message, "连接失败", MessageBoxButtons.OK, MessageBoxIcon.Error); }
        }
        private void AddClicked(object sender, EventArgs e) {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog { Description = "选择要加入清单的项目文件夹", ShowNewFolderButton = true }) if (dialog.ShowDialog() == DialogResult.OK) AddProject(dialog.SelectedPath, true);
        }
        private void RemoveClicked(object sender, EventArgs e) { if (projects.SelectedRows.Count > 0) projects.Rows.Remove(projects.SelectedRows[0]); }
        private void DiscoverClicked(object sender, EventArgs e) {
            string path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex", "config.toml");
            if (!File.Exists(path)) { MessageBox.Show("没有找到 Codex config.toml。", Text); return; }
            int added = 0; Regex pattern = new Regex("^\\[projects\\.(?:'([^']+)'|\"([^\"]+)\")\\]$");
            foreach (string line in File.ReadLines(path, Encoding.UTF8)) {
                Match match = pattern.Match(line.Trim()); if (!match.Success) continue;
                string project = (match.Groups[1].Success ? match.Groups[1].Value : match.Groups[2].Value).Replace("\\\\", "\\");
                if (Directory.Exists(project) && AddProject(project, false)) added++;
            }
            MessageBox.Show(added == 0 ? "没有发现新的项目；已有项目不会重复添加。" : "已加入 " + added + " 个项目，请勾选需要同步的项目。", Text);
        }
        private bool AddProject(string path, bool select) {
            string full = Path.GetFullPath(path);
            foreach (DataGridViewRow row in projects.Rows) if (String.Equals(Path.GetFullPath(Convert.ToString(row.Cells["Path"].Value)), full, StringComparison.OrdinalIgnoreCase)) return false;
            int index = projects.Rows.Add(select, CollectorConfig.Slug(Path.GetFileName(full.TrimEnd('\\', '/'))), full, "双向同步"); if (select) projects.Rows[index].Selected = true; return true;
        }
        private static string DirectionText(string value) { return value == "upload" ? "仅上传" : value == "download" ? "仅下载" : "双向同步"; }
        private static string DirectionValue(string value) { return value == "仅上传" ? "upload" : value == "仅下载" ? "download" : "both"; }
    }
}
