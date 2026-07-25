' Runs the refresh script fully hidden (no console window).
' Edit the two paths below to match your machine, then point
' Windows Task Scheduler at this file for an hourly refresh.
CreateObject("Wscript.Shell").Run "cmd /c """"C:\Program Files\nodejs\node.exe"" ""C:\path\to\naukri_update\naukri-profile-refresh.js"" >> ""C:\path\to\naukri_update\naukri-launcher.log"" 2>&1""", 0, False
