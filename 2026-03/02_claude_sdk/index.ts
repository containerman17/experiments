import { unstable_v2_createSession } from "@anthropic-ai/claude-agent-sdk";

await using session = unstable_v2_createSession({
    model: "claude-sonnet-4-6",
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
});

await session.send("List the files in my project");
for await (const msg of session.stream()) {
    if (msg.type === "assistant") {
        const text = msg.message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
        if (text) process.stdout.write(text);
    }
}
console.log();
