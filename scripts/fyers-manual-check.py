"""Run a one-time FYERS authentication check without saving credentials or tokens.

Before running, set the FYERS API app redirect URL to the value shown below.
"""

from __future__ import annotations

import getpass
import sys
import webbrowser
from urllib.parse import parse_qs, urlparse


REDIRECT_URL = "https://trade.fyers.in/api-login/redirect-uri/index.html"


def auth_code_from(value: str) -> str:
    """Accept either a raw auth code or the complete redirected URL."""
    if value.startswith(("http://", "https://")):
        query = parse_qs(urlparse(value).query)
        return (query.get("auth_code") or query.get("code") or [""])[0]
    return value


def safe_response(response: object) -> dict[str, object]:
    """Keep useful status fields while never printing a token."""
    if not isinstance(response, dict):
        return {"response": str(response)}
    return {
        key: value
        for key, value in response.items()
        if key in {"s", "code", "message", "error"}
    }


def main() -> int:
    try:
        from fyers_apiv3 import fyersModel
    except ImportError:
        print("FYERS SDK is not installed. Run: python -m pip install fyers-apiv3")
        return 1

    print("FYERS manual authentication check")
    print(f"\nYour FYERS API app Redirect URL must be exactly:\n{REDIRECT_URL}\n")
    app_id = input("FYERS App ID (including -100): ").strip()
    secret_id = getpass.getpass("FYERS Secret ID (hidden): ").strip()
    if not app_id or not secret_id:
        print("App ID and Secret ID are both required.")
        return 1

    session = fyersModel.SessionModel(
        client_id=app_id,
        secret_key=secret_id,
        redirect_uri=REDIRECT_URL,
        response_type="code",
        grant_type="authorization_code",
        state="oi-lens-manual-check",
    )
    login_url = session.generate_authcode()
    print("\nOpening FYERS login in your browser…")
    print("After you approve access, copy the full final browser URL and paste it here.")
    webbrowser.open(login_url, new=1)

    auth_code = auth_code_from(input("\nFinal URL or auth code: ").strip())
    if not auth_code:
        print("No auth code found. Please start again and paste the final redirected URL.")
        return 1

    session.set_token(auth_code)
    response = session.generate_token()
    result = safe_response(response)
    if isinstance(response, dict) and response.get("access_token"):
        print("\nSuccess: FYERS generated an access token.")
        print("The token is intentionally not shown or saved by this check.")
        return 0

    print("\nFYERS did not generate an access token.")
    print("FYERS response (tokens removed):", result)
    return 1


if __name__ == "__main__":
    sys.exit(main())
