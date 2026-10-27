' zombie-reaper-hidden.vbs -- windowless launcher for zombie-reaper.ps1.
'
' The BridgeZombieReaper scheduled task used to invoke powershell.exe
' directly with -WindowStyle Hidden, but powershell is a console app:
' the console window is created BEFORE PowerShell gets to hide it, so a
' black window flashed on the desktop every 30 minutes (task runs
' interactively in the user session). wscript is a GUI host, and
' shell.Run with window style 0 starts powershell with no console at
' all, so nothing ever flashes.
'
' KEEP THIS FILE PURE ASCII -- non-ASCII in .vbs needs UTF-16LE and is
' easy to corrupt; nothing here needs Chinese.

Option Explicit

Dim fso, shell, here, ps1
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = here & "\zombie-reaper.ps1"

shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """", 0, False
WScript.Quit 0
