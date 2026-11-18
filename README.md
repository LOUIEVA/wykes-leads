# Wykes Leads dashboard

A private, passcode-protected lead dashboard for Wykes Contracts.

- `scripts/build-data.mjs` pulls the "Website Leads" pipeline, contacts and conversations from GoHighLevel, summarises them, and encrypts the result with the dashboard passcode (PBKDF2-SHA256 + AES-256-GCM).
- `.github/workflows/refresh.yml` runs it every 15 minutes and publishes `site/` plus the encrypted `data.enc.json` to GitHub Pages.
- The GHL token and passcode live only in GitHub Actions secrets: `GHL_PIT`, `GHL_LOCATION_ID`, `DASH_PASSCODE`. No customer data is stored in this repo.

To change the passcode: update the `DASH_PASSCODE` secret and run the workflow. Old links stop working.
