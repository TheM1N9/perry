# Perry UI and UX audit

10 November 2026. Extends the [project audit](project-audit.md).

Perry should make it easy to ask for an outcome, see what is happening and intervene when needed. Familiar chat conventions are a useful starting point. They need additional controls because Perry can keep working, change files and act through connected accounts.

The implementation now prioritizes the request, the result and anything waiting on the owner. Needs you is a named, counted destination; technical reply choices are grouped under Reply options, while access remains visible. The [implementation record](ui-ux-implementation.md) covers the changes and verification.

## Evidence and limits

- Current component source is the evidence for implemented behavior. The historical captures in `artifacts/profile/chat-sidebar.png` and `artifacts/workspace-ui/float-own-files-light.png` help explain layout history; they are not current live screenshots. For example, the older sidebar capture says Tasks, while current source says To-dos and Work.
- Public research below supports general usability principles. It does not predict Perry's conversion, retention or where a particular person will look.
- Mobbin screenshots establish visible patterns in specific products. They do not establish why those products chose them, whether those choices succeeded, or whether Perry's users have used them.
- No Perry eye-tracking, click heatmap, user interviews or task-completion dataset was available for this review. The [predicted attention map](ui-attention-map.html) forecasts plausible looking behavior over a reconstruction of the updated desktop chat, with synthetic content. Its regions and routes are manual design predictions, not measurements or output from a trained gaze model. They include likely distractions and omissions, rather than only showing where we want people to look.
- The structural changes below are implemented. The [spacing pass](spacing-audit.md) covers the earlier exhaustive source review and browser checks. The implementation record distinguishes verified behavior from research and device checks that need people or hardware.

## Human behavior that should guide the design

**Give people something they can recognize.** Named destinations, visible actions and task examples reduce the need to remember commands or invent a suitable prompt. Keep New chat, Search, familiar message entry and the existing editable starter requests above the composer. This applies the [recognition-over-recall principle](https://www.nngroup.com/articles/recognition-and-recall/).

**Design around the task someone is doing now.** On a new chat, the composer should stand out. While waiting, progress and Stop should be easy to find. When an action needs approval, its consequences and the decision should stand out. These are proposed priorities, not observed gaze sequences. Reading research shows several scanning patterns; an F-shaped heatmap is not a universal layout prescription. [NN/G's scanning research](https://www.nngroup.com/articles/f-shaped-pattern-reading-web-content/)

**Help people recover their context.** A returning owner needs to know what finished, what is still running and what needs a decision. Returning to the last chat is useful, but it does not answer all three questions. Offer a compact, persistent route to current work and pending decisions without turning every visit into an activity dashboard.

**Make control understandable.** Stop this reply, pause a schedule, take over the browser and pause Perry have different scopes. Their labels and confirmations should say which activity changes. An approval should explain the action, destination and scope before asking for a decision. This follows the general principles of [visible system status and user control](https://www.nngroup.com/articles/ten-usability-heuristics/).

**Make the complete journey usable.** A good first screen does not compensate for losing a draft, an ambiguous retry or an approval that disappears without an outcome. Keyboard access, touch access, pending states and recovery belong in the main interaction design. For touch, aim for 44 by 44 CSS pixels on important controls. WCAG 2.2 AA's minimum criterion is 24 by 24, with specified exceptions; a 32-pixel control is not automatically an AA failure. [W3C target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum)

## What familiar products can teach us

These are reference products to test with users, not an assertion about their app history.

| Product evidence | Visible convention | Application to Perry |
| --- | --- | --- |
| [Claude chat list](https://mobbin.com/screens/ef4dc71f-9d6e-4b35-89d7-26c2393c58c0?utm_source=chatgpt&utm_medium=ai-assistant&utm_source_platform=mcp) | New chat and Search appear in a left sidebar; the main pane lists chats with titles and recency. | Retain Perry's predictable New chat/Search placement and recognizable chat history. Do not make users learn a new navigation system merely to send a message. |
| [Todoist Today](https://mobbin.com/screens/fedfc0e2-73d1-42b6-853c-fb41ec5919f7?utm_source=chatgpt&utm_medium=ai-assistant&utm_source_platform=mcp) | A day heading, task rows, completion circles and Add task are visible. An Undo message is also visible in this capture. | Keep Perry's to-dos direct and structured. Users should be able to add or complete a task without having to use chat. Review reversible actions for equally understandable recovery. |
| [Searchable conversation](https://mobbin.com/screens/b34a24b1-6e6d-4176-ad05-d57f60a05c6d?utm_source=chatgpt&utm_medium=ai-assistant&utm_source_platform=mcp) | A response occupies the main pane, follow-up suggestions appear beneath it and a composer stays near the bottom. | Use this as a conversation-structure reference only. Keep Perry's response readable and make the next action easy to recognize. Its product domain is not evidence about Perry's audience. |

The missing research is a short account of what prospective users already do: which messenger they open first, how they manage tasks, whether they use a chat assistant, and how they expect background work to behave. Familiarity should be established from those answers rather than assumed from popular apps.

## Current strengths worth preserving

- [Chat scroll behavior](../components/dashboard/chat/use-chat-scroll.ts) releases automatic following when the reader interacts and provides an explicit return to the latest reply. This respects someone reading earlier messages.
- [The composer](../components/dashboard/chat/composer.tsx) preserves drafts, labels its controls and distinguishes sending into a running reply from queuing a later message. [Its editor](../components/dashboard/chat/prompt-editor.tsx) handles composition input and multiline/code editing instead of treating every Enter as send.
- [Approval cards](../components/dashboard/approval-card.tsx) show the requested action, available details, an expiry and explicit decisions. Brain proposals can show before/after text. Keep this evidence visible.
- [The inbox](../components/dashboard/screens/inbox.tsx) already puts approvals ahead of other updates. It has a useful aggregation model; discovery of that destination is the issue.
- [Onboarding](../components/dashboard/screens/welcome.tsx) offers escape routes and moves focus to each step's heading. [NextStep](../components/dashboard/chat/next-step.tsx) presents one setup suggestion at a time rather than a grid of competing prompts.
- [ThreadNow](../components/dashboard/chat/thread-now.tsx), turn errors, browser takeover and the paused-state notice already expose useful status and recovery. Improve their discoverability before introducing another parallel status system.

## Findings and implemented changes

| Finding | Implemented resolution |
| --- | --- |
| Pending decisions were behind a footer bell | Named Needs you navigation with a live count. Approvals stay in their conversation too. |
| First use competed with setup | Concrete editable starters remain; setup is collapsed and optional. Fresh Welcome leads to text chat with explicit engine choice. |
| Personalization and voice appeared required | Start chatting bypasses both; personalization remains available as an optional path. |
| Technical choices crowded routine writing | Model and thinking moved to Reply options with next-reply timing. Access stays visible and explains immediate scope. |
| Blocking waits were muted or truncated | Wait/disconnect/failure cards wrap their full explanation and show Stop this reply or Try again. |
| Work opened on Schedules | Work opens on Tasks, includes older active tasks and displays their count. Existing `tab=plans` and schedule/goal/watch anchors keep working. |
| Local stop and global pause were hard to distinguish | A visible Pause all work control appears during activity, including in the collapsed sidebar. Confirmation explains scope; Resume is persistent while paused. |
| Brain, Library and Work needed explanation | Navigation descriptions and page introductions identify memory/notes, files and background tasks/schedules. |
| Touch targets and hidden actions needed review | Shared touch controls have 44px targets; adjacent controls reserve space, touch actions remain visible, and narrow layouts wrap. Desktop density is retained. |
| Panels needed predictable close and focus return | Mobile uses Base UI final focus; floating and docked panels close with Escape and return focus to the toggle. Browser application keyboard handling is preserved. |

Approval requests now distinguish Allow once, Apply change and Always allow this rule. A request stays visible while its answer is being acknowledged and remains retryable after failure. The pet supports native pointer, Enter and Space activation while keeping drag separate. Autosaves drain in order during navigation and recover failed drafts in the same browser tab. Site copy feedback resets with its command and cleans up its timer.

## Predicted visual attention

The later [proposed-design map](ui-attention-map-proposed.html) shows the follow-up suggestions: a task-focused landing, consequence-first approval, clearer status and contextual pending decisions. It offers alternate attention paths with variable numbers of regions. These additional layout proposals are not a claim that the app has already changed.

The [interactive forecast](ui-attention-map.html) maps six activities on the existing desktop chat after setup. It includes the implemented navigation, optional setup and composer controls. Geometry remains an approximate illustration rather than a screenshot.

- **Landing:** the large isolated greeting is a plausible first glance. Concrete starter requests can attract attention before the composer; collapsed setup remains a possible distraction. A person familiar with chat may go straight to the input; navigation is a possible orientation detour.
- **Scrolling:** show three paused checkpoints through a long reply. Headings and relevant details become stopping points as content moves, while the sidebar and composer remain stationary. This applies [heading-led scanning research](https://www.nngroup.com/articles/layer-cake-pattern-scanning/); it does not impose a universal F pattern.
- **Writing:** attention may stay around the draft and a wording check before submission. Enter-to-send users can bypass the send control. Users who look at a physical keyboard will have a different path. The access setting may never get a glance.
- **Waiting:** a person checking back may look for new reply content, then status and possibly Stop. They may also leave the app entirely. Small muted status can be overlooked.
- **Reviewing an action:** the distinct approval header and short operation are likely landmarks. A careful reader may check the destination before deciding. A risky alternative is jumping from the header to the filled Allow once button, skipping important details.
- **Returning:** the latest visible outcome and generated file can help restore context. If the desired task is elsewhere, attention may move to recent chats or Work. The named Needs you destination can still be overlooked when attention stays on the current result.

The map shows illustrative heat regions, a numbered route, individual route steps and heat/path toggles. Warmth represents relative expected attention or revisiting within one scenario; it is not a probability, calibrated dwell time or a comparison between scenarios. Coordinates, region sizes and intensities are chosen manually from the layout and task assumptions. Numbers are one plausible sequence, not timed fixations. Selecting a step isolates its region; scrolling changes both the visible content and predicted route.

These forecasts assume a sighted, English-reading desktop user, an expanded sidebar and no startup alert. The fresh-install Welcome flow, mobile layouts and assistive-technology navigation need separate maps. Actual routes can differ with prior product experience, input method, task and content. Research supports [task-dependent eye movements](https://www.nngroup.com/articles/eyetracking-tasks-efficient-scanning/); it does not validate Perry's particular coordinates or sequence.

A click map, gaze map and scroll-depth map measure different things; none alone proves understanding or successful completion. Do not optimize an approval merely to attract more clicks on Approve. Keep the desired hierarchy in the recommendations separate from this forecast of probable looking behavior.

## Validation before a redesign

Run a small formative study with people resembling the intended users, including people who already use a chat assistant and people who do not. Ask about their actual apps first. Use synthetic content and a disposable installation.

1. With a fresh install, create a reminder without enabling voice. Observe where participants hesitate and whether they believe voice is required.
2. Start work, leave the chat and return. Ask what is running, what completed and what needs them. Record whether they can find each without hints.
3. Present an approval with a specific recipient or file destination. Before they choose, ask them to explain what will happen and whether the permission is one-time or persistent.
4. Ask them to stop one reply, pause one schedule and take over the browser. Check whether the selected control matches the intended scope.
5. Ask them to find a remembered preference and a generated file. Use this to evaluate Brain versus Library, not a preference poll about which label sounds better.
6. Exercise a disconnected runner, a failed upload and an unconfirmed write. Check draft preservation and whether participants know when a retry might duplicate a change.
7. Repeat the core tasks with keyboard only, touch, zoom and a small viewport. Include a screen-reader pass and reduced-motion settings.

Record task completion, assistance required, wrong destinations, time to find the next action, permission comprehension and recovery success. Segment observations by task, device, product familiarity and screen state. Heatmaps are supplementary evidence. If collecting behavioral analytics, obtain appropriate consent and exclude message bodies, files, credentials, page contents and recipient details.

Use these tasks to validate the implemented changes. Preserve the visual language and revise the design when observed behavior warrants it.
