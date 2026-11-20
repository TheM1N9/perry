# Group and contact chats can read the files people send

Incident, 20 Nov 2026, WhatsApp group "HC podcasts": Siya sent a set-design PDF; Perry
said "I can't open the set file here" three times, even after the owner said it had all
access in that group. Two causes: a file in someone else's chat never reached the turn
(the server sent "(sent a file, which you cannot open here)" in its place, and a document
with a caption was dropped whole), and a guest turn has no shell or files, so a PDF's
path told its engine nothing it could read.

Ways it could fail, written down before the checks:

Getting the file to the turn
1. A file sent in an allowed group without mentioning Perry is not in the turn of the next mention.
2. A file sent with the mention itself is not in its turn.
3. A document sent with a caption (documentWithCaptionMessage) is dropped, or its caption lost.
4. The same file is attached again at every later mention.
5. A file is downloaded or stored for a group or person the owner never allowed.
6. Video or voice notes are stored though no engine can read them.
7. Files on lines that drop off a group's recent messages stay in storage for ever.
8. Blocking a group leaves its unread files in storage.
9. The guest rules still tell the engine it has no files, so it refuses the one it was given.
10. A Telegram file in an allowed chat still arrives as "(sent a file, which you cannot open here)".

Making it readable
11. A guest turn gets the PDF's path, which it cannot open, instead of page pictures and text.
12. Page pictures are written outside the guest folder, or the guest turn gets a path into the owner's uploads.
13. A long PDF is drawn whole (hundreds of pictures): pictures must stop at 20, longest side 1600 px, with the text saying so.
14. Text past the drawn pages is lost (page 25's words), or a huge text is sent whole.
15. "$name" or "@path" in a file name or in the file's text reaches the engine live.
16. An owner turn loses the original file's path (it may still want to open or edit it).
17. A DOCX, PPTX or XLSX gives no text; with LibreOffice absent the turn fails instead of going on with text.
18. A broken PDF fails the turn instead of passing the file on as it came.
19. A zip bomb dressed as a DOCX exhausts memory.
20. The engine (Codex, locked down for a guest) does not take local pictures, so it still cannot see the pages.

Two runs:
- run.mjs, in CI: the real backend on SQLite (WhatsApp in, contacts, brain, the runner's claim), the
  runner's readable() and Codex's userInput(), with no network and no engine. Writes result.json.
- live.ts, by hand: the production build, the runner and Codex for real, with the stand-in WhatsApp
  (artifacts/whatsapp/fake-driver.mjs). Perry must answer from inside the PDF in a group, in a
  contact's chat and in the owner's own chat. Writes result.json and the first drawn page.
