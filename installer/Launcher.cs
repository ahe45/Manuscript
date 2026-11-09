using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Program {
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

    [STAThread]
    static void Main() {
        bool first;
        using (var mutex = new Mutex(true, @"Local\Manuscript.Offline", out first)) {
            if (!first) {
                MessageBox.Show("Manuscript가 이미 실행 중입니다.", "Manuscript");
                return;
            }
            SetCurrentProcessExplicitAppUserModelID("UPlus.Manuscript");
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new Launcher());
        }
    }
}

sealed class Launcher : Form {
    const string AddressPlaceholder = "서버가 준비되면 접속 주소가 표시됩니다.";
    readonly Label status, statusCaption;
    readonly Panel statusPanel;
    readonly Button open, start, stop, backup, restore, folder, logs;
    readonly TextBox address;
    readonly string backupDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Manuscript", "data", "backups");
    Process server;
    string url;
    bool stopping;
    bool closeOnStop;
    bool stopAfterBackup;
    string pendingCommand;
    bool failed;
    bool busy;

    public Launcher() {
        Text = "Manuscript · 서버 관리";
        string executable = typeof(Launcher).Assembly.Location;
        Icon = System.Drawing.Icon.ExtractAssociatedIcon(executable);
        ClientSize = new Size(680, 532);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        AutoScaleMode = AutoScaleMode.Dpi;
        AutoScaleDimensions = new SizeF(96, 96);
        BackColor = ColorTranslator.FromHtml("#f5f7fb");
        Font = new Font("Malgun Gothic", 10);

        var header = new Panel { BackColor = Color.White };
        header.SetBounds(0, 0, 680, 94);
        Controls.Add(header);
        var brand = new PictureBox { SizeMode = PictureBoxSizeMode.Zoom };
        brand.SetBounds(24, 23, 48, 48);
        using (var brandIcon = new Icon(Path.Combine(Path.GetDirectoryName(executable), "Manuscript.ico"), 48, 48)) {
            brand.Image = brandIcon.ToBitmap();
        }
        brand.Disposed += delegate { brand.Image.Dispose(); };
        header.Controls.Add(brand);
        AddLabel(header, "Manuscript", 88, 20, 400, 30, 17, true);
        AddLabel(header, "서버 실행부터 데이터 백업까지, 한곳에서 관리하세요.", 90, 53, 480, 24, 9, false, "#7b8a9f");

        statusPanel = new Panel();
        statusPanel.SetBounds(24, 114, 632, 88);
        Controls.Add(statusPanel);
        statusCaption = AddLabel(statusPanel, "서버 상태", 18, 13, 580, 22, 9, true);
        status = AddLabel(statusPanel, "서버를 준비하고 있습니다…", 18, 40, 592, 40, 12, true);
        ShowState("서버 준비 중", status.Text);

        AddLabel(this, "접속 주소", 24, 217, 240, 24, 10, true);
        address = new TextBox {
            Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical,
            BorderStyle = BorderStyle.FixedSingle, BackColor = Color.White,
            ForeColor = ColorTranslator.FromHtml("#52637c"), Font = new Font("Segoe UI", 11),
            Text = AddressPlaceholder,
        };
        address.SetBounds(24, 246, 632, 56);
        Controls.Add(address);
        open = AddButton("원고지 화면 열기", 24, 318, 272, true);
        start = AddButton("서버 시작", 308, 318, 168);
        stop = AddButton("서버 종료", 488, 318, 168);
        AddLabel(this, "데이터 및 지원", 24, 382, 600, 24, 10, true);
        backup = AddButton("백업하기", 24, 416, 149);
        restore = AddButton("복원하기", 185, 416, 149);
        folder = AddButton("백업 폴더", 346, 416, 149);
        logs = AddButton("로그 보기", 507, 416, 149);
        AddLabel(this, "이 창을 닫으면 서버도 안전하게 종료됩니다. 브라우저만 닫으면 계속 실행됩니다.",
            24, 484, 632, 28, 9, false, "#7b8a9f");
        SetControls(false);
        open.Click += delegate { OpenBrowser(); };
        start.Click += delegate { StartServer(); };
        stop.Click += delegate { RequestStop(false); };
        backup.Click += delegate { RunMaintenance("backup", "데이터를 백업하고 있습니다…"); };
        restore.Click += delegate { PickBackup(); };
        folder.Click += delegate { OpenBackupFolder(); };
        logs.Click += delegate {
            string log = Path.Combine(Path.GetDirectoryName(backupDirectory), "runtime.log");
            if (File.Exists(log)) Process.Start("notepad.exe", "\"" + log + "\"");
            else status.Text = "아직 기록된 로그가 없습니다.";
        };
        Shown += delegate { StartServer(); };
        FormClosing += StopServer;
    }

    static Label AddLabel(Control parent, string text, int x, int y, int width, int height,
        int size, bool bold, string color = "#172033") {
        var label = new Label {
            Text = text, Font = new Font("Malgun Gothic", size, bold ? FontStyle.Bold : FontStyle.Regular),
            ForeColor = ColorTranslator.FromHtml(color),
        };
        label.SetBounds(x, y, width, height);
        parent.Controls.Add(label);
        return label;
    }

    Button AddButton(string text, int x, int y, int width, bool primary = false) {
        var button = new Button {
            Text = text, Font = new Font("Malgun Gothic", 10, FontStyle.Bold), FlatStyle = FlatStyle.Flat,
            BackColor = primary ? ColorTranslator.FromHtml("#3264f5") : Color.White,
            ForeColor = primary ? Color.White : ColorTranslator.FromHtml("#43536b"), Cursor = Cursors.Hand,
        };
        button.SetBounds(x, y, width, 42);
        button.FlatAppearance.BorderColor = primary ? button.BackColor : ColorTranslator.FromHtml("#dce4ef");
        button.FlatAppearance.MouseOverBackColor = ColorTranslator.FromHtml(primary ? "#2453d8" : "#edf3ff");
        Controls.Add(button);
        return button;
    }

    void ShowState(string caption, string message, string tone = "pending") {
        statusCaption.Text = caption;
        status.Text = message;
        statusPanel.BackColor = ColorTranslator.FromHtml(tone == "error" ? "#fff0f3" : tone == "ready" ? "#eaf8f2" : "#edf3ff");
        statusCaption.ForeColor = ColorTranslator.FromHtml(tone == "error" ? "#dc365b" : tone == "ready" ? "#009c73" : "#3264f5");
    }

    void StartServer() {
        var home = AppDomain.CurrentDomain.BaseDirectory;
        if (server != null) server.Dispose();
        failed = stopping = false;
        SetControls(false);
        ShowState("서버 준비 중", "원고지 서버를 시작하고 있습니다…");
        try {
            server = new Process();
            server.StartInfo = new ProcessStartInfo {
                FileName = Path.Combine(home, "runtime", "node", "node.exe"),
                Arguments = "\"installer\\runtime.mjs\"",
                WorkingDirectory = home,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                StandardOutputEncoding = Encoding.UTF8
            };
            server.EnableRaisingEvents = true;
            server.Exited += delegate { OnUi(ServerExited); };
            server.OutputDataReceived += (sender, args) => { if (args.Data != null) OnUi(() => ShowStatus(args.Data)); };
            server.Start();
            server.BeginOutputReadLine();
        } catch {
            failed = true;
            pendingCommand = null;
            stopAfterBackup = false;
            ShowState("확인이 필요합니다", "서버 실행 파일을 열지 못했습니다. 설치를 확인해 주세요.", "error");
            SetStoppedControls();
        }
    }

    void OnUi(Action action) {
        if (IsDisposed || !IsHandleCreated) return;
        try { BeginInvoke(action); } catch (InvalidOperationException) {}
    }

    void ShowStatus(string line) {
        if (line.StartsWith("READY ", StringComparison.Ordinal)) {
            if (stopping) return;
            url = line.Substring(6);
            address.Text = url;
            ShowState("서버 실행 중", "정상적으로 실행 중입니다.", "ready");
            SetControls(true);
            if (pendingCommand != null) {
                string command = pendingCommand;
                pendingCommand = null;
                RunMaintenance(command, "데이터 작업을 준비하고 있습니다…");
            } else OpenBrowser();
        } else if (line.StartsWith("BACKUP ", StringComparison.Ordinal)) {
            CompleteMaintenance("백업 완료 · " + Path.GetFileName(line.Substring(7)));
        } else if (line.StartsWith("RESTORED ", StringComparison.Ordinal)) {
            CompleteMaintenance("복원 완료. 원고지를 다시 열어 로그인해 주세요.");
        } else if (line.StartsWith("FAILED ", StringComparison.Ordinal)) {
            CompleteMaintenance(line.Substring(7), true);
        } else if (line.StartsWith("ERROR ", StringComparison.Ordinal)) {
            failed = true;
            ShowState("확인이 필요합니다", line.Substring(6), "error");
        } else if (!stopping && line.StartsWith("STATUS ", StringComparison.Ordinal)) {
            ShowState(busy ? "데이터 작업 중" : "서버 준비 중", line.Substring(7));
        }
    }

    void SetControls(bool enabled) {
        open.Enabled = backup.Enabled = restore.Enabled = folder.Enabled = stop.Enabled = enabled;
        start.Enabled = false;
    }

    void SetStoppedControls() {
        SetControls(false);
        start.Enabled = backup.Enabled = restore.Enabled = folder.Enabled = true;
        address.Text = AddressPlaceholder;
    }

    void RunMaintenance(string command, string message) {
        if (busy) return;
        if (!ServerRunning()) {
            pendingCommand = command;
            stopAfterBackup = command == "backup";
            StartServer();
            return;
        }
        try {
            server.StandardInput.WriteLine(command);
            busy = true;
            SetControls(false);
            ShowState("데이터 작업 중", message);
        } catch (IOException) {
            CompleteMaintenance("서버에 작업을 요청하지 못했습니다.", true);
        }
    }

    void CompleteMaintenance(string message, bool error = false) {
        busy = false;
        ShowState(error ? "확인이 필요합니다" : "서버 실행 중", message, error ? "error" : "ready");
        SetControls(ServerRunning());
        if (stopAfterBackup) {
            stopAfterBackup = false;
            SendStop(false);
        }
    }

    void PickBackup() {
        using (var picker = new OpenFileDialog()) {
            picker.Title = "Manuscript 백업 선택";
            picker.Filter = "Manuscript 백업 (*.msbackup)|*.msbackup";
            if (Directory.Exists(backupDirectory)) picker.InitialDirectory = backupDirectory;
            if (picker.ShowDialog(this) != DialogResult.OK) return;
            if (MessageBox.Show(this, "현재 답안과 설정을 선택한 백업으로 교체합니다. 복원 전에 현재 데이터를 자동으로 백업합니다. 계속할까요?",
                "DB 복원", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
            RunMaintenance("restore " + Convert.ToBase64String(Encoding.UTF8.GetBytes(picker.FileName)), "백업을 확인하고 있습니다…");
        }
    }

    void OpenBackupFolder() {
        try {
            Directory.CreateDirectory(backupDirectory);
            Process.Start(new ProcessStartInfo(backupDirectory) { UseShellExecute = true });
        } catch {
            status.Text = "백업 폴더를 열지 못했습니다.";
        }
    }

    void OpenBrowser() {
        if (url == null) return;
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch { status.Text = "브라우저에서 다음 주소를 열어 주세요.\n" + url; }
    }

    bool ServerRunning() {
        try { return server != null && !server.HasExited; }
        catch (InvalidOperationException) { return false; }
    }

    void StopServer(object sender, FormClosingEventArgs args) {
        if (!ServerRunning()) return;
        args.Cancel = true;
        RequestStop(true);
    }

    void RequestStop(bool exit) {
        if (stopping || busy) return;
        if (MessageBox.Show("원고지에 저장 대기 중인 입력이 없는지 확인해 주세요. 서버를 종료할까요?",
            "Manuscript", MessageBoxButtons.OKCancel) != DialogResult.OK) return;
        SendStop(exit);
    }

    void SendStop(bool exit) {
        closeOnStop = exit;
        stopping = true;
        SetControls(false);
        if (!status.Text.StartsWith("백업 완료", StringComparison.Ordinal)) ShowState("서버 종료 중", "서버를 종료하고 있습니다…");
        try { server.StandardInput.WriteLine("stop"); }
        catch (IOException) {}
    }

    void ServerExited() {
        bool cleanStop = stopping && !failed && server.ExitCode == 0;
        busy = stopping = stopAfterBackup = false;
        pendingCommand = null;
        SetStoppedControls();
        if (cleanStop) {
            if (closeOnStop) Close();
            else ShowState("서버 중지됨", status.Text.StartsWith("백업 완료", StringComparison.Ordinal) ? status.Text : "서버가 중지되었습니다.");
            return;
        }
        if (!failed) ShowState("확인이 필요합니다", "서버가 종료되었습니다. 데이터 폴더의 로그를 확인해 주세요.", "error");
    }
}
