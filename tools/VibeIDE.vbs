' VibeIDE launcher (versioned copy; the live one lives on the user's Desktop).
' Exit code 42 = bot asked to restart -> run again; anything else -> stop.
' VibeIDE-STOP.cmd force-kills node (exit <> 42), so it still stops the loop.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\alex\vibeide"
Do
    rc = sh.Run("cmd /c node --import tsx app\src\index.ts ""Z:\!Test_claude_1c"" >> bot.out 2>> bot.err", 0, True)
Loop While rc = 42
