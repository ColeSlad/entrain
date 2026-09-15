"""Create the user's dedicated API secret without putting tokens in shell history.

Run after `modal token new`. This makes a remote Secret, not a GPU deployment.
Existing secrets are not overwritten; rotate them explicitly in Modal instead.
"""

import argparse
import secrets
from urllib.parse import urlsplit

import modal


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True, help="Exact HTTPS website origin, without a trailing slash")
    args = parser.parse_args()
    origin = urlsplit(args.origin)
    if origin.scheme != "https" or not origin.netloc or origin.path or origin.query or origin.fragment or origin.username or origin.password:
        parser.error("Use an HTTPS origin such as https://entrain-rouge.vercel.app (no path)")
    token = secrets.token_urlsafe(32)
    modal.Secret.objects.create("entrain-web", {
        "ENTRAIN_API_TOKEN": token,
        "ENTRAIN_JOB_SIGNING_KEY": secrets.token_urlsafe(32),
        "ENTRAIN_ALLOWED_ORIGINS": args.origin,
    })
    print("Created the entrain-web secret in your current Modal environment.")
    print("Save this Entrain access token in your password manager; paste it only into your trusted Entrain site:")
    print(token)
    print("Do not paste it into chat, commit it, or include it in Vercel environment variables.")


if __name__ == "__main__":
    main()
