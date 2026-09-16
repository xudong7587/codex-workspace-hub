using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace CWUsageReporter {
    internal static class Program {
        internal static readonly Icon AppIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
        internal static readonly Bitmap AppBitmap = AppIcon.ToBitmap();

        [STAThread]
        private static void Main(string[] args) {
            bool created;
            using (Mutex mutex = new Mutex(true, "Local\\CWUsageReporter.SingleInstance", out created)) {
                if (!created) { MessageBox.Show("CW Token 详情采集器已经在运行。", "CW Token 详情采集器"); return; }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                bool startInBackground = Array.Exists(args ?? new string[0], value => String.Equals(value, "--background", StringComparison.OrdinalIgnoreCase));
                Application.Run(new ReporterContext(startInBackground));
            }
        }
    }

    internal sealed class ReporterContext : ApplicationContext {
        private ReporterConfig config;
        private readonly NotifyIcon tray;
        private readonly SynchronizationContext uiContext;
        private System.Threading.Timer timer;
        private int running;
        private string lastStatus = "等待首次上报";
        private DateTime? lastSuccess;
        private UsageOverview usageOverview;
        private Icon quotaIcon;
        private static readonly string LogPath = Path.Combine(ReporterConfig.DataDirectory, "reporter.log");

        public ReporterContext(bool startInBackground) {
            uiContext = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
            config = ReporterConfig.Load();
            try { config.ApplyStartupSetting(); }
            catch (Exception error) { Log("自启动配置失败：" + Short(error.Message, 120)); }
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("立即刷新用量", null, delegate { QueueReport(true); });
            menu.Items.Add("连接设置", null, delegate { ShowSettings(); });
            menu.Items.Add("查看日志", null, delegate { OpenLog(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出", null, delegate { ExitThread(); });
            tray = new NotifyIcon { Icon = Program.AppIcon, Text = "CW Token 详情采集器", Visible = true, ContextMenuStrip = menu };
            tray.DoubleClick += delegate { ShowSettings(); };
            ResetTimer();
            if (config.IsReady()) {
                QueueReport(false);
                if (!startInBackground) ShowSettings();
            } else if (!startInBackground) {
                ShowSettings();
            } else {
                lastStatus = "尚未配置，请双击托盘图标完成连接";
                tray.Text = "CW Token 详情采集器 · 尚未配置";
                Log("后台启动时未找到可用配置，已保持托盘运行");
            }
            Log("启动 v" + ReporterConfig.AppVersion);
        }

        private void ShowSettings() {
            using (SettingsForm form = new SettingsForm(config, lastStatus, lastSuccess, usageOverview)) {
                if (form.ShowDialog() == DialogResult.OK) {
                    config = form.Value;
                    config.Save();
                    ResetTimer();
                    QueueReport(true);
                }
            }
        }

        private void ResetTimer() {
            if (timer != null) timer.Dispose();
            timer = new System.Threading.Timer(delegate { QueueReport(false); }, null, TimeSpan.FromMinutes(Math.Max(1, config.IntervalMinutes)), TimeSpan.FromMinutes(Math.Max(1, config.IntervalMinutes)));
        }

        private void QueueReport(bool notify) {
            if (!config.IsReady()) { if (notify) ShowSettings(); return; }
            if (Interlocked.Exchange(ref running, 1) != 0) return;
            ThreadPool.QueueUserWorkItem(delegate {
                try {
                    ReporterConfig snapshot = ReporterConfig.Load();
                    UsageSnapshot usage = UsageScanner.Scan(snapshot.UsdCnyRate);
                    usageOverview = UsageOverview.FromSnapshot(usage, snapshot.UsdCnyRate);
                    var accountUsage = AccountUsageClient.Read();
                    usage.Payload["accountUsage"] = accountUsage;
                    usageOverview = UsageOverview.FromSnapshot(usage, snapshot.UsdCnyRate);
                    if (Convert.ToString(accountUsage["status"]) != "available") Log("官方账号统计暂不可用；本地日志仍会上报");
                    HubClient client = new HubClient(snapshot);
                    client.Post("/api/collector/v1/usage", new Dictionary<string, object> { { "deviceId", snapshot.DeviceId }, { "snapshot", usage.Payload } });
                    try {
                        Dictionary<string, object> stats = client.Get("/api/stats");
                        long cachedOfficialTotal;
                        if (Convert.ToString(accountUsage["status"]) != "available"
                            && UsageOverview.TryOfficialTotalFromStats(stats, out cachedOfficialTotal)) {
                            usageOverview.ApplyOfficialTotal(cachedOfficialTotal);
                            Log("本机官方统计暂不可用，累计沿用 CW 最近官方值 " + cachedOfficialTotal);
                        }
                        QuotaOverview quota = QuotaOverview.FromStats(stats);
                        if (quota.SessionRemaining.HasValue || quota.WeeklyRemaining.HasValue) {
                            Log("额度图标：5小时剩余 " + (quota.SessionRemaining.HasValue ? quota.SessionRemaining.Value + "%" : "—")
                                + "，每周剩余 " + (quota.WeeklyRemaining.HasValue ? quota.WeeklyRemaining.Value + "%" : "—"));
                            uiContext.Post(delegate { UpdateQuotaTray(quota); }, null);
                        }
                    } catch (Exception quotaError) { Log("额度图标暂未更新：" + Short(quotaError.Message, 120)); }
                    lastSuccess = DateTime.Now;
                    lastStatus = "已连接，最近上报 " + lastSuccess.Value.ToString("HH:mm");
                    tray.Text = "CW Token 详情采集器 · 已更新";
                    UsagePeriodView day = usageOverview.Day ?? new UsagePeriodView();
                    Log("上报完成：本机今日 " + day.TotalTokens + " tokens，扫描 " + usage.FilesScanned + " 个会话文件");
                    if (notify) Balloon(day.TokensAvailable ? "今日 " + UsageFormatting.Tokens(day.TotalTokens) + " tokens" : "官方今日暂未返回", ToolTipIcon.Info);
                } catch (Exception error) {
                    lastStatus = "连接失败：" + Short(error.Message, 90);
                    tray.Text = "CW Token 详情采集器 · 连接异常";
                    Log(lastStatus);
                    if (notify) Balloon(lastStatus, ToolTipIcon.Error);
                } finally { Interlocked.Exchange(ref running, 0); }
            });
        }

        private void Balloon(string text, ToolTipIcon icon) {
            uiContext.Post(delegate { tray.ShowBalloonTip(3500, "CW Token 详情采集器", Short(text, 230), icon); }, null);
        }

        private void UpdateQuotaTray(QuotaOverview quota) {
            int shown = quota.SessionRemaining ?? quota.WeeklyRemaining ?? 0;
            Icon next = CreatePercentIcon(shown);
            Icon previous = quotaIcon;
            quotaIcon = next;
            tray.Icon = next;
            string session = quota.SessionRemaining.HasValue ? quota.SessionRemaining.Value + "%" : "—";
            string weekly = quota.WeeklyRemaining.HasValue ? quota.WeeklyRemaining.Value + "%" : "—";
            tray.Text = Short("CW · 5小时剩余 " + session + " · 每周剩余 " + weekly, 63);
            if (previous != null) previous.Dispose();
        }

        private static Icon CreatePercentIcon(int percent) {
            percent = Math.Max(0, Math.Min(100, percent));
            using (Bitmap bitmap = new Bitmap(32, 32))
            using (Graphics graphics = Graphics.FromImage(bitmap)) {
                graphics.SmoothingMode = SmoothingMode.AntiAlias;
                Color background = percent <= 10 ? Color.FromArgb(198, 62, 55)
                    : percent <= 30 ? Color.FromArgb(205, 132, 24) : Color.FromArgb(0, 132, 104);
                using (Brush circle = new SolidBrush(background)) graphics.FillEllipse(circle, 0, 0, 31, 31);
                float size = percent >= 100 ? 14F : percent >= 10 ? 19F : 22F;
                using (Font font = new Font("Segoe UI", size, FontStyle.Bold, GraphicsUnit.Pixel))
                using (Brush textBrush = new SolidBrush(Color.White))
                using (StringFormat format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center }) {
                    string text = percent.ToString();
                    graphics.DrawString(text, font, textBrush, new RectangleF(0, -1, 31, 32), format);
                }
                IntPtr handle = bitmap.GetHicon();
                try { using (Icon temporary = Icon.FromHandle(handle)) return (Icon)temporary.Clone(); }
                finally { DestroyIcon(handle); }
            }
        }

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern bool DestroyIcon(IntPtr handle);

        private static string Short(string value, int limit) { value = value ?? ""; return value.Length <= limit ? value : value.Substring(0, limit) + "…"; }
        private static void Log(string message) { try { Directory.CreateDirectory(ReporterConfig.DataDirectory); File.AppendAllText(LogPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message + Environment.NewLine); } catch { } }
        private static void OpenLog() { try { Directory.CreateDirectory(ReporterConfig.DataDirectory); if (!File.Exists(LogPath)) File.WriteAllText(LogPath, ""); Process.Start(LogPath); } catch { } }

        protected override void ExitThreadCore() {
            if (timer != null) timer.Dispose();
            tray.Visible = false; tray.Dispose(); if (quotaIcon != null) quotaIcon.Dispose();
            base.ExitThreadCore();
        }
    }
}
