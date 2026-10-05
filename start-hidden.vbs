' mariowOS silent launcher: starts the OS without any terminal window.
' Output is written to system\mariowos.log. Use start.bat to see the console for debugging.
Option Explicit
Dim shell, fso, root
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root

' First run (dependencies missing): fall back to the visible installer.
If Not fso.FolderExists(root & "\node_modules\electron") Then
  shell.Run """" & root & "\start.bat""", 1, False
  WScript.Quit
End If

' 0 = hidden window, False = don't wait.
shell.Run "cmd /c npm run start-os > ""system\mariowos.log"" 2>&1", 0, False
