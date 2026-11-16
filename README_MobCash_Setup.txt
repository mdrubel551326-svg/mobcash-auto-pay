MobCash Telegram Mini App + Company API integration
===================================================

FILES
- MobCash_AutoPay_Telegram_Mini_App.html : updated app frontend
- worker.js : Cloudflare Worker backend proxy

IMPORTANT
1. The HTML file is not live yet. It must be hosted on an HTTPS domain and configured as your Telegram Mini App URL.
2. Deploy worker.js as a Cloudflare Worker. IMPORTANT: route `https://YOUR-MINI-APP-DOMAIN/api/*` to this Worker on the SAME domain that serves the HTML, because the frontend calls relative `/api/...` paths. If using a separate Worker domain, change the frontend API base URL and configure CORS for the exact Mini App origin.
3. In Cloudflare Worker Settings > Variables and Secrets, add:
   Secrets:
     API_HASH = company-issued hash
     CASHIERPASS = company-issued cashier password
     TELEGRAM_BOT_TOKEN = your Telegram bot token
   Plain-text variables:
     CASHDESKID = company-issued cashdesk ID (digits only)
     API_LOGIN = company-issued login (the supplied PDF lists it but does not describe how any endpoint uses it)
     API_LANGUAGE = en (or the language code agreed with the company)
     API_BASE_URL = https://partners.servcul.com/CashdeskBotAPI (optional)
     ALLOWED_ORIGIN = https://YOUR-MINI-APP-DOMAIN (optional; comma-separated origins)
4. Do not put API_HASH, CASHIERPASS, or the bot token in the HTML file or send them in chat.
5. Open the app through Telegram, not as a local file. The Worker validates Telegram WebApp initData using TELEGRAM_BOT_TOKEN.

WHAT THE COMPANY PDF SUPPORTS
- Player lookup: GET /Users/{userId}?confirm=&cashdeskid=
- Deposit: POST /Deposit/{userid}/Add with cashdeskid, lng, summa, confirm
- Payout: POST /Deposit/{userId}/Payout with cashdeskId, lng, code, confirm
- Each request includes the generated `sign` header.

LIMITATIONS / COMPANY CONFIRMATION REQUIRED
- The PDF lists `login` as a credential but does not specify where/how to use it. API_LOGIN is retained as a Worker variable but is not sent in requests because the PDF gives no rule for it.
- The PDF does not define a bKash/Nagad account field or a transaction-ID field for deposit. Those unsupported fields were removed from the transaction flow; payout is submitted using the company `code` and Player ID only.
- The PDF's signature template writes `Userid` in one place, but its worked example uses lowercase `userid`. This implementation follows the worked example and the player-lookup-specific lowercase format. If the company requires different casing, ask their technical support to confirm.
- A successful API response still needs testing with the real company-issued credentials and an authorized test player. No real transaction has been executed by preparing these files.

SECURITY
- The Worker rejects calls without a valid, recent Telegram Mini App initData signature.
- Use a separate test cashdesk/account first. Never test with real funds until the company confirms the integration and you verify the response behavior.

CRITICAL SIGNATURE SAMPLE MISMATCH
The PDF's worked sample for step 2 states that MD5("summa=100&cashierpass=123123&cashdeskid=77") is
cc8123f763fec8ca3624304756dd9991. Standard MD5 for that exact literal string is instead
c62f2599297398178325c0291cefca32 (verified independently). The PDF's confirm example does match
standard MD5. This implementation uses standard MD5 of the literal formula, but do NOT enable
real-money transactions until the company's technical team confirms whether the sample value or
the written formula is authoritative and supplies a corrected test vector.
