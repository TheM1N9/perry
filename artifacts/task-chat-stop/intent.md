# Owner control during background work

Mani sends corrections while a task is working and expects Stop to remain stopped. The job is to keep progress and session context while making his latest action authoritative.

Chosen flow: existing Stop holds the same task; the next deliberate message in its chat resumes it. Work-page Answer also resumes it. Existing steering delivers live updates, with the existing ordered queue as fallback. Automatic task prompts always wait. Stopped runs get a neutral, textual Stopped label using the existing Activity badge/filter. Genuine failures retain their diagnostic details.

Alternatives considered: terminate and recreate the task (loses continuity), add another pause mode/control (duplicates blocked/resume), or retain the current turn-only Stop (permits surprising restart). The chosen flow uses existing controls and task states.

Review: desktop Stop, visible preserved progress and cancelled messages, deliberate resume, same model session, Activity Stopped filter, genuine error view, keyboard submission. Existing status tokens and native controls retain contrast and keyboard behavior. Unacceptable: a red Failed label for Stop, silent replay, fabricated recovery, or a fresh task/session on resume.

Applied skills: session-continuity, human-writing, mani-ui-workflow and ui-ux-pro-max. Read bundled Next.js use-client guide before the Activity edit. UI-UX rules page revision 5 supplied truthful-feedback and complete-flow guidance; targeted UX search supplied existing contrast guidance, with no new palette or controls.
