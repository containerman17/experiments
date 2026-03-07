# Redesign Principles

## 1. Fire-and-forget by default
95% of the time you send a message and walk away. The UI should be optimized for that — not for hovering over the agent. Send message, see it's working, move on.

## 2. Passive awareness, not active review
You don't want to review diffs — you want to *notice* diffs. Streaming diffs, status indicators, subtle color changes. The UI communicates state through peripheral vision, not modal dialogs demanding attention.

## 3. Terminals are first-class persistent infrastructure
Not an afterthought tab. Terminals survive device switches, server restarts, everything. They're your anchor across sessions. Visible, always reachable, and show "something is still running" at a glance even when minimized.

## 4. Multi-agent is multi-project
The primary switching axis is *project/workspace*, not agent-within-workspace. Each workspace has one primary agent. You switch between workspaces. Temporary agents can be spun up for quick questions but you don't work on two features simultaneously in the same project.

## 5. Device-fluid: mobile and desktop are separate UIs
Mobile is not a constrained desktop. Different UIs, different designs, possibly different technologies — same backend. Mobile is the remote control: send messages, glance at status, check results. Desktop is the cockpit: watch streams, use terminals, deeper inspection. No adaptive/responsive compromise.

## 6. Agent is a colleague, not a tool
Minimize chrome, settings, dropdowns. The chat *is* the interface. Mode switches and config are contextual or conversational, not toolbar buttons.

## 7. Time-based, not tree-based
Don't show file trees or project explorers. Show a *timeline* — what happened, what's happening now, what finished. Recent activity > file hierarchy.

## 8. Code review is dead, long live the diff stream
Traditional code review (opening files, reading hunks, approving) is gone. The replacement is a passively scrolling stream of changes — like a terminal scrollback but for diffs. Most of the time it's background noise. But occasionally something jumps out — a wrong direction, a bad pattern — and you catch it *without ever consciously deciding to review*. The goal is ambient awareness that lets you spot "what the fuck" moments naturally, not a formal review step you'll never actually do.

## 9. Voice-first
Voice input is a primary interaction mode on both mobile AND desktop. Big mic button, always reachable. Many users code with their voice — honor that workflow.

---

# UI Architecture Implementation Notes

## The Desktop Layout
* **Left Edge:** Vertical Agent Tabs + Git Status Icon.
* **Center Column:** The Chat Feed (Intent & Results only, no inline diffs).
* **Right-Center Column:** The Diff Stream (passively scrolling).
* **Right Edge:** Vertical Terminal Tabs. Clicking rolls out a 50% overlay terminal.

## The Mobile "Walkie-Talkie" Layout
* Massive Push-to-Talk button.
* Chat feed only (diffs aggressively hidden/collapsed).
* Driven entirely by terminal results and test passes, not code review.

---

# Conceptual Reasoning & Building Plan

## Why this Architecture? (The "Vibe Coding" Philosophy)
Traditional IDEs (like VS Code) were built for *writing* code. Their layout (File Tree on left, Editor in middle, Terminal on bottom) reflects a workflow where you type characters into files.
"Vibe Coding" fundamentally changes this. You are no longer writing code; you are managing an agent that writes code. You operate through *intent* (usually voice) and observe *results* (tests, terminal outputs, ambient diffs).

Therefore, the layout must reflect a timeline of cause-and-effect rather than a hierarchy of files:
1. **The Left Column (The Intent Feed / Chat):** This is your control column. It shows what you asked for and high-level summaries of what the agent decided to do. It must be clean and free of huge code walls so you can always see the "story" of the session at a glance.
2. **The Middle Column (The Diff Stream):** This is the ambient noise. Because modern agents write multi-file patches, inline diffs destroy the chat's readability. Moving diffs to a separate tethered stream allows you to passively monitor the code changes (like a Twitch chat) without losing your place in the conversation.
3. **The Right Edge (Persistent Terminals):** Terminals are your ground truth. They are no longer hidden away in a bottom panel. They are persistent vertical tabs that can slide out (overlay) when you need to inspect a build error, and easily slide away when you're done.

## The Build Plan

### 1. Update the State Model (`store.ts`)
Currently, Agents and Terminals share a single `tabs` array and `activeTabId`, meaning they are mutually exclusive. We must decouple them.
*   **Change:** Track `activeAgentId` (for the Left Column) and `openTerminalId` (for the Right Edge Overlay) independently.
*   **Why:** You need to be able to look at your Agent Chat and pop open a Terminal overlay simultaneously without losing the active Agent state.

### 2. The Left Edge: Agent Sidebar & Git Icon (`LeftSidebar.tsx`)
*   **Change:** Replace the horizontal `TabBar.tsx` with a thin, vertical sidebar anchored to the left.
*   **Why:** Maximizes vertical screen real estate for the timeline. It holds your Agents and a global Git Status indicator.

### 3. The Left Column: Stripped-Down `AgentChat.tsx`
*   **Change:** Remove all inline diff rendering (`DiffBlock`) from `AgentChat.tsx`.
*   **Why:** To prevent "vertical bloat." Tool calls should only show high-level summaries (e.g., `[✓ Modified App.tsx]`).

### 4. The Right Column: The Diff Stream (`DiffStream.tsx`)
*   **Change:** Create a new component that sits next to the chat. It filters the active agent's log specifically for diffs and renders them in a scrolling feed.
*   **Why:** Provides the "Twitch stream" of code changes for passive oversight.

### 5. The Right Edge: Terminal Sidebar & Overlay (`TerminalOverlay.tsx`)
*   **Change:** Create a thin vertical bar on the right edge for terminal icons. When clicked, it renders the `Terminal` component inside a 50% width absolute-positioned container that slides in. Clicking outside closes it.
*   **Why:** Terminals need to be easily accessible for quick checks (like dragging an error to the chat) but shouldn't permanently consume 50% of the screen.

### 6. The Master Layout (`WorkspacePage.tsx`)
*   **Change:** Rewrite the main container using flex layout to map out this exact horizontal flow:
    `[LeftSidebar (thin)] [AgentChat (flex-1)] [DiffStream (flex-1)] [TerminalSidebar (thin)]`
    *(With the Terminal Overlay sliding over the DiffStream when active).*

---

# Progress & Completed Changes

We have successfully rebuilt the main pane into the new "Cockpit" architecture. Below is the list of changes made and files affected:

### 1. Decoupled App State
*   **File:** `frontend/src/store.ts`
*   **Change:** Added `uiActiveAgentId` and `uiOpenTerminalId` to `AppState`. Updated the reducer to track these independently instead of relying on a single exclusive `activeTabId`.

### 2. Built the Left Edge (Agents)
*   **File:** `frontend/src/components/LeftSidebar.tsx` (New)
*   **Change:** Created a vertical sidebar for Agents replacing `TabBar`. Includes a Git Status placeholder icon and a "New Agent" slide-out menu.

### 3. Built the Right Edge (Terminals)
*   **File:** `frontend/src/components/RightSidebar.tsx` (New)
*   **Change:** Created a vertical sidebar for Terminals. Clicking a terminal icon sets the `uiOpenTerminalId` to trigger the overlay.

### 4. Stripped Diffs from Chat
*   **File:** `frontend/src/components/AgentChat.tsx`
*   **Change:** Completely removed `DiffBlock` and inline diff rendering. `ToolCallCard` now only displays a high-level summary of the files modified.

### 5. Created the Diff Stream
*   **File:** `frontend/src/components/DiffStream.tsx` (New)
*   **Change:** Built a dedicated component that filters the active agent's ACP log for diffs and renders them in an independently scrolling vertical feed.

### 6. Rewrote the Master Layout
*   **File:** `frontend/src/pages/WorkspacePage.tsx`
*   **Change:** Replaced the legacy single-view design with a 4-column flex layout for desktop (`LeftSidebar` | `AgentChat` | `DiffStream` | `RightSidebar`). Added the slide-out logic for the 50% Terminal overlay. Implemented a separate mobile layout with absolute-positioned terminal overlays.

### 7. Refined the Mobile Experience ("Walkie-Talkie" Drawer)
*   **File:** `frontend/src/components/MobileNav.tsx`
*   **Change:** Updated the mobile hamburger menu drawer to visually separate "Agents" and "Terminals". Selecting an Agent closes the terminal overlay; selecting a Terminal correctly slides the overlay on top of the active Agent while keeping the Agent running in the background.

### 8. Cleanup
*   **Files:** `frontend/src/components/RightSidebar.tsx`, `frontend/src/components/AgentChat.tsx`, `frontend/src/pages/MainScreen.tsx`
*   **Change:** Fixed unused parameter warnings and React import errors to ensure `npm run build` succeeds cleanly.
