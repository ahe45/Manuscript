#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef StageDir
  #error StageDir is required
#endif
#ifndef ReleaseDir
  #error ReleaseDir is required
#endif

[Setup]
AppId={{1AB84AB3-BD04-437C-AAB7-92952A7F785A}
AppName=Manuscript
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\Manuscript
DefaultGroupName=Manuscript
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#ReleaseDir}
OutputBaseFilename=Manuscript-{#AppVersion}-Setup
Compression=lzma2/fast
SolidCompression=yes
AppMutex=Local\Manuscript.Offline
CloseApplications=no
UninstallDisplayIcon={app}\Manuscript.exe
SetupIconFile={#StageDir}\Manuscript.ico

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Tasks]
Name: "desktopicon"; Description: "바탕화면에 바로가기 만들기"

[Icons]
Name: "{group}\Manuscript"; Filename: "{app}\Manuscript.exe"; WorkingDir: "{app}"; IconFilename: "{app}\Manuscript.exe"; AppUserModelID: "UPlus.Manuscript"
Name: "{userdesktop}\Manuscript"; Filename: "{app}\Manuscript.exe"; WorkingDir: "{app}"; IconFilename: "{app}\Manuscript.exe"; AppUserModelID: "UPlus.Manuscript"; Tasks: desktopicon

[Run]
Filename: "{app}\Manuscript.exe"; Description: "Manuscript 실행"; Flags: nowait postinstall skipifsilent

[Code]
function InitializeUninstall(): Boolean;
begin
  Result := not CheckForMutexes('Local\Manuscript.Offline');
  if not Result then
    MsgBox('Manuscript를 종료한 뒤 다시 시도해 주세요.', mbError, MB_OK);
end;
