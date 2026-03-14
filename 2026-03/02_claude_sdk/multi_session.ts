import { query } from "@anthropic-ai/claude-agent-sdk";

let sessionId: string | undefined;

for await (const message of query({
    prompt: "Which folder am I in?",
    options: { allowedTools: ["Read", "Glob", "Grep"] },
})) {
    // console.log(message);
    if (message.type === "result") {
        sessionId = message.session_id;
        if (message.subtype === "success") {
            console.log(message.result);
        }
    }
}

console.log(`Session ID: ${sessionId}`);

// Earlier session analyzed the code; now build on that analysis
for await (const message of query({
    prompt: "Whats in here? Briefly",
    options: {
        resume: sessionId,
        allowedTools: ["Read", "Edit", "Write", "Glob", "Grep"],
        permissionMode: "bypassPermissions",
    },
})) {
    if (message.type === "result" && message.subtype === "success") {
        console.log(message.result);
    }
}
