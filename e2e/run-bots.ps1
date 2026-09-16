Set-Location "C:\Users\ARFA TECH\Desktop\RSN-fixloc\e2e"
$env:JWT_SECRET = (Get-Content ".jwt_secret" -Raw).Trim()
$env:EVENT_TITLE = "z1"
npx playwright test tests/bots-8.spec.ts --workers=1 *> bots-log.txt
