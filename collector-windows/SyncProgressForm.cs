using System;
using System.Drawing;
using System.Windows.Forms;

namespace CodexWorkspaceCollector {
    internal sealed class SyncProgressForm : Form {
        private readonly Label status = new Label(), percent = new Label(), workspace = new Label(), detail = new Label(), file = new Label(), counts = new Label();
        private readonly ProgressBar bar = new ProgressBar();

        public SyncProgressForm() {
            Text = "CW 同步进度"; Width = 650; Height = 345; MinimumSize = new Size(560, 310); StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Dpi; AutoScaleDimensions = new SizeF(96F, 96F); Font = new Font("Microsoft YaHei UI", 10F);
            BackColor = Color.FromArgb(242, 247, 244); FormBorderStyle = FormBorderStyle.Sizable; MaximizeBox = false;

            TableLayoutPanel root = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(30, 24, 30, 26), RowCount = 7, ColumnCount = 2 };
            root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); root.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            Controls.Add(root);
            Label kicker = new Label { Text = "CODEX WORKSPACE HUB", AutoSize = true, ForeColor = Color.FromArgb(13, 132, 89), Font = new Font(Font.FontFamily, 8.5F, FontStyle.Bold), Margin = new Padding(0, 0, 0, 5) };
            root.Controls.Add(kicker, 0, 0); root.SetColumnSpan(kicker, 2);
            status.Text = "等待同步"; status.AutoSize = true; status.Font = new Font(Font.FontFamily, 20F, FontStyle.Bold); status.ForeColor = Color.FromArgb(18, 45, 35);
            percent.Text = "0%"; percent.AutoSize = true; percent.Font = new Font(Font.FontFamily, 20F, FontStyle.Bold); percent.ForeColor = Color.FromArgb(13, 132, 89); percent.Anchor = AnchorStyles.Right;
            root.Controls.Add(status, 0, 1); root.Controls.Add(percent, 1, 1);
            workspace.AutoSize = true; workspace.ForeColor = Color.FromArgb(62, 91, 80); workspace.Margin = new Padding(0, 8, 0, 13);
            root.Controls.Add(workspace, 0, 2); root.SetColumnSpan(workspace, 2);
            bar.Dock = DockStyle.Fill; bar.Height = 18; bar.Style = ProgressBarStyle.Continuous; bar.Margin = new Padding(0, 0, 0, 18);
            root.Controls.Add(bar, 0, 3); root.SetColumnSpan(bar, 2);
            detail.AutoSize = true; detail.Font = new Font(Font.FontFamily, 10F, FontStyle.Bold); detail.ForeColor = Color.FromArgb(30, 66, 52);
            counts.AutoSize = true; counts.Anchor = AnchorStyles.Right; counts.ForeColor = Color.FromArgb(92, 112, 104);
            root.Controls.Add(detail, 0, 4); root.Controls.Add(counts, 1, 4);
            file.AutoEllipsis = true; file.Dock = DockStyle.Fill; file.Height = 48; file.ForeColor = Color.FromArgb(92, 112, 104); file.Margin = new Padding(0, 7, 0, 0);
            root.Controls.Add(file, 0, 5); root.SetColumnSpan(file, 2);
            Label hint = new Label { Text = "窗口可以关闭，同步会继续在后台运行；从托盘菜单可再次打开。", AutoSize = true, ForeColor = Color.FromArgb(118, 137, 129), Margin = new Padding(0, 14, 0, 0) };
            root.Controls.Add(hint, 0, 6); root.SetColumnSpan(hint, 2);
        }

        public void UpdateProgress(SyncProgressInfo info) {
            if (info == null) return;
            int value = Math.Max(0, Math.Min(100, info.Percent));
            bar.Value = value; percent.Text = value + "%"; status.Text = info.Phase ?? "同步中";
            workspace.Text = String.IsNullOrWhiteSpace(info.WorkspaceName) ? "" : "当前项目  ·  " + info.WorkspaceName;
            detail.Text = String.IsNullOrWhiteSpace(info.Message) ? "正在处理" : info.Message;
            counts.Text = info.TotalFiles > 0 ? info.CompletedFiles + " / " + info.TotalFiles + " 个文件" : FormatBytes(info.TransferredBytes, info.TotalBytes);
            file.Text = String.IsNullOrWhiteSpace(info.CurrentFile) ? "" : "正在处理：" + info.CurrentFile;
            percent.ForeColor = info.Status == "error" ? Color.FromArgb(190, 63, 58) : Color.FromArgb(13, 132, 89);
        }

        private static string FormatBytes(long done, long total) {
            if (total <= 0) return "";
            return FormatSize(done) + " / " + FormatSize(total);
        }
        private static string FormatSize(long value) {
            if (value >= 1024L * 1024L) return (value / 1024d / 1024d).ToString("0.0") + " MB";
            if (value >= 1024L) return (value / 1024d).ToString("0.0") + " KB";
            return value + " B";
        }
    }
}
