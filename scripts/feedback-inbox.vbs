' Owner-only feedback inbox launcher. ASCII only so Windows Script Host
' reads it correctly on this machine.
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = base
sh.Run "node.exe """ & base & "\feedback-inbox.mjs"" --html --open", 0, False
