using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace CWUsageReporter {
    internal sealed class CardPanel : Panel {
        public CardPanel() { DoubleBuffered = true; BackColor = Color.FromArgb(250, 253, 252); Padding = new Padding(22); }
        protected override void OnPaint(PaintEventArgs e) {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle rect = new Rectangle(0, 0, Width - 1, Height - 1);
            using (GraphicsPath path = Rounded(rect, 18))
            using (Pen pen = new Pen(Color.FromArgb(220, 231, 226))) e.Graphics.DrawPath(pen, path);
            base.OnPaint(e);
        }
        private static GraphicsPath Rounded(Rectangle rect, int radius) {
            int d = radius * 2; GraphicsPath path = new GraphicsPath();
            path.AddArc(rect.X, rect.Y, d, d, 180, 90); path.AddArc(rect.Right - d, rect.Y, d, d, 270, 90);
            path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90); path.AddArc(rect.X, rect.Bottom - d, d, d, 90, 90); path.CloseFigure(); return path;
        }
    }

    internal sealed class SettingsForm : Form {
        private readonly TextBox hubUrl = Input();
        private readonly TextBox key = Input();
        private readonly TextBox device = Input();
        private readonly NumericUpDown interval = NumberInput(1, 1440, 5, 0);
        private readonly NumericUpDown rate = NumberInput(1, 20, 7.2m, 2);
        private readonly CheckBox startup = new CheckBox();
        private readonly Label message = new Label();
        private readonly ReporterConfig original;
        public ReporterConfig Value { get; private set; }

        public SettingsForm(ReporterConfig config, string status, DateTime? lastSuccess, long todayTokens, double todayValueCny) {
            original = config;
            Text = "CW Token 详情采集器";
            Icon = SystemIcons.Application;
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(760, 680);
            ClientSize = new Size(800, 700);
            BackColor = Color.FromArgb(241, 246, 243);
            ForeColor = Color.FromArgb(20, 35, 30);
            Font = new Font("Segoe UI", 10F);
            AutoScaleMode = AutoScaleMode.Dpi;
            FormBorderStyle = FormBorderStyle.Sizable;

            TableLayoutPanel root = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(36, 30, 36, 28), ColumnCount = 1, RowCount = 4, BackColor = BackColor };
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 100));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 112));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 74));
            Controls.Add(root);

            Panel heading = new Panel { Dock = DockStyle.Fill, BackColor = BackColor };
            heading.Controls.Add(TextLabel("CW · TOKEN REPORTER", 10, FontStyle.Bold, Color.FromArgb(8, 122, 88), new Point(0, 2), new Size(400, 20)));
            heading.Controls.Add(TextLabel("只采集 Token，不接触项目文件", 23, FontStyle.Bold, ForeColor, new Point(0, 27), new Size(680, 34)));
            heading.Controls.Add(TextLabel("本机汇总 Codex 会话用量，定时向 CW 上报统计数字。", 10, FontStyle.Regular, Color.FromArgb(91, 109, 102), new Point(0, 68), new Size(680, 23)));
            root.Controls.Add(heading, 0, 0);

            CardPanel statusCard = new CardPanel { Dock = DockStyle.Fill, Margin = new Padding(0, 0, 0, 16) };
            Label dot = TextLabel("●", 15, FontStyle.Regular, config.IsReady() ? Color.FromArgb(8, 122, 88) : Color.FromArgb(139, 93, 16), new Point(22, 20), new Size(30, 28));
            statusCard.Controls.Add(dot);
            statusCard.Controls.Add(TextLabel(status ?? "等待连接", 12, FontStyle.Bold, ForeColor, new Point(57, 19), new Size(620, 27)));
            string detail = lastSuccess.HasValue ? "今日 " + FormatTokens(todayTokens) + " tokens · API 等价价值约 ¥" + todayValueCny.ToString("0.00") : "保存连接后将立即进行首次上报";
            statusCard.Controls.Add(TextLabel(detail, 9, FontStyle.Regular, Color.FromArgb(128, 144, 137), new Point(58, 50), new Size(620, 24)));
            root.Controls.Add(statusCard, 0, 1);

            CardPanel form = new CardPanel { Dock = DockStyle.Fill, Margin = new Padding(0) };
            TableLayoutPanel fields = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 6, BackColor = Color.Transparent };
            fields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50)); fields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
            fields.RowStyles.Add(new RowStyle(SizeType.Absolute, 76)); fields.RowStyles.Add(new RowStyle(SizeType.Absolute, 76));
            fields.RowStyles.Add(new RowStyle(SizeType.Absolute, 76)); fields.RowStyles.Add(new RowStyle(SizeType.Absolute, 76));
            fields.RowStyles.Add(new RowStyle(SizeType.Absolute, 46)); fields.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            form.Controls.Add(fields);
            AddField(fields, "CW HTTPS 地址", hubUrl, 0, 0, 2);
            AddField(fields, "设备连接 Key", key, 0, 1, 2);
            AddField(fields, "设备名称", device, 0, 2, 2);
            AddField(fields, "上报间隔（分钟）", interval, 0, 3, 1);
            AddField(fields, "美元兑人民币", rate, 1, 3, 1);
            startup.Text = "随 Windows 启动并在后台保持更新"; startup.AutoSize = true; startup.ForeColor = Color.FromArgb(59, 79, 71); startup.Margin = new Padding(2, 12, 0, 0);
            fields.Controls.Add(startup, 0, 4); fields.SetColumnSpan(startup, 2);
            Label privacy = TextLabel("隐私边界：只读取 ~/.codex/sessions 与 archived_sessions 中的 token_count 统计；不会上传提示词、回答、会话原文或任何项目文件。", 8.5f, FontStyle.Regular, Color.FromArgb(128, 144, 137), Point.Empty, Size.Empty);
            privacy.Dock = DockStyle.Fill; privacy.Padding = new Padding(2, 12, 0, 0); privacy.AutoEllipsis = true;
            fields.Controls.Add(privacy, 0, 5); fields.SetColumnSpan(privacy, 2);
            root.Controls.Add(form, 0, 2);

            Panel actions = new Panel { Dock = DockStyle.Fill, BackColor = BackColor };
            message.AutoSize = false; message.Location = new Point(0, 20); message.Size = new Size(430, 35); message.ForeColor = Color.FromArgb(166, 63, 63);
            actions.Controls.Add(message);
            Button cancel = ButtonOf("取消", false); cancel.Location = new Point(490, 14); cancel.Click += delegate { DialogResult = DialogResult.Cancel; Close(); };
            Button save = ButtonOf("保存并连接", true); save.Location = new Point(592, 14); save.Click += Save;
            actions.Controls.Add(cancel); actions.Controls.Add(save);
            actions.Resize += delegate { save.Left = actions.ClientSize.Width - save.Width; cancel.Left = save.Left - cancel.Width - 10; };
            root.Controls.Add(actions, 0, 3);

            hubUrl.Text = config.HubUrl ?? "";
            key.UseSystemPasswordChar = true; key.Text = config.IsReady() ? "••••••••••••" : "";
            device.Text = config.DeviceId ?? "";
            interval.Value = Math.Max(interval.Minimum, Math.Min(interval.Maximum, config.IntervalMinutes));
            rate.Value = Math.Max(rate.Minimum, Math.Min(rate.Maximum, (decimal)config.UsdCnyRate));
            startup.Checked = config.StartWithWindows;
        }

        private void Save(object sender, EventArgs e) {
            string url = hubUrl.Text.Trim().TrimEnd('/'); Uri uri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out uri) || uri.Scheme != Uri.UriSchemeHttps) { message.Text = "请输入有效的 HTTPS CW 地址。"; return; }
            string id = ReporterConfig.Slug(device.Text);
            string nextKey = key.Text == "••••••••••••" ? original.Key : key.Text.Trim();
            if (String.IsNullOrWhiteSpace(nextKey)) { message.Text = "请输入设备连接 Key。"; return; }
            ReporterConfig value = new ReporterConfig { HubUrl = url, DeviceId = id, IntervalMinutes = (int)interval.Value, UsdCnyRate = (double)rate.Value, StartWithWindows = startup.Checked };
            value.Key = nextKey; Value = value; DialogResult = DialogResult.OK; Close();
        }

        private static TextBox Input() { return new TextBox { BorderStyle = BorderStyle.FixedSingle, BackColor = Color.White, Font = new Font("Segoe UI", 10F), Margin = new Padding(2, 4, 12, 8) }; }
        private static NumericUpDown NumberInput(decimal min, decimal max, decimal value, int decimals) { return new NumericUpDown { Minimum = min, Maximum = max, Value = value, DecimalPlaces = decimals, BorderStyle = BorderStyle.FixedSingle, BackColor = Color.White, Font = new Font("Segoe UI", 10F), Margin = new Padding(2, 4, 12, 8) }; }
        private static void AddField(TableLayoutPanel panel, string title, Control control, int column, int row, int span) { Panel wrap = new Panel { Dock = DockStyle.Fill, BackColor = Color.Transparent }; Label label = TextLabel(title, 8.5f, FontStyle.Bold, Color.FromArgb(91, 109, 102), new Point(2, 0), new Size(300, 22)); control.Location = new Point(2, 24); control.Size = new Size(300, 34); control.Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Top; wrap.Controls.Add(label); wrap.Controls.Add(control); panel.Controls.Add(wrap, column, row); panel.SetColumnSpan(wrap, span); }
        private static Label TextLabel(string text, float size, FontStyle style, Color color, Point location, Size bounds) { return new Label { Text = text, Font = new Font("Segoe UI", size, style), ForeColor = color, BackColor = Color.Transparent, Location = location, Size = bounds, AutoSize = bounds.IsEmpty }; }
        private static Button ButtonOf(string text, bool primary) { Button button = new Button { Text = text, Size = new Size(primary ? 130 : 92, 42), FlatStyle = FlatStyle.Flat, Font = new Font("Segoe UI", 9.5f, FontStyle.Bold), Cursor = Cursors.Hand, BackColor = primary ? Color.FromArgb(8, 122, 88) : Color.White, ForeColor = primary ? Color.White : Color.FromArgb(59, 79, 71) }; button.FlatAppearance.BorderColor = primary ? Color.FromArgb(8, 122, 88) : Color.FromArgb(210, 224, 217); return button; }
        private static string FormatTokens(long value) { if (value >= 1000000) return (value / 1000000d).ToString("0.##") + "M"; if (value >= 1000) return (value / 1000d).ToString("0.##") + "K"; return value.ToString(); }
    }
}
