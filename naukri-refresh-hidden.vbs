' Runs the refresh script fully hidden (no console window).
' Point Windows Task Scheduler at this file for an hourly refresh (see README).
'
' EDIT THE TWO PATHS BELOW before use:
'   1. C:\Program Files\nodejs\node.exe          -> your node.exe  (find it with:  where node)
'   2. C:\path\to\naukri_update\...              -> the folder where you cloned this repo (twice)
'
' How the line works:
'   >> naukri-launcher.log 2>&1  = append all output to a log file
'   0                            = window style: hidden
'   False                        = don't wait for the script to finish
CreateObject("Wscript.Shell").Run "cmd /c """"C:\Program Files\nodejs\node.exe"" ""C:\path\to\naukri_update\naukri-profile-refresh.js"" >> ""C:\path\to\naukri_update\naukri-launcher.log"" 2>&1""", 0, False
