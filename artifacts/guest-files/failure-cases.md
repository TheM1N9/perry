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
21. Persisting a plain WhatsApp envelope changes its Uint8Array media key into an object; downloading then derives the wrong cipher key and the engine never receives the PDF's contents.
22. Automatic extraction fails silently, leaving only a file name/path and no explanation of what was not read. A corrupt, encrypted or oversized document must keep its original attachment and tell the engine that automatic extraction failed.
23. Text, CSV, JSON, source code and UTF-16 text attachments reach the engine only by path. Their actual bounded text must be included automatically, with truncation disclosed and attachment instructions treated as data.
24. An unknown binary attachment is mistaken for readable text, or is silently presented as already read. Keep the original and explain that automatic extraction did not support its format.
25. A scan after the shared page-image budget is exhausted tells the engine to read pictures that were never included. Report the missing visual content explicitly.
26. One native file read returns fewer bytes than requested before EOF. Continue at the correct file and buffer offsets until the byte cap or EOF, retaining complete UTF-8 and BOM-marked UTF-16 text across chunk boundaries.
27. Repeated short reads overrun the existing bounded text buffer, or a multibyte character at its byte limit is reported as an invalid attachment. Keep the byte cap and disclose character truncation.
28. A file becomes shorter after its size was measured. A zero-byte read must end extraction without looping, inventing zero padding or losing handle cleanup.
29. A later chunk read fails after earlier chunks succeeded. Close the handle, retain the original attachment and report extraction failure rather than presenting the partial text as complete.
30. An Excel worksheet omits empty cells or rows. Extracted values must retain their cell addresses, so a value in C4 cannot move under the B column or appear to be from row 2.
31. Valid worksheet rows or cells omit their optional coordinates. Infer their positions from preceding rows/cells, including after an explicit gap, while preserving shared strings, inline strings, cached values and explicit empty cells.
32. A sparse sheet contains XFD1048576. Retain that coordinate without constructing millions of blank rows or columns, and continue to disclose the normal extracted-text limit.
33. A worksheet declares malformed or out-of-range coordinates. Reject that attachment honestly without overflowing a counter, looping or preventing a following valid attachment from being read.

Two runs:
- run.mjs, in CI: the real backend on SQLite (WhatsApp in, contacts, brain, the runner's claim), the
  runner's readable() and Codex's userInput(), with no network and no engine. Writes result.json.
- live.ts, by hand: the production build, the runner and Codex for real, with the stand-in WhatsApp
  (artifacts/whatsapp/fake-driver.mjs). Perry must answer from inside the PDF in a group, in a
  contact's chat and in the owner's own chat. Writes result.json and the first drawn page.
