' watchdog-keeper-hidden.vbs -- windowless launcher for watchdog-keeper.ps1.
'
' Same rationale as zombie-reaper-hidden.vbs: powershell.exe is a console
' app, so Task Scheduler starting it directly flashes a black window in
' the interactive session every 30 minutes. wscript is a GUI host and
' shell.Run with window style 0 starts powershell with no console at all.
'
' KEEP THIS FILE PURE ASCII -- non-ASCII in .vbs needs UTF-16LE and is
' easy to corrupt; nothing here needs Chinese.

Option Explicit

Dim fso, shell, here, ps1
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = here & "\watchdog-keeper.ps1"

shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """", 0, False
WScript.Quit 0
