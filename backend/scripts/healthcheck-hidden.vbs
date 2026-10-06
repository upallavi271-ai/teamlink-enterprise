' TeamLink uptime check, started by Windows Task Scheduler WITHOUT a window
' popping up every 5 minutes. It runs healthcheck.js (next to this file) with
' node and appends what it found to healthcheck.log in the same folder as the
' uptime state (%USERPROFILE%\.teamlink-data\system).
'
' Install (one line in PowerShell, no admin needed):
'   schtasks /Create /TN "TeamLink uptime check" /SC MINUTE /MO 5 /F /TR "wscript.exe \"C:\Users\user\Desktop\All_Projects\teamlink-enterprise\backend\scripts\healthcheck-hidden.vbs\""
Option Explicit
Dim sh, fso, here, logDir, nodeExe, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
logDir = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.teamlink-data\system"
If Not fso.FolderExists(sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.teamlink-data") Then fso.CreateFolder(sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.teamlink-data")
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
nodeExe = "node"
If fso.FileExists("C:\Program Files\nodejs\node.exe") Then nodeExe = """C:\Program Files\nodejs\node.exe"""
' cmd /c "<whole line>" — the outer quotes keep cmd from eating the inner ones.
cmd = "cmd /c """ & nodeExe & " """ & here & "\healthcheck.js"" >> """ & logDir & "\healthcheck.log"" 2>&1"""
sh.Run cmd, 0, False
