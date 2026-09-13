# Saved FYERS setup

Save the FYERS App ID and Secret ID once in a normal browser profile. The server
encrypts both into a Secure, HttpOnly cookie with a one-year lifetime. Opening the
site or reconnecting renews that lifetime. No credentials are stored in browser
localStorage, the public cache, source code, or D1.

The FYERS access-token session is separate and lasts at most one day; an earlier
expiry in the provider's token is respected. After expiry, Connect FYERS starts
the provider login with the saved setup. FYERS may still require authentication.
Disconnect and failed callbacks retain setup. Forget saved FYERS setup removes
it. Clearing cookies, changing site domains, private browsing, or changing
browser profiles can require setup again.

Production requires the persistent `OI_COOKIE_SECRET` Cloudflare secret and the
`nodejs_compat_populate_process_env` compatibility flag. Keep this secret stable
across deployments. There is no public encryption-key fallback. Older cookies
that used the previous public fallback cannot be trusted or migrated; affected
browsers must save their setup once after this update.

Verification: `npm test` includes simulated broker-token expiry. Run
`node scripts/check_fyers_persistence.mjs https://your-site` for an isolated
synthetic-cookie check of save, renewal, disconnect, reconnect redirect, failed
callback, and Forget. It never follows the broker redirect or uses a real account.
