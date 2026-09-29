if (-not ('ForgeLinkConsoleMode' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class ForgeLinkConsoleMode
{
    private const int StdInputHandle = -10;
    private const uint EnableQuickEditMode = 0x0040;
    private const uint EnableExtendedFlags = 0x0080;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetConsoleMode(IntPtr handle, out uint mode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleMode(IntPtr handle, uint mode);

    public static bool DisableQuickEdit()
    {
        IntPtr input = GetStdHandle(StdInputHandle);
        uint mode;
        if (input == IntPtr.Zero || input == new IntPtr(-1) || !GetConsoleMode(input, out mode))
            return false;

        uint updated = (mode & ~EnableQuickEditMode) | EnableExtendedFlags;
        return SetConsoleMode(input, updated);
    }
}
'@ -ErrorAction Stop | Out-Null
}

try { [void][ForgeLinkConsoleMode]::DisableQuickEdit() } catch { }
