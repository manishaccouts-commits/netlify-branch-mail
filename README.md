# Branch Mail Portal (Netlify version)

Netlify's drag-and-drop upload only hosts plain files and cannot run this server code. Import this project from GitHub instead. No commands are needed.

## 1. Google Sheet
Create a new blank Google Sheet with two tabs.
- BM_QUEUE: row 1 headers: REQ_ID, SUBMITTED_AT, SUBMITTED_BY, LOAN_NO, CUSTOMER, BRANCH, SETTLEMENT, CALLER_CODE, CALLER_NAME, CC_MAIL, STATUS, LEADER_BY, LEADER_AT, SENT_AT, SENT_BY, NOTE
- BM_USERS: row 1 headers: LOGIN, NAME, ROLE, PW_HASH. Add one row: your employee code, your name, ADMIN, and the hash from step 2.
Create a Google service account in Google Cloud, enable the Google Sheets API, download its JSON key, and share the sheet with the service account email as Editor.

## 2. Password hash
Run this in a terminal and paste the output into PW_HASH:
python -c "import hashlib,os,sys;s=os.urandom(16).hex();print(s+'$'+hashlib.pbkdf2_hmac('sha256',sys.argv[1].encode(),bytes.fromhex(s),200000).hex())" "YourPassword"

## 3. Brevo (sends the mail)
Sign up at brevo.com (free, 300 emails a day). Verify your sender address and create an API key.

## 4. GitHub
Create a private repository. Extract netlify-branch-mail.zip and drag the contents (the files and the public and netlify folders) into the repository on github.com using Add file > Upload files.

## 5. Netlify
In app.netlify.com choose Add new project > Import an existing project > GitHub, and select the repository. Settings come from netlify.toml, so leave them as they are. Before the first deploy, add these environment variables under Project configuration:
- SESSION_SECRET: a long random text
- SHEET_ID: the sheet ID from its URL
- GOOGLE_SA_JSON: the whole service account JSON as one value
- BREVO_API_KEY, SENDER_EMAIL (verified in Brevo), SENDER_NAME
- FORECLOSURE_TO: the two Foreclosure addresses, comma-separated
- MAIL_TEST_TO: your own test address
- MAIL_LIVE: leave empty until the test passes, then set it to 1

Deploy, then open the Netlify address.

## 6. Before mail can send
Paste the Branch Mail v3.2 subject, opening line, EOD validity line, and internal-only note into netlify/functions/api.js in place of the PASTE lines. Sending stays blocked until they are replaced.

## Testing
Test mode (MAIL_LIVE empty) sends every mail only to MAIL_TEST_TO, with [TEST] in the subject. Send one test request and check the subject and Cc before setting MAIL_LIVE to 1.

## Notes
- Every deploy from GitHub uses credits on the free plan. Avoid many small commits.
- Keep SESSION_SECRET, GOOGLE_SA_JSON and BREVO_API_KEY only in Netlify's environment settings, never in the files.
