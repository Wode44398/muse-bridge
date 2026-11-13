' logon-autostart-hidden.vbs -- windowless launcher for logon-autostart.ps1.
'
' Run by the BridgeAutostart scheduled task (logon trigger). Same rationale as
' watchdog-keeper-hidden.vbs: powershell.exe started directly by Task
' Scheduler flashes a console window; wscript + Run style 0 does not.
'
' KEEP THIS FILE PURE ASCII.

Option Explicit

Dim fso, shell, here, ps1
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = here & "\logon-autostart.ps1"

shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """", 0, False
WScript.Quit 0
