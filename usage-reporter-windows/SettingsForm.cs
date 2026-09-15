using System;
using System.Collections.Generic;
using System.Drawing;
using System.Windows.Forms;

namespace CWUsageReporter {
    internal static class Theme {
        public static readonly Color Background = Color.FromArgb(247, 249, 248);
        public static readonly Color Surface = Color.FromArgb(255, 255, 255);
        public static readonly Color Text = Color.FromArgb(19, 34, 29);
        public static readonly Color TextSoft = Color.FromArgb(83, 103, 95);
        public static readonly Color TextFaint = Color.FromArgb(126, 143, 136);
        public static readonly Color Border = Color.FromArgb(218, 227, 223);
        public static readonly Color Accent = Color.FromArgb(8, 122, 88);
        public static readonly Color Warning = Color.FromArgb(151, 99, 16);
    }

    internal sealed class SettingsForm : Form {
        private const string UiFontName = "Microsoft YaHei UI";
        private static readonly Dictionary<string, Font> FontCache = new Dictionary<string, Font>();
        private readonly TextBox hubUrl = Input();
        private readonly TextBox key = Input();
        private readonly TextBox device = Input();
        private readonly NumericUpDown interval = NumberInput(1, 1440, 5, 0);
        private readonly NumericUpDown rate = NumberInput(1, 20, 7.2m, 2);
        private readonly CheckBox startup = new CheckBox();
        private readonly Label message = new Label();
        private readonly ReporterConfig original;
        public ReporterConfig Value { get; private set; }

        public SettingsForm(ReporterConfig config, string status, DateTime? lastSuccess, UsageOverview usage) {
            original = config; Text = "CW Token 详情采集器";
            Icon = Program.AppIcon;
            StartPosition = FormStartPosition.CenterScreen; MinimumSize = new Size(950, 750); ClientSize = new Size(1060, 780);
            BackColor = Theme.Background; ForeColor = Theme.Text; Font = FontOf(16F, FontStyle.Regular);
            AutoScaleMode = AutoScaleMode.None; FormBorderStyle = FormBorderStyle.Sizable;

            TableLayoutPanel root = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(38, 26, 38, 20), ColumnCount = 1, RowCount = 8, BackColor = Theme.Background };
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 102)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 1));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 51)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 154));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 1)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 44));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); root.RowStyles.Add(new RowStyle(SizeType.Absolute, 56));
            Controls.Add(root);
            root.Controls.Add(BuildHeading(), 0, 0); root.Controls.Add(Line(), 0, 1);
            root.Controls.Add(BuildStatus(config, status, lastSuccess, usage), 0, 2); root.Controls.Add(BuildMetrics(usage, config.UsdCnyRate), 0, 3);
            root.Controls.Add(Line(), 0, 4); root.Controls.Add(BuildSectionHeading(), 0, 5); root.Controls.Add(BuildSettings(), 0, 6); root.Controls.Add(BuildActions(), 0, 7);

            hubUrl.Text = config.HubUrl ?? ""; key.UseSystemPasswordChar = true; key.Text = config.IsReady() ? "••••••••••••" : "";
            device.Text = config.DeviceId ?? ""; interval.Value = Math.Max(interval.Minimum, Math.Min(interval.Maximum, config.IntervalMinutes));
            rate.Value = Math.Max(rate.Minimum, Math.Min(rate.Maximum, (decimal)config.UsdCnyRate)); startup.Checked = config.StartWithWindows;
        }

        private Control BuildHeading() {
            TableLayoutPanel heading = new TableLayoutPanel { Dock = DockStyle.Fill, BackColor = Theme.Background, ColumnCount = 2, RowCount = 1, Margin = new Padding(0) };
            heading.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 68)); heading.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            heading.Controls.Add(new PictureBox { Dock = DockStyle.Fill, Margin = new Padding(0, 8, 18, 28), SizeMode = PictureBoxSizeMode.Zoom, Image = Program.AppBitmap }, 0, 0);
            TableLayoutPanel copy = new TableLayoutPanel { Dock = DockStyle.Fill, BackColor = Theme.Background, ColumnCount = 1, RowCount = 4, Margin = new Padding(0) };
            copy.RowStyles.Add(new RowStyle(SizeType.Absolute, 20)); copy.RowStyles.Add(new RowStyle(SizeType.Absolute, 40)); copy.RowStyles.Add(new RowStyle(SizeType.Absolute, 27)); copy.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            copy.Controls.Add(LabelOf("CW  /  TOKEN REPORTER  ·  v" + ReporterConfig.AppVersion, 14F, FontStyle.Bold, Theme.Accent), 0, 0);
            copy.Controls.Add(LabelOf("Token 用量采集器", 30F, FontStyle.Bold, Theme.Text), 0, 1);
            copy.Controls.Add(LabelOf("安静地汇总 Codex 用量；不读取提示词、回答或项目文件。", 15F, FontStyle.Regular, Theme.TextSoft), 0, 2);
            heading.Controls.Add(copy, 1, 0); return heading;
        }

        private Control BuildStatus(ReporterConfig config, string status, DateTime? lastSuccess, UsageOverview usage) {
            TableLayoutPanel row = new TableLayoutPanel { Dock = DockStyle.Fill, BackColor = Theme.Background, ColumnCount = 2, RowCount = 1, Margin = new Padding(0) };
            row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 26)); row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            Label dot = LabelOf("●", 16F, FontStyle.Regular, config.IsReady() ? Theme.Accent : Theme.Warning);
            string meta = usage != null ? "  ·  " + usage.SourceNote : "  ·  保存后立即上报";
            Label state = LabelOf((status ?? "等待连接") + meta, 16F, FontStyle.Bold, Theme.Text); row.Controls.Add(dot, 0, 0); row.Controls.Add(state, 1, 0); return row;
        }

        private Control BuildMetrics(UsageOverview usage, double fallbackRate) {
            TableLayoutPanel strip = new TableLayoutPanel { Dock = DockStyle.Fill, BackColor = Theme.Background, ColumnCount = 4, RowCount = 1, Margin = new Padding(0) };
            for (int i = 0; i < 4; i++) strip.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25));
            double exchange = usage == null ? fallbackRate : usage.UsdCnyRate;
            strip.Controls.Add(Metric("今日", usage == null ? null : usage.Day, exchange, true), 0, 0); strip.Controls.Add(Metric("本周", usage == null ? null : usage.Week, exchange, true), 1, 0);
            strip.Controls.Add(Metric("本月", usage == null ? null : usage.Month, exchange, true), 2, 0); strip.Controls.Add(Metric("累计", usage == null ? null : usage.Total, exchange, false), 3, 0); return strip;
        }

        private Control Metric(string title, UsagePeriodView period, double exchange, bool divider) {
            Panel host = new Panel { Dock = DockStyle.Fill, BackColor = Theme.Background, Margin = new Padding(0), Padding = new Padding(16, 9, 16, 8) };
            TableLayoutPanel body = new TableLayoutPanel { Dock = DockStyle.Fill, BackColor = Theme.Background, ColumnCount = 1, RowCount = 4, Margin = new Padding(0) };
            body.RowStyles.Add(new RowStyle(SizeType.Absolute, 24)); body.RowStyles.Add(new RowStyle(SizeType.Absolute, 42)); body.RowStyles.Add(new RowStyle(SizeType.Absolute, 42)); body.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            double? valueCny = period == null ? null : period.ValueCny(exchange);
            string value = !valueCny.HasValue ? "—" : "¥" + valueCny.Value.ToString("0.00");
            body.Controls.Add(LabelOf(title.ToUpperInvariant() + "  TOKEN", 13F, FontStyle.Bold, Theme.TextSoft), 0, 0);
            body.Controls.Add(LabelOf(period == null || !period.TokensAvailable ? "待官方返回" : UsageFormatting.Tokens(period.TotalTokens) + (period.Partial ? " *" : ""), 30F, FontStyle.Bold, Theme.Text), 0, 1);
            body.Controls.Add(LabelOf(value, 30F, FontStyle.Bold, Theme.Accent), 0, 2);
            body.Controls.Add(LabelOf("用量价值", 11F, FontStyle.Regular, Theme.TextSoft), 0, 3); host.Controls.Add(body);
            if (divider) host.Controls.Add(new Panel { Dock = DockStyle.Right, Width = 1, BackColor = Theme.Border }); return host;
        }

        private Control BuildSectionHeading() {
            TableLayoutPanel row = new TableLayoutPanel { Dock = DockStyle.Fill, BackColor = Theme.Background, ColumnCount = 2, RowCount = 1, Margin = new Padding(0) };
            row.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize)); row.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            Label title = LabelOf("连接设置", 18F, FontStyle.Bold, Theme.Text); title.AutoSize = true; title.Padding = new Padding(0, 8, 20, 0);
            Label note = LabelOf("连接信息只保存在当前 Windows 用户中", 14F, FontStyle.Regular, Theme.TextFaint); note.TextAlign = ContentAlignment.MiddleRight; note.Padding = new Padding(0, 8, 0, 0);
            row.Controls.Add(title, 0, 0); row.Controls.Add(note, 1, 0); return row;
        }

        private Control BuildSettings() {
            TableLayoutPanel fields = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 4, BackColor = Theme.Background, Margin = new Padding(0) };
            fields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50)); fields.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
            fields.RowStyles.Add(new RowStyle(SizeType.Absolute, 62)); fields.RowStyles.Add(new RowStyle(SizeType.Absolute, 62)); fields.RowStyles.Add(new RowStyle(SizeType.Absolute, 62)); fields.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            AddField(fields, "CW HTTPS 地址", hubUrl, 0, 0, 2); AddField(fields, "设备连接 Key", key, 0, 1, 1); AddField(fields, "设备名称", device, 1, 1, 1);
            AddField(fields, "上报间隔（分钟）", interval, 0, 2, 1); AddField(fields, "美元兑人民币", rate, 1, 2, 1);
            TableLayoutPanel foot = new TableLayoutPanel { Dock = DockStyle.Fill, BackColor = Theme.Background, ColumnCount = 1, RowCount = 2, Margin = new Padding(0) };
            foot.RowStyles.Add(new RowStyle(SizeType.Absolute, 38)); foot.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            startup.Text = "随 Windows 登录启动，并在后台保持更新"; startup.AutoSize = true; startup.ForeColor = Theme.TextSoft; startup.Margin = new Padding(0, 10, 0, 0);
            Label privacy = LabelOf("用量价值为 API 单价折算参考，不是实际账单；数据来源见顶部说明。", 12F, FontStyle.Regular, Theme.TextFaint); privacy.Padding = new Padding(0, 4, 0, 0);
            foot.Controls.Add(startup, 0, 0); foot.Controls.Add(privacy, 0, 1); fields.Controls.Add(foot, 0, 3); fields.SetColumnSpan(foot, 2); return fields;
        }

        private Control BuildActions() {
            TableLayoutPanel actions = new TableLayoutPanel { Dock = DockStyle.Fill, BackColor = Theme.Background, ColumnCount = 2, RowCount = 1, Margin = new Padding(0) };
            actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); actions.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            message.Dock = DockStyle.Fill; message.TextAlign = ContentAlignment.MiddleLeft; message.ForeColor = Color.FromArgb(166, 63, 63); message.AutoEllipsis = true;
            FlowLayoutPanel buttons = new FlowLayoutPanel { AutoSize = true, Dock = DockStyle.Fill, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, Padding = new Padding(0, 8, 0, 0), BackColor = Theme.Background };
            Button cancel = ButtonOf("取消", false); cancel.Click += delegate { DialogResult = DialogResult.Cancel; Close(); }; Button save = ButtonOf("保存并连接", true); save.Click += Save;
            buttons.Controls.Add(cancel); buttons.Controls.Add(save); actions.Controls.Add(message, 0, 0); actions.Controls.Add(buttons, 1, 0); return actions;
        }

        private void Save(object sender, EventArgs e) {
            string url = hubUrl.Text.Trim().TrimEnd('/'); Uri uri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out uri) || uri.Scheme != Uri.UriSchemeHttps) { message.Text = "请输入有效的 HTTPS CW 地址。"; return; }
            string id = ReporterConfig.Slug(device.Text); string nextKey = key.Text == "••••••••••••" ? original.Key : key.Text.Trim();
            if (String.IsNullOrWhiteSpace(nextKey)) { message.Text = "请输入设备连接 Key。"; return; }
            ReporterConfig value = new ReporterConfig { HubUrl = url, DeviceId = id, IntervalMinutes = (int)interval.Value, UsdCnyRate = (double)rate.Value, StartWithWindows = startup.Checked };
            value.Key = nextKey; Value = value; DialogResult = DialogResult.OK; Close();
        }

        private static Control Line() { return new Panel { Dock = DockStyle.Fill, BackColor = Theme.Border, Margin = new Padding(0) }; }
        private static TextBox Input() { return new TextBox { Dock = DockStyle.Fill, BorderStyle = BorderStyle.None, BackColor = Theme.Background, ForeColor = Theme.Text, Font = FontOf(16F, FontStyle.Regular), Margin = new Padding(0, 3, 12, 0) }; }
        private static NumericUpDown NumberInput(decimal min, decimal max, decimal value, int decimals) { return new NumericUpDown { Dock = DockStyle.Fill, Minimum = min, Maximum = max, Value = value, DecimalPlaces = decimals, BorderStyle = BorderStyle.None, BackColor = Theme.Background, ForeColor = Theme.Text, Font = FontOf(16F, FontStyle.Regular), Margin = new Padding(0, 3, 12, 0) }; }
        private static void AddField(TableLayoutPanel panel, string title, Control control, int column, int row, int span) {
            TableLayoutPanel field = new TableLayoutPanel { Dock = DockStyle.Fill, BackColor = Theme.Background, RowCount = 3, ColumnCount = 1, Margin = new Padding(column == 0 ? 0 : 12, 0, column == 0 && span == 1 ? 12 : 0, 7) };
            field.RowStyles.Add(new RowStyle(SizeType.Absolute, 20)); field.RowStyles.Add(new RowStyle(SizeType.Percent, 100)); field.RowStyles.Add(new RowStyle(SizeType.Absolute, 1));
            field.Controls.Add(LabelOf(title, 14F, FontStyle.Bold, Theme.TextSoft), 0, 0); field.Controls.Add(control, 0, 1); field.Controls.Add(Line(), 0, 2);
            panel.Controls.Add(field, column, row); panel.SetColumnSpan(field, span);
        }
        private static Label LabelOf(string text, float size, FontStyle style, Color color) { return new Label { Text = text, Dock = DockStyle.Fill, AutoEllipsis = true, Font = FontOf(size, style), ForeColor = color, BackColor = Theme.Background, TextAlign = ContentAlignment.MiddleLeft, Margin = new Padding(0) }; }
        private static Button ButtonOf(string text, bool primary) { Button button = new Button { Text = text, Size = new Size(primary ? 132 : 86, 38), Margin = new Padding(8, 0, 0, 0), FlatStyle = FlatStyle.Flat, Font = FontOf(15F, FontStyle.Bold), Cursor = Cursors.Hand, BackColor = primary ? Theme.Accent : Theme.Background, ForeColor = primary ? Color.White : Theme.TextSoft }; button.FlatAppearance.BorderColor = primary ? Theme.Accent : Theme.Border; button.FlatAppearance.MouseDownBackColor = primary ? Color.FromArgb(5, 103, 71) : Color.FromArgb(236, 241, 239); return button; }
        private static Font FontOf(float pixels, FontStyle style) {
            string key = pixels.ToString(System.Globalization.CultureInfo.InvariantCulture) + ":" + (int)style; Font font;
            lock (FontCache) { if (!FontCache.TryGetValue(key, out font)) { font = new Font(UiFontName, pixels, style, GraphicsUnit.Pixel); FontCache[key] = font; } }
            return font;
        }
    }
}
