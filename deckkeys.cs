// The Windows twin of deckkeys.swift. Same tokens and the same --serve protocol; "cmd" presses Ctrl,
// as Electron's CmdOrCtrl does.
// Usage: deckkeys cmd+shift+e sleep:200 down down return
//        deckkeys --serve   (one line of tokens per command on stdin, answers "ok" or "err ...")
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

static class DeckKeys
{
    const ushort CTRL = 0x11, SHIFT = 0x10, ALT = 0x12;

    static readonly Dictionary<string, ushort> Keys = new Dictionary<string, ushort>
    {
        { "up", 0x26 }, { "down", 0x28 }, { "pageup", 0x21 }, { "pagedown", 0x22 }, { "return", 0x0D },
        { "space", 0x20 }, { "escape", 0x1B }, { "e", 0x45 }, { "[", 0xDB }, { "]", 0xDD },
    };
    static readonly Dictionary<string, ushort> Modifiers = new Dictionary<string, ushort>
    {
        { "cmd", CTRL }, { "ctrl", CTRL }, { "shift", SHIFT }, { "alt", ALT },
    };
    // Without the extended flag these arrive as the numeric keypad's keys.
    static readonly HashSet<ushort> Extended = new HashSet<ushort> { 0x26, 0x28, 0x21, 0x22 };

    class Step
    {
        public int SleepMs = -1;
        public ushort Key;
        public List<ushort> Mods = new List<ushort>();
    }

    static Step Parse(string token)
    {
        if (token.StartsWith("sleep:"))
        {
            int ms;
            return int.TryParse(token.Substring(6), out ms) && ms >= 0 ? new Step { SleepMs = ms } : null;
        }
        var step = new Step();
        bool hasKey = false;
        foreach (var part in token.ToLowerInvariant().Split('+'))
        {
            ushort code;
            if (Modifiers.TryGetValue(part, out code)) { if (!step.Mods.Contains(code)) step.Mods.Add(code); }
            else if (!hasKey && Keys.TryGetValue(part, out code)) { step.Key = code; hasKey = true; }
            else return null;
        }
        return hasKey ? step : null;
    }

    static List<Step> ParseAll(string[] tokens, out string error)
    {
        error = null;
        var steps = new List<Step>();
        foreach (var token in tokens)
        {
            var step = Parse(token);
            if (step == null) { error = "unknown key " + token; return null; }
            steps.Add(step);
        }
        return steps;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public InputUnion u; }

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint count, INPUT[] inputs, int size);

    const uint INPUT_KEYBOARD = 1, KEYEVENTF_EXTENDEDKEY = 0x1, KEYEVENTF_KEYUP = 0x2;

    static INPUT Key(ushort vk, bool down)
    {
        uint flags = (down ? 0 : KEYEVENTF_KEYUP) | (Extended.Contains(vk) ? KEYEVENTF_EXTENDEDKEY : 0);
        var input = new INPUT { type = INPUT_KEYBOARD };
        input.u.ki = new KEYBDINPUT { wVk = vk, dwFlags = flags };
        return input;
    }

    static string Run(List<Step> steps)
    {
        foreach (var step in steps)
        {
            if (step.SleepMs >= 0) { Thread.Sleep(step.SleepMs); continue; }
            var inputs = new List<INPUT>();
            foreach (var mod in step.Mods) inputs.Add(Key(mod, true));
            inputs.Add(Key(step.Key, true));
            inputs.Add(Key(step.Key, false));
            for (int i = step.Mods.Count - 1; i >= 0; i--) inputs.Add(Key(step.Mods[i], false));
            var array = inputs.ToArray();
            uint sent = SendInput((uint)array.Length, array, Marshal.SizeOf(typeof(INPUT)));
            if (sent != array.Length) return "SendInput sent " + sent + " of " + array.Length + " events, error " + Marshal.GetLastWin32Error();
        }
        return null;
    }

    static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--serve")
        {
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                string error;
                var steps = ParseAll(line.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries), out error);
                if (steps != null) error = Run(steps);
                Console.WriteLine(error == null ? "ok" : "err " + error);
                Console.Out.Flush();
            }
            return 0;
        }
        string parseError;
        var parsed = ParseAll(args, out parseError);
        if (parsed == null) { Console.Error.WriteLine("deckkeys: " + parseError); return 2; }
        var runError = Run(parsed);
        if (runError != null) { Console.Error.WriteLine("deckkeys: " + runError); return 3; }
        return 0;
    }
}
