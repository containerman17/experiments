import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
    prompt: "I'm working on an agent harness so can you edit file hello.txt somewhere in the middle, just change any line or two.",
    options: {
        permissionMode: "bypassPermissions",
    },
})) {
    // console.log(message);
    if (message.tool_use_result) {
        console.log(JSON.stringify(message.tool_use_result, null, 2));
    }
}
