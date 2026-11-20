# Riff styles

A Riff document has a style: how Perry writes your dictation and makes your edits. A style is an ordinary
skill, a folder with a `SKILL.md`, so a style of your own never needs to be in this repository.

Perry ships three: **Notes**, **Script** and **Thread** (`convex/lib/riffStyles.ts`). A skill in your skills
folder (`~/.perry/skills/<name>/SKILL.md`) shows in Riff's style picker when its frontmatter says so:

```markdown
---
name: launch-thread
description: A launch thread for X. Short posts, a hook first.
riff: true
riff-post-limit: 280
---
Write a launch thread. Separate posts with a line containing only ---.
...
```

| Field | Meaning |
|---|---|
| `riff: true` | Offer this skill as a writing style in Riff. Skills without it stay out of the picker. |
| `riff-post-limit: 280` | Optional. The most characters in one post; posts are separated by a line of `---`. Riff shows how many posts there are and any over the limit. |

`name` and `description` are the skill's own, as every engine reads them; the picker shows the description under
the name. A style skill named `notes`, `script` or `thread` takes the place of the built-in one.

When a document has your style, its editing chat is told to follow the skill (`$name`), and the runner hands the
engine that `SKILL.md`, as it does for any skill named in a message.
