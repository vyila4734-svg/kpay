# KPay — цифровые покупки

Responsive storefront for digital purchases. Run the local Node.js server to create Steam, Telegram Stars and Telegram Premium orders through NS API.

- `index.html` contains the complete storefront, including Steam, Telegram Stars and Telegram Premium forms.
- `steam.html`, `stars.html` and `premium.html` provide dedicated pages for each product.
- `server.js` serves the site, signs NS API requests and stores Steam, Telegram Stars and Telegram Premium order history on the server. It uses only Node.js built-ins; no package install is needed.
- Interactive Steam amount calculator with promo code `KPay10`, Telegram Stars/Premium selectors, mobile menu, FAQ accordion and notifications. The catalog links to dedicated Stars and Premium pages; Steam remains accessible from its form on the home page.
- Steam orders are created through NS API service `1`; the requested amount is entered in rubles and converted to USD using the provider's current exchange rate. Only a Steam login (not email) is sent to the provider, without a prior account check.
- Telegram Stars orders use the eight NS stock packages `2249`–`2256` (50–2,500 Stars) and send the normalized Telegram username as `account_number`. Storefront prices are estimates at 2.50 ₽ per Star; update the package list and estimates if the NS account's stock or pricing changes.
- Telegram Premium orders use NS stock services `2246`–`2248` for 3-, 6- and 12-month plans and send the normalized Telegram username as `account_number`. Storefront prices are estimates and should be checked against the provider's current prices.
- Order creation uses `create_order` and does not charge the provider balance. Payment via `pay_order`, customer payments and order fulfilment are not connected. Created orders appear on the server-backed “Мои заказы” page with an awaiting-payment status; each browser sees orders associated with its own session cookie.

## Start

Fill in the private `.env` file in the project folder with the account ID, API login, password and Base64 API secret from NS.GIFTS. The server reads this file on startup. `.env` is excluded from Git and is not served to visitors. Keep real credentials out of frontend files and chat.

Start the server:

```powershell
node server.js
```

Open `http://localhost:3000`. Do not open `index.html` directly as a `file://` URL. By default, the server binds to `127.0.0.1`; for deployment configure `HOST` and `PORT` with your hosting provider, use HTTPS, and allowlist the server's outbound IP with NS.GIFTS if required.

To test NS API credentials without creating an order, open `http://localhost:3000/ns-test.html` while the local server is running. Enter `USER_ID`, `LOGIN`, `PASSWORD`, `API_SECRET` and `BASE_URL` (`https://api.ns.gifts`). The page only requests an API token; the credential-check endpoint accepts connections from this computer only and does not save the submitted values. A provider HTTP 403 is reported separately because its documentation associates it with IP allowlisting or account permissions. Do not expose this page on a public server.

An optional `STEAM_WEB_API_KEY` field is reserved in `.env` for future Steam API features; it is not currently used to check login names. Never store a visitor's Steam password or Steam Guard code.

Run the built-in tests with `node --test`.
