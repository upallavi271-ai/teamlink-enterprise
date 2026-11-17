# OCR for scanned resumes

A scanned PDF, or a photo (JPG / PNG) of a paper resume, has no text inside, so the
resume parser has nothing to read. TeamLink reads these with the free `tesseract`
program (and `pdftoppm` from poppler-utils to turn a PDF's pages into pictures).

Until it is installed, nothing breaks: the resume is saved and marked
"Scanned resume — text could not be read (OCR not installed on the server)".

## Install on the server (Ubuntu / Debian)

Run once, as root:

```
apt-get install -y tesseract-ocr tesseract-ocr-tel tesseract-ocr-hin poppler-utils
```

No restart is needed. TeamLink checks for the programs again within 10 minutes. To
check at once, an Admin can open `GET /api/candidate-resumes/ocr-status?fresh=1`.
It shows whether OCR is available and which languages it reads (English, Telugu
and Hindi: `eng+tel+hin`).

## How it runs

- OCR runs only when a PDF has no text, or nearly none (fewer than 80 letters), or
  when the file is a JPG / PNG photo.
- It reads at most 4 pages of a PDF, at 200 dpi.
- It reads one resume at a time, at low priority (`nice -n 19`), so the app stays
  fast. Each resume is stopped after 60 seconds.
- If more than 25 resumes are waiting, the next upload is saved without OCR and
  says "the text reader is busy". Upload it again later.
- The work files go in a private temp folder and are deleted afterwards. Nothing
  leaves the server.

## Settings (optional)

| Variable            | Default     | What it does                    |
|---------------------|-------------|---------------------------------|
| `OCR_TESSERACT_BIN` | `tesseract` | Path to the tesseract program   |
| `OCR_PDFTOPPM_BIN`  | `pdftoppm`  | Path to the pdftoppm program    |
| `OCR_MAX_QUEUE`     | `25`        | Most resumes waiting for OCR    |

The test `backend/scripts/resume-ocr-test.js` points these at small stand-in
programs, so it runs on a machine without tesseract.
