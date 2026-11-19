# ZimQuote Mail v6: attachments both ways

Upload 4 files. No new packages.

| File | Change |
|---|---|
| `services/mailInbox.js` | bigger received files, sending files with replies |
| `routes/mailInbox.js` | attachment download reads large files |
| `models/mailMessage.js` | + skipped-file list, file names on replies |
| `routes/meta_webhook.js` | your latest file + documents/photos go to Mail while someone is writing a reply. Everything else in the file is unchanged |

Then run `pm2 restart cripfcnt --update-env`.

## Receiving
- Any file type: PDF, Word, Excel, images, zip.
- Up to **25 MB per file** (was 8 MB). Change it with `MAIL_MAX_ATTACH_MB`. Big files are stored in pieces, so MongoDB's 16 MB limit doesn't matter.
- The alert lists the file names: `📎 3 attachments: RFQ.pdf, Specs.docx, BOQ.xlsx`.
- **📄 Full email** sends up to 8 files as WhatsApp documents. Files that are too large get a clear note: *"Video.mp4 (30 MB) - open in your email app"*.

## Sending
1. Tap **↩️ Reply**.
2. **Send the file here** (PDF, Word, Excel, photo), then type the message. Or type first and send files after. Either order works.
   - A photo or document with a **caption**: the caption becomes the message.
3. The preview lists the files: `📎 Attached (420 KB): • Quotation-0042.pdf`.
4. **✅ Send.** The email goes out with the files attached, threaded under the original email.

Limits: up to 5 files and **15 MB in total** per email (`MAIL_MAX_SEND_MB`), because many company mail servers reject bigger emails. If a file is too big, they get a clear message.
