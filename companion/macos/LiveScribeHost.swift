import Foundation

let storeExtensionID = "gfhncbgjiechicicabgkmlmcljamdelf"

func send(_ object: [String: Any]) {
    guard let payload = try? JSONSerialization.data(withJSONObject: object) else { return }
    var length = UInt32(payload.count).littleEndian
    let header = Data(bytes: &length, count: 4)
    FileHandle.standardOutput.write(header)
    FileHandle.standardOutput.write(payload)
}

func executable(_ name: String) -> String? {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let candidates = [
        "/opt/homebrew/bin/\(name)", "/usr/local/bin/\(name)",
        "\(home)/.local/bin/\(name)", "\(home)/.npm-global/bin/\(name)",
        "\(home)/.bun/bin/\(name)"
    ]
    return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
}

func cleanCodex(_ output: String) -> String {
    var lines = output.components(separatedBy: .newlines)
    if let tokenIndex = lines.firstIndex(where: { $0.lowercased().hasPrefix("tokens used") }) {
        lines = Array(lines[..<tokenIndex])
    }
    if let separator = lines.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "--------" }) {
        lines = Array(lines.dropFirst(separator + 1))
    }
    return lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
}

func run(prompt: String, provider: String, model: String?) -> [String: Any] {
    let commandName = provider == "codex" ? "codex" : "claude"
    guard let command = executable(commandName) else {
        return ["error": "\(commandName) CLI was not found. Install it and sign in, then try again."]
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: command)
    if provider == "codex" {
        var args = ["exec", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "-s", "read-only"]
        if let model, !model.isEmpty { args += ["-m", model] }
        args.append("-")
        process.arguments = args
    } else {
        process.arguments = ["-p"]
    }
    let input = Pipe(), output = Pipe(), errors = Pipe()
    process.standardInput = input; process.standardOutput = output; process.standardError = errors
    do { try process.run() } catch { return ["error": "Could not launch \(commandName): \(error.localizedDescription)"] }
    input.fileHandleForWriting.write(prompt.data(using: .utf8) ?? Data())
    input.fileHandleForWriting.closeFile()
    process.waitUntilExit()
    let stdout = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    let stderr = String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    let answer = provider == "codex" ? cleanCodex(stdout) : stdout.trimmingCharacters(in: .whitespacesAndNewlines)
    if process.terminationStatus != 0 || answer.isEmpty {
        return ["error": "\(commandName) exited \(process.terminationStatus): \(stderr.prefix(400))"]
    }
    return ["summary": answer]
}

var buffer = Data()
while let chunk = try? FileHandle.standardInput.read(upToCount: 65536), !chunk.isEmpty {
    buffer.append(chunk)
    while buffer.count >= 4 {
        let bytes = [UInt8](buffer.prefix(4))
        let length = UInt32(bytes[0]) | (UInt32(bytes[1]) << 8) | (UInt32(bytes[2]) << 16) | (UInt32(bytes[3]) << 24)
        guard buffer.count >= 4 + Int(length) else { break }
        let payload = buffer.subdata(in: 4..<(4 + Int(length)))
        buffer.removeSubrange(0..<(4 + Int(length)))
        guard let message = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
            send(["error": "bad json"]); continue
        }
        if message["type"] as? String == "ping" { send(["ok": true]); continue }
        guard let prompt = message["prompt"] as? String else { send(["error": "missing prompt"]); continue }
        send(run(prompt: prompt, provider: message["provider"] as? String ?? "claude", model: message["model"] as? String))
    }
}
