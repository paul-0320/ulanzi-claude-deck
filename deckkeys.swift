// Usage: deckkeys cmd+shift+e sleep:200 down down return
//        deckkeys --serve   (one line of tokens per command on stdin, answers "ok" or "err ...")
import ApplicationServices
import Foundation

enum Step {
    case press(CGKeyCode, CGEventFlags)
    case sleep(UInt32)
}

let keyCodes: [String: CGKeyCode] = [
    "up": 126, "down": 125, "pageup": 116, "pagedown": 121, "return": 36, "space": 49, "escape": 53, "e": 14,
    "[": 33, "]": 30,
]
let modifierFlags: [String: CGEventFlags] = [
    "cmd": .maskCommand, "shift": .maskShift, "alt": .maskAlternate, "ctrl": .maskControl,
]

func parse(_ token: String) -> Step? {
    if token.hasPrefix("sleep:") {
        return UInt32(token.dropFirst("sleep:".count)).map { .sleep($0) }
    }
    var flags: CGEventFlags = []
    var key: CGKeyCode?
    for part in token.lowercased().split(separator: "+").map(String.init) {
        if let flag = modifierFlags[part] {
            flags.insert(flag)
        } else if let code = keyCodes[part], key == nil {
            key = code
        } else {
            return nil
        }
    }
    return key.map { .press($0, flags) }
}

func parseAll(_ tokens: [String]) -> Result<[Step], Error> {
    var steps: [Step] = []
    for token in tokens {
        guard let step = parse(token) else { return .failure(DeckKeysError("unknown key \(token)")) }
        steps.append(step)
    }
    return .success(steps)
}

struct DeckKeysError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

let notTrusted = "not allowed to send keys; grant Accessibility to the app that runs this"

func run(_ steps: [Step]) {
    let source = CGEventSource(stateID: .hidSystemState)
    for step in steps {
        switch step {
        case let .sleep(ms):
            usleep(ms * 1000)
        case let .press(code, flags):
            for isDown in [true, false] {
                let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: isDown)
                event?.flags = flags
                event?.post(tap: .cghidEventTap)
            }
        }
    }
}

func fail(_ message: String, _ code: Int32) -> Never {
    FileHandle.standardError.write(Data("deckkeys: \(message)\n".utf8))
    exit(code)
}

let arguments = Array(CommandLine.arguments.dropFirst())

if arguments == ["--serve"] {
    setvbuf(stdout, nil, _IOLBF, 0)
    let trusted = AXIsProcessTrusted()
    while let line = readLine() {
        let tokens = line.split(separator: " ").map(String.init)
        switch (trusted, parseAll(tokens)) {
        case (false, _): print("err \(notTrusted)")
        case let (true, .failure(error)): print("err \(error)")
        case let (true, .success(steps)): run(steps); print("ok")
        }
    }
    exit(0)
}

switch parseAll(arguments) {
case let .failure(error): fail("\(error)", 2)
case let .success(steps):
    guard AXIsProcessTrusted() else { fail(notTrusted, 3) }
    run(steps)
}
