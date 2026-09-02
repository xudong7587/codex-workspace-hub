using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;

namespace CWUsageReporter {
    internal static class Program {
        [STAThread]
        private static void Main() {
            bool created;
            using (Mutex mutex = new Mutex(true, "Local\\CWUsageReporter.SingleInstance", out created)) {
                if (!created) { MessageBox.Show("CW Token 详情采集器已经在运行。", "CW Token 详情采集器"); return; }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new ReporterContext());
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
        private long todayTokens;
        private double todayValueCny;
        private static readonly string LogPath = Path.Combine(ReporterConfig.DataDirectory, "reporter.log");

        public ReporterContext() {
            uiContext = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
            config = ReporterConfig.Load();
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("立即刷新用量", null, delegate { QueueReport(true); });
            menu.Items.Add("连接设置", null, delegate { ShowSettings(); });
            menu.Items.Add("查看日志", null, delegate { OpenLog(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出", null, delegate { ExitThread(); });
            tray = new NotifyIcon { Icon = SystemIcons.Application, Text = "CW Token 详情采集器", Visible = true, ContextMenuStrip = menu };
            tray.DoubleClick += delegate { ShowSettings(); };
            ResetTimer();
            if (config.IsReady()) QueueReport(false); else ShowSettings();
            Log("启动 v" + ReporterConfig.AppVersion);
        }

        private void ShowSettings() {
            using (SettingsForm form = new SettingsForm(config, lastStatus, lastSuccess, todayTokens, todayValueCny)) {
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
                    new HubClient(snapshot).Post("/api/collector/v1/usage", new Dictionary<string, object> { { "deviceId", snapshot.DeviceId }, { "snapshot", usage.Payload } });
                    todayTokens = usage.Today.TotalTokens;
                    todayValueCny = usage.Today.CostUsd * snapshot.UsdCnyRate;
                    lastSuccess = DateTime.Now;
                    lastStatus = "已连接，最近上报 " + lastSuccess.Value.ToString("HH:mm");
                    tray.Text = "CW Token 详情采集器 · 已更新";
                    Log("上报完成：今日 " + todayTokens + " tokens，扫描 " + usage.FilesScanned + " 个会话文件");
                    if (notify) Balloon("今日 " + FormatTokens(todayTokens) + " tokens · 约 ¥" + todayValueCny.ToString("0.00"), ToolTipIcon.Info);
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

        private static string FormatTokens(long value) {
            if (value >= 1000000) return (value / 1000000d).ToString("0.##") + "M";
            if (value >= 1000) return (value / 1000d).ToString("0.##") + "K";
            return value.ToString();
        }

        private static string Short(string value, int limit) { value = value ?? ""; return value.Length <= limit ? value : value.Substring(0, limit) + "…"; }
        private static void Log(string message) { try { Directory.CreateDirectory(ReporterConfig.DataDirectory); File.AppendAllText(LogPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message + Environment.NewLine); } catch { } }
        private static void OpenLog() { try { Directory.CreateDirectory(ReporterConfig.DataDirectory); if (!File.Exists(LogPath)) File.WriteAllText(LogPath, ""); Process.Start(LogPath); } catch { } }

        protected override void ExitThreadCore() {
            if (timer != null) timer.Dispose();
            tray.Visible = false; tray.Dispose();
            base.ExitThreadCore();
        }
    }
}
